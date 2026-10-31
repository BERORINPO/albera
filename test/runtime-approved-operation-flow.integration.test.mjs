import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApprovedOperationFlow } from '../src/runtime/approved-operation-flow.mjs';
import { createMemoryFlowJournal } from '../src/runtime/approved-operation-journal.mjs';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { getApprovalStatus, submitApproval } from '../src/runtime/approval-authority-client.mjs';
import { sendBrokerFence, sendBrokerInspect, sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';
import {
  GENERATION, LEASE_CONFIG, POLICY_VERSION, buildBrokerWithTestSeams, buildPipeClient, currentUserSid, getUnavailableReason, makeTrustedTempDirectory, standInService, startProcess, waitForExit, waitForLine,
} from './helpers/windows-broker-harness.mjs';
import { buildAuthority, makeConfig, presenceMessage, startAuthority } from './helpers/approval-authority-harness.mjs';

// Windows-only, same-user, unprivileged. The approved-operation flow (src/runtime/approved-operation-flow.mjs) end to end over the REAL pipes: the Node clients and the
// trusted pipe client helper, the test-faults Approval Authority (fake presence, in-memory signer) and the test-faults Host Broker (journal in a trusted temp folder).
// A task plays the approver: it lists the pending request and decides it through the approver pipe, like the future approver UI. The scenarios end with a claim in
// the Broker's own journal (approve), no claim (deny), a claim under a new epoch after a Broker restart, and a claim whose reply was lost (post-send timeout).
// Pipes here are created by the .NET programs (owner = this user), so the expected owner is the user SID; no Node-made pipe is involved. Skipped without the .NET 10 SDK.
const ACTION = Object.freeze({ action: 'synthetic.noop', projectId: 'project-1', computerId: 'computer-1', args: {} });
const FLOW_OPTIONS = Object.freeze({ pollInitialMs: 200, pollMaxMs: 1000, sendBackoffMs: 200, sendAttempts: 5, reconcileAttempts: 8 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeProof = (entry) => createHash('sha256').update(Buffer.concat([Buffer.from('albera-fake-presence\0'), presenceMessage(entry)])).digest().toString('base64');

describe('approved operation flow: real Approval Authority and real Host Broker (test builds)', { skip: getUnavailableReason(), timeout: 900_000 }, () => {
  let root, authorityExe, brokerExe, helper, sid;
  const running = new Set();
  let scenarios = 0;
  before(async () => {
    root = makeTrustedTempDirectory('albera-flow-it-'); // long form, DACL = this user + SYSTEM only: the trusted baseline both services demand
    authorityExe = buildAuthority(path.join(root, 'authority'), { faults: true });
    brokerExe = buildBrokerWithTestSeams(path.join(root, 'broker'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };

  /** The approver: decides every pending request with `decide(entry, index)` ('approve' with the fake presence proof, or 'deny'). */
  function startHuman(authority, decide) {
    const decided = [];
    const errors = [];
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        try {
          const { pending = [] } = await authority.approver({ v: 1, verb: 'list' });
          for (const entry of pending) {
            if (decided.some((d) => d.approvalId === entry.approvalId)) continue;
            const decision = decide(entry, decided.length);
            const request = { v: 1, verb: 'decide', approvalId: entry.approvalId, decision, ...(decision === 'approve' ? { presence: fakeProof(entry) } : {}) };
            // Recorded before the answer: the flow may see the decision and finish before the approver's reply reaches this loop.
            const record = { approvalId: entry.approvalId, decision, action: entry.action, actionDigest: entry.actionDigest, answer: undefined };
            decided.push(record);
            record.answer = await authority.approver(request);
          }
        } catch (error) { errors.push(String(error)); }
        await sleep(150);
      }
    })();
    return { decided, errors, async stop() { stopped = true; await loop; } };
  }

  /** A fresh Authority + Broker pair wired to a fresh flow. `hold` makes the Broker keep each committed claim open that many ms before it answers. */
  async function withStack(body, { hold, claimTimeoutMs = 10_000, decide = () => 'approve' } = {}) {
    const dir = path.join(root, `scenario-${(scenarios += 1)}`);
    mkdirSync(path.join(dir, 'db'), { recursive: true });
    const authority = await startAuthority(authorityExe, root, { config: makeConfig({ policyVersion: POLICY_VERSION }), presence: 'fake' });
    const database = path.join(dir, 'db', 'journal.sqlite');
    const config = { pipeName: `ALBERA_Flow_${randomBytes(6).toString('hex')}`, database, authorityKeys: [{ kid: authority.config.kid, spki: authority.publicKey }], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG };
    const configFile = path.join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify(config));
    const stack = { authority, database, broker: null, hooks: {} };
    stack.startBroker = async () => {
      stack.broker = track(startProcess(brokerExe, standInService('serve-loop', configFile, ...(hold ? [String(hold)] : [])), { stdin: true }));
      await waitForLine(stack.broker, 'BROKER_READY');
    };
    stack.restartBroker = async () => { stack.broker.stdin.end(); await waitForExit(stack.broker); await stack.startBroker(); };
    await stack.startBroker();
    const brokerConnection = (timeoutMs = 10_000) => ({ pipeName: config.pipeName, expect: { ownerSid: sid, pid: stack.broker.pid }, helperPath: helper, timeoutMs });
    const authorityConnection = () => ({ pipeRoot: authority.config.pipeRoot, expect: { ownerSid: sid, pid: authority.child.pid }, helperPath: helper, timeoutMs: 10_000 });
    const clients = {
      broker: {
        fence: (args) => sendBrokerFence({ ...brokerConnection(), ...args }),
        claim: (args) => sendBrokerRequest({ ...brokerConnection(claimTimeoutMs), ...args }),
        inspect: (args) => sendBrokerInspect({ ...brokerConnection(), ...args }),
      },
      authority: {
        submit: (fields) => submitApproval({ ...fields, includeDigest: true, ...authorityConnection() }),
        status: async (args) => { const reply = await getApprovalStatus({ ...args, ...authorityConnection() }); await stack.hooks.afterStatus?.(reply); return reply; },
      },
    };
    stack.clients = clients;
    stack.journal = createMemoryFlowJournal();
    stack.flow = createApprovedOperationFlow({ ...clients, journal: stack.journal, now: Date.now, sleep, options: FLOW_OPTIONS });
    stack.human = startHuman(authority, decide);
    try { return await body(stack); } finally {
      await stack.human.stop();
      if (stack.broker.closeCode === undefined) { stack.broker.stdin.end(); await waitForExit(stack.broker); }
      await authority.stop();
    }
  }

  /** The Broker's own journal, read-only: every claim it recorded. */
  function brokerClaims(database) {
    const db = new DatabaseSync(database, { readOnly: true });
    try { return db.prepare('SELECT operation_id, state, lease_generation FROM claims ORDER BY operation_id').all().map((row) => ({ ...row })); } finally { db.close(); }
  }

  it('approve: fence, submit, the human approves the exact action, poll, claim; the claim is in the Broker journal and a duplicate run is replayed', async () => {
    await withStack(async (stack) => {
      const first = await stack.flow.run({ operationId: 'flow-approve', action: ACTION });
      assert.equal(first.status, 'claimed', JSON.stringify(first));
      assert.deepEqual([first.phase, first.cycle, first.brokerEpoch, first.brokerState, first.reconciled, first.replayed], ['CLAIMED', 1, 1, 'UNKNOWN', false, false]);

      assert.deepEqual(brokerClaims(stack.database), [{ operation_id: 'flow-approve', state: 'UNKNOWN', lease_generation: GENERATION }]);
      assert.equal(stack.human.errors.length, 0, stack.human.errors.join('|'));
      assert.equal(stack.human.decided.length, 1);
      assert.deepEqual(stack.human.decided[0].action, ACTION, 'the human saw the exact DTO');
      assert.equal(stack.human.decided[0].actionDigest, computeActionDigest('broker.operation', ACTION));
      assert.deepEqual(await stack.clients.broker.inspect({ operationId: 'flow-approve' }), { ok: true, state: 'UNKNOWN', action: 'synthetic.inspect' });
      assert.deepEqual(stack.journal.history.map((h) => h.phase), ['INTENT', 'FENCED', 'SUBMITTED', 'APPROVED', 'CLAIMING', 'CLAIMED']);

      const again = await stack.flow.run({ operationId: 'flow-approve', action: ACTION });
      assert.deepEqual(again, { ...first, replayed: true });
      const stored = stack.journal.get('flow-approve');
      const resent = await stack.clients.broker.claim({ receipt: stored.receipt.receipt, signature: stored.receipt.signature });
      assert.deepEqual(resent, { ok: true, state: 'UNKNOWN', action: 'synthetic.noop', replayed: true }, 'the exact same receipt is an exact duplicate for the Broker');
      assert.equal(brokerClaims(stack.database).length, 1);
    });
  });

  it('task.start: the human approves the exact guest.command DTO, the Broker claims it from the DTO sent next to the receipt and names task.start, a duplicate is replayed, and without the DTO it is refused', async () => {
    const task = Object.freeze({ action: 'task.start', projectId: 'project-1', computerId: 'computer-1', args: Object.freeze({ task: 'build the project' }) });
    await withStack(async (stack) => {
      const first = await stack.flow.run({ operationId: 'flow-task', purpose: 'guest.command', action: task });
      assert.equal(first.status, 'claimed', JSON.stringify(first));
      assert.deepEqual([first.phase, first.brokerState, first.reconciled, first.replayed], ['CLAIMED', 'UNKNOWN', false, false]);
      assert.deepEqual(brokerClaims(stack.database), [{ operation_id: 'flow-task', state: 'UNKNOWN', lease_generation: GENERATION }]);
      assert.deepEqual(stack.human.decided.map((d) => d.action), [task], 'the human saw the exact DTO, including the task');
      assert.equal(stack.human.decided[0].actionDigest, computeActionDigest('guest.command', task));

      const stored = stack.journal.get('flow-task');
      const resent = await stack.clients.broker.claim({ receipt: stored.receipt.receipt, signature: stored.receipt.signature, action: task });
      assert.deepEqual(resent, { ok: true, state: 'UNKNOWN', action: 'task.start', replayed: true });
      assert.deepEqual(await stack.clients.broker.claim({ receipt: stored.receipt.receipt, signature: stored.receipt.signature }), { ok: false, code: 'denied' }, 'the two-key form is for broker.operation receipts');
      assert.deepEqual(await stack.clients.broker.claim({ receipt: stored.receipt.receipt, signature: stored.receipt.signature, action: { ...task, args: { task: 'build the project!' } } }), { ok: false, code: 'denied' }, 'another task is not the signed one');
      assert.equal(brokerClaims(stack.database).length, 1);
    });
  });

  it('deny: the human denies; the result is denied/human_denied, recorded, and the Broker journal has no claim', async () => {
    await withStack(async (stack) => {
      const result = await stack.flow.run({ operationId: 'flow-deny', action: ACTION });
      assert.deepEqual([result.status, result.code, result.phase], ['denied', 'human_denied', 'DENIED'], JSON.stringify(result));
      assert.deepEqual(brokerClaims(stack.database), []);
      assert.deepEqual(stack.human.decided.map((d) => d.decision), ['deny']);
      assert.deepEqual(stack.journal.get('flow-deny').outcome, { code: 'human_denied' });
      const again = await stack.flow.run({ operationId: 'flow-deny', action: ACTION });
      assert.equal(again.replayed, true);
      assert.equal(stack.human.decided.length, 1, 'nobody is asked again');
    }, { decide: () => 'deny' });
  });

  it('the Broker restarts between the fence and the claim: the old receipt is not mixed with the new epoch; the flow fences, submits and is approved again, and one claim is recorded', async () => {
    await withStack(async (stack) => {
      let restarted = false;
      stack.hooks.afterStatus = async (reply) => {
        if (reply.ok && reply.state === 'approved' && !restarted) { restarted = true; await stack.restartBroker(); }
      };
      const result = await stack.flow.run({ operationId: 'flow-epoch', action: ACTION });
      assert.equal(result.status, 'claimed', JSON.stringify(result));
      assert.deepEqual([result.cycle, result.brokerEpoch], [2, 2]);
      assert.equal(stack.human.decided.length, 2, 'the human approved once per cycle');
      assert.notEqual(stack.human.decided[0].approvalId, stack.human.decided[1].approvalId);
      const stored = stack.journal.get('flow-epoch');
      assert.deepEqual(stored.superseded, [{ cycle: 1, brokerEpoch: 1, leaseGeneration: GENERATION, reason: 'epoch_changed' }]);
      assert.equal(stored.idempotencyKey, 'flow-epoch.c2');
      assert.deepEqual(brokerClaims(stack.database), [{ operation_id: 'flow-epoch', state: 'UNKNOWN', lease_generation: GENERATION }]);
    });
  });

  it('the Broker commits the claim but its reply is lost (held past the client timeout): the flow ends UNKNOWN, asks inspect, and finds the one claim without a second receipt', async () => {
    await withStack(async (stack) => {
      const result = await stack.flow.run({ operationId: 'flow-timeout', action: ACTION });
      assert.equal(result.status, 'claimed', JSON.stringify(result));
      assert.deepEqual([result.reconciled, result.replayed, result.cycle], [true, false, 1]);
      assert.ok(stack.journal.history.some((h) => h.phase === 'UNKNOWN'), 'the lost reply was recorded as UNKNOWN first');
      assert.equal(stack.human.decided.length, 1, 'no second approval, no second receipt');
      assert.deepEqual(brokerClaims(stack.database), [{ operation_id: 'flow-timeout', state: 'UNKNOWN', lease_generation: GENERATION }]);
    }, { hold: 2500, claimTimeoutMs: 500 });
  });
});
