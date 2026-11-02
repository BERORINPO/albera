import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { ID_PATTERN } from '../src/runtime/broker-contract/action-digest.mjs';
import { createFakeGitPromotion } from '../src/runtime/fake-git-promotion.mjs';
import { createFakeGitQuarantine } from '../src/runtime/fake-git-quarantine.mjs';
import { createFakeIntegrationApprovals, fakeHumanApproval } from '../src/runtime/fake-integration-approvals.mjs';
import { createFakeIntegrationVerifier, fakeVerifierEvidence } from '../src/runtime/fake-integration-verifier.mjs';
import { TIMEOUT_MS } from '../src/runtime/git-process.mjs';
import { createGitPromotion } from '../src/runtime/git-promotion.mjs';
import { createGitQuarantine } from '../src/runtime/git-quarantine.mjs';
import { createIntegrationService, INTEGRATION_DEFAULTS, INTEGRATION_PHASES, INTEGRATION_STATUSES } from '../src/runtime/integration-service.mjs';
import { createMemoryFlowJournal } from '../src/runtime/approved-operation-journal.mjs';
import { openSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';

// The Integration Service (ADR-007 §3-§8; INT-01 / INT-02) against FAKE ports: a fake quarantine, a remote that is a variable, a fake verifier and fake approvals. Every
// scenario runs on the in-memory journal and on the SQLite journal. Synthetic: nothing here ran a test in a VM or asked a person; the last describe drives the real
// git quarantine and promotion adapters against local bare repositories. A crash is simulated by throwing after a journal write or a port call (the effect happened,
// the answer was lost), then building a NEW service over the same journal and ports.
const MAIN = 'refs/heads/main';
const TIP = 'a'.repeat(40);
const RESULT = 'b'.repeat(40);
const CAND = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);
const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const IDENTITY = Object.freeze({ name: 'ALBERA Integration', email: 'integration@albera.invalid' });
const digest = (c) => `sha256:${c.repeat(64)}`;
const REQUEST = Object.freeze({
  integrationId: 'int-1', projectId: 'proj_001', repositoryId: 'repo_001', targetRef: MAIN,
  submissions: [{ submissionId: 'sub_101', bundlePath: '/host/bundles/sub_101.bundle', ref: 'refs/heads/task', baseCommitOid: TIP, resultCommitOid: RESULT }],
  testPlanDigest: digest('1'), imageDigest: digest('2'), lockfileDigest: digest('3'), policyVersion: 3, algorithmVersion: 1, risk: 'low', requiredGates: ['unit'],
});
const died = () => { throw new Error('process died'); };

/** The journal seen by one service instance: records every phase written, and throws after the `crashAt`-th event (a write or a port call) of this instance. */
function instrument(journal, history, tick) {
  return {
    begin: (record) => { const r = journal.begin(record); if (r.created) history.push(r.record.phase); tick(); return r; },
    advance: (...args) => { const r = journal.advance(...args); history.push(r.phase); tick(); return r; },
    get: (id) => journal.get(id),
  };
}

function makeWorld(journal, over = {}) {
  const w = { journal, clock: { ms: NOW_MS }, sleeps: [], history: [], repos: 0, remote: { tip: TIP, pushes: [] }, tipDown: false, options: over.options, trusted: over.trusted ?? ['trusted-verifier-01'] };
  w.defaultPush = (repo, update) => {
    w.remote.pushes.push(update);
    if (w.remote.tip !== update.expectedOldOid) return { outcome: 'rejected', code: 'stale' };
    w.remote.tip = update.newOid;
    return { outcome: 'updated', code: 'fast_forward' };
  };
  w.quarantine = createFakeGitQuarantine({
    create: () => `/fake/quarantine/q-${(w.repos += 1)}`,
    buildCandidate: () => ({ ok: true, candidateCommitOid: CAND, candidateTreeOid: TREE }),
    ...over.quarantine,
  });
  w.promotion = createFakeGitPromotion({
    readTip: () => (w.tipDown ? { ok: false, code: 'git_failed' } : { ok: true, oid: w.remote.tip }),
    push: (...args) => w.defaultPush(...args),
    ...over.promotion,
  });
  w.verifier = createFakeIntegrationVerifier(over.verifier);
  w.approvals = createFakeIntegrationApprovals(over.approvals);
  w.build = ({ crashAt = Infinity, journal: j = w.journal } = {}) => {
    let events = 0;
    const tick = () => { events += 1; if (events === crashAt) died(); };
    const hook = (port, names) => Object.fromEntries(names.map((n) => [n, async (...args) => { const r = await port[n](...args); tick(); return r; }]));
    return createIntegrationService({
      quarantine: hook(w.quarantine, ['create', 'importBundle', 'inspect', 'buildCandidate']), promotion: hook(w.promotion, ['readTip', 'fetchTip', 'push']),
      verifier: hook(w.verifier, ['start', 'collect']), approvals: hook(w.approvals, ['request', 'status']), journal: instrument(j, w.history, tick),
      now: () => w.clock.ms, sleep: async (ms) => { w.sleeps.push(ms); }, trustedRunners: w.trusted, identity: IDENTITY, options: w.options,
    });
  };
  w.service = w.build();
  w.record = (id = 'int-1') => w.journal.get(`integration/${id}`);
  w.pushes = () => w.remote.pushes.length;
  w.requestIds = () => w.approvals.calls().filter((c) => c.method === 'request').map((c) => c.args[0].requestId);
  w.runIds = () => w.verifier.calls().filter((c) => c.method === 'start').map((c) => c.args[0].runId);
  return w;
}

const brief = (r) => ({ status: r.status, phase: r.phase, code: r.code });
const merged = { status: 'merged', phase: 'MERGED' };
const phasesOf = (history) => history.filter((p, i) => p !== history[i - 1]);

