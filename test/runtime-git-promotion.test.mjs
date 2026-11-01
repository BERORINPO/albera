import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFakeGitPromotion } from '../src/runtime/fake-git-promotion.mjs';
import { runGitProcess } from '../src/runtime/git-process.mjs';
import { createGitPromotion, pushOutcome } from '../src/runtime/git-promotion.mjs';
import { createGitQuarantine } from '../src/runtime/git-quarantine.mjs';
import {
  authorizePromotion, beginPromotion, freezeCandidate, markApproved, reconcilePromotion, recordPromotion, startVerification,
} from '../src/runtime/integration-candidate.mjs';

// Promotion of an approved candidate (ADR-007 §5, §8; INT-02) against REAL git in temporary folders. The "protected remote" is a local bare
// repository; the candidate is built by the real quarantine from a guest bundle. Synthetic: no network remote, no credentials, no hosting service's
// branch protection (a pre-receive hook stands in for the remote's own rules).
const gitPath = (() => {
  const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/u).find((l) => l.trim());
  return path.resolve(out.trim());
})();
const work = mkdtempSync(path.join(tmpdir(), 'albera-git-promotion-'));
const guest = path.join(work, 'guest');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'none.gitconfig'), GIT_AUTHOR_NAME: 'g', GIT_AUTHOR_EMAIL: 'g@x.invalid', GIT_COMMITTER_NAME: 'g', GIT_COMMITTER_EMAIL: 'g@x.invalid' };
const g = (...args) => execFileSync('git', ['-C', guest, ...args], { env, encoding: 'utf8' }).trim();
const file = (rel, text) => { const p = path.join(guest, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };
const commitAll = (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
const MAIN = 'refs/heads/main';
const IDENTITY = Object.freeze({ name: 'ALBERA Integration', email: 'integration@albera.invalid', timestamp: 1_800_000_000 });
const NOW = 1_800_000_000;

let base; let task; let other; let repo; let candidate; let tree; let remotes = 0;
before(async () => {
  writeFileSync(path.join(work, 'none.gitconfig'), '');
  execFileSync('git', ['init', '-q', '-b', 'main', guest], { env });
  file('a.txt', 'one\n'); base = commitAll('base');
  g('checkout', '-q', '-b', 'task'); file('a.txt', 'one\ntwo\n'); task = commitAll('task');
  g('checkout', '-q', '-b', 'other', base); file('c.txt', 'c\n'); other = commitAll('other');
  g('checkout', '-q', 'main');
  const bundle = path.join(work, 'guest.bundle');
  g('bundle', 'create', '-q', bundle, 'main', 'task', 'other');
  const q = createGitQuarantine({ git: gitPath, root: path.join(work, 'q') });
  repo = await q.create();
  for (const [ref, oid] of [['main', base], ['task', task], ['other', other]]) assert.deepEqual(await q.importBundle(repo, { bundlePath: bundle, ref: `refs/heads/${ref}`, expectedOid: oid }), { ok: true });
  const built = await q.buildCandidate(repo, { targetOid: base, submissions: [{ baseOid: base, resultOid: task }], identity: IDENTITY });
  assert.equal(built.ok, true);
  candidate = built.candidateCommitOid; tree = built.candidateTreeOid;
});
after(() => rmSync(work, { recursive: true, force: true }));

/** A fresh protected remote whose main is `tip` (the guest pushes it there, as an ordinary host checkout would have). */
function freshRemote(tip = base) {
  const url = path.join(work, `remote-${(remotes += 1)}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', url], { env });
  g('push', '-q', url, `${tip}:${MAIN}`);
  return url;
}
const remoteTip = (url) => execFileSync('git', ['--git-dir', url, 'rev-parse', MAIN], { env, encoding: 'utf8' }).trim();
const promotion = (url, over = {}) => createGitPromotion({ git: gitPath, root: path.join(work, 'p'), remotes: { repo_001: { url, refs: [MAIN, 'refs/heads/absent'] } }, ...over });
const update = (over = {}) => ({ repositoryId: 'repo_001', ref: MAIN, expectedOldOid: base, newOid: candidate, ...over });

describe('readTip', () => {
  it('reads the registered ref of the registered remote; a ref that does not exist reads as null', async () => {
    const url = freshRemote();
    const p = promotion(url);
    assert.deepEqual(await p.readTip({ repositoryId: 'repo_001', ref: MAIN }), { ok: true, oid: base });
    assert.deepEqual(await p.readTip({ repositoryId: 'repo_001', ref: 'refs/heads/absent' }), { ok: true, oid: null });
  });
  it('refuses a repository or ref the host did not register, and malformed requests', async () => {
    const p = promotion(freshRemote());
    assert.deepEqual(await p.readTip({ repositoryId: 'repo_999', ref: MAIN }), { ok: false, code: 'remote_unknown' });
    assert.deepEqual(await p.readTip({ repositoryId: 'repo_001', ref: 'refs/heads/dev' }), { ok: false, code: 'ref_not_promotable' });
    assert.deepEqual(await p.readTip({ repositoryId: 'constructor', ref: MAIN }), { ok: false, code: 'remote_unknown' });
    for (const ref of ['main', 'refs/tags/v1', 'refs/heads/a..b', 'refs/heads/x.lock', undefined]) {
      assert.deepEqual(await p.readTip({ repositoryId: 'repo_001', ref }), { ok: false, code: 'request_invalid' }, String(ref));
    }
  });
  it('a remote that cannot be read is git_failed, not an empty ref', async () => {
    const p = promotion(path.join(work, 'missing.git'));
    assert.deepEqual(await p.readTip({ repositoryId: 'repo_001', ref: MAIN }), { ok: false, code: 'git_failed' });
  });
});

describe('push: a fast-forward compare-and-swap only', () => {
  it('moves the ref from the approved old tip to the candidate', async () => {
    const url = freshRemote();
    assert.deepEqual(await promotion(url).push(repo, update()), { outcome: 'updated', code: 'fast_forward' });
    assert.equal(remoteTip(url), candidate);
  });
  it('refuses, as stale, when the remote tip moved after the approval (it does not overwrite the newer tip)', async () => {
    const url = freshRemote(other);   // someone promoted `other` meanwhile; `other` is not an ancestor of the candidate
    assert.deepEqual(await promotion(url).push(repo, update()), { outcome: 'rejected', code: 'stale' });
    assert.equal(remoteTip(url), other);
  });
  it('refuses, as stale, even when the newer tip is an ancestor of the candidate (the approval named another old tip)', async () => {
    const url = freshRemote(task);   // the candidate descends from task, so a plain push would fast-forward: the lease still refuses it
    assert.deepEqual(await promotion(url).push(repo, update()), { outcome: 'rejected', code: 'stale' });
    assert.equal(remoteTip(url), task);
  });
  it('sends nothing when the new commit does not descend from the old tip (no forced update, ever)', async () => {
    const url = freshRemote(other);
    assert.deepEqual(await promotion(url).push(repo, update({ expectedOldOid: other })), { ok: false, code: 'not_fast_forward', outcome: null });
    assert.equal(remoteTip(url), other);
  });
  it("the remote's own rule refuses (its pre-receive hook) -> blocked, and the ref stays", async () => {
    const url = freshRemote();
    const hook = path.join(url, 'hooks', 'pre-receive');
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\necho "protected: needs review" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    assert.deepEqual(await promotion(url).push(repo, update()), { outcome: 'blocked', code: 'remote_rule' });
    assert.equal(remoteTip(url), base);
  });
  it("runs no hook of the pushing repository (a planted pre-push hook does not run)", async () => {
    const marker = path.join(work, 'pre-push-ran');
    const hook = path.join(repo, 'hooks', 'pre-push');
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\nexit 0\n`);
    chmodSync(hook, 0o755);
    try {
      const url = freshRemote();
      assert.equal((await promotion(url).push(repo, update())).outcome, 'updated');
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(hook, { force: true });
    }
  });
  it('refuses unregistered targets and malformed requests without running git', async () => {
    const calls = [];
    const p = promotion(path.join(work, 'unused.git'), { run: async (...a) => { calls.push(a); return { code: 0, stdout: '', stderr: '' }; } });
    assert.deepEqual(await p.push(repo, update({ repositoryId: 'repo_2' })), { ok: false, code: 'remote_unknown', outcome: null });
    assert.deepEqual(await p.push(repo, update({ ref: 'refs/heads/dev' })), { ok: false, code: 'ref_not_promotable', outcome: null });
    for (const [label, args] of [
      ['same old and new', [repo, update({ newOid: base })]], ['a relative repository', ['q/repo', update()]], ['a short oid', [repo, update({ newOid: candidate.slice(0, 12) })]],
      ['an uppercase oid', [repo, update({ expectedOldOid: base.toUpperCase() })]], ['a tag ref', [repo, update({ ref: 'refs/tags/v1' })]], ['nothing', [repo]],
    ]) {
      assert.deepEqual(await p.push(...args), { ok: false, code: 'request_invalid', outcome: null }, label);
    }
    assert.equal(calls.length, 0);
  });
  it('passes the lease, the single refspec and the hardening to git', async () => {
    const seen = [];
    const run = async (file, args) => { seen.push({ file, args }); return { code: 0, stdout: `To x\n \t${candidate}:${MAIN}\tabc..def\nDone\n`, stderr: '' }; };
    const url = path.join(work, 'shape.git');
    assert.equal((await promotion(url, { run }).push(repo, update())).outcome, 'updated');
    const pushed = seen.find((s) => s.args.includes('push'));
    assert.equal(pushed.file, gitPath);
    const tail = pushed.args.slice(pushed.args.indexOf('push'));
    assert.deepEqual(tail, ['push', '--porcelain', '--no-verify', '--atomic', '--no-follow-tags', '--no-recurse-submodules', `--force-with-lease=${MAIN}:${base}`, '--', url, `${candidate}:${MAIN}`]);
    for (const flag of ['protocol.allow=never', 'credential.helper=', 'core.fsmonitor=false']) assert.ok(pushed.args.includes(flag), flag);
    assert.ok(!pushed.args.some((a) => a.startsWith('+') || a === '--force' || a === '-f'));
  });
});

