import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';
import {
  GENERATION, buildBroker, buildPipeClient, currentUserSid, digest, getUnavailableReason, inspectClaimCount, makeReceipt, signReceipt,
  startBroker, waitForExit, waitForLine,
} from './helpers/windows-broker-harness.mjs';

// Windows-only: the Node client (through the trusted .NET pipe client helper) drives the REAL built .NET Broker over a real Named Pipe
// (same-user, ephemeral pipe, temp journal). Skipped where the .NET 10 SDK/runtime is unavailable. The Broker is started here by the test,
// never by the client. Server-identity refusals are in runtime-windows-broker-server-identity.test.mjs.
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const DENIED = { ok: false, code: 'denied' };

describe('Node client against the real .NET Host Broker Named Pipe', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, helper, sid;
  const running = new Set();

  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-broker-client-'));
    brokerExe = buildBroker(path.join(root, 'broker'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
  });

  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Start one Broker (it serves exactly one connection), run `use(pipeName, child)`, then wait for it to exit. */
  async function withBroker(db, signed, use, { generation = GENERATION, hold = false } = {}) {
    const pipeName = `ALBERA_ClientTest_${randomBytes(8).toString('hex')}`;
    const child = startBroker(brokerExe, pipeName, db, signed.publicKey, sid, generation, hold);
    running.add(child);
    try {
      await waitForLine(child, 'BROKER_READY');
      const value = await use(pipeName, child);
      if (!hold) await waitForExit(child);
      return { value, lines: [...child.lines] };
    } finally {
      if (child.closeCode === undefined) { child.kill(); await waitForExit(child); }
      running.delete(child);
    }
  }
  const send = (pipeName, signed, child, extra = {}) => sendBrokerRequest({
    pipeName, receipt: signed.receipt, signature: signed.signature, timeoutMs: 10_000, helperPath: helper,
    expect: { ownerSid: sid, pid: child?.pid ?? 4_000_000 }, ...extra,
  });
  const freshDb = () => path.join(root, `journal-${randomBytes(6).toString('hex')}.sqlite`);
  const claims = (db) => inspectClaimCount(brokerExe, db);

  it('authorized request succeeds exactly once; a replay of the same request and a second receipt for the same operation are denied', async () => {
    const db = freshDb();
    const signed = signReceipt(makeReceipt('client-op', 'client-approval', 'client-receipt'));
    const first = await withBroker(db, signed, (pipe, child) => send(pipe, signed, child));
    assert.deepEqual(first.value, SUCCESS);
    assert.ok(first.lines.includes('PEER=authenticated') && first.lines.includes('CLAIM=PERSISTED_UNKNOWN'), first.lines.join('|'));
    assert.equal(claims(db), 1);

    const replay = await withBroker(db, signed, (pipe, child) => send(pipe, signed, child));
    assert.deepEqual(replay.value, DENIED);
    assert.ok(replay.lines.includes('DENY=duplicate'), replay.lines.join('|'));

    const sameOperation = signReceipt(makeReceipt('client-op', 'other-approval', 'other-receipt'));
    const duplicate = await withBroker(db, sameOperation, (pipe, child) => send(pipe, sameOperation, child));
    assert.deepEqual(duplicate.value, DENIED);
    assert.ok(duplicate.lines.includes('DENY=duplicate'), duplicate.lines.join('|'));
    assert.equal(claims(db), 1, 'no second claim row');
  });

  it('stale generation and a tampered digest are denied and leave no claim', async () => {
    const db = freshDb();
    const stale = signReceipt(makeReceipt('stale-op', 'stale-approval', 'stale-receipt', { leaseGeneration: GENERATION - 1 }));
    const staleRun = await withBroker(db, stale, (pipe, child) => send(pipe, stale, child));
    assert.deepEqual(staleRun.value, DENIED);
    assert.ok(staleRun.lines.includes('DENY=receipt-policy'), staleRun.lines.join('|'));

    const wrongDigest = signReceipt(makeReceipt('digest-op', 'digest-approval', 'digest-receipt', { actionDigest: digest('shell.exec') }));
    const digestRun = await withBroker(db, wrongDigest, (pipe, child) => send(pipe, wrongDigest, child));
    assert.deepEqual(digestRun.value, DENIED);
    assert.ok(digestRun.lines.includes('DENY=receipt-policy'), digestRun.lines.join('|'));

    const signedOk = signReceipt(makeReceipt('edited-op', 'edited-approval', 'edited-receipt'));
    const edited = { ...signedOk, receipt: Buffer.from(Buffer.from(signedOk.receipt, 'base64').toString('utf8').replace(digest('synthetic.noop'), digest('shell.exec'))).toString('base64') };
    const editedRun = await withBroker(db, edited, (pipe, child) => send(pipe, edited, child));
    assert.deepEqual(editedRun.value, DENIED);
    assert.ok(editedRun.lines.includes('DENY=signature'), editedRun.lines.join('|'));
    assert.equal(claims(db), 0);
  });

  it('an oversized message is refused by the client before the pipe is used, and the Broker is still free for a valid request', async () => {
    const db = freshDb();
    const signed = signReceipt(makeReceipt('size-op', 'size-approval', 'size-receipt'));
    const { value, lines } = await withBroker(db, signed, async (pipe, child) => {
      const oversized = await sendBrokerRequest({ pipeName: pipe, receipt: 'A'.repeat(4096), signature: signed.signature, expect: { ownerSid: sid, pid: child.pid }, helperPath: helper });
      assert.deepEqual(oversized, { ok: false, code: 'request_too_large' });
      assert.equal(child.lines.some((line) => line.startsWith('PEER=')), false, 'the Broker never saw a connection');
      return send(pipe, signed, child);
    });
    assert.deepEqual(value, SUCCESS);
    assert.equal(lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 1);
    assert.equal(claims(db), 1);
  });

  it('a missing pipe and a Broker that holds its answer map to fixed codes; the held claim stays durable', async () => {
    const signed = signReceipt(makeReceipt('hold-op', 'hold-approval', 'hold-receipt'));
    assert.deepEqual(await send(`ALBERA_ClientTest_missing_${randomBytes(4).toString('hex')}`, signed, undefined, { timeoutMs: 2000 }), { ok: false, code: 'broker_unavailable' });
    const db = freshDb();
    const { value, lines } = await withBroker(db, signed, async (pipe, child) => {
      const pending = send(pipe, signed, child, { timeoutMs: 1500 });
      await waitForLine(child, 'CLAIM=PERSISTED_UNKNOWN');
      return pending;
    }, { hold: true });
    assert.deepEqual(value, { ok: false, code: 'timeout' });
    assert.ok(lines.includes('CLAIM=PERSISTED_UNKNOWN'));
    assert.equal(claims(db), 1);
  });
});
