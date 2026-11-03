import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { readPngHeader } from '../src/runtime/desktop-broker-client-contract.mjs';
import { syntheticPng } from '../src/runtime/mock-desktop-broker.mjs';
import { createWindowsDesktopBrokerClient } from '../src/runtime/windows-desktop-broker-client.mjs';
import {
  brokerSession, buildBrokerWithTestSeams, buildPipeClient, buildProbe, createTestAuthority, currentUserSid, getUnavailableReason, makeTrustedTempDirectory, nodePipeOwnerSid,
  standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged: the Node client + the REAL pipe client helper in desktop mode against (a) the real Broker service loop (test-faults build, the same one the desktop
// pipe tests use), (b) hostile same-user pipe servers that must receive no byte, and (c) a Node stand-in for the Broker's desktop pipe, the only way to reach a SUCCESSFUL capture without
// a VM (the Broker's own success path is the opt-in live test at the bottom). No VM is touched and no input reaches one: the configured VM GUID does not exist, so an input that passes every
// check of the Broker ends in `desktop_unavailable` at its adapter. Proves the SAME-USER verification only; the service identity (SCM PID, owner, session 0) stays lab-only (#23).
const NO_SUCH_VM = '0123abcd-4567-89ab-cdef-000000000001'; // a GUID that no Hyper-V host has
const COMPUTERS = [{ computerId: 'room-1', vmId: NO_SUCH_VM }];
const ROOM = { vmId: 'room-1', width: 640, height: 480 };
const CLICK = { action: 'left_click', coordinate: [10, 20] };
const TASK_SUCCESS = { ok: true, state: 'UNKNOWN', action: 'task.start' };
const PLAIN_ARGS = { task: 'build the project' };
const MAX_PNG = 8 * 1024 * 1024;
const NOT_APPLIED_DENIED = { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'denied' };
const MISMATCH = { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'server_identity_mismatch' };

const frameOf = (value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length);
  return Buffer.concat([head, body]);
};
const shapeOf = (error) => ({ code: error.code, outcome: error.outcome, brokerCode: error.brokerCode });
const failure = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 10_000) {
  for (const limit = Date.now() + ms; !condition();) {
    assert.ok(Date.now() < limit, `timeout: ${what}`);
    await sleep(20);
  }
}
/** A PNG of the given total size: a valid signature and IHDR for width x height, then filler. */
const pngOfSize = (width, height, size) => Buffer.concat([syntheticPng(width, height).subarray(0, 33), Buffer.alloc(size - 33, 0x5a)]);