describe('pushOutcome: only a fast-forward status line counts as updated', () => {
  const line = (flag, summary, ref = MAIN) => `To x\n${flag}\t${candidate}:${ref}\t${summary}\nDone\n`;
  for (const [label, result, expected] of [
    ['fast-forward, exit 0', { code: 0, stdout: line(' ', 'a..b') }, ['updated', 'fast_forward']],
    ['fast-forward line but a failing exit', { code: 1, stdout: line(' ', 'a..b') }, ['unknown', 'no_status']],
    ['stale lease', { code: 1, stdout: line('!', '[rejected] (stale info)') }, ['rejected', 'stale']],
    ['not a fast-forward', { code: 1, stdout: line('!', '[rejected] (non-fast-forward)') }, ['rejected', 'not_fast_forward']],
    ['remote rejected', { code: 1, stdout: line('!', '[remote rejected] (pre-receive hook declined)') }, ['blocked', 'remote_rule']],
    ['remote failure', { code: 1, stdout: line('!', '[remote failure] (remote failed to report status)') }, ['blocked', 'remote_rule']],
    ['a forced update', { code: 0, stdout: line('+', 'a...b (forced update)') }, ['unknown', 'no_status']],
    ['a new ref', { code: 0, stdout: line('*', '[new branch]') }, ['unknown', 'no_status']],
    ['up to date', { code: 0, stdout: line('=', '[up to date]') }, ['unknown', 'no_status']],
    ['a line for another ref only', { code: 0, stdout: line(' ', 'a..b', 'refs/heads/other') }, ['unknown', 'no_status']],
    ['two lines for the ref', { code: 0, stdout: line(' ', 'a..b') + line(' ', 'a..b') }, ['unknown', 'no_status']],
    ['a timeout', { code: -1, failure: 'timeout', stdout: '' }, ['unknown', 'no_answer']],
    ['no output at all', { code: 128, stdout: '' }, ['unknown', 'no_status']],
    ['nothing', undefined, ['unknown', 'no_answer']],
  ]) {
    it(label, () => assert.deepEqual(pushOutcome(result, MAIN), { outcome: expected[0], code: expected[1] }));
  }
});

