import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createApprovedOperationFlow, FLOW_AUTHORITY_FINAL_CODES, FLOW_PHASES, FLOW_PRESEND_CODES, FLOW_STATUSES } from '../src/runtime/approved-operation-flow.mjs';
import { createMemoryFlowJournal, FlowJournalError } from '../src/runtime/approved-operation-journal.mjs';
import { AUTHORITY_CLIENT_PRESEND_CODES, AUTHORITY_REPLY_CODES } from '../src/runtime/approval-authority-client.mjs';
import { BROKER_CLIENT_PRESEND_CODES } from '../src/runtime/windows-broker-client.mjs';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { createTestAuthority, signedReceipt, stableUuid } from '../scripts/issue-22-approval-authority-fixture.mjs';

// Unit tests of the approved-operation flow with a fake Broker, a fake Approval Authority, an in-memory journal and a fake clock. Every branch of the
// state machine in src/runtime/approved-operation-flow.mjs has a test; the Windows integration test (runtime-approved-operation-flow.integration.test.mjs)
// runs the same flow against the real test Authority and the real test Broker.
const START_MS = 1_800_000_000_000;
const ACTION = Object.freeze({ action: 'synthetic.noop', projectId: 'project-1', computerId: 'computer-1', args: {} });
const REQUEST = Object.freeze({ operationId: 'op-1', action: ACTION });
const DENIED = { ok: false, code: 'denied' };
const TIMEOUT = { ok: false, code: 'timeout' };
const sum = (values) => values.reduce((a, b) => a + b, 0);

