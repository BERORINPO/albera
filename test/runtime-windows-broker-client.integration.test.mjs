import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sendBrokerFence, sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';
import {
  GENERATION, brokerSession, buildBroker, buildPipeClient, createTestAuthority, currentUserSid, getUnavailableReason, inspectClaimCount, makeTrustedTempDirectory,
  stableUuid, startBroker, waitForExit, waitForLine,
} from './helpers/windows-broker-harness.mjs';

// Windows-only: the Node client (through the trusted .NET pipe client helper) drives the REAL built .NET Broker over a real Named Pipe
// (same-user, ephemeral pipe, temp journal). Skipped where the .NET 10 SDK/runtime is unavailable. The Broker is started here by the test,
// never by the client. Server-identity refusals are in runtime-windows-broker-server-identity.test.mjs.
// The shipped one-shot `serve` answers fence requests and exits after the first request that is not one.
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const REPLAYED = { ...SUCCESS, replayed: true };
const DENIED = { ok: false, code: 'denied' };

describe('Node client against the real .NET Host Broker Named Pipe', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, helper, sid;
  const authority = createTestAuthority();
  const running = new Set();

  before(async () => {
    root = makeTrustedTempDirectory('albera-broker-client-');
    brokerExe = buildBroker(path.join(root, 'broker'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
  });

  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Start one Broker, run `use(session, child)`, then wait for it to exit (unless `hold`, then it is killed). */
  async function withBroker(db, use, { hold = false } = {}) {
    const pipeName = `ALBERA_ClientTest_${randomBytes(8).toString('hex')}`;
    const child = startBroker(brokerExe, pipeName, db, authority.serveArgument, sid, GENERATION, hold);
    running.add(child);
    try {
      await waitForLine(child, 'BROKER_READY');
      const value = await use(brokerSession({ helper, sid, pipeName, pid: child.pid, authority }), child);
      if (!hold) await waitForExit(child);
      return { value, lines: [...child.lines] };
    } finally {
      if (child.closeCode === undefined) { child.kill(); await waitForExit(child); }
      running.delete(child);
    }
  }
  const freshDb = () => path.join(root, `journal-${randomBytes(6).toString('hex')}.sqlite`);
  const claims = (db) => inspectClaimCount(brokerExe, db);

  it('authorized request is claimed exactly once; an exact replay gets the recorded outcome (replayed: true) and a second receipt for the same operation is denied', async () => {
    const db = freshDb();
    let request;
    const first = await withBroker(db, async (session) => { const made = await session.claim('client'); request = made.request; return made.result; });
    assert.deepEqual(first.value, SUCCESS, 'the first claim has no `replayed` key');
    assert.ok(first.lines.includes('PEER=authenticated') && first.lines.includes('CLAIM=PERSISTED_UNKNOWN'), first.lines.join('|'));
    assert.equal(claims(db), 1);

    const replay = await withBroker(db, (session) => session.send(request));
    assert.deepEqual(replay.value, REPLAYED, 'exact duplicate: the recorded outcome, not a bare denial');
    assert.ok(replay.lines.includes('REPLAY=RECORDED_OUTCOME') && !replay.lines.includes('CLAIM=PERSISTED_UNKNOWN'), replay.lines.join('|'));
    assert.equal(claims(db), 1, 'a replay writes no row');

    const duplicate = await withBroker(db, async (session) => (await session.claim('client', { receiptId: stableUuid('other-receipt'), approvalId: stableUuid('other-approval') })).result);
    assert.deepEqual(duplicate.value, DENIED);
    assert.ok(duplicate.lines.includes('DENY=duplicate'), duplicate.lines.join('|'));
    assert.equal(claims(db), 1, 'no second claim row');
  });

  it('stale generation, a digest that is not the one computed from the trusted DTO, and an edited receipt are denied and leave no claim', async () => {
    const db = freshDb();
    const stale = await withBroker(db, async (session) => (await session.claim('stale', (fence) => ({ leaseGeneration: fence.leaseGeneration - 1 }))).result);
    assert.deepEqual(stale.value, DENIED);
    assert.ok(stale.lines.includes('DENY=generation_stale'), stale.lines.join('|'));

    const wrongDigest = await withBroker(db, async (session) => (await session.claim('digest', { actionDigest: `sha256:${'0'.repeat(64)}` })).result);
    assert.deepEqual(wrongDigest.value, DENIED);
    assert.ok(wrongDigest.lines.includes('DENY=action_digest'), wrongDigest.lines.join('|'));

    const edited = await withBroker(db, async (session) => {
      const good = await session.prepare('edited');
      return session.send({ receipt: Buffer.from(Buffer.from(good.receipt, 'base64').toString('utf8').replace('edited-op', 'edited-ox')).toString('base64'), signature: good.signature });
    });
    assert.deepEqual(edited.value, DENIED);
    assert.ok(edited.lines.includes('DENY=signature'), edited.lines.join('|'));
    assert.equal(claims(db), 0);
  });

  it('an oversized message is refused by the client before the pipe is used, and the Broker is still free for a valid request', async () => {
    const db = freshDb();
    const { value, lines } = await withBroker(db, async (session, child) => {
      const oversized = await sendBrokerRequest({ pipeName: session.pipeName, receipt: 'A'.repeat(4096), signature: 'A'.repeat(88), expect: { ownerSid: sid, pid: child.pid }, helperPath: helper });
      assert.deepEqual(oversized, { ok: false, code: 'request_too_large' });
      assert.equal(child.lines.some((line) => line.startsWith('PEER=')), false, 'the Broker never saw a connection');
      return (await session.claim('size')).result;
    });
    assert.deepEqual(value, SUCCESS);
    assert.equal(lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 1);
    assert.equal(claims(db), 1);
  });

  it('fence through the real helper: the reply has exactly the five keys, and the one-shot Broker is still free for the claim that follows', async () => {
    const db = freshDb();
    const { value } = await withBroker(db, async (session, child) => {
      const fence = await sendBrokerFence({ pipeName: session.pipeName, computerId: 'computer-1', expect: { ownerSid: sid, pid: child.pid }, helperPath: helper, timeoutMs: 10_000 });
      assert.deepEqual(Object.keys(fence).sort(), ['brokerChallenge', 'brokerEpoch', 'leaseGeneration', 'leaseId', 'ok']);
      return (await session.claim('after-fence')).result;
    });
    assert.deepEqual(value, SUCCESS);
  });

  it('a missing pipe and a Broker that holds its answer map to fixed codes; the held claim stays durable', async () => {
    assert.deepEqual(await sendBrokerFence({ pipeName: `ALBERA_ClientTest_missing_${randomBytes(4).toString('hex')}`, computerId: 'computer-1', expect: { ownerSid: sid, pid: 4_000_000 }, helperPath: helper, timeoutMs: 2000 }), { ok: false, code: 'broker_unavailable' });
    const db = freshDb();
    const { value, lines } = await withBroker(db, async (session, child) => {
      const request = await session.prepare('hold');
      const pending = sendBrokerRequest({ ...session.common(), receipt: request.receipt, signature: request.signature, timeoutMs: 1500 });
      await waitForLine(child, 'CLAIM=PERSISTED_UNKNOWN');
      return pending;
    }, { hold: true });
    assert.deepEqual(value, { ok: false, code: 'timeout' });
    assert.ok(lines.includes('CLAIM=PERSISTED_UNKNOWN'));
    assert.equal(claims(db), 1);
  });
});