describe('desktop Broker client: the real helper, the real Broker, hostile servers and a stand-in desktop pipe', { skip: getUnavailableReason(), timeout: 600_000 }, () => {
  let root, loopExe, helper, probeExe, sid, nodeOwner;
  const authority = createTestAuthority();
  const running = new Set();
  const clients = new Set();
  const servers = new Set();
  before(async () => {
    root = makeTrustedTempDirectory('albera-desktop-client-it-');
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    probeExe = buildProbe(path.join(root, 'probe'));
    sid = currentUserSid();
    nodeOwner = nodePipeOwnerSid(); // owner of the Node-made pipes (Administrators when elevated)
  });
  after(async () => {
    for (const client of clients) await client.close();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const unique = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  /** A client over the real helper; every client is closed at the end. `spawnImpl` can count spawns. */
  function clientFor(pipeName, expect, options = {}) {
    const client = createWindowsDesktopBrokerClient({ pipeName, expect, helperPath: helper, openTimeoutMs: 10_000, captureTimeoutMs: 20_000, inputTimeoutMs: 20_000, ...options });
    clients.add(client);
    return client;
  }

  // ---- (a) the real Broker --------------------------------------------------------------------------------------------------------------------------------------------------
  async function startBroker(name, computers = COMPUTERS) {
    const config = { pipeName: unique('ALBERA_DeskCli'), database: path.join(root, `${name}.sqlite`), authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG, computers };
    const file = path.join(root, `${name}.config.json`);
    writeFileSync(file, JSON.stringify(config));
    const child = track(startProcess(loopExe, standInService('serve-loop', file), { stdin: true }));
    await waitForLine(child, 'BROKER_READY');
    const claims = brokerSession({ helper, sid, pipeName: config.pipeName, pid: child.pid, authority });
    return { child, config, claims, expect: { ownerSid: sid, pid: child.pid }, client: (options) => clientFor(config.pipeName, { ownerSid: sid, pid: child.pid }, options) };
  }
  async function stopBroker({ child }) {
    child.stdin.end();
    assert.equal(await waitForExit(child), 0);
  }
  const logged = (child, prefix) => child.lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
  /** A task.start claim over the real claim pipe: the only thing that makes a lease. Returns the operationId. */
  async function claimTaskStart(claims, name, computerId = 'room-1') {
    const prepared = await claims.prepare(name, { purpose: 'guest.command', action: 'task.start', args: PLAIN_ARGS, computerId });
    assert.deepEqual(await claims.send({ ...prepared, action: { action: 'task.start', projectId: 'project-1', computerId, args: PLAIN_ARGS } }), TASK_SUCCESS);
    return `${name}-op`;
  }

  it('a view session through the real helper: a capture of a VM the host does not have ends in the fixed denied, the Broker logs the reason, the next call opens a new session', async () => {
    const broker = await startBroker('view');
    const client = broker.client();
    const error = await failure(client.captureVmScreen(ROOM));
    assert.deepEqual(shapeOf(error), { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'denied' });
    await until(() => logged(broker.child, 'DESKTOP_DENY=').length === 1, 'the logged reason');
    assert.deepEqual(logged(broker.child, 'DESKTOP_DENY='), ['desktop_unavailable']);
    assert.ok(broker.child.lines.includes('DESKTOP_PEER=authenticated') && broker.child.lines.includes('DESKTOP=OPENED'));
    assert.equal(broker.child.lines.join('\n').includes(NO_SUCH_VM), false, 'the log names no VM GUID');
    assert.equal((await failure(client.captureVmScreen(ROOM))).brokerCode, 'denied');
    await until(() => broker.child.lines.filter((line) => line === 'DESKTOP=OPENED').length === 2, 'a second session');
    await client.close();
    await stopBroker(broker);
  });

  it('refuses a computer the Broker was not given, an act open without a claim and a wrong generation at the open: nothing is applied, the Broker logs the word', async () => {
    const broker = await startBroker('refusals');
    const client = broker.client();
    assert.deepEqual(shapeOf(await failure(client.captureVmScreen({ ...ROOM, vmId: 'room-9' }))), NOT_APPLIED_DENIED);
    assert.deepEqual(shapeOf(await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'nobody-op', generation: 1 } }))), NOT_APPLIED_DENIED);
    const operationId = await claimTaskStart(broker.claims, 'gen');
    assert.deepEqual(shapeOf(await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: operationId, generation: 2 } }))), NOT_APPLIED_DENIED);
    assert.deepEqual(shapeOf(await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'other-op', generation: 1 } }))), NOT_APPLIED_DENIED);
    await until(() => logged(broker.child, 'DESKTOP_DENY=').length === 4, 'four logged reasons');
    assert.deepEqual(logged(broker.child, 'DESKTOP_DENY='), ['computer_unknown', 'lease_unknown', 'lease_generation', 'lease_unknown']);
    assert.equal(broker.child.lines.includes('DESKTOP=ACT'), false, 'no act session was ever opened');
    await client.close();
    await stopBroker(broker);
  });

  it('an act session for the lease a task.start claim made: the open is accepted and the input reaches the adapter, which has no such VM (outcome unknown: it was sent); a newer claim ends the older lease', async () => {
    const broker = await startBroker('act');
    const client = broker.client();
    const operationId = await claimTaskStart(broker.claims, 'first');
    const lease = { desktopSessionId: operationId, generation: 1 };
    const error = await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease }));
    assert.deepEqual(shapeOf(error), { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'denied' });
    await until(() => logged(broker.child, 'DESKTOP_DENY=').length === 1, 'the logged reason');
    assert.ok(broker.child.lines.includes('DESKTOP=ACT'), 'the act open was accepted');
    assert.ok(broker.child.lines.includes('DESKTOP_TEST=input_enter'), 'the input passed every check of the Broker and reached the adapter');
    assert.deepEqual(logged(broker.child, 'DESKTOP_DENY='), ['desktop_unavailable']);
    // The same lease opens again (a refusal ends a session, not a lease), the newer claim makes the older lease unusable.
    assert.equal((await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease }))).outcome, 'unknown');
    const second = await claimTaskStart(broker.claims, 'second');
    assert.deepEqual(shapeOf(await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease }))), NOT_APPLIED_DENIED, 'the older lease is gone');
    assert.equal((await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: second, generation: 2 } }))).outcome, 'unknown', 'the newer one reaches the adapter');
    await client.close();
    await stopBroker(broker);
  });

  // ---- (b) hostile servers: the helper must verify before it writes ----------------------------------------------------------------------------------------------------
  const lineValue = (child, key) => child.lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);
  const probe = async (mode = 'reply') => {
    const pipeName = unique('ALBERA_DeskProbe');
    const child = track(startProcess(probeExe, ['serve', `${pipeName}_desktop`, mode]));
    const ready = await waitForLine(child, /^READY pid=\d+$/u);
    return { pipeName, child, pid: Number(ready.split('=')[1]) };
  };

  it('control: a same-user server whose PID and owner match gets the open frame and answers denied; and it sees an Identification-level client only (SQOS)', async () => {
    const fake = await probe('impersonate');
    const error = await failure(clientFor(fake.pipeName, { ownerSid: sid, pid: fake.pid }).captureVmScreen(ROOM));
    await waitForExit(fake.child);
    assert.deepEqual(shapeOf(error), NOT_APPLIED_DENIED);
    assert.ok(Number(lineValue(fake.child, 'BYTES')) > 4, fake.child.lines.join('|'));
    assert.equal(lineValue(fake.child, 'IMPERSONATION'), 'Identification');
  });

  it('a server with the wrong PID, the wrong owner SID or the wrong image hash receives 0 bytes; the error says nothing was applied', async () => {
    const wrongs = {
      'PID': (pid) => ({ ownerSid: sid, pid: pid + 4 }),
      'owner SID': (pid) => ({ ownerSid: 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555', pid }),
      'image hash': (pid) => ({ ownerSid: sid, pid, imageSha256: '0'.repeat(64) }),
    };
    for (const [label, expectation] of Object.entries(wrongs)) {
      const fake = await probe();
      const error = await failure(clientFor(fake.pipeName, expectation(fake.pid)).sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-1', generation: 1 } }));
      assert.deepEqual(shapeOf(error), MISMATCH, label);
      fake.child.kill();
      await waitForExit(fake.child);
      assert.ok([undefined, '0'].includes(lineValue(fake.child, 'BYTES')), `${label}: the fake received data: ${fake.child.lines.join('|')}`);
    }
  });

  it('a squatter that takes the name after the Broker left receives 0 bytes (.NET probe and Node server); nothing listening is broker_unavailable; a missing service is unavailable before any write', async () => {
    const broker = await startBroker('squat');
    const { config, child } = broker;
    await stopBroker(broker);
    const dead = { ownerSid: sid, pid: child.pid };
    const squatted = await probe();
    assert.deepEqual(shapeOf(await failure(clientFor(squatted.pipeName, dead).captureVmScreen(ROOM))), MISMATCH);
    squatted.child.kill();
    await waitForExit(squatted.child);
    assert.ok([undefined, '0'].includes(lineValue(squatted.child, 'BYTES')));

    const stats = { connections: 0, bytes: 0 };
    const server = net.createServer((socket) => { stats.connections += 1; socket.on('data', (data) => { stats.bytes += data.length; }); socket.on('error', () => {}); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${config.pipeName}_desktop`, resolve); });
    try {
      assert.deepEqual(shapeOf(await failure(clientFor(config.pipeName, dead).captureVmScreen(ROOM))), MISMATCH);
      await sleep(300);
      assert.equal(stats.bytes, 0);
    } finally { await new Promise((resolve) => server.close(resolve)); }

    assert.deepEqual(shapeOf(await failure(clientFor(unique('ALBERA_DeskNone'), dead).captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'broker_unavailable' });
    const service = await probe();
    const missing = await failure(clientFor(service.pipeName, { serviceName: `AlberaNoSuchService${randomBytes(4).toString('hex')}` }).captureVmScreen(ROOM));
    assert.deepEqual(shapeOf(missing), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'server_identity_unavailable' });
    service.child.kill();
    await waitForExit(service.child);
    assert.ok([undefined, '0'].includes(lineValue(service.child, 'BYTES')));
  });

  it('a helper or manifest that was changed is helper_unavailable and no process is started', async () => {
    const fake = await probe();
    let spawns = 0;
    const client = clientFor(fake.pipeName, { ownerSid: sid, pid: fake.pid }, { helperPath: `${helper}.missing`, spawnImpl: (...args) => { spawns += 1; return spawn(...args); } });
    assert.deepEqual(shapeOf(await failure(client.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'helper_unavailable' });
    assert.equal(spawns, 0);
    fake.child.kill();
    await waitForExit(fake.child);
  });

  // ---- (c) a Node stand-in for the Broker's desktop pipe: the success path and a server that lies -------------------------------------------------------------------------
  /** A pipe server at `<name>_desktop` owned by this process. `answer(request, ctx)` replies to each frame after the open (`ctx.send(...values)` sends one frame per value; `ctx.end()` hangs up). */
  async function standIn(answer) {
    const pipeName = unique('ALBERA_DeskStand');
    const stats = { connections: 0, closed: 0, frames: [] };
    const server = net.createServer((socket) => {
      stats.connections += 1;
      let buffer = Buffer.alloc(0);
      const ctx = { send: (...values) => { for (const value of values) socket.write(frameOf(value)); }, end: () => socket.end() };
      socket.on('error', () => {});
      socket.on('close', () => { stats.closed += 1; });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
          const request = JSON.parse(buffer.subarray(4, 4 + buffer.readInt32LE(0)).toString('utf8'));
          buffer = buffer.subarray(4 + buffer.readInt32LE(0));
          stats.frames.push(request);
          if (request.open) ctx.send({ ok: true });
          else answer(request, ctx);
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${pipeName}_desktop`, resolve); });
    servers.add(server);
    return { pipeName, stats, expect: { ownerSid: nodeOwner, pid: process.pid } };
  }
  const replyPng = (size, width = 640, height = 480) => (request, ctx) => ctx.send({ ok: true, width: request.capture.width, height: request.capture.height, bytes: size }, pngOfSize(width, height, size));

  it('captures a PNG through the helper: the open the Broker sees is exactly the view open, sizes from 1 KB to exactly 8 MiB arrive byte for byte, one session serves them all, and close() ends the helper', async () => {
    let wanted = 1000;
    const server = await standIn((request, ctx) => replyPng(wanted, request.capture.width, request.capture.height)(request, ctx));
    const children = [];
    const client = clientFor(server.pipeName, server.expect, { spawnImpl: (...args) => { const child = spawn(...args); children.push(child); return child; } });
    for (const size of [1000, 100_000, 3 * 1024 * 1024 + 7, MAX_PNG]) {
      wanted = size;
      const png = await client.captureVmScreen(ROOM);
      assert.equal(png.length, size);
      assert.ok(png.equals(pngOfSize(640, 480, size)), `${size} bytes arrived intact`);
      assert.deepEqual({ ...readPngHeader(png) }, { width: 640, height: 480 });
    }
    assert.equal(server.stats.connections, 1);
    assert.deepEqual(server.stats.frames[0], { open: { computerId: 'room-1', mode: 'view' } });
    assert.deepEqual(server.stats.frames[1], { capture: { width: 640, height: 480 } });
    assert.equal(children.length, 1, 'one helper');
    await client.close();
    await until(() => server.stats.closed === 1 && children[0].exitCode !== null, 'the session and its helper to end');
    assert.equal(children[0].exitCode, 0, 'a quiet end: exit 0');
  });

  it('an act session sends the exact act open and the planned steps, and the Broker\'s { ok: true } is the result', async () => {
    const server = await standIn((request, ctx) => ctx.send({ ok: true }));
    const client = clientFor(server.pipeName, server.expect);
    assert.deepEqual(await client.sendVmInput({ vmId: 'room-1', action: { action: 'type', text: 'hello' }, lease: { desktopSessionId: 'op-7', generation: 3 } }), { ok: true });
    assert.deepEqual(server.stats.frames[0], { open: { computerId: 'room-1', mode: 'act', operationId: 'op-7', leaseGeneration: 3 } });
    assert.deepEqual(server.stats.frames[1], { input: { steps: [{ op: 'text', text: 'hello' }] } });
    await client.close();
  });

  const lies = [
    ['a header whose width is not the one asked for', (request, ctx) => ctx.send({ ok: true, width: 320, height: 240, bytes: 1000 }, pngOfSize(320, 240, 1000)), 'invalid_response'],
    ['a header that announces 8 MiB + 1', (request, ctx) => ctx.send({ ok: true, width: 640, height: 480, bytes: MAX_PNG + 1 }, pngOfSize(640, 480, MAX_PNG + 1)), 'invalid_response'],
    ['a header that announces 0 bytes', (request, ctx) => ctx.send({ ok: true, width: 640, height: 480, bytes: 0 }, pngOfSize(640, 480, 1000)), 'invalid_response'],
    ['a PNG frame shorter than announced', (request, ctx) => ctx.send({ ok: true, width: 640, height: 480, bytes: 2000 }, pngOfSize(640, 480, 1000)), 'invalid_response'],
    ['a PNG frame longer than announced', (request, ctx) => ctx.send({ ok: true, width: 640, height: 480, bytes: 1000 }, pngOfSize(640, 480, 2000)), 'invalid_response'],
    ['a PNG frame above 8 MiB', (request, ctx) => ctx.send({ ok: true, width: 640, height: 480, bytes: MAX_PNG }, Buffer.alloc(MAX_PNG + 1, 0x41)), 'response_too_large'],
    ['a header with an extra key', (request, ctx) => ctx.send({ ok: true, width: 640, height: 480, bytes: 1000, extra: 1 }, pngOfSize(640, 480, 1000)), 'invalid_response'],
    ['a header above 256 bytes', (request, ctx) => ctx.send(Buffer.alloc(257, 0x20)), 'response_too_large'],
    ['an empty frame', (request, ctx) => ctx.send(Buffer.alloc(0)), 'invalid_response'],
    ['text that is not JSON', (request, ctx) => ctx.send('not json at all'), 'invalid_response'],
    ['a refusal with another code', (request, ctx) => ctx.send({ ok: false, code: 'capture_busy' }), 'invalid_response'],
    ['a hang-up without a reply', (request, ctx) => ctx.end(), 'invalid_response'],
    ['a PNG whose own header says another size', (request, ctx) => ctx.send({ ok: true, width: 640, height: 480, bytes: 1000 }, pngOfSize(320, 240, 1000)), 'invalid_response'],
  ];
  for (const [label, lie, brokerCode] of lies) {
    it(`a Broker that sends ${label} is ${brokerCode}, outcome unknown, and the session is not reused`, async () => {
      const server = await standIn(lie);
      const client = clientFor(server.pipeName, server.expect);
      const error = await failure(client.captureVmScreen(ROOM));
      assert.deepEqual(shapeOf(error), { code: 'desktop_unavailable', outcome: 'unknown', brokerCode }, label);
      await failure(client.captureVmScreen(ROOM));
      assert.equal(server.stats.connections, 2, 'the next call opened a new session');
      await client.close();
    });
  }

  // ---- the helper's own input handling: what Node can send it, without the Node client's checks in front --------------------------------------------------------------
  /** The helper in desktop mode with raw stdin / stdout: `frames()` are the length-prefixed frames it has written so far. */
  function rawHelper() {
    const child = spawn(helper, ['desktop'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stdin.on('error', () => {});
    const exit = new Promise((resolve) => child.once('close', resolve));
    const frames = () => {
      const all = Buffer.concat(chunks);
      const out = [];
      for (let at = 0; at + 4 <= all.length && at + 4 + all.readInt32LE(at) <= all.length; at += 4 + all.readInt32LE(at)) out.push(JSON.parse(all.subarray(at + 4, at + 4 + all.readInt32LE(at)).toString('utf8')));
      return out;
    };
    return { child, exit, frames, send: (value) => child.stdin.write(frameOf(value)), sendRaw: (bytes) => child.stdin.write(bytes), end: () => child.stdin.end() };
  }
  const startFrame = (server, overrides = {}) => ({
    pipeName: `${server.pipeName}_desktop`, timeoutMs: 5000, requestTimeoutMs: 5000, expect: { ...server.expect }, open: { computerId: 'room-1', mode: 'view' }, ...overrides,
  });
  const INVALID = { ok: false, code: 'invalid_request' };

  it('a start frame that is malformed, out of range or not for the desktop pipe ends the helper with exit 64 and invalid_request; the server never sees a connection', async () => {
    const server = await standIn(() => {});
    const expect = server.expect;
    const bad = [
      ['an unknown key', { extra: 1 }], ['the claim pipe\'s name (no _desktop)', { pipeName: server.pipeName }], ['a pipe path', { pipeName: `a\\${server.pipeName}_desktop` }], ['a dotted name', { pipeName: 'a.b_desktop' }],
      ['an empty name', { pipeName: '' }], ['an open timeout of 99 ms', { timeoutMs: 99 }], ['an open timeout of 30001 ms', { timeoutMs: 30_001 }], ['a request timeout of 999 ms', { requestTimeoutMs: 999 }],
      ['a request timeout above 120 s', { requestTimeoutMs: 120_001 }], ['a PID and a service name together', { expect: { ...expect, serviceName: 'AlberaHostBroker' } }],
      ['neither a PID nor a service name', { expect: { ownerSid: expect.ownerSid } }], ['a PID without an owner', { expect: { pid: expect.pid } }], ['an upper-case image hash', { expect: { ...expect, imageSha256: 'A'.repeat(64) } }],
      ['a mode that is not view or act', { open: { computerId: 'room-1', mode: 'edit' } }], ['a view open with an operationId', { open: { computerId: 'room-1', mode: 'view', operationId: 'op-1' } }],
      ['an act open without a generation', { open: { computerId: 'room-1', mode: 'act', operationId: 'op-1' } }], ['an act open without an operationId', { open: { computerId: 'room-1', mode: 'act', leaseGeneration: 1 } }],
      ['a generation of 0', { open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 0 } }], ['a generation above 2^53 - 1', { open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 2 ** 53 } }],
      ['a fractional generation', { open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 1.5 } }], ['a computerId that is not an id', { open: { computerId: 'bad id', mode: 'view' } }],
      ['an extra key in open', { open: { computerId: 'room-1', mode: 'view', extra: 1 } }], ['an operationId that is not an id', { open: { computerId: 'room-1', mode: 'act', operationId: '../x', leaseGeneration: 1 } }],
    ];
    for (const [label, overrides] of bad) {
      const run = rawHelper();
      run.send(startFrame(server, overrides));
      assert.equal(await run.exit, 64, label);
      assert.deepEqual(run.frames(), [INVALID], label);
    }
    for (const [label, payload] of [['text that is not JSON', 'not json'], ['an empty frame', Buffer.alloc(0)], ['a JSON array', '[]']]) {
      const run = rawHelper();
      run.sendRaw(frameOf(payload));
      assert.equal(await run.exit, 64, label);
      assert.deepEqual(run.frames(), [INVALID], label);
    }
    const oversize = rawHelper();
    oversize.sendRaw(frameOf(`${JSON.stringify(startFrame(server))}${' '.repeat(8200)}`)); // valid JSON, one byte over what a start frame may be
    assert.equal(await oversize.exit, 64);
    assert.deepEqual(oversize.frames(), [INVALID]);
    const cut = rawHelper();
    cut.sendRaw(Buffer.from([20, 0, 0, 0, 123]));
    cut.end();
    assert.equal(await cut.exit, 64, 'a frame cut short by the end of input');
    assert.equal(server.stats.connections, 0, 'no start frame was ever good enough to connect');
  });

  it('a request frame that is not exactly one capture (or one input in an act session) ends the helper with exit 64 and nothing is written to the Broker for it', async () => {
    const view = await standIn(() => {});
    const bad = [
      ['two keys', { capture: { width: 640, height: 480 }, input: { steps: [] } }], ['an unknown key', { snapshot: {} }], ['an array', []], ['input in a view session', { input: { steps: [{ op: 'sleep', ms: 1 }] } }],
      ['text that is not JSON', 'nope'], ['an empty frame', Buffer.alloc(0)], ['a frame above 16 KiB', Buffer.alloc(16 * 1024 + 1, 0x20)],
    ];
    for (const [label, payload] of bad) {
      const run = rawHelper();
      run.send(startFrame(view));
      await until(() => run.frames().length === 1, `${label}: the open`);
      assert.deepEqual(run.frames()[0], { ok: true });
      run.sendRaw(frameOf(payload));
      assert.equal(await run.exit, 64, label);
      assert.deepEqual(run.frames().slice(1), [INVALID], label);
    }
    assert.ok(view.stats.frames.every((request) => request.open), 'the Broker only ever saw opens');
    const act = await standIn(() => {});
    const run = rawHelper();
    run.send(startFrame(act, { open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 1 } }));
    await until(() => run.frames().length === 1, 'the act open');
    run.send({ capture: { width: 640, height: 480 }, extra: 1 });
    assert.equal(await run.exit, 64);
    assert.deepEqual(act.stats.frames, [{ open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 1 } }]);
  });

  it('forwards a capture or an input frame to the Broker unchanged, and ends quietly (exit 0, no output) when Node closes stdin, before the start frame and after the open', async () => {
    const early = rawHelper();
    early.end();
    assert.equal(await early.exit, 0);
    assert.deepEqual(early.frames(), []);
    const server = await standIn((request, ctx) => ctx.send({ ok: true }));
    const run = rawHelper();
    run.send(startFrame(server, { open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 1 } }));
    await until(() => run.frames().length === 1, 'the open');
    const input = { input: { steps: [{ op: 'sleep', ms: 5 }] } };
    run.send(input);
    await until(() => run.frames().length === 2, 'the input reply');
    assert.deepEqual(run.frames(), [{ ok: true }, { ok: true }]);
    assert.deepEqual(server.stats.frames[1], input);
    run.end();
    assert.equal(await run.exit, 0);
    assert.equal(run.frames().length, 2, 'nothing after the replies');
    await until(() => server.stats.closed === 1, 'the Broker side to see the end');
  });

  it('a Broker that sends nothing: the open times out after the open timeout (nothing applied), a capture after the request timeout (outcome unknown)', async () => {
    const silentOpen = await standIn(() => {});
    const noOpenReply = net.createServer((socket) => { socket.on('error', () => {}); socket.on('data', () => {}); });
    const name = unique('ALBERA_DeskMute');
    await new Promise((resolve, reject) => { noOpenReply.once('error', reject); noOpenReply.listen(`\\\\.\\pipe\\${name}_desktop`, resolve); });
    try {
      const started = Date.now();
      const opening = await failure(clientFor(name, { ownerSid: nodeOwner, pid: process.pid }, { openTimeoutMs: 500 }).captureVmScreen(ROOM));
      assert.deepEqual(shapeOf(opening), { code: 'desktop_broker_timeout', outcome: 'not_applied', brokerCode: 'timeout' });
      assert.ok(Date.now() - started < 3000, `the helper's own deadline came first (${Date.now() - started} ms)`);
    } finally { await new Promise((resolve) => noOpenReply.close(resolve)); }
    const started = Date.now();
    const capturing = await failure(clientFor(silentOpen.pipeName, silentOpen.expect, { captureTimeoutMs: 1000 }).captureVmScreen(ROOM));
    assert.deepEqual(shapeOf(capturing), { code: 'desktop_broker_timeout', outcome: 'unknown', brokerCode: 'timeout' });
    assert.ok(Date.now() - started >= 900 && Date.now() - started < 4000, `${Date.now() - started} ms`);
  });

  it('an unused session is closed by the client after idleCloseMs: the Broker side sees it end, and the next call opens a new session', async () => {
    const server = await standIn((request, ctx) => replyPng(1000)(request, ctx));
    const client = clientFor(server.pipeName, server.expect, { idleCloseMs: 1000 });
    await client.captureVmScreen(ROOM);
    await until(() => server.stats.closed === 1, 'the idle close', 5000);
    await client.captureVmScreen(ROOM);
    assert.equal(server.stats.connections, 2);
    await client.close();
  });
});