/** The two clients, the clock and the journal, with scripted deviations: `script.<method>` entries are used first, in order (a result, or a function of the world and the call). */
function makeWorld({ options, journal = createMemoryFlowJournal(), approveAfterPolls = 2, receiptTtl = 120 } = {}) {
  const authorityKey = createTestAuthority();
  const world = {
    journal, clock: START_MS, sleeps: [], calls: [], epoch: 1, submissions: [], claims: [], claimLog: [], phaseAtClaim: [], script: { fence: [], submit: [], status: [], claim: [], inspect: [] },
    approvals: new Map(), recorded: new Map(), onApproved: null, polls: 0,
  };
  const scripted = (method, args) => {
    const entry = world.script[method].shift();
    return entry === undefined ? undefined : (typeof entry === 'function' ? entry(world, args) : entry);
  };
  const seconds = () => Math.floor(world.clock / 1000);
  const record = ({ receipt, signature }) => {
    const parsed = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8'));
    const replayed = world.recorded.get(parsed.operationId)?.receipt === receipt;
    world.recorded.set(parsed.operationId, { receipt, signature });
    return replayed;
  };
  world.record = record;
  world.broker = {
    async fence(args) {
      world.calls.push('fence');
      return scripted('fence', args) ?? { ok: true, brokerEpoch: world.epoch, leaseGeneration: 7, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') };
    },
    async claim(args) {
      world.calls.push('claim');
      world.claims.push(args);
      world.phaseAtClaim.push(journal.get('op-1')?.phase);
      const override = scripted('claim', args);
      if (override !== undefined) return override;
      const parsed = JSON.parse(Buffer.from(args.receipt, 'base64').toString('utf8'));
      if (parsed.brokerEpoch !== world.epoch) return DENIED;
      const replayed = record(args);
      return { ok: true, state: 'UNKNOWN', action: 'synthetic.noop', ...(replayed ? { replayed: true } : {}) };
    },
    async inspect(args) {
      world.calls.push('inspect');
      return scripted('inspect', args) ?? (world.recorded.has(args.operationId) ? { ok: true, state: 'UNKNOWN', action: 'synthetic.inspect' } : DENIED);
    },
  };
  world.authority = {
    async submit(fields) {
      world.calls.push('submit');
      world.submissions.push(fields);
      const override = scripted('submit', fields);
      if (override !== undefined) return override;
      const approvalId = stableUuid(`${fields.operationId}/${fields.idempotencyKey}`);
      world.approvals.set(approvalId, fields);
      return { ok: true, approvalId, state: 'pending', expiresAt: seconds() + 120 };
    },
    async status({ approvalId }) {
      world.calls.push('status');
      world.polls += 1;
      const override = scripted('status', { approvalId });
      if (override !== undefined) return override;
      const fields = world.approvals.get(approvalId);
      if (approveAfterPolls === null || world.polls < approveAfterPolls) return { ok: true, state: 'pending', expiresAt: seconds() + 60 };
      const result = world.receiptFor(approvalId, fields);
      world.onApproved?.(world);
      return result;
    },
  };
  world.receiptFor = (approvalId, fields, overrides = {}) => ({
    ok: true, state: 'approved',
    ...signedReceipt({
      authority: authorityKey, name: fields.idempotencyKey, now: seconds(), ttlSeconds: receiptTtl, approvalId, operationId: fields.operationId, idempotencyKey: fields.idempotencyKey,
      leaseId: fields.leaseId, projectId: fields.action.projectId, computerId: fields.action.computerId,
      fence: { brokerEpoch: fields.brokerEpoch, leaseGeneration: fields.leaseGeneration, brokerChallenge: fields.brokerChallenge }, ...overrides,
    }),
  });
  world.build = (extra = {}) => createApprovedOperationFlow({
    broker: world.broker, authority: world.authority, journal: extra.journal ?? journal, now: () => world.clock, options,
    sleep: async (ms) => { world.sleeps.push(ms); world.clock += ms; },
  });
  world.flow = world.build();
  world.count = (name) => world.calls.filter((call) => call === name).length;
  world.phases = () => journal.history.map((entry) => entry.phase);
  return world;
}

const receiptEpoch = (claim) => JSON.parse(Buffer.from(claim.receipt, 'base64').toString('utf8')).brokerEpoch;

describe('approved operation flow: approve', () => {
  it('fence -> submit -> poll -> claim: intent is persisted before the claim, the key is stable, polling backs off', async () => {
    const world = makeWorld();
    const result = await world.flow.run(REQUEST);
    assert.deepEqual(result, { status: 'claimed', operationId: 'op-1', phase: 'CLAIMED', cycle: 1, approvalId: result.approvalId, brokerEpoch: 1, brokerState: 'UNKNOWN', reconciled: false, replayed: false });
    assert.ok(Object.isFrozen(result) && FLOW_STATUSES.includes(result.status) && FLOW_PHASES.includes(result.phase));
    assert.deepEqual(world.calls, ['fence', 'submit', 'status', 'status', 'claim']);
    assert.deepEqual(world.phaseAtClaim, ['CLAIMING'], 'the journal already said CLAIMING when the claim was written');
    assert.deepEqual(world.phases(), ['INTENT', 'FENCED', 'SUBMITTED', 'APPROVED', 'CLAIMING', 'CLAIMED']);
    assert.deepEqual(world.sleeps, [500]);
    const [submitted] = world.submissions;
    assert.deepEqual({ ...submitted, action: undefined }, {
      purpose: 'broker.operation', operationId: 'op-1', idempotencyKey: 'op-1.c1', leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 1, brokerChallenge: submitted.brokerChallenge, action: undefined,
    });
    assert.deepEqual(submitted.action, ACTION);
    const stored = world.journal.get('op-1');
    assert.equal(stored.receipt.receipt, world.claims[0].receipt, 'the receipt that was claimed is the one that was journaled');
    assert.equal(stored.outcome.brokerState, 'UNKNOWN');
  });

  it('a duplicate run reports the recorded outcome as replayed and touches nothing', async () => {
    const world = makeWorld();
    const first = await world.flow.run(REQUEST);
    const callsBefore = [...world.calls];
    const again = await world.flow.run(REQUEST);
    assert.deepEqual(again, { ...first, replayed: true });
    assert.deepEqual(await world.build().run(REQUEST), { ...first, replayed: true }, 'also from a new flow over the same journal (a restart)');
    assert.deepEqual(await world.flow.resume('op-1'), { ...first, replayed: true });
    assert.deepEqual(world.calls, callsBefore, 'no fence, submit, poll, claim or inspect');
  });

  it('two concurrent runs of one operation share one run', async () => {
    const world = makeWorld();
    const [a, b] = await Promise.all([world.flow.run(REQUEST), world.flow.run(REQUEST)]);
    assert.equal(a, b);
    assert.equal(world.count('fence'), 1);
    assert.equal(world.count('claim'), 1);
  });

  it('the Broker\'s own replayed flag comes through (the exact receipt was already recorded)', async () => {
    const world = makeWorld();
    world.script.claim.push((w, args) => { w.record(args); return TIMEOUT; }); // applied, reply lost
    world.script.inspect.push(DENIED); // ... and the first inspect does not see it
    const result = await world.flow.run(REQUEST);
    assert.equal(result.status, 'claimed');
    assert.equal(result.replayed, true);
    assert.equal(world.claims.length, 2);
    assert.equal(world.claims[0].receipt, world.claims[1].receipt, 'the exact same receipt bytes');
    assert.equal(world.claims[0].signature, world.claims[1].signature);
    assert.equal(world.count('submit'), 1, 'no new approval');
  });
});

describe('approved operation flow: deny, expire, other final answers', () => {
  for (const [code, status, phase] of [
    ['human_denied', 'denied', 'DENIED'], ['presence_unavailable', 'denied', 'DENIED'], ['presence_mismatch', 'denied', 'DENIED'],
    ['request_expired', 'expired', 'EXPIRED'], ['request_invalid', 'failed', 'FAILED'], ['authority_unavailable', 'failed', 'FAILED'], ['queue_full', 'failed', 'FAILED'],
  ]) {
    it(`status ${code} is final and recorded: ${status}, no claim, never retried`, async () => {
      const world = makeWorld();
      world.script.status.push({ ok: true, state: 'pending', expiresAt: START_MS / 1000 + 100 }, { ok: false, code });
      const result = await world.flow.run(REQUEST);
      assert.equal(result.status, status);
      assert.equal(result.code, code);
      assert.equal(result.phase, phase);
      assert.equal(world.count('claim'), 0);
      assert.equal(world.count('status'), 2);
      assert.deepEqual(world.journal.get('op-1').outcome, { code });
      assert.equal((await world.flow.run(REQUEST)).replayed, true, 'a rerun reports the recorded refusal and asks no one again');
      assert.equal(world.count('submit'), 1);
    });
  }

  it('submit refused with a final code is recorded without polling', async () => {
    const world = makeWorld();
    world.script.submit.push({ ok: false, code: 'queue_full' });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['failed', 'queue_full', 'FAILED']);
    assert.equal(world.count('status'), 0);
  });

  it('a request nobody decides runs into its own expiry: backoff, the last poll lands on the deadline, then expired', async () => {
    const world = makeWorld({ approveAfterPolls: null });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['expired', 'approval_timeout', 'EXPIRED']);
    assert.deepEqual(world.sleeps.slice(0, 5), [500, 1000, 2000, 4000, 5000]);
    assert.ok(world.sleeps.every((ms) => ms <= 5000));
    assert.equal(sum(world.sleeps), 120_000, 'bounded by the request expiry the Authority reported');
    assert.equal(world.clock, START_MS + 120_000);
    assert.equal(world.count('claim'), 0);
    assert.equal(world.count('status'), world.sleeps.length + 1, 'one last look at the deadline');
  });

  it('maxPolls bounds the polling even when the expiry is far away', async () => {
    const world = makeWorld({ approveAfterPolls: null, options: { maxPolls: 3 } });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code], ['expired', 'approval_timeout']);
    assert.equal(world.count('status'), 3);
  });

  it('persistent status failures stop the polling as retryable, and a rerun resumes it without a second submit', async () => {
    const world = makeWorld({ options: { maxStatusErrors: 3 } });
    world.script.status.push(TIMEOUT, TIMEOUT, TIMEOUT);
    const first = await world.flow.run(REQUEST);
    assert.deepEqual([first.status, first.code, first.phase], ['retryable', 'timeout', 'SUBMITTED']);
    const second = await world.flow.run(REQUEST);
    assert.equal(second.status, 'claimed');
    assert.equal(world.count('submit'), 1);
    assert.equal(world.count('fence'), 1);
  });

  it('a status failure that is not transient (identity mismatch) stops at once', async () => {
    const world = makeWorld();
    world.script.status.push({ ok: false, code: 'server_identity_mismatch' });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['retryable', 'server_identity_mismatch', 'SUBMITTED']);
    assert.equal(world.count('status'), 1);
  });
});