function defineSuite(name, makeJournal) {
  describe(name, () => {
    const world = (over) => makeWorld(makeJournal(), over);

    describe('happy path', () => {
      it('goes SUBMITTED to MERGED with one push of exactly the approved update, and replays the outcome without touching a port', async () => {
        const w = world();
        const r = await w.service.submit(REQUEST);
        assert.deepEqual(brief(r), { ...merged, code: 'fast_forward' });
        assert.equal(r.candidateCommitOid, CAND);
        assert.deepEqual(phasesOf(w.history), ['SUBMITTED', 'VALIDATING', 'PREPARED', 'VERIFYING', 'REVIEW_REQUIRED', 'PROMOTING', 'MERGED']);
        assert.deepEqual(w.remote.pushes, [{ repositoryId: 'repo_001', ref: MAIN, expectedOldOid: TIP, newOid: CAND }]);
        assert.equal(w.remote.tip, CAND);
        assert.equal(w.promotion.calls().find((c) => c.method === 'push').args[0], '/fake/quarantine/q-1');
        assert.deepEqual(w.quarantine.calls().map((c) => c.method), ['create', 'importBundle', 'inspect', 'buildCandidate']);
        const build = w.quarantine.calls().at(-1).args[1];
        assert.deepEqual({ targetOid: build.targetOid, timestamp: build.identity.timestamp, name: build.identity.name }, { targetOid: TIP, timestamp: NOW_SEC, name: IDENTITY.name });
        assert.deepEqual(w.runIds(), ['int-1.v2.r1']);
        assert.deepEqual(w.requestIds(), ['int-1.v2.a1']);
        const rec = w.record();
        assert.deepEqual({ kind: rec.kind, phase: rec.phase, state: rec.candidate.state, attempts: rec.promotion.attempts, evidence: rec.verification.evidence.length, claims: rec.verification.claims.length },
          { kind: 'integration', phase: 'MERGED', state: 'MERGED', attempts: 1, evidence: 1, claims: 0 });
        assert.deepEqual(rec.authorization.update, { ref: MAIN, expectedOldOid: TIP, newOid: CAND });
        const before = [w.quarantine.calls().length, w.promotion.calls().length, w.verifier.calls().length, w.approvals.calls().length];
        const again = await w.build().submit(REQUEST);
        assert.deepEqual({ ...brief(again), replayed: again.replayed }, { ...brief(r), replayed: true });
        assert.deepEqual([w.quarantine.calls().length, w.promotion.calls().length, w.verifier.calls().length, w.approvals.calls().length], before);
      });
      it('keeps its records under integration/<id>, outside the approved-operation-flow id grammar', async () => {
        const w = world();
        await w.service.submit(REQUEST);
        assert.equal(w.journal.get('int-1'), null);
        assert.equal(new RegExp(ID_PATTERN, 'u').test('integration/int-1'), false);
        assert.equal(w.record().operationId, 'integration/int-1');
      });
      it('a medium-risk integration merges only with a comprehension record grounded in this commit by the same person', async () => {
        const request = { ...REQUEST, risk: 'medium' };
        const refused = world();
        assert.deepEqual(brief(await refused.service.submit(request)), { status: 'failed', phase: 'FAILED', code: 'comprehension_required' });
        assert.equal(refused.pushes(), 0);
        const grounded = world({ approvals: { status: (r, s) => ({ ok: true, state: 'decided', approval: fakeHumanApproval(s, { comprehension: { reviewerId: 'yosuke', basis: 'demonstration', candidateCommitOid: CAND } }) }) } });
        assert.equal((await grounded.service.submit(request)).status, 'merged');
        const aiSummary = world({ approvals: { status: (r, s) => ({ ok: true, state: 'decided', approval: fakeHumanApproval(s, { comprehension: { reviewerId: 'yosuke', basis: 'ai_summary', candidateCommitOid: CAND } }) }) } });
        assert.equal((await aiSummary.service.submit(request)).code, 'comprehension_required');
      });
    });

    describe('crash injection: a new instance resumes after every journal write and every port call', () => {
      it('always ends MERGED with exactly one push that landed, whichever point the process died at', async () => {
        let finished = 0;
        for (let crashAt = 1; crashAt < 100 && !finished; crashAt += 1) {
          const w = world();
          const first = await w.build({ crashAt }).submit(REQUEST).then((r) => r, (e) => e);
          if (!(first instanceof Error) && first.status !== 'retryable') { finished = crashAt; assert.equal(first.status, 'merged'); break; }
          const resumed = await w.build().resume('int-1');
          assert.equal(resumed.status, 'merged', `crash at event ${crashAt}`);
          assert.equal(w.pushes(), 1, `crash at event ${crashAt}`);
          assert.equal(w.remote.tip, CAND);
          assert.equal(new Set(w.runIds()).size, 1, `crash at event ${crashAt}: one run id`);
        }
        assert.ok(finished > 15, `a full run has more than 15 events (${finished})`);
      });
      it('verifier: died while collecting, the new instance starts the SAME run id again and collects', async () => {
        const w = world({ verifier: { collect: [died, (r, s) => ({ state: 'done', evidence: fakeVerifierEvidence(s) })] } });
        await assert.rejects(() => w.service.submit(REQUEST), /process died/u);
        assert.equal(w.record().phase, 'VERIFYING');
        assert.equal((await w.build().resume('int-1')).status, 'merged');
        assert.deepEqual(w.runIds(), ['int-1.v2.r1', 'int-1.v2.r1']);
      });
      it('approvals: died after the request, the new instance asks about the SAME request id and does not request again', async () => {
        const w = world({ approvals: { status: [died, (r, s) => ({ ok: true, state: 'decided', approval: fakeHumanApproval(s) })] } });
        await assert.rejects(() => w.service.submit(REQUEST), /process died/u);
        assert.equal(w.record().phase, 'REVIEW_REQUIRED');
        assert.equal((await w.build().resume('int-1')).status, 'merged');
        assert.deepEqual(w.requestIds(), ['int-1.v2.a1']);
        assert.equal(w.pushes(), 1);
      });
      it('died after PROMOTING was recorded and before the push: the resume pushes nothing, waits, finds the old tip, goes back to VERIFYING and needs a NEW approval, then pushes once', async () => {
        let first = true;
        const w = world({ promotion: { push: (...args) => { if (first) { first = false; died(); } return w.defaultPush(...args); } } });
        await assert.rejects(() => w.service.submit(REQUEST), /process died/u);
        assert.deepEqual({ phase: w.record().phase, pushes: w.pushes(), attempts: w.record().promotion.attempts }, { phase: 'PROMOTING', pushes: 0, attempts: 1 });
        const resumed = await w.build().resume('int-1');
        assert.equal(resumed.status, 'merged');
        assert.deepEqual(w.sleeps, [INTEGRATION_DEFAULTS.settleMs]);
        assert.deepEqual(w.requestIds(), ['int-1.v2.a1', 'int-1.v6.a1']);
        assert.equal(w.runIds().length, 1, 'the verified evidence is still valid, nothing is re-run');
        assert.deepEqual({ pushes: w.pushes(), attempts: w.record().promotion.attempts, superseded: w.record().approval.superseded }, { pushes: 1, attempts: 2, superseded: ['int-1.v2.a1'] });
        assert.deepEqual(phasesOf(w.history).slice(5), ['PROMOTING', 'UNKNOWN_PROMOTION', 'VERIFYING', 'REVIEW_REQUIRED', 'PROMOTING', 'MERGED']);
      });
      it('died after the push landed and before it was recorded: the resume reads the tip back, MERGED, still one push', async () => {
        const w = world({ promotion: { push: (...args) => { w.defaultPush(...args); return died(); } } });
        await assert.rejects(() => w.service.submit(REQUEST), /process died/u);
        const resumed = await w.build().resume('int-1');
        assert.deepEqual(brief(resumed), { ...merged, code: 'found_on_remote' });
        assert.deepEqual({ pushes: w.pushes(), requests: w.requestIds().length, sleeps: w.sleeps }, { pushes: 1, requests: 1, sleeps: [INTEGRATION_DEFAULTS.settleMs] });
      });
      it('died while validating: the resume uses a NEW quarantine repository, keeps the old path as abandoned, and rebuilds the candidate with the stored identity time', async () => {
        let first = true;
        const w = world({ quarantine: { importBundle: () => { if (first) { first = false; died(); } return { ok: true }; } } });
        await assert.rejects(() => w.service.submit(REQUEST), /process died/u);
        assert.equal(w.record().quarantine.repo, '/fake/quarantine/q-1');
        w.clock.ms += 3_600_000;   // an hour later
        assert.equal((await w.build().resume('int-1')).status, 'merged');
        assert.deepEqual({ repo: w.record().quarantine.repo, abandoned: w.record().quarantine.abandoned }, { repo: '/fake/quarantine/q-2', abandoned: ['/fake/quarantine/q-1'] });
        assert.equal(w.quarantine.calls().find((c) => c.method === 'buildCandidate').args[1].identity.timestamp, NOW_SEC);
        assert.equal(w.promotion.calls().find((c) => c.method === 'push').args[0], '/fake/quarantine/q-2');
      });
    });

    describe('duplicates and races', () => {
      it('same id with other content is integration_conflict and changes nothing', async () => {
        const w = world();
        await w.service.submit(REQUEST);
        const calls = w.quarantine.calls().length;
        const r = await w.service.submit({ ...REQUEST, testPlanDigest: digest('9') });
        assert.deepEqual({ status: r.status, code: r.code }, { status: 'failed', code: 'integration_conflict' });
        assert.equal(w.record().request.testPlanDigest, digest('1'));
        assert.equal(w.quarantine.calls().length, calls);
      });
      it('concurrent calls in one process share one run (submit, submit and resume give the same result object)', async () => {
        const w = world();
        const [a, b, c] = await Promise.all([w.service.submit(REQUEST), w.service.submit(REQUEST), w.service.resume('int-1')]);
        assert.ok(a === b && b === c);
        assert.equal(a.status, 'merged');
        assert.deepEqual({ creates: w.quarantine.calls().filter((x) => x.method === 'create').length, pushes: w.pushes() }, { creates: 1, pushes: 1 });
      });
      it('a concurrent submit with other content waits for the run and then meets the stored request', async () => {
        const w = world();
        const [a, b] = await Promise.all([w.service.submit(REQUEST), w.service.submit({ ...REQUEST, imageDigest: digest('8') })]);
        assert.deepEqual([a.status, b.code], ['merged', 'integration_conflict']);
        assert.equal(w.pushes(), 1);
      });
      it('two instances racing on one journal: the compare-and-set lets one win, the other stops, and exactly one push happens', async () => {
        const w = world();
        const results = await Promise.all([w.build().submit(REQUEST), w.build().submit(REQUEST)]);
        assert.deepEqual(results.map((r) => r.status).sort(), ['merged', 'retryable']);
        assert.equal(results.find((r) => r.status === 'retryable').code, 'journal_conflict');
        assert.equal(w.pushes(), 1);
        assert.equal((await w.build().resume('int-1')).replayed, true);
        assert.equal(w.pushes(), 1);
      });
    });

    describe('the target moves (ADR-007 §4 step 8)', () => {
      it('during verification: STALE before anybody is asked, nothing pushed', async () => {
        const w = world({ verifier: { collect: (r, s) => { w.remote.tip = OTHER; return { state: 'done', evidence: fakeVerifierEvidence(s) }; } } });
        const r = await w.service.submit(REQUEST);
        assert.deepEqual(brief(r), { status: 'stale', phase: 'STALE', code: 'target_moved' });
        assert.deepEqual({ approvals: w.approvals.calls().length, pushes: w.pushes(), state: w.record().candidate.state }, { approvals: 0, pushes: 0, state: 'STALE' });
      });
      it('between the approval and the authorization: target_moved is STALE, nothing pushed', async () => {
        const w = world({ approvals: { status: (r, s) => { w.remote.tip = OTHER; return { ok: true, state: 'decided', approval: fakeHumanApproval(s) }; } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'stale', phase: 'STALE', code: 'target_moved' });
        assert.equal(w.pushes(), 0);
      });
      it('between the authorization and the push: the compare-and-swap loses, STALE, and a resume does not push again', async () => {
        const w = world({ promotion: { push: (repo, update) => { w.remote.tip = OTHER; w.remote.pushes.push(update); return { outcome: 'rejected', code: 'stale' }; } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'stale', phase: 'STALE', code: 'stale' });
        assert.equal((await w.build().resume('int-1')).replayed, true);
        assert.equal(w.pushes(), 1);
      });
      it('a rejected push whose read-back tip IS the candidate is MERGED', async () => {
        const w = world({ promotion: { push: (repo, update) => { w.remote.tip = update.newOid; w.remote.pushes.push(update); return { outcome: 'rejected', code: 'stale' }; } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { ...merged, code: 'found_on_remote' });
        assert.equal(w.record().promotion.rawOutcome, 'rejected');
      });
    });

    describe('the remote refuses or does not answer (ADR-007 §8)', () => {
      it('blocked by the remote\'s own rule: BLOCKED, no resend', async () => {
        const w = world({ promotion: { push: (repo, update) => { w.remote.pushes.push(update); return { outcome: 'blocked', code: 'remote_rule' }; } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'blocked', phase: 'BLOCKED', code: 'remote_rule' });
        assert.equal((await w.build().resume('int-1')).replayed, true);
        assert.equal(w.pushes(), 1);
      });
      it('refused by the adapter before anything was sent: BLOCKED with its code, never retried', async () => {
        const w = world({ promotion: { push: () => { w.remote.pushes.push('attempt'); return { ok: false, code: 'not_fast_forward', outcome: null }; } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'blocked', phase: 'BLOCKED', code: 'not_fast_forward' });
        assert.equal(w.record().promotion.rawOutcome, 'refused');
        await w.build().resume('int-1');
        assert.equal(w.pushes(), 1);
      });
      it('no answer and the push landed: UNKNOWN_PROMOTION, the tip read back is MERGED, one push', async () => {
        const w = world({ promotion: { push: (...args) => { w.defaultPush(...args); return { outcome: 'unknown', code: 'no_answer' }; } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { ...merged, code: 'found_on_remote' });
        assert.ok(phasesOf(w.history).includes('UNKNOWN_PROMOTION'));
        assert.equal(w.pushes(), 1);
      });
      it('no answer and the push did not land: back to VERIFYING, a NEW approval, and only then a second push', async () => {
        let first = true;
        const w = world({ promotion: { push: (...args) => { if (first) { first = false; w.remote.pushes.push('lost'); return { outcome: 'unknown', code: 'no_answer' }; } return w.defaultPush(...args); } } });
        assert.equal((await w.service.submit(REQUEST)).status, 'merged');
        assert.deepEqual(w.requestIds(), ['int-1.v2.a1', 'int-1.v6.a1']);
        assert.equal(w.remote.tip, CAND);
      });
      it('an approval of the previous candidate version is approval_stale after such a retry', async () => {
        let first = true;
        let old;
        const w = world({
          promotion: { push: () => { w.remote.pushes.push('lost'); return { outcome: 'unknown', code: 'no_answer' }; } },
          approvals: { status: (r, s) => { old ??= fakeHumanApproval(s); first = false; return { ok: true, state: 'decided', approval: old }; } },
        });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'failed', phase: 'FAILED', code: 'approval_stale' });
        assert.equal(first, false);
        assert.equal(w.pushes(), 1);
      });
      it('a tip that cannot be read keeps UNKNOWN_PROMOTION and sends nothing, however often it is retried; once readable the tip decides', async () => {
        const w = world({ promotion: { push: (...args) => { w.defaultPush(...args); w.tipDown = true; return { outcome: 'unknown', code: 'no_answer' }; } } });
        for (let i = 0; i < 3; i += 1) {
          const r = i === 0 ? await w.service.submit(REQUEST) : await w.build().resume('int-1');
          assert.deepEqual(brief(r), { status: 'unknown', phase: 'UNKNOWN_PROMOTION', code: 'git_failed' });
        }
        assert.equal(w.pushes(), 1);
        w.tipDown = false;
        assert.deepEqual(brief(await w.build().resume('int-1')), { ...merged, code: 'found_on_remote' });
        assert.equal(w.pushes(), 1);
      });
      it('a rejected push whose tip cannot be read back stays UNKNOWN_PROMOTION', async () => {
        const w = world({ promotion: { push: (repo, update) => { w.remote.pushes.push(update); w.tipDown = true; return { outcome: 'rejected', code: 'stale' }; } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'unknown', phase: 'UNKNOWN_PROMOTION', code: 'git_failed' });
      });
    });

    describe('approvals (INT-02)', () => {
      const decided = (over) => ({ status: (r, s) => ({ ok: true, state: 'decided', approval: fakeHumanApproval(s, over) }) });
      for (const [label, over, phase, code] of [
        ['a denied approval', { decision: 'deny' }, 'DENIED', 'approval_denied'],
        ['an approval from an AI', { decidedBy: { kind: 'agent', id: 'bero' } }, 'FAILED', 'approval_not_human'],
        ['an approval that expired before PROMOTING', { expiresAt: NOW_SEC }, 'EXPIRED', 'approval_expired'],
        ['an approval of another commit', { candidateCommitOid: OTHER }, 'FAILED', 'approval_mismatch'],
        ['an approval of another target tip', { targetTipOid: OTHER }, 'FAILED', 'approval_mismatch'],
      ]) {
        it(`${label}: ${code}, nothing is pushed`, async () => {
          const w = world({ approvals: decided(over) });
          assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: phase.toLowerCase(), phase, code });
          assert.equal(w.pushes(), 0);
          assert.equal(w.record().candidate.state, 'VERIFYING');
        });
      }
      it('stores only the scalar fields of what the approvals returned', async () => {
        const w = world({ approvals: decided({ extra: { deep: [1] }, comprehension: { reviewerId: 'yosuke', basis: 'x', nested: {} } }) });
        await w.service.submit(REQUEST);
        assert.equal(w.record().approval.decision.extra, undefined);
        assert.deepEqual(Object.keys(w.record().approval.decision.comprehension), ['reviewerId', 'basis']);
      });
      it('a request that expires is asked again once; expiring twice is EXPIRED', async () => {
        const w = world({ approvals: { status: { ok: true, state: 'expired' } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'expired', phase: 'EXPIRED', code: 'approval_expired' });
        assert.deepEqual(w.requestIds(), ['int-1.v2.a1', 'int-1.v2.a2']);
        assert.equal(w.record().approval.rounds, 2);
        const second = world({ approvals: { status: [{ ok: true, state: 'expired' }, (r, s) => ({ ok: true, state: 'decided', approval: fakeHumanApproval(s) })] } });
        assert.equal((await second.service.submit(REQUEST)).status, 'merged');
        assert.deepEqual(second.requestIds(), ['int-1.v2.a1', 'int-1.v2.a2']);
      });
      it('waits with backoff while pending; a pending that outlasts maxPolls is an open result and a resume continues', async () => {
        const w = world({ options: { maxPolls: 3 }, approvals: { status: (r, s) => (w.approve ? { ok: true, state: 'decided', approval: fakeHumanApproval(s) } : { ok: true, state: 'pending' }) } });
        const r = await w.service.submit(REQUEST);
        assert.deepEqual(brief(r), { status: 'pending', phase: 'REVIEW_REQUIRED', code: 'approval_pending' });
        assert.deepEqual(w.sleeps, [500, 1000]);
        w.approve = true;
        assert.equal((await w.build().resume('int-1')).status, 'merged');
        assert.deepEqual(w.requestIds(), ['int-1.v2.a1']);
      });
      it('a refused request is retryable and the record keeps its phase', async () => {
        let open = false;
        const w = world({ approvals: { request: () => (open ? { ok: true } : { ok: false, code: 'queue_full' }) } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'retryable', phase: 'REVIEW_REQUIRED', code: 'queue_full' });
        open = true;
        assert.equal((await w.build().resume('int-1')).status, 'merged');
      });
      it('an answer that is none of pending / decided / expired is retryable, never a decision', async () => {
        const w = world({ approvals: { status: { ok: true, state: 'approved' } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'retryable', phase: 'REVIEW_REQUIRED', code: 'approvals_unavailable' });
        assert.equal(w.pushes(), 0);
      });
    });

    describe('verification (INT-01)', () => {
      const evidence = (over) => ({ collect: (r, s) => ({ state: 'done', evidence: fakeVerifierEvidence(s, over) }) });
      for (const [label, over, phase, code] of [
        ['a failed gate', { result: 'failed' }, 'VERIFY_FAILED', 'verification_failed'],
        ['a runner the host did not register', { runnerId: 'rogue-runner' }, 'VERIFY_FAILED', 'evidence_untrusted_runner'],
        ['evidence about another commit', { subjectCommitOid: OTHER }, 'VERIFY_FAILED', 'evidence_commit_mismatch'],
        ['evidence about another tree', { subjectTreeOid: OTHER }, 'VERIFY_FAILED', 'evidence_tree_mismatch'],
        ['evidence under another policy', { policyVersion: 4 }, 'VERIFY_FAILED', 'evidence_policy_mismatch'],
        ['evidence for a gate nobody required', { gate: 'extra' }, 'VERIFY_FAILED', 'evidence_gate_unknown'],
        ['results only the agent reported', { provenance: 'agent_reported' }, 'VERIFY_FAILED', 'evidence_missing'],
      ]) {
        it(`${label}: ${code}, nobody is asked and nothing is pushed`, async () => {
          const w = world({ verifier: evidence(over) });
          assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: phase.toLowerCase(), phase, code });
          assert.deepEqual({ approvals: w.approvals.calls().length, pushes: w.pushes() }, { approvals: 0, pushes: 0 });
        });
      }
      it('agent_reported results are kept as claims and never count, next to evidence that does', async () => {
        const w = world({ verifier: { collect: (r, s) => ({ state: 'done', evidence: [...fakeVerifierEvidence(s), ...fakeVerifierEvidence(s, { provenance: 'agent_reported', evidenceId: 'claim_1', gate: 'e2e' })] }) } });
        assert.equal((await w.service.submit(REQUEST)).status, 'merged');
        assert.deepEqual({ evidence: w.record().verification.evidence.map((e) => e.evidenceId), claims: w.record().verification.claims.map((e) => e.evidenceId) }, { evidence: ['ev_unit'], claims: ['claim_1'] });
      });
      it('a lost run is started again once under a new run id; losing it twice is FAILED verifier_lost', async () => {
        const done = (r, s) => ({ state: 'done', evidence: fakeVerifierEvidence(s) });
        const once = world({ verifier: { collect: [{ state: 'lost' }, done] } });
        assert.equal((await once.service.submit(REQUEST)).status, 'merged');
        assert.deepEqual({ runs: once.runIds(), count: once.record().verification.runs }, { runs: ['int-1.v2.r1', 'int-1.v2.r2'], count: 2 });
        const twice = world({ verifier: { collect: { state: 'lost' } } });
        assert.deepEqual(brief(await twice.service.submit(REQUEST)), { status: 'failed', phase: 'FAILED', code: 'verifier_lost' });
        assert.equal(twice.runIds().length, 2);
        assert.equal(twice.approvals.calls().length, 0);
      });
      it('polls a running verifier with backoff; running past maxPolls is an open result and a resume collects with the same run id', async () => {
        const w = world({ options: { maxPolls: 3 }, verifier: { collect: (r, s) => (w.verified ? { state: 'done', evidence: fakeVerifierEvidence(s) } : { state: 'running' }) } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'pending', phase: 'VERIFYING', code: 'verification_running' });
        assert.deepEqual(w.sleeps, [500, 1000]);
        w.verified = true;
        assert.equal((await w.build().resume('int-1')).status, 'merged');
        assert.deepEqual(new Set(w.runIds()), new Set(['int-1.v2.r1']));
      });
      it('a verifier that does not start, or answers nonsense, is retryable; an evidence list that is not a list is FAILED', async () => {
        let up = false;
        const w = world({ verifier: { start: () => (up ? { ok: true } : { ok: false, code: 'no_capacity' }) } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'retryable', phase: 'VERIFYING', code: 'no_capacity' });
        up = true;
        assert.equal((await w.build().resume('int-1')).status, 'merged');
        assert.deepEqual(brief(await world({ verifier: { collect: { state: 'weird' } } }).service.submit(REQUEST)), { status: 'retryable', phase: 'VERIFYING', code: 'verifier_unavailable' });
        assert.deepEqual(brief(await world({ verifier: { collect: { state: 'done', evidence: 'passed' } } }).service.submit(REQUEST)), { status: 'failed', phase: 'FAILED', code: 'verifier_response_invalid' });
        assert.equal((await world({ options: { maxEvidence: 2 }, verifier: { collect: (r, s) => ({ state: 'done', evidence: [...fakeVerifierEvidence(s), ...fakeVerifierEvidence(s), ...fakeVerifierEvidence(s)] }) } }).service.submit(REQUEST)).code, 'verifier_response_invalid');
      });
    });

    describe('quarantine and target', () => {
      for (const [method, code, phase] of [
        ['importBundle', 'oid_mismatch', 'REJECTED'], ['importBundle', 'bundle_invalid', 'REJECTED'], ['inspect', 'not_descendant', 'REJECTED'], ['inspect', 'symlink', 'REJECTED'],
        ['inspect', 'path_forbidden', 'REJECTED'], ['buildCandidate', 'base_mismatch', 'REJECTED'], ['buildCandidate', 'conflicted', 'CONFLICTED'], ['buildCandidate', 'request_invalid', 'FAILED'],
      ]) {
        it(`${method} says ${code}: ${phase}, the verifier is never called`, async () => {
          const w = world({ quarantine: { [method]: { ok: false, code } } });
          const r = await w.service.submit(REQUEST);
          assert.deepEqual([r.status, r.phase, r.code], [phase.toLowerCase(), phase, code === 'request_invalid' ? 'quarantine_request_invalid' : code]);
          assert.deepEqual({ verifier: w.verifier.calls().length, approvals: w.approvals.calls().length, pushes: w.pushes() }, { verifier: 0, approvals: 0, pushes: 0 });
        });
      }
      it('every submission is imported and inspected; the second one refused rejects the whole integration', async () => {
        const request = { ...REQUEST, submissions: [REQUEST.submissions[0], { ...REQUEST.submissions[0], submissionId: 'sub_102', resultCommitOid: OTHER }] };
        const w = world({ quarantine: { inspect: (repo, a) => (a.resultOid === OTHER ? { ok: false, code: 'symlink' } : { ok: true }) } });
        assert.deepEqual(brief(await w.service.submit(request)), { status: 'rejected', phase: 'REJECTED', code: 'symlink' });
        assert.deepEqual(w.quarantine.calls().map((c) => c.method), ['create', 'importBundle', 'inspect', 'importBundle', 'inspect']);
      });
      it('git trouble is retryable and the resume goes on', async () => {
        let broken = true;
        const w = world({ quarantine: { importBundle: () => (broken ? { ok: false, code: 'git_failed' } : { ok: true }) } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'retryable', phase: 'VALIDATING', code: 'git_failed' });
        broken = false;
        assert.equal((await w.build().resume('int-1')).status, 'merged');
      });
      it('a candidate the contract cannot freeze is FAILED with the contract\'s own code', async () => {
        const w = world({ quarantine: { buildCandidate: { ok: true, candidateCommitOid: TIP, candidateTreeOid: TREE } } });
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'failed', phase: 'FAILED', code: 'invalid_candidate_candidateCommitOid' });
      });
      it('fetches the registered target tip into the new quarantine repository before any bundle is imported, and freezes the candidate on the tip it fetched', async () => {
        const order = [];
        const w = world({
          quarantine: { importBundle: () => { order.push('importBundle'); return { ok: true }; }, buildCandidate: () => { order.push('buildCandidate'); return { ok: true, candidateCommitOid: CAND, candidateTreeOid: TREE }; } },
          promotion: { fetchTip: () => { order.push('fetchTip'); return { ok: true, oid: TIP }; } },
        });
        const r = await w.service.submit(REQUEST);
        assert.equal(r.status, 'merged');
        assert.deepEqual(order, ['fetchTip', 'importBundle', 'buildCandidate']);
        assert.deepEqual(w.promotion.calls().find((c) => c.method === 'fetchTip').args, ['/fake/quarantine/q-1', { repositoryId: 'repo_001', ref: MAIN }]);
        assert.equal(w.record().candidate.targetTipOid, TIP);
      });
      it('a fetch that fails: a configuration problem is FAILED, a tip that moved or a git failure is retryable, and no bundle is imported either way', async () => {
        for (const [code, expected] of [['remote_unknown', ['failed', 'FAILED']], ['ref_not_promotable', ['failed', 'FAILED']], ['target_missing', ['failed', 'FAILED']],
          ['target_moved', ['retryable', 'VALIDATING']], ['git_failed', ['retryable', 'VALIDATING']]]) {
          const w = world({ promotion: { fetchTip: { ok: false, code } } });
          const r = await w.service.submit(REQUEST);
          assert.deepEqual([r.status, r.phase, r.code], [...expected, code], code);
          assert.deepEqual({ imports: w.quarantine.calls().filter((c) => c.method === 'importBundle').length, verifier: w.verifier.calls().length, pushes: w.pushes() }, { imports: 0, verifier: 0, pushes: 0 });
        }
      });
      it('an answer that is not an oid is not used: retryable, nothing is built', async () => {
        for (const reply of [{ ok: true, oid: 'main' }, { ok: true, oid: null }, { ok: true }, undefined, { ok: false, code: 'not a code!' }]) {
          const w = world({ promotion: { fetchTip: reply } });
          const r = await w.service.submit(REQUEST);
          assert.deepEqual([r.status, r.code], ['retryable', 'tip_unreadable'], JSON.stringify(reply));
          assert.equal(w.quarantine.calls().some((c) => c.method === 'buildCandidate'), false);
        }
      });
      it('a target that moves after the fetch is STALE as always: the candidate was frozen on the fetched tip, the live tip is checked again before anybody is asked', async () => {
        const w = world({ promotion: { fetchTip: () => { const fetched = { ok: true, oid: w.remote.tip }; w.remote.tip = OTHER; return fetched; } } });
        const r = await w.service.submit(REQUEST);
        assert.deepEqual(brief(r), { status: 'stale', phase: 'STALE', code: 'target_moved' });
        assert.equal(w.record().candidate.targetTipOid, TIP);
        assert.deepEqual({ approvals: w.approvals.calls().length, pushes: w.pushes() }, { approvals: 0, pushes: 0 });
      });
      it('a target ref that does not exist or is not registered is FAILED; an unreadable tip is retryable', async () => {
        assert.deepEqual(brief(await world({ promotion: { readTip: { ok: true, oid: null } } }).service.submit(REQUEST)), { status: 'failed', phase: 'FAILED', code: 'target_missing' });
        assert.equal((await world({ promotion: { readTip: { ok: false, code: 'remote_unknown' } } }).service.submit(REQUEST)).code, 'remote_unknown');
        assert.deepEqual(brief(await world({ promotion: { readTip: { ok: false, code: 'git_failed' } } }).service.submit(REQUEST)), { status: 'retryable', phase: 'VALIDATING', code: 'git_failed' });
      });
    });

    describe('a journal record edited on disk is not believed', () => {
      /** Rewrites fields of the stored record the way somebody with write access to the journal would (the store owns the revision). */
      const tamper = (w, change) => { const rec = w.record(); w.journal.advance(rec.operationId, rec.revision, [rec.phase], change(rec)); };
      /** An integration waiting for a person (REVIEW_REQUIRED); `w.approve = true` lets the next service instance see an approval. */
      const waiting = (over = {}, request = REQUEST) => {
        const w = world({ options: { maxPolls: 1 }, approvals: { status: (r, s) => (w.approve ? { ok: true, state: 'decided', approval: fakeHumanApproval(s) } : { ok: true, state: 'pending' }) }, ...over });
        return w.service.submit(request).then((r) => { assert.equal(r.phase, 'REVIEW_REQUIRED'); return w; });
      };
      const resumeApproved = async (w) => { w.approve = true; return w.build().resume('int-1'); };
      const refused = (r) => assert.deepEqual([r.status, r.code], ['failed', 'record_mismatch']);

      it('a lowered risk on the candidate: record_mismatch, no comprehension check is skipped and nothing is pushed', async () => {
        const w = await waiting({}, { ...REQUEST, risk: 'medium' });
        tamper(w, (rec) => ({ candidate: { ...rec.candidate, risk: 'low' } }));
        refused(await resumeApproved(w));
        assert.equal(w.pushes(), 0);
        assert.equal(w.record().phase, 'FAILED');
      });
      it('a lowered risk on the request has the same result', async () => {
        const w = await waiting({}, { ...REQUEST, risk: 'medium' });
        tamper(w, (rec) => ({ request: { ...rec.request, risk: 'low' } }));
        refused(await resumeApproved(w));
        assert.equal(w.pushes(), 0);
      });
      it('removed required gates: record_mismatch, nothing is pushed', async () => {
        const w = await waiting({}, { ...REQUEST, requiredGates: ['unit', 'lint'] });
        tamper(w, (rec) => ({ candidate: { ...rec.candidate, requiredGates: ['unit'] } }));
        refused(await resumeApproved(w));
        assert.equal(w.pushes(), 0);
      });
      it('another digest, a request that is no request, and a candidate in a state its phase cannot have', async () => {
        const digestTampered = await waiting();
        tamper(digestTampered, (rec) => ({ candidate: { ...rec.candidate, imageDigest: digest('9') } }));
        refused(await resumeApproved(digestTampered));
        const notARequest = await waiting();
        tamper(notARequest, (rec) => ({ request: { ...rec.request, risk: 'none' } }));
        refused(await resumeApproved(notARequest));
        assert.equal(notARequest.record().phase, 'REVIEW_REQUIRED', 'nothing valid to record against: the record is left as found');
        const wrongState = await waiting();
        tamper(wrongState, (rec) => ({ candidate: { ...rec.candidate, state: 'PREPARED' } }));
        refused(await resumeApproved(wrongState));
        assert.equal(digestTampered.pushes() + notARequest.pushes() + wrongState.pushes(), 0);
      });
      it('evidence planted before the verifier ran (another commit, an unregistered runner) does not count: the verifier is still asked and nobody is approached', async () => {
        for (const planted of [{ subjectCommitOid: OTHER }, { runnerId: 'rogue-runner' }]) {
          const w = world({ options: { maxPolls: 1 }, verifier: { collect: { state: 'running' } } });
          assert.equal((await w.service.submit(REQUEST)).phase, 'VERIFYING');
          tamper(w, (rec) => ({ verification: { ...rec.verification, evidence: fakeVerifierEvidence(rec.candidate, planted) } }));
          const r = await w.build().resume('int-1');
          assert.deepEqual([r.status, r.phase], ['pending', 'VERIFYING'], JSON.stringify(planted));
          assert.deepEqual({ approvals: w.approvals.calls().length, pushes: w.pushes(), starts: w.runIds().length }, { approvals: 0, pushes: 0, starts: 2 });
        }
      });
      it('stored evidence swapped for evidence of another commit while a person is deciding: not_verified, nothing is pushed', async () => {
        const w = await waiting();
        tamper(w, (rec) => ({ verification: { ...rec.verification, evidence: fakeVerifierEvidence(rec.candidate, { subjectCommitOid: OTHER }) } }));
        const r = await resumeApproved(w);
        assert.deepEqual([r.status, r.code], ['failed', 'not_verified']);
        assert.equal(w.pushes(), 0);
      });
      it('a changed authorization while PROMOTING is recorded: the resume refuses it and pushes nothing', async () => {
        const w = world({ promotion: { push: died } });
        await assert.rejects(() => w.service.submit(REQUEST), /process died/u);
        tamper(w, (rec) => ({ authorization: { ...rec.authorization, update: { ...rec.authorization.update, newOid: OTHER } } }));
        refused(await w.build().resume('int-1'));
        assert.deepEqual({ pushes: w.pushes(), sleeps: w.sleeps }, { pushes: 0, sleeps: [] });
      });
    });

    describe('how long an approval may last', () => {
      const lasting = (seconds, options) => world({ options, approvals: { status: (r, s) => ({ ok: true, state: 'decided', approval: fakeHumanApproval(s, { expiresAt: NOW_SEC + seconds }) }) } });
      it('15 minutes from now is the default limit: exactly 15 minutes merges, one second more is approval_lifetime_exceeded and nothing is pushed', async () => {
        assert.equal(INTEGRATION_DEFAULTS.maxApprovalLifetimeMs, 15 * 60 * 1000);
        assert.equal((await lasting(900).service.submit(REQUEST)).status, 'merged');
        const w = lasting(901);
        assert.deepEqual(brief(await w.service.submit(REQUEST)), { status: 'failed', phase: 'FAILED', code: 'approval_lifetime_exceeded' });
        assert.deepEqual({ pushes: w.pushes(), decision: w.record().approval.decision.expiresAt }, { pushes: 0, decision: NOW_SEC + 901 });
      });
      it('the limit is an option, and a port that answers with an enormous expiry cannot stretch it', async () => {
        assert.equal((await lasting(61, { maxApprovalLifetimeMs: 60_000 }).service.submit(REQUEST)).code, 'approval_lifetime_exceeded');
        assert.equal((await lasting(60, { maxApprovalLifetimeMs: 60_000 }).service.submit(REQUEST)).status, 'merged');
        assert.equal((await lasting(4_000_000_000).service.submit(REQUEST)).code, 'approval_lifetime_exceeded');
      });
    });

    describe('requests and construction', () => {
      it('a malformed request is refused before anything is recorded', async () => {
        const w = world();
        const sub = REQUEST.submissions[0];
        for (const bad of [
          null, 'x', { ...REQUEST, extra: 1 }, { ...REQUEST, integrationId: 'x'.repeat(65) }, { ...REQUEST, integrationId: 'a/b' }, { ...REQUEST, risk: 'none' }, { ...REQUEST, submissions: [] },
          { ...REQUEST, submissions: [{ ...sub, baseCommitOid: 'abc' }] }, { ...REQUEST, submissions: [{ ...sub, bundlePath: '' }] }, { ...REQUEST, submissions: [{ ...sub, extra: 1 }] },
          { ...REQUEST, targetRef: 'main' }, { ...REQUEST, requiredGates: [] }, { ...REQUEST, policyVersion: 0 },
        ]) {
          assert.deepEqual(brief(await w.service.submit(bad)), { status: 'failed', phase: undefined, code: 'invalid_request' }, JSON.stringify(bad));
        }
        assert.equal(w.record(), null);
        assert.equal((await w.service.resume('a/b')).code, 'invalid_request');
        assert.equal((await w.service.resume('nobody')).code, 'unknown_integration');
        assert.equal(w.quarantine.calls().length, 0);
      });
      it('a journal that fails to write stops before the next effect', async () => {
        const w = world();
        const broken = { begin: (r) => w.journal.begin(r), get: (id) => w.journal.get(id), advance: () => { throw new Error('disk full'); } };
        const svc = w.build({ journal: broken });
        assert.deepEqual(brief(await svc.submit(REQUEST)), { status: 'retryable', phase: undefined, code: 'journal_error' });
        assert.equal(w.verifier.calls().length, 0);
      });
    });
  });
}

describe('constants and construction', () => {
  it('waits for a possibly in-flight push as long as git can run, plus 5 s', () => {
    assert.equal(INTEGRATION_DEFAULTS.settleMs, TIMEOUT_MS + 5000);
  });
  it('lists phases and statuses, frozen, with every terminal phase as a status', () => {
    assert.ok(Object.isFrozen(INTEGRATION_PHASES) && Object.isFrozen(INTEGRATION_STATUSES) && Object.isFrozen(INTEGRATION_DEFAULTS));
    assert.equal(INTEGRATION_PHASES.includes('APPROVED'), false, 'APPROVED is never recorded alone');
    for (const s of ['merged', 'stale', 'blocked', 'rejected', 'conflicted', 'verify_failed', 'denied', 'expired', 'failed', 'pending', 'retryable', 'unknown']) assert.ok(INTEGRATION_STATUSES.includes(s), s);
  });
  it('requires every port, a non-empty trusted runner list, an identity and valid options', () => {
    const w = makeWorld(createMemoryFlowJournal());
    const ok = { quarantine: w.quarantine, promotion: w.promotion, verifier: w.verifier, approvals: w.approvals, journal: w.journal, now: () => NOW_MS, sleep: async () => {}, trustedRunners: ['r'], identity: IDENTITY };
    assert.doesNotThrow(() => createIntegrationService(ok));
    for (const over of [{ quarantine: {} }, { promotion: undefined }, { verifier: {} }, { approvals: null }, { journal: {} }, { now: undefined }, { sleep: 1 }, { trustedRunners: [] }, { trustedRunners: undefined }, { identity: null }]) {
      assert.throws(() => createIntegrationService({ ...ok, ...over }), /invalid_integration_dependencies/u, JSON.stringify(Object.keys(over)));
    }
    for (const options of [{ maxPolls: 0 }, { settleMs: -1 }, { pollFactor: 0.5 }, { surprise: 1 }, { maxVerifierReruns: -1 }]) assert.throws(() => createIntegrationService({ ...ok, options }), /invalid_integration_options/u);
    assert.throws(() => createIntegrationService(), /invalid_integration_dependencies/u);
  });
});

const sqliteDir = { root: null, store: null, raw: null };
before(async () => {
  sqliteDir.root = await mkdtemp(path.join(os.homedir(), '.albera-integration-journal-test-'));
  sqliteDir.store = await openSqliteEnvironmentStore(path.join(sqliteDir.root, 'shared.sqlite'), { verifyWindowsAcl: async () => {} });
  sqliteDir.raw = new DatabaseSync(path.join(sqliteDir.root, 'shared.sqlite'));
});
after(async () => {
  sqliteDir.raw?.close();
  sqliteDir.store?.close();
  if (sqliteDir.root) await rm(sqliteDir.root, { recursive: true, force: true });
});

defineSuite('memory journal', () => createMemoryFlowJournal());
defineSuite('SQLite journal', () => {
  sqliteDir.raw.exec('DELETE FROM flow_operations');   // every test starts with an empty journal on the one shared database
  return sqliteDir.store.flowJournal();
});

describe('real git quarantine and promotion adapters (local bare repositories; synthetic verifier and approvals)', () => {
  const gitPath = path.resolve(execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/u).find((l) => l.trim()).trim());
  const work = mkdtempSync(path.join(tmpdir(), 'albera-integration-service-'));
  const guest = path.join(work, 'guest');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'none.gitconfig'), GIT_AUTHOR_NAME: 'g', GIT_AUTHOR_EMAIL: 'g@x.invalid', GIT_COMMITTER_NAME: 'g', GIT_COMMITTER_EMAIL: 'g@x.invalid' };
  const g = (...args) => execFileSync('git', ['-C', guest, ...args], { env, encoding: 'utf8' }).trim();
  const remoteGit = (url, ...args) => execFileSync('git', ['--git-dir', url, ...args], { env, encoding: 'utf8' }).trim();
  let base; let task; let ahead; let bundle; let remotes = 0;
  before(() => {
    writeFileSync(path.join(work, 'none.gitconfig'), '');
    execFileSync('git', ['init', '-q', '-b', 'main', guest], { env });
    writeFileSync(path.join(guest, 'a.txt'), 'one\n'); g('add', '-A'); g('commit', '-q', '-m', 'base'); base = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'task'); mkdirSync(path.join(guest, 'src')); writeFileSync(path.join(guest, 'src', 'b.txt'), 'two\n'); g('add', '-A'); g('commit', '-q', '-m', 'task'); task = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'ahead', base); writeFileSync(path.join(guest, 'c.txt'), 'host\n'); g('add', '-A'); g('commit', '-q', '-m', 'host moved on'); ahead = g('rev-parse', 'HEAD');
    // What a real guest hands over: ONLY its own commits on top of its base (`base` is a prerequisite, not part of the bundle). The target tip is never in it.
    bundle = path.join(work, 'guest.bundle');
    g('bundle', 'create', '-q', bundle, 'task', `^${base}`);
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  /** A fresh protected remote at `tip` (the guest's base unless said), and a service whose ports are the real adapters (verifier and approvals stay fakes). */
  function realWorld(quarantineWrap = (q) => q, promotionWrap = (p) => p, tip = base) {
    const url = path.join(work, `remote-${(remotes += 1)}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', url], { env });
    g('push', '-q', url, `${tip}:${MAIN}`);
    const clock = { ms: NOW_MS };
    const quarantine = quarantineWrap(createGitQuarantine({ git: gitPath, root: path.join(work, `q-${remotes}`) }));
    const promotion = promotionWrap(createGitPromotion({ git: gitPath, root: path.join(work, `p-${remotes}`), remotes: { repo_001: { url, refs: [MAIN] } } }));
    const verifier = createFakeIntegrationVerifier();
    const approvals = createFakeIntegrationApprovals();
    const journal = createMemoryFlowJournal();
    const build = () => createIntegrationService({ quarantine, promotion, verifier, approvals, journal, now: () => clock.ms, sleep: async () => {}, trustedRunners: ['trusted-verifier-01'], identity: IDENTITY });
    const request = { ...REQUEST, submissions: [{ submissionId: 'sub_101', bundlePath: bundle, ref: 'refs/heads/task', baseCommitOid: base, resultCommitOid: task }] };
    return { url, clock, build, request, journal, verifier };
  }

  it('merges: the remote main becomes the candidate, a merge of the old tip and the submission', async () => {
    const x = realWorld();
    const r = await x.build().submit(x.request);
    assert.deepEqual(brief(r), { ...merged, code: 'fast_forward' });
    assert.equal(remoteGit(x.url, 'rev-parse', MAIN), r.candidateCommitOid);
    assert.equal(remoteGit(x.url, 'rev-list', '--parents', '-n', '1', MAIN), `${r.candidateCommitOid} ${base} ${task}`);
    assert.equal((await x.build().submit(x.request)).replayed, true);
    assert.equal(remoteGit(x.url, 'rev-list', '--count', MAIN), '3');
  });
  it('the guest bundle carries only the guest commits: it does not verify in an empty repository, so the tip and the base can only come from the host', () => {
    const empty = path.join(work, 'empty.git');
    execFileSync('git', ['init', '-q', '--bare', empty], { env });
    assert.throws(() => execFileSync('git', ['--git-dir', empty, 'bundle', 'verify', bundle], { env, stdio: 'pipe' }));
    assert.equal(g('rev-list', '--count', `${base}..${task}`), '1');
  });
  it('merges onto a target tip that is ahead of the guest base: the tip is fetched from the registered remote, the candidate is a merge of it and the submission', async () => {
    const x = realWorld(undefined, undefined, ahead);
    const r = await x.build().submit(x.request);
    assert.deepEqual(brief(r), { ...merged, code: 'fast_forward' });
    assert.equal(remoteGit(x.url, 'rev-parse', MAIN), r.candidateCommitOid);
    assert.equal(remoteGit(x.url, 'rev-list', '--parents', '-n', '1', MAIN), `${r.candidateCommitOid} ${ahead} ${task}`);
    assert.equal(remoteGit(x.url, 'rev-list', '--count', MAIN), '4');
    assert.equal(x.journal.get('integration/int-1').candidate.targetTipOid, ahead);
  });
  it('a crash between the fetch of the tip and the record of the candidate: the resume fetches again into a NEW repository and merges once', async () => {
    const fetched = [];
    let first = true;
    const x = realWorld(undefined, (p) => ({ ...p, fetchTip: async (...args) => { const r = await p.fetchTip(...args); fetched.push({ repo: args[0], oid: r.oid }); if (first) { first = false; died(); } return r; } }), ahead);
    await assert.rejects(() => x.build().submit(x.request), /process died/u);
    assert.equal(x.journal.get('integration/int-1').phase, 'VALIDATING');
    assert.equal(remoteGit(x.url, 'rev-parse', MAIN), ahead);
    const r = await x.build().resume('int-1');
    assert.equal(r.status, 'merged');
    assert.equal(fetched.length, 2);
    assert.notEqual(fetched[0].repo, fetched[1].repo);
    assert.deepEqual([fetched[0].oid, fetched[1].oid], [ahead, ahead]);
    assert.deepEqual(x.journal.get('integration/int-1').quarantine.abandoned, [fetched[0].repo]);
    assert.equal(remoteGit(x.url, 'rev-list', '--parents', '-n', '1', MAIN), `${r.candidateCommitOid} ${ahead} ${task}`);
    assert.equal(remoteGit(x.url, 'rev-list', '--count', MAIN), '4');
  });
  it('a target that cannot be read while fetching is retryable and nothing is imported; the resume goes on', async () => {
    let down = true;
    const x = realWorld(undefined, (p) => ({ ...p, fetchTip: async (...args) => (down ? { ok: false, code: 'git_failed' } : p.fetchTip(...args)) }));
    assert.deepEqual(brief(await x.build().submit(x.request)), { status: 'retryable', phase: 'VALIDATING', code: 'git_failed' });
    down = false;
    assert.equal((await x.build().resume('int-1')).status, 'merged');
  });
  it('a crash after the candidate was built: the resume rebuilds in a NEW repository, an hour later, and gets the very same commit', async () => {
    const built = [];
    let first = true;
    const x = realWorld((q) => ({ ...q, buildCandidate: async (...args) => { const r = await q.buildCandidate(...args); built.push({ repo: args[0], oid: r.candidateCommitOid }); if (first) { first = false; died(); } return r; } }));
    await assert.rejects(() => x.build().submit(x.request), /process died/u);
    x.clock.ms += 3_600_000;
    const r = await x.build().resume('int-1');
    assert.equal(r.status, 'merged');
    assert.equal(built.length, 2);
    assert.notEqual(built[0].repo, built[1].repo);
    assert.equal(built[0].oid, built[1].oid);
    assert.equal(remoteGit(x.url, 'rev-parse', MAIN), built[1].oid);
  });
  it('a hostile submission is REJECTED by the real quarantine and the remote never moves', async () => {
    const x = realWorld();
    const r = await x.build().submit({ ...x.request, submissions: [{ ...x.request.submissions[0], resultCommitOid: base }] });   // the bundle's task ref is not that commit
    assert.deepEqual([r.status, r.code], ['rejected', 'oid_mismatch']);
    assert.equal(remoteGit(x.url, 'rev-parse', MAIN), base);
    assert.equal(x.verifier.calls().length, 0);
  });
});
