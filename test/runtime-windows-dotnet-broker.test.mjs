import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildBroker, createTestAuthority, currentUserSid, getUnavailableReason, inspectClaimCount, makeTrustedTempDirectory, rawFencedClaim, rawRequest, signedReceipt,
  startBroker, waitForExit, waitForLine, GENERATION,
} from './helpers/windows-broker-harness.mjs';

// The shipped one-shot Broker (`serve`) over a real Named Pipe, with the receipt v2 flow: fence -> sign with a separate ephemeral authority -> claim.
// `serve` answers fence requests and exits after the first request that is not one, so every scenario below starts its own Broker.
const unavailableReason = getUnavailableReason();
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const REPLAYED = { ...SUCCESS, replayed: true };
const DENIED = { ok: false, code: 'denied' };
const pipeName = () => `ALBERA_Issue22_${randomBytes(8).toString('hex')}`;

test('Node Control Plane uses an independent .NET Broker over a real Named Pipe and durable signed claims', { skip: unavailableReason }, async () => {
  const root = makeTrustedTempDirectory('albera-issue22-broker-');
  let active;
  try {
    const brokerExe = buildBroker(path.join(root, 'out'));
    const sid = currentUserSid();
    const authority = createTestAuthority();
    const start = (pipe, db, hold = false) => { active = startBroker(brokerExe, pipe, db, authority.serveArgument, sid, GENERATION, hold); return active; };
    const db = path.join(root, 'broker-owned-journal.sqlite');
    let pipe = pipeName();
    start(pipe, db);
    await waitForLine(active, 'BROKER_READY');
    const accepted = await rawFencedClaim(pipe, authority, 'accepted');
    assert.deepEqual(accepted.reply, SUCCESS);
    await waitForExit(active); active = null;
    pipe = pipeName();
    start(pipe, db);
    await waitForLine(active, 'BROKER_READY');
    assert.deepEqual(await rawRequest(pipe, accepted.request), REPLAYED, 'exact duplicate after a restart: the recorded outcome');
    await waitForExit(active); active = null;
    assert.equal(inspectClaimCount(brokerExe, db), 1);

    const crashDb = path.join(root, 'broker-owned-crash-journal.sqlite');
    pipe = pipeName();
    start(pipe, crashDb, true);
    await waitForLine(active, 'BROKER_READY');
    const fence = await rawRequest(pipe, { fence: { computerId: 'computer-1' } });
    const crashed = signedReceipt({ authority, fence, name: 'restart-replay' });
    const pending = rawRequest(pipe, crashed);
    await waitForLine(active, 'CLAIM=PERSISTED_UNKNOWN');
    active.kill(); // durable claim, intentionally lost response
    await pending.catch(() => {}); await waitForExit(active); active = null;

    const retryPipe = pipeName();
    start(retryPipe, crashDb);
    await waitForLine(active, 'BROKER_READY');
    assert.deepEqual(await rawRequest(retryPipe, crashed), REPLAYED, 'the lost reply is answered from the journal, never claimed twice');
    await waitForExit(active); active = null;
    assert.equal(inspectClaimCount(brokerExe, crashDb), 1);

    /** A fresh Broker, a fence, then `mutate(request, fence)` and the claim: denied, and no claim recorded. */
    const assertDenied = async (name, overrides, mutate = (request) => request) => {
      const deniedDb = path.join(root, `${pipeName()}.sqlite`), deniedPipe = pipeName();
      const broker = start(deniedPipe, deniedDb);
      try {
        await waitForLine(broker, 'BROKER_READY');
        const denied = await rawFencedClaim(deniedPipe, authority, name, overrides, mutate);
        assert.deepEqual(denied.reply, DENIED, name);
      } finally { await waitForExit(broker); active = null; }
      assert.equal(inspectClaimCount(brokerExe, deniedDb), 0, name);
    };
    await assertDenied('altered', {}, (request) => ({ receipt: Buffer.from(Buffer.from(request.receipt, 'base64').toString('utf8').replace('synthetic.noop', 'shell.exec')).toString('base64'), signature: request.signature }));
    await assertDenied('expired', { now: Math.floor(Date.now() / 1000) - 600 });
    await assertDenied('stale', (fenceReply) => ({ leaseGeneration: fenceReply.leaseGeneration - 1 }));
    await assertDenied('unfenced', { brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' });

    const secretDb = path.join(root, 'secret-denial.sqlite'), secretPipe = pipeName();
    const secretBroker = start(secretPipe, secretDb);
    await waitForLine(secretBroker, 'BROKER_READY');
    assert.deepEqual(await rawRequest(secretPipe, { receipt: 'SYNTHETIC_SECRET_MARKER', signature: 'SYNTHETIC_SECRET_MARKER', error: 'SYNTHETIC_SECRET_MARKER' }), DENIED);
    await waitForExit(secretBroker); active = null;
    assert.equal(secretBroker.lines.join('|').includes('SYNTHETIC_SECRET_MARKER'), false);
    assert.equal(inspectClaimCount(brokerExe, secretDb), 0);
    // ADR-002 bounds a protocol message at 2 KiB: a 2049..4096-byte frame is refused while reading, before the peer check.
    const largeDb = path.join(root, 'oversized-frame.sqlite'), largePipe = pipeName();
    const largeBroker = start(largePipe, largeDb);
    await waitForLine(largeBroker, 'BROKER_READY');
    // The Broker may close the pipe before the oversized body is fully written; a refusal or a closed write are both a denial.
    const large = await rawRequest(largePipe, { receipt: 'A'.repeat(2100), signature: 'A' }).catch(() => null);
    assert.ok(large === null || (large.ok === false && large.code === 'denied'));
    await waitForExit(largeBroker); active = null;
    assert.equal(largeBroker.lines.some((line) => line.startsWith('PEER=')), false);
    assert.ok(largeBroker.lines.includes('REQUEST=DENIED'));
    assert.equal(inspectClaimCount(brokerExe, largeDb), 0);
    process.stdout.write('BROKER_TRANSPORT=real local Windows Named Pipe; peer SID from OS impersonation token\n');
    process.stdout.write('APPROVAL=separate ephemeral ECDSA signer over a Broker-issued challenge; tampered, expired, stale-generation and unfenced receipts denied\n');
    process.stdout.write('ERRORS=fixed denial; synthetic secret marker absent from broker response/logs\n');
    process.stdout.write('ACCEPT=authorized exact fixed-action receipt stored as UNKNOWN; exact duplicate returns the recorded outcome with replayed=true\n');
    process.stdout.write('RESTART_REPLAY=force-killed after durable claim; restart returned the recorded outcome for the same signed receipt; crash journal rows=1\n');
    process.stdout.write('PROVIDER=synthetic noop; no provider process, Hyper-V or side effect\n');
    process.stdout.write('LIMITS=same-user ephemeral token proof only; service identity and persistent ACL NOT_VERIFIED\n');
  } finally {
    if (active) { active.kill(); await waitForExit(active); }
    rmSync(root, { recursive: true, force: true });
  }
});