describe('approved operation flow: pre-send failures are retryable', () => {
  it('Authority unreachable before the frame: retried with backoff, then retryable; the rerun resumes at FENCED without a second fence', async () => {
    const world = makeWorld();
    const down = { ok: false, code: 'authority_unreachable' };
    world.script.submit.push(down, down, down);
    const first = await world.flow.run(REQUEST);
    assert.deepEqual([first.status, first.code, first.phase], ['retryable', 'authority_unreachable', 'FENCED']);
    assert.deepEqual(world.sleeps, [250, 500]);
    assert.equal(world.count('fence'), 1);
    const second = await world.flow.run(REQUEST);
    assert.equal(second.status, 'claimed');
    assert.equal(world.count('fence'), 1, 'the persisted challenge is reused');
    assert.deepEqual(new Set(world.submissions.map((s) => s.idempotencyKey)), new Set(['op-1.c1']), 'every resubmit used the same key');
    assert.equal(new Set(world.submissions.map((s) => s.brokerChallenge)).size, 1);
  });

  it('a post-send submit failure is resubmitted under the same key (the Authority returns the first request)', async () => {
    const world = makeWorld();
    world.script.submit.push(TIMEOUT);
    assert.equal((await world.flow.run(REQUEST)).status, 'claimed');
    assert.equal(world.count('submit'), 2);
    assert.equal(world.submissions[0].idempotencyKey, world.submissions[1].idempotencyKey);
  });

  it('Broker unreachable on the fence: transient codes are retried, an identity mismatch is not', async () => {
    const world = makeWorld();
    world.script.fence.push({ ok: false, code: 'broker_unavailable' }, { ok: false, code: 'broker_unavailable' });
    assert.equal((await world.flow.run(REQUEST)).status, 'claimed');
    assert.equal(world.count('fence'), 3);

    const hostile = makeWorld();
    hostile.script.fence.push({ ok: false, code: 'server_identity_mismatch' });
    const result = await hostile.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['retryable', 'server_identity_mismatch', 'INTENT']);
    assert.equal(hostile.count('fence'), 1);
    assert.deepEqual(hostile.sleeps, []);
    assert.equal(hostile.count('submit'), 0);
  });

  it('a fence the Broker denies is final', async () => {
    const world = makeWorld();
    world.script.fence.push(DENIED);
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['failed', 'fence_denied', 'FAILED']);
  });

  it('a claim that never left the process is retried with the same receipt and never becomes UNKNOWN', async () => {
    const world = makeWorld();
    world.script.claim.push({ ok: false, code: 'broker_unavailable' }, { ok: false, code: 'broker_unavailable' });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.reconciled, result.replayed], ['claimed', false, false]);
    assert.equal(world.count('inspect'), 0);
    assert.equal(world.count('submit'), 1);
    assert.equal(new Set(world.claims.map((c) => c.receipt)).size, 1);
    assert.equal(world.phases().includes('UNKNOWN'), false);
    assert.deepEqual(world.phaseAtClaim, ['CLAIMING', 'CLAIMING', 'CLAIMING']);
  });

  it('claim pre-send failures that outlast the attempts leave the record APPROVED; the rerun claims the same receipt without asking a human again', async () => {
    const world = makeWorld();
    const down = { ok: false, code: 'broker_unavailable' };
    world.script.claim.push(down, down, down);
    const first = await world.flow.run(REQUEST);
    assert.deepEqual([first.status, first.code, first.phase], ['retryable', 'broker_unavailable', 'APPROVED']);
    const second = await world.flow.run(REQUEST);
    assert.equal(second.status, 'claimed');
    assert.equal(world.count('submit'), 1);
    assert.equal(new Set(world.claims.map((c) => c.receipt)).size, 1);
  });

  it('a claim pre-send failure that is not transient (identity mismatch) stops at once', async () => {
    const world = makeWorld();
    world.script.claim.push({ ok: false, code: 'server_identity_mismatch' });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['retryable', 'server_identity_mismatch', 'APPROVED']);
    assert.equal(world.claims.length, 1);
  });

  it('a receipt that expired before the claim was written ends expired without sending anything', async () => {
    const world = makeWorld();
    world.onApproved = (w) => { w.clock += 200_000; };
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['expired', 'receipt_expired', 'EXPIRED']);
    assert.equal(world.count('claim'), 0);
    assert.equal(world.count('inspect'), 0);
  });
});