// Real-machine test, opt in with ALBERA_HYPERV_DESKTOP_VM_ID=<GUID of a running VM> (Msvm_ComputerSystem.Name, any case). It needs a user that may call the Hyper-V WMI provider (Hyper-V
// Administrators), so it is skipped in CI. READ ONLY: a view session and captures; no input is ever sent. The picture is checked structurally and discarded.
const liveVm = process.env.ALBERA_HYPERV_DESKTOP_VM_ID;
const liveSkip = getUnavailableReason() || (liveVm ? false : 'set ALBERA_HYPERV_DESKTOP_VM_ID=<VM GUID> to capture one real VM screen through the desktop client (read only)');
describe('desktop Broker client against a real VM (opt in, read only)', { skip: liveSkip }, () => {
  let root, loopExe, helper, sid, child, config, client;
  before(async () => {
    root = makeTrustedTempDirectory('albera-desktop-client-live-');
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
    config = {
      pipeName: `ALBERA_DeskCliLive_${randomBytes(6).toString('hex')}`, database: path.join(root, 'live.sqlite'), authorityKeys: [createTestAuthority().keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG,
      computers: [{ computerId: 'room-live', vmId: String(liveVm).toLowerCase() }],
    };
    const file = path.join(root, 'live.config.json');
    writeFileSync(file, JSON.stringify(config));
    child = startProcess(loopExe, standInService('serve-loop', file), { stdin: true });
    await waitForLine(child, 'BROKER_READY');
    client = createWindowsDesktopBrokerClient({ pipeName: config.pipeName, expect: { ownerSid: sid, pid: child.pid, imageSha256: (await captureExecutableIdentity(loopExe)).sha256 }, helperPath: helper });
  });
  after(async () => {
    await client?.close();
    child?.stdin.end();
    if (child) await waitForExit(child);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('captures the screen twice through one session as a PNG of exactly the asked size', async () => {
    for (let round = 0; round < 2; round += 1) {
      const png = await client.captureVmScreen({ vmId: 'room-live', width: 640, height: 480 });
      assert.deepEqual({ ...readPngHeader(png) }, { width: 640, height: 480 });
      assert.ok(png.length > 33 && png.length <= MAX_PNG);
    }
    assert.equal(child.lines.filter((line) => line === 'DESKTOP=OPENED').length, 1, 'one session');
  });
});