describe('INT-02 end to end: integration-candidate + real git', () => {
  const RUNNERS = Object.freeze(['trusted-verifier-01']);
  const digest = (c) => `sha256:${c.repeat(64)}`;
  const verifying = () => startVerification(freezeCandidate({
    candidateId: 'cand_7', projectId: 'proj_001', repositoryId: 'repo_001', targetRef: MAIN, targetTipOid: base, candidateCommitOid: candidate, candidateTreeOid: tree,
    testPlanDigest: digest('1'), imageDigest: digest('2'), lockfileDigest: digest('3'), policyVersion: 3, algorithmVersion: 1, risk: 'low', requiredGates: ['unit'],
    submissions: [{ submissionId: 'sub_101', baseCommitOid: base, resultCommitOid: task }],
  }));
  const evidence = () => [{ evidenceId: 'ev_unit', gate: 'unit', result: 'passed', provenance: 'trusted_verified', runnerId: 'trusted-verifier-01', subjectCommitOid: candidate,
    subjectTreeOid: tree, testPlanDigest: digest('1'), imageDigest: digest('2'), lockfileDigest: digest('3'), policyVersion: 3 }];
  const approval = (c, over = {}) => ({ decidedBy: { kind: 'human', id: 'yosuke' }, decision: 'approve', candidateId: c.candidateId, candidateVersion: c.version,
    candidateCommitOid: c.candidateCommitOid, targetRef: c.targetRef, targetTipOid: c.targetTipOid, policyVersion: c.policyVersion, expiresAt: NOW + 300, ...over });
  /** authorize -> APPROVED -> PROMOTING -> push -> recordPromotion, reading the tip from the remote first as the Integration Service would. */
  async function promote(p, c, approvalOver) {
    const tip = await p.readTip({ repositoryId: c.repositoryId, ref: c.targetRef });
    const auth = authorizePromotion(c, { currentTipOid: tip.oid, evidence: evidence(), trustedRunners: RUNNERS, approval: approval(c, approvalOver), now: NOW });
    if (!auth.ok) return { auth, candidate: c };
    const promoting = beginPromotion(markApproved(c, auth), NOW + 1);
    const pushed = await p.push(repo, { repositoryId: c.repositoryId, ...auth.update });
    return { auth, pushed, candidate: recordPromotion(promoting, pushed.outcome) };
  }

  it('an approved, verified candidate is promoted: MERGED and the remote tip is the candidate commit', async () => {
    const url = freshRemote();
    const r = await promote(promotion(url), verifying());
    assert.equal(r.candidate.state, 'MERGED');
    assert.equal(remoteTip(url), candidate);
  });
  for (const [label, over, code] of [
    ['a denied approval', { decision: 'deny' }, 'approval_denied'],
    ['an expired approval', { expiresAt: NOW }, 'approval_expired'],
    ['an approval from an AI', { decidedBy: { kind: 'agent', id: 'bero' } }, 'approval_not_human'],
    ['an approval of another target tip', { targetTipOid: other }, 'approval_mismatch'],
  ]) {
    it(`${label}: nothing is pushed and the protected ref stays`, async () => {
      const url = freshRemote();
      const r = await promote(promotion(url), verifying(), over);
      assert.deepEqual({ ok: r.auth.ok, code: r.auth.code }, { ok: false, code });
      assert.equal(r.pushed, undefined);
      assert.equal(remoteTip(url), base);
    });
  }
  it('the target moved before authorization: refused as target_moved, nothing pushed', async () => {
    const url = freshRemote(other);
    const r = await promote(promotion(url), verifying());
    assert.equal(r.auth.code, 'target_moved');
    assert.equal(remoteTip(url), other);
  });
  it('the target moved between authorization and push: the CAS refuses, the candidate is STALE', async () => {
    const url = freshRemote();
    const p = promotion(url);
    const c = verifying();
    const auth = authorizePromotion(c, { currentTipOid: (await p.readTip({ repositoryId: 'repo_001', ref: MAIN })).oid, evidence: evidence(), trustedRunners: RUNNERS, approval: approval(c), now: NOW });
    const promoting = beginPromotion(markApproved(c, auth), NOW + 1);
    g('push', '-q', '--force', url, `${other}:${MAIN}`);   // someone else promotes meanwhile
    const pushed = await p.push(repo, { repositoryId: 'repo_001', ...auth.update });
    assert.equal(recordPromotion(promoting, pushed.outcome).state, 'STALE');
    assert.equal(remoteTip(url), other);
  });
  it('the remote refuses by its own rule: BLOCKED, the ref stays', async () => {
    const url = freshRemote();
    const hook = path.join(url, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
    const r = await promote(promotion(url), verifying());
    assert.equal(r.candidate.state, 'BLOCKED');
    assert.equal(remoteTip(url), base);
  });
  it('no answer after the push landed: UNKNOWN_PROMOTION, and reading the tip back gives MERGED (no second push)', async () => {
    const url = freshRemote();
    let pushes = 0;
    const run = async (file, args, opts) => {
      const r = await runGitProcess(file, args, opts);
      if (!args.includes('push')) return r;
      pushes += 1;
      return { code: -1, failure: 'timeout', stdout: '', stderr: '' };   // the push went through; the answer was lost
    };
    const p = promotion(url, { run });
    const r = await promote(p, verifying());
    assert.equal(r.candidate.state, 'UNKNOWN_PROMOTION');
    const tip = await p.readTip({ repositoryId: 'repo_001', ref: MAIN });
    assert.equal(reconcilePromotion(r.candidate, tip.oid).state, 'MERGED');
    assert.equal(pushes, 1);
  });
  it('no answer and the push did not land: back to VERIFYING, so a retry needs a fresh approval of the new version', async () => {
    const url = freshRemote();
    const run = async (file, args, opts) => (args.includes('push') ? { code: -1, failure: 'spawn_failed', stdout: '', stderr: '' } : runGitProcess(file, args, opts));
    const p = promotion(url, { run });
    const r = await promote(p, verifying());
    const back = reconcilePromotion(r.candidate, (await p.readTip({ repositoryId: 'repo_001', ref: MAIN })).oid);
    assert.equal(back.state, 'VERIFYING');
    const stale = authorizePromotion(back, { currentTipOid: base, evidence: evidence(), trustedRunners: RUNNERS, approval: approval(r.candidate), now: NOW });
    assert.equal(stale.code, 'approval_stale');   // the old approval named the previous version
    assert.equal(remoteTip(url), base);
  });
});

describe('construction', () => {
  it('requires an absolute git, an absolute root and a registry of absolute local remotes with refs', () => {
    const ok = { git: gitPath, root: path.join(work, 'p'), remotes: { repo_001: { url: path.join(work, 'r.git'), refs: [MAIN] } } };
    assert.doesNotThrow(() => createGitPromotion(ok));
    for (const over of [
      { git: 'git' }, { root: 'p' }, { remotes: undefined }, { remotes: { repo_001: { url: 'r.git', refs: [MAIN] } } },
      { remotes: { repo_001: { url: '\\\\server\\share\\r.git', refs: [MAIN] } } }, { remotes: { repo_001: { url: '//server/share/r.git', refs: [MAIN] } } },
      { remotes: { repo_001: { url: path.join(work, 'r.git'), refs: [] } } }, { remotes: { repo_001: { url: path.join(work, 'r.git'), refs: ['main'] } } },
      { remotes: { '../x': { url: path.join(work, 'r.git'), refs: [MAIN] } } },
    ]) {
      assert.throws(() => createGitPromotion({ ...ok, ...over }), /invalid_git_promotion/u, JSON.stringify(over));
    }
  });
});

describe('fake pair', () => {
  it('answers the same two methods, defaults to success and records calls', async () => {
    const f = createFakeGitPromotion({ push: () => ({ outcome: 'unknown', code: 'no_answer' }) });
    assert.deepEqual(await f.readTip({ repositoryId: 'r', ref: MAIN }), { ok: true, oid: 'a'.repeat(40) });
    assert.deepEqual(await f.push('/q', { ref: MAIN }), { outcome: 'unknown', code: 'no_answer' });
    assert.deepEqual(f.calls().map((c) => c.method), ['readTip', 'push']);
  });
});