describe('approved operation flow: after the frame was written the outcome is UNKNOWN and is reconciled with inspect', () => {
  it('Broker timeout, claim applied: inspect finds it; the claim was written once and no new receipt exists', async () => {
    const world = makeWorld();
    world.script.claim.push((w, args) => { w.record(args); return TIMEOUT; });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.reconciled, result.replayed, result.phase], ['claimed', true, false, 'CLAIMED']);
    assert.deepEqual(world.calls.slice(-2), ['claim', 'inspect'], 'claim, then inspect, nothing after');
    assert.equal(world.count('claim'), 1);
    assert.equal(world.count('submit'), 1);
    assert.ok(world.phases().includes('UNKNOWN'));
  });

  it('Broker timeout, nothing recorded, receipt still valid: the same receipt is sent again, exactly', async () => {
    const world = makeWorld();
    world.script.claim.push(TIMEOUT); // not applied
    const result = await world.flow.run(REQUEST);
    assert.equal(result.status, 'claimed');
    assert.equal(result.replayed, false);
    assert.equal(world.claims.length, 2);
    assert.deepEqual(world.claims[1], world.claims[0]);
    assert.equal(world.count('submit'), 1);
    assert.equal(world.count('fence'), 1);
  });

  it('a lost inspect answer is asked again with backoff; the claim is not resent meanwhile', async () => {
    const world = makeWorld();
    world.script.claim.push((w, args) => { w.record(args); return TIMEOUT; });
    world.script.inspect.push(TIMEOUT, TIMEOUT);
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.reconciled], ['claimed', true]);
    assert.equal(world.count('inspect'), 3);
    assert.equal(world.count('claim'), 1);
    assert.deepEqual(world.sleeps.slice(-2), [250, 500]);
  });

  it('inspect never answers: the result is unknown, the claim was sent once, and a later resume reconciles', async () => {
    const world = makeWorld();
    world.script.claim.push((w, args) => { w.record(args); return TIMEOUT; });
    world.script.inspect.push(TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT);
    const first = await world.flow.run(REQUEST);
    assert.deepEqual([first.status, first.phase, first.code], ['unknown', 'UNKNOWN', 'timeout']);
    assert.equal(world.count('claim'), 1);
    const second = await world.flow.resume('op-1');
    assert.deepEqual([second.status, second.reconciled], ['claimed', true]);
    assert.equal(world.count('claim'), 1, 'never replayed, never a new receipt');
    assert.equal(world.count('submit'), 1);
  });

  it('a crash while the claim is in flight leaves CLAIMING; a new flow over the same journal reconciles instead of claiming again', async () => {
    const world = makeWorld();
    world.script.claim.push((w, args) => { w.record(args); throw new Error('process died'); });
    await assert.rejects(() => world.flow.run(REQUEST), /process died/u);
    assert.equal(world.journal.get('op-1').phase, 'CLAIMING');
    const restarted = world.build();
    const result = await restarted.resume('op-1');
    assert.deepEqual([result.status, result.reconciled, result.phase], ['claimed', true, 'CLAIMED']);
    assert.equal(world.count('claim'), 1);
    assert.equal(world.count('submit'), 1);
  });

  it('a crash in CLAIMING where the claim never arrived: the same receipt is sent again after inspect found nothing', async () => {
    const world = makeWorld();
    world.script.claim.push(() => { throw new Error('process died'); });
    await assert.rejects(() => world.flow.run(REQUEST));
    const result = await world.build().resume('op-1');
    assert.equal(result.status, 'claimed');
    assert.equal(world.claims.length, 2);
    assert.deepEqual(world.claims[1], world.claims[0]);
    assert.equal(world.count('submit'), 1);
  });

  it('a Broker that refuses (denied) and has no claim: failed broker_denied, not resent, not re-approved', async () => {
    const world = makeWorld();
    world.script.claim.push(DENIED);
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['failed', 'broker_denied', 'FAILED']);
    assert.equal(world.count('claim'), 1);
    assert.equal(world.count('submit'), 1);
    assert.equal(world.count('inspect'), 1, 'it checked for a recorded claim first');
  });

  it('a `denied` reply for a claim the Broker did record is reconciled as claimed (denied after the frame is not proof of anything)', async () => {
    const world = makeWorld();
    world.script.claim.push((w, args) => { w.record(args); return DENIED; });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.reconciled], ['claimed', true]);
  });
});

