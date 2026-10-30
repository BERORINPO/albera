import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { BROKER_CLIENT_PRESEND_CODES, sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';
import {
  buildBroker, buildPipeClient, buildProbe, currentUserSid, getUnavailableReason, inspectClaimCount, makeReceipt, signReceipt,
  startBroker, startProcess, waitForExit, waitForLine, GENERATION,
} from './helpers/windows-broker-harness.mjs';

// Windows-only: the Node client + the trusted .NET pipe client helper + the REAL Broker, plus hostile same-user pipe servers.
// Same-user, unprivileged, random pipe names, temp journals. No service, ACL, admin or Hyper-V. Skipped without the .NET 10 SDK.
// Proves the SAME-USER verification only; service identity (SCM PID, NT SERVICE owner, session 0) stays lab-only (#23).
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const MISMATCH = { ok: false, code: 'server_identity_mismatch' };

describe('Broker pipe client verifies the pipe server before it writes', { skip: getUnavailableReason() }, () => {
  let root, brokerExe, helper, probeExe, sid, brokerImage;
  const running = new Set();

  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-server-identity-'));
    brokerExe = buildBroker(path.join(root, 'broker'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    probeExe = buildProbe(path.join(root, 'probe'));
    sid = currentUserSid();
    brokerImage = (await captureExecutableIdentity(brokerExe)).sha256;
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  const pipeName = () => `ALBERA_Identity_${randomBytes(8).toString('hex')}`;
  const freshDb = () => path.join(root, `journal-${randomBytes(6).toString('hex')}.sqlite`);
  const claims = (db) => inspectClaimCount(brokerExe, db);
  const expectBroker = (child, overrides = {}) => ({ ownerSid: sid, pid: child.pid, imageSha256: brokerImage, ...overrides });
  const countingSpawn = (counter) => (...args) => { counter.spawns += 1; return spawn(...args); };
  const send = (pipe, signed, expect, extra = {}) => sendBrokerRequest({ pipeName: pipe, receipt: signed.receipt, signature: signed.signature, expect, helperPath: helper, timeoutMs: 10_000, ...extra });
  const probe = async (pipe, mode) => { const child = track(startProcess(probeExe, ['serve', pipe, mode])); const ready = await waitForLine(child, /^READY pid=\d+$/u); return { child, pid: Number(ready.split('=')[1]) }; };
  const lineValue = (child, key) => child.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

  /** One real Broker (it serves exactly one connection): run `use`, wait for it to exit (unless `hold`, then it is killed), return what it did. */
  async function withBroker(db, signed, use, { hold = false } = {}) {
    const pipe = pipeName();
    const child = track(startBroker(brokerExe, pipe, db, signed.publicKey, sid, GENERATION, hold));
    try {
      await waitForLine(child, 'BROKER_READY');
      const value = await use(pipe, child);
      if (!hold) await waitForExit(child);
      return { value, pipe, pid: child.pid, lines: [...child.lines] };
    } finally {
      if (child.closeCode === undefined) { child.kill(); await waitForExit(child); }
    }
  }

  it('real Broker with matching owner SID, PID and image hash: ok, exactly one claim, one helper spawn', async () => {
    const db = freshDb();
    const signed = signReceipt(makeReceipt('id-ok-op', 'id-ok-approval', 'id-ok-receipt'));
    const counter = { spawns: 0 };
    const run = await withBroker(db, signed, (pipe, broker) => send(pipe, signed, expectBroker(broker), { spawnImpl: countingSpawn(counter) }));
    assert.deepEqual(run.value, SUCCESS);
    assert.equal(counter.spawns, 1);
    assert.ok(run.lines.includes('PEER=authenticated') && run.lines.includes('CLAIM=PERSISTED_UNKNOWN'), run.lines.join('|'));
    assert.equal(claims(db), 1);
  });

  it('squatter that takes the name after the Broker exited: server_identity_mismatch and the squatter receives 0 bytes (.NET and Node)', async () => {
    const db = freshDb();
    const first = signReceipt(makeReceipt('squat-op-1', 'squat-approval-1', 'squat-receipt-1'));
    const served = await withBroker(db, first, (pipe, broker) => send(pipe, first, expectBroker(broker)));
    assert.deepEqual(served.value, SUCCESS);
    assert.equal(claims(db), 1);
    const deadBroker = { ownerSid: sid, pid: served.pid, imageSha256: brokerImage };
    const second = signReceipt(makeReceipt('squat-op-2', 'squat-approval-2', 'squat-receipt-2'));

    const dotnet = await probe(served.pipe, 'reply'); // owned by the same user, so the owner check passes: only the PID can tell it apart
    assert.deepEqual(await send(served.pipe, second, deadBroker), MISMATCH);
    await waitForExit(dotnet.child);
    assert.equal(lineValue(dotnet.child, 'BYTES'), '0', dotnet.child.lines.join('|'));

    const squatter = { connections: 0, bytes: 0 };
    const server = net.createServer((socket) => { squatter.connections += 1; socket.on('data', (data) => { squatter.bytes += data.length; }); socket.on('error', () => {}); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${served.pipe}`, resolve); });
    try {
      assert.deepEqual(await send(served.pipe, second, deadBroker), MISMATCH);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(squatter.bytes, 0);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    assert.equal(claims(db), 1, 'no second claim');
  });

  it('control for the squatter test: the same .NET fake with its own PID is accepted, so the PID check was what refused it', async () => {
    const signed = signReceipt(makeReceipt('control-op', 'control-approval', 'control-receipt'));
    const pipe = pipeName();
    const fake = await probe(pipe, 'reply');
    assert.deepEqual(await send(pipe, signed, { ownerSid: sid, pid: fake.pid }), { ok: false, code: 'denied' });
    await waitForExit(fake.child);
    assert.ok(Number(lineValue(fake.child, 'BYTES')) > 4, fake.child.lines.join('|'));
  });

  it('wrong owner SID, wrong PID or wrong image hash against the real Broker: mismatch and no claim', async () => {
    const wrong = {
      'owner SID': (broker) => expectBroker(broker, { ownerSid: 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555' }),
      'PID': (broker) => expectBroker(broker, { pid: broker.pid + 4 }),
      'image hash': (broker) => expectBroker(broker, { imageSha256: '0'.repeat(64) }),
    };
    for (const [label, expectation] of Object.entries(wrong)) {
      const db = freshDb();
      const signed = signReceipt(makeReceipt(`wrong-${label}`, `wrong-approval-${label}`, `wrong-receipt-${label}`));
      const run = await withBroker(db, signed, (pipe, broker) => send(pipe, signed, expectation(broker)));
      assert.deepEqual(run.value, MISMATCH, label);
      assert.equal(run.lines.includes('CLAIM=PERSISTED_UNKNOWN'), false, label);
      assert.equal(run.lines.includes('PEER=authenticated'), false, label);
      assert.equal(claims(db), 0, label);
    }
  });

  it('SQOS: a server that impersonates the client gets Identification level, while a plain client would give Impersonation', async () => {
    const signed = signReceipt(makeReceipt('sqos-op', 'sqos-approval', 'sqos-receipt'));
    const pipe = pipeName();
    const fake = await probe(pipe, 'impersonate');
    assert.deepEqual(await send(pipe, signed, { ownerSid: sid, pid: fake.pid }), { ok: false, code: 'denied' });
    await waitForExit(fake.child);
    assert.ok(Number(lineValue(fake.child, 'BYTES')) > 4, 'the helper passed the identity check and sent the frame');
    assert.equal(lineValue(fake.child, 'IMPERSONATION'), 'Identification', fake.child.lines.join('|'));

    const controlPipe = pipeName();
    const control = await probe(controlPipe, 'impersonate');
    const client = track(startProcess(probeExe, ['client', controlPipe]));
    await waitForExit(client);
    await waitForExit(control.child);
    assert.equal(lineValue(control.child, 'IMPERSONATION'), 'Impersonation', 'the detector sees a higher level when the client does not use SQOS identification');
  });

  it('tampered helper or manifest: helper_unavailable, zero spawns, the Broker never sees a connection', async () => {
    const signed = signReceipt(makeReceipt('tamper-op', 'tamper-approval', 'tamper-receipt'));
    const db = freshDb();
    const cases = {
      'manifest hash changed': (exe) => writeFileSync(`${exe}.manifest.json`, JSON.stringify({ sha256: 'f'.repeat(64) })),
      'helper bytes changed': (exe) => appendFileSync(exe, Buffer.from([0])),
      'manifest missing': (exe) => rmSync(`${exe}.manifest.json`),
      'manifest malformed': (exe) => writeFileSync(`${exe}.manifest.json`, '{"sha256": "not-a-digest"}'),
    };
    const run = await withBroker(db, signed, async (pipe, broker) => {
      const results = [];
      for (const [label, tamper] of Object.entries(cases)) {
        const directory = path.join(root, `tampered-${randomBytes(4).toString('hex')}`);
        mkdirSync(directory);
        const copy = path.join(directory, 'albera-windows-broker-pipe-client.exe');
        copyFileSync(helper, copy);
        copyFileSync(`${helper}.manifest.json`, `${copy}.manifest.json`);
        tamper(copy);
        const counter = { spawns: 0 };
        results.push([label, await send(pipe, signed, expectBroker(broker), { helperPath: copy, spawnImpl: countingSpawn(counter) }), counter.spawns]);
      }
      return results;
    }, { hold: true });
    for (const [label, result, spawns] of run.value) {
      assert.deepEqual(result, { ok: false, code: 'helper_unavailable' }, label);
      assert.equal(spawns, 0, label);
    }
    assert.equal(run.lines.some((line) => line.startsWith('PEER=')), false, 'no connection reached the Broker');
    assert.equal(claims(db), 0);
  });

  it('a server that hangs up after the frame was sent gives a post-send code, never a pre-send one', async () => {
    const signed = signReceipt(makeReceipt('drop-op', 'drop-approval', 'drop-receipt'));
    const pipe = pipeName();
    const fake = await probe(pipe, 'drop');
    const result = await send(pipe, signed, { ownerSid: sid, pid: fake.pid });
    await waitForExit(fake.child);
    assert.ok(Number(lineValue(fake.child, 'BYTES')) > 4, 'the frame did reach the fake');
    assert.equal(result.ok, false);
    assert.ok(['invalid_response', 'transport_error', 'timeout'].includes(result.code), result.code);
    assert.equal(BROKER_CLIENT_PRESEND_CODES.includes(result.code), false, 'outcome unknown: must not look retry-safe');
  });

  it('service mode fails closed before sending: a missing service is unavailable, an unrelated service is not the server', async () => {
    const signed = signReceipt(makeReceipt('svc-op', 'svc-approval', 'svc-receipt'));
    for (const [serviceName, accepted] of [[`AlberaNoSuchService${randomBytes(4).toString('hex')}`, ['server_identity_unavailable']], ['EventLog', ['server_identity_mismatch', 'server_identity_unavailable']]]) {
      const pipe = pipeName();
      const fake = await probe(pipe, 'reply');
      const result = await send(pipe, signed, { serviceName });
      assert.equal(result.ok, false, serviceName);
      assert.ok(accepted.includes(result.code), `${serviceName}: ${result.code}`);
      assert.ok(BROKER_CLIENT_PRESEND_CODES.includes(result.code));
      fake.child.kill();
      await waitForExit(fake.child);
      assert.ok([undefined, '0'].includes(lineValue(fake.child, 'BYTES')), `${serviceName}: the fake received data: ${fake.child.lines.join('|')}`);
    }
  });
});