describe('approved operation flow: epochs are never mixed', () => {
  it('the Broker restarted between fence and claim: no claim is mixed, the flow fences again, submits again under a new key and is approved again', async () => {
    const world = makeWorld();
    world.onApproved = (w) => { if (w.epoch === 1) w.epoch = 2; }; // the Broker restarts right after the first approval
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.cycle, result.brokerEpoch], ['claimed', 2, 2]);
    assert.deepEqual(world.submissions.map((s) => [s.brokerEpoch, s.idempotencyKey]), [[1, 'op-1.c1'], [2, 'op-1.c2']]);
    assert.notEqual(world.submissions[0].brokerChallenge, world.submissions[1].brokerChallenge);
    assert.deepEqual(world.claims.map(receiptEpoch), [1, 2], 'the epoch-1 receipt was written once, before the Broker said no; the epoch-2 receipt is the only one claimed after the re-fence');
    assert.equal(world.count('fence'), 3, 'the first fence, the diagnosing fence, the fence of the new cycle');
    assert.deepEqual(world.journal.get('op-1').superseded, [{ cycle: 1, brokerEpoch: 1, leaseGeneration: 7, reason: 'epoch_changed' }]);
    assert.deepEqual(world.phases(), ['INTENT', 'FENCED', 'SUBMITTED', 'APPROVED', 'CLAIMING', 'UNKNOWN', 'INTENT', 'FENCED', 'SUBMITTED', 'APPROVED', 'CLAIMING', 'CLAIMED']);
  });

  it('a Broker that keeps restarting ends failed epoch_changed after maxCycles, not in a loop', async () => {
    const world = makeWorld();
    world.onApproved = (w) => { w.epoch += 1; };
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase, result.cycle], ['failed', 'epoch_changed', 'FAILED', 2]);
    assert.equal(world.submissions.length, 2);
  });

  it('a lease generation that moved counts like an epoch change', async () => {
    const world = makeWorld();
    let generation = 7;
    world.broker.fence = async () => { world.calls.push('fence'); return { ok: true, brokerEpoch: 1, leaseGeneration: generation, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') }; };
    world.script.claim.push(() => { generation = 8; return DENIED; });
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.cycle], ['claimed', 2]);
    assert.deepEqual(world.submissions.map((s) => s.leaseGeneration), [7, 8]);
  });

  it('a receipt that names another epoch than the fence is refused and never claimed', async () => {
    const world = makeWorld();
    world.script.status.push((w, { approvalId }) => w.receiptFor(approvalId, w.approvals.get(approvalId), { brokerEpoch: 99 }));
    const result = await world.flow.run(REQUEST);
    assert.deepEqual([result.status, result.code, result.phase], ['failed', 'receipt_mismatch', 'FAILED']);
    assert.equal(world.count('claim'), 0);
  });

  it('a receipt with the same ids and fence but another purpose, action, project, computer or digest is refused and never claimed', async () => {
    const otherArgs = computeActionDigest('broker.operation', { ...ACTION, args: { vmName: 'other' } });
    const variants = [
      { purpose: 'guest.command' }, { action: 'environment.inspect' }, { projectId: 'project-2' }, { computerId: 'computer-2' },
      { actionDigest: otherArgs }, { actionDigest: `sha256:${'0'.repeat(64)}` },
    ];
    for (const overrides of variants) {
      const world = makeWorld();
      world.script.status.push((w, { approvalId }) => w.receiptFor(approvalId, w.approvals.get(approvalId), overrides));
      const result = await world.flow.run(REQUEST);
      assert.deepEqual([result.status, result.code, result.phase], ['failed', 'receipt_mismatch', 'FAILED'], JSON.stringify(overrides));
      assert.equal(world.count('claim'), 0, JSON.stringify(overrides));
      assert.equal(world.journal.get('op-1').receipt, undefined, 'never journaled as APPROVED');
    }
  });

  it('a receipt for another operation, key or challenge is refused', async () => {
    for (const overrides of [{ operationId: 'op-other' }, { idempotencyKey: 'op-1.c9' }, { brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' }, { leaseId: 'lease-2' }]) {
      const world = makeWorld();
      world.script.status.push((w, { approvalId }) => w.receiptFor(approvalId, w.approvals.get(approvalId), overrides));
      assert.equal((await world.flow.run(REQUEST)).code, 'receipt_mismatch', JSON.stringify(overrides));
      assert.equal(world.count('claim'), 0);
    }
  });
});

describe('approved operation flow: input, journal, construction', () => {
  it('the same operationId with a different action is a conflict and touches nothing', async () => {
    const world = makeWorld();
    await world.flow.run(REQUEST);
    const callsBefore = world.calls.length;
    const result = await world.flow.run({ operationId: 'op-1', action: { ...ACTION, computerId: 'computer-2' } });
    assert.deepEqual([result.status, result.code], ['failed', 'operation_conflict']);
    assert.equal(world.calls.length, callsBefore);
    assert.equal(world.journal.get('op-1').phase, 'CLAIMED');
  });

  it('invalid requests are failed invalid_request with no journal entry and no call', async () => {
    const world = makeWorld();
    const bad = [
      null, {}, { operationId: 'op-1' }, { operationId: '', action: ACTION }, { operationId: 'x'.repeat(62), action: ACTION }, { operationId: 'op 1', action: ACTION },
      { operationId: 'op-1', action: { ...ACTION, action: 'rm.everything' } }, { operationId: 'op-1', action: ACTION, extra: true }, { operationId: 'op-1', purpose: 'nope', action: ACTION },
    ];
    for (const request of bad) {
      const result = await world.flow.run(request);
      assert.deepEqual([result.status, result.code], ['failed', 'invalid_request'], JSON.stringify(request));
    }
    assert.deepEqual(world.calls, []);
    assert.equal(world.journal.get('op-1'), null);
    assert.equal((await world.flow.resume('not an id')).code, 'invalid_request');
    assert.equal((await world.flow.resume('op-unknown')).code, 'unknown_operation');
  });

  it('when the claim intent cannot be persisted, the claim is not written', async () => {
    const world = makeWorld();
    const inner = world.journal;
    const failing = { ...inner, advance: (id, revision, from, patch) => { if (patch.phase === 'CLAIMING') throw new Error('disk full'); return inner.advance(id, revision, from, patch); } };
    const result = await world.build({ journal: failing }).run(REQUEST);
    assert.deepEqual([result.status, result.code], ['retryable', 'journal_error']);
    assert.equal(world.count('claim'), 0, 'intent before effect');
    assert.equal(inner.get('op-1').phase, 'APPROVED');
    assert.equal((await world.build().run(REQUEST)).status, 'claimed', 'with a working journal the same operation completes');
    assert.equal(world.count('submit'), 1);
  });

  it('a compare-and-set conflict (another writer moved the record) stops the flow as journal_conflict', async () => {
    const world = makeWorld();
    const inner = world.journal;
    const racing = { ...inner, advance: (id, revision, from, patch) => { if (patch.phase === 'FENCED') throw new FlowJournalError('conflict'); return inner.advance(id, revision, from, patch); } };
    const result = await world.build({ journal: racing }).run(REQUEST);
    assert.deepEqual([result.status, result.code], ['retryable', 'journal_conflict']);
    assert.equal(world.count('submit'), 0);
  });

  it('a journal that cannot be read or begun stops the flow before any effect', async () => {
    const world = makeWorld();
    const broken = { begin: () => { throw new Error('locked'); }, advance: () => { throw new Error('locked'); }, get: () => { throw new Error('locked'); } };
    assert.equal((await world.build({ journal: broken }).run(REQUEST)).code, 'journal_error');
    assert.equal((await world.build({ journal: broken }).resume('op-1')).code, 'journal_error');
    assert.deepEqual(world.calls, []);
  });

  it('a corrupt phase in the journal is reported, not acted on', async () => {
    const world = makeWorld();
    world.journal.begin({ operationId: 'op-1', purpose: 'broker.operation', action: ACTION, requestDigest: 'x', phase: 'BOGUS', cycle: 1 });
    assert.equal((await world.flow.resume('op-1')).code, 'journal_corrupt');
    assert.deepEqual(world.calls, []);
  });

  it('the journal revision starts at 0, rises with every advance, and cannot be set by a patch', () => {
    const journal = createMemoryFlowJournal();
    const { record } = journal.begin({ operationId: 'op-r', phase: 'INTENT', cycle: 1, revision: 99 });
    assert.equal(record.revision, 0);
    const next = journal.advance('op-r', 0, ['INTENT'], { phase: 'FENCED', revision: 50 });
    assert.deepEqual([next.phase, next.revision], ['FENCED', 1]);
    assert.equal(journal.begin({ operationId: 'op-r', phase: 'INTENT' }).record.revision, 1, 'a second begin returns the stored record unchanged');
  });

  it('a stale step holding an old record cannot overwrite a newer cycle even when the phase matches', async () => {
    const journal = createMemoryFlowJournal();
    const stale = journal.begin({ operationId: 'op-c', phase: 'INTENT', cycle: 1 }).record; // revision 0, cycle 1, INTENT
    const fenced = journal.advance('op-c', stale.revision, ['INTENT'], { phase: 'FENCED' });
    const cycle2 = journal.advance('op-c', fenced.revision, ['FENCED'], { phase: 'INTENT', cycle: 2 }); // phases repeat across cycles
    assert.equal(cycle2.phase, stale.phase, "same phase as the stale holder's record");
    assert.throws(() => journal.advance('op-c', stale.revision, ['INTENT'], { phase: 'FENCED', cycle: 1, fence: { brokerEpoch: 1 } }), { code: 'conflict' });
    assert.deepEqual(journal.get('op-c'), cycle2, 'nothing changed');
    assert.throws(() => journal.advance('op-c', cycle2.revision, ['FENCED'], { phase: 'SUBMITTED' }), { code: 'conflict' }, 'the right revision with the wrong phase is refused too');
    assert.equal(journal.advance('op-c', cycle2.revision, ['INTENT'], { phase: 'FENCED' }).revision, cycle2.revision + 1);

    // The same through the flow: after a real second cycle, a holder of the revision-0 record cannot touch the record.
    const world = makeWorld();
    world.onApproved = (w) => { if (w.epoch === 1) w.epoch = 2; };
    const result = await world.flow.run(REQUEST);
    assert.equal(result.cycle, 2);
    const final = world.journal.get('op-1');
    assert.throws(() => world.journal.advance('op-1', 0, ['INTENT', 'CLAIMING', 'UNKNOWN'], { phase: 'FAILED' }), { code: 'conflict' });
    assert.deepEqual(world.journal.get('op-1'), final);
  });

  it('construction rejects missing dependencies and bad options', () => {
    const world = makeWorld();
    const deps = { broker: world.broker, authority: world.authority, journal: world.journal, now: () => 0, sleep: async () => {} };
    for (const broken of [{}, { ...deps, broker: {} }, { ...deps, authority: undefined }, { ...deps, journal: {} }, { ...deps, now: 1 }, { ...deps, sleep: null }]) {
      assert.throws(() => createApprovedOperationFlow(broken), /invalid_flow_dependencies/u);
    }
    for (const options of [{ maxCycles: 0 }, { maxCycles: 10 }, { pollFactor: 0.5 }, { sendAttempts: 0 }, { reconcileAttempts: -1 }, { surprise: 1 }, { pollInitialMs: 1.5 }]) {
      assert.throws(() => createApprovedOperationFlow({ ...deps, options }), /invalid_flow_options/u, JSON.stringify(options));
    }
    assert.doesNotThrow(() => createApprovedOperationFlow({ ...deps, options: { reconcileAttempts: 0, maxCycles: 9 } }));
  });

  it('the code lists in the flow match the two clients\' own constants', () => {
    assert.deepEqual([...FLOW_PRESEND_CODES].sort(), [...new Set([...BROKER_CLIENT_PRESEND_CODES, ...AUTHORITY_CLIENT_PRESEND_CODES])].sort());
    assert.deepEqual([...FLOW_AUTHORITY_FINAL_CODES].sort(), [...AUTHORITY_REPLY_CODES].sort());
  });
});
