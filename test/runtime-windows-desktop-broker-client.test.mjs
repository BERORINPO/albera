import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it, mock } from 'node:test';
import { DESKTOP_BROKER_LIMITS, checkCaptureRequest, checkInputRequest, desktopClientError, readPngHeader } from '../src/runtime/desktop-broker-client-contract.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { planDesktopInput } from '../src/runtime/desktop-control.mjs';
import { createFakeDesktopBrokerClient } from '../src/runtime/fake-desktop-broker-client.mjs';
import { syntheticPng } from '../src/runtime/mock-desktop-broker.mjs';
import { createWindowsDesktopBrokerClient } from '../src/runtime/windows-desktop-broker-client.mjs';

// Pure and scripted-helper tests: every OS, no .NET, no pipe. The scripted helper plays the helper side of the frames documented in DesktopSession.cs. The real helper against the real Broker
// (and against hostile same-user pipe servers) is runtime-windows-desktop-broker-client.integration.test.mjs.
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const EXPECT = { ownerSid: SID, pid: 4242 };
const ROOM = { vmId: 'room-1', width: 640, height: 480 };
const LEASE = { desktopSessionId: 'op-1', generation: 1 };
const CLICK = { action: 'left_click', coordinate: [10, 20] };
const SECRET = 'SYNTHETIC_SECRET_MARKER C:\\Users\\yosuke\\secret';

const root = mkdtempSync(path.join(os.tmpdir(), 'albera-desktop-client-unit-'));
after(() => rmSync(root, { recursive: true, force: true }));
let helperCounter = 0;
/** A stand-in helper file plus a matching SHA-256 manifest, like `npm run build:windows-broker` writes. */
function makeHelper(content = 'not a real executable') {
  const helperPath = path.join(root, `helper-${helperCounter += 1}.exe`);
  writeFileSync(helperPath, content);
  writeFileSync(`${helperPath}.manifest.json`, JSON.stringify({ sha256: createHash('sha256').update(content).digest('hex') }));
  return helperPath;
}

const frame = (value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length);
  return Buffer.concat([head, body]);
};
const PLAIN_OK = { ok: true };
const captureReply = (width, height, png = syntheticPng(width, height)) => [{ ok: true, width, height, bytes: png.length }, png];

/**
 * A spawn replacement whose child plays the helper. `behave(request, ctx)` is called for every frame Node writes (`ctx.index` 0 is the start frame) and answers with
 * `ctx.reply(...values)` (JSON values or Buffers, each sent as one frame), `ctx.exit(code)` or nothing (silence). The default answers like a healthy helper and Broker.
 */
function scriptedHelper(behave = healthy) {
  const log = { spawns: [], frames: [], killed: 0, ended: 0, children: [] };
  const spawnImpl = (command, args, options) => {
    const spawnIndex = log.spawns.length;
    log.spawns.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    let closed = false;
    let buffer = Buffer.alloc(0);
    let index = 0;
    // Like a real process: its last words are read before its end is noticed.
    const exit = (code = 0) => {
      if (closed) return;
      closed = true;
      setImmediate(() => { child.stdout.end(); child.emit('close', code); });
    };
    const ctx = { spawnIndex, get index() { return index; }, exit, raw: (bytes) => child.stdout.write(bytes), reply: (...values) => { for (const value of values) child.stdout.write(frame(value)); } };
    child.kill = () => { log.killed += 1; exit(1); };
    child.stdin.on('end', () => { log.ended += 1; exit(0); });
    child.stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const request = JSON.parse(buffer.subarray(4, 4 + buffer.readInt32LE(0)).toString('utf8'));
        buffer = buffer.subarray(4 + buffer.readInt32LE(0));
        log.frames.push({ spawn: spawnIndex, request });
        behave(request, ctx);
        index += 1;
      }
    });
    log.children.push(child);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  return { spawnImpl, log };
}
/** The Broker's accepted open: `{ ok: true }` for a view, and for an act open the lease it joined (the generation named, or `joined` when none was). */
const openReply = (open, joined = 1) => (open.mode === 'act' ? { ok: true, leaseGeneration: open.leaseGeneration ?? joined } : PLAIN_OK);
function healthy(request, ctx) {
  if (ctx.index === 0) ctx.reply(openReply(request.open));
  else if (request.capture) ctx.reply(...captureReply(request.capture.width, request.capture.height));
  else ctx.reply(PLAIN_OK);
}
/** Healthy until request number `at` (0 is the open), which `fail(ctx)` answers. */
const failingAt = (at, fail) => (request, ctx) => (ctx.index === at ? fail(ctx) : healthy(request, ctx));

function clientOver(scripted, options = {}) {
  return createWindowsDesktopBrokerClient({ pipeName: 'ALBERA_Test_abc', expect: EXPECT, helperPath: makeHelper(), spawnImpl: scripted.spawnImpl, ...options });
}
const failure = async (promise) => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
const shapeOf = (error) => ({ code: error.code, outcome: error.outcome, brokerCode: error.brokerCode });
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Waits for `condition` by yielding to the event loop, not by a timer: some tests mock the timers. */
async function until(condition) {
  for (let turns = 0; !condition(); turns += 1) {
    assert.ok(turns < 200_000, 'timeout');
    await settle();
  }
}

describe('desktop client contract (pure)', () => {
  it('checks a capture request: a contract id, a size inside the Broker\'s 64..1920 bounds and 1920x1080 pixels', () => {
    assert.deepEqual({ ...checkCaptureRequest(ROOM) }, { computerId: 'room-1', width: 640, height: 480 });
    assert.deepEqual({ ...checkCaptureRequest({ vmId: 'room-1', width: 1920, height: 1080 }) }, { computerId: 'room-1', width: 1920, height: 1080 });
    for (const bad of [{ ...ROOM, width: 63 }, { ...ROOM, height: 63 }, { ...ROOM, width: 1921 }, { ...ROOM, height: 1921 }, { ...ROOM, width: 1920, height: 1081 }, { ...ROOM, width: 640.5 }, { ...ROOM, width: '640' }, { vmId: 'room-1' }]) {
      assert.throws(() => checkCaptureRequest(bad), TypeError, JSON.stringify(bad));
    }
    for (const vmId of [undefined, '', 'bad id', 'a'.repeat(65), 'room\\1', '../x', 7]) assert.deepEqual(shapeOf((() => { try { checkCaptureRequest({ ...ROOM, vmId }); } catch (error) { return error; } })()), { code: 'desktop_vm_not_found', outcome: 'not_applied', brokerCode: undefined }, String(vmId));
  });

  it('plans an input like the prototype does and takes the lease from the room\'s desktop lease: operationId = desktopSessionId, leaseGeneration = generation', () => {
    const checked = checkInputRequest({ vmId: 'room-1', action: CLICK, lease: { ...LEASE, ownerType: 'AI', ownerId: 'agent-1', expiresAt: '2030-01-01T00:00:00.000Z' } });
    assert.deepEqual({ ...checked, steps: [...checked.steps] }, { computerId: 'room-1', operationId: 'op-1', leaseGeneration: 1, steps: [...planDesktopInput(CLICK, { width: 4096, height: 4096 })] });
    // a lease that names no generation is the Control Plane's normal case: the Broker joins the lease that is current for the operation
    assert.deepEqual({ ...checkInputRequest({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-1' } }), steps: [] }, { computerId: 'room-1', operationId: 'op-1', leaseGeneration: null, steps: [] });
    for (const lease of [undefined, null, {}, { generation: 1 }, { ...LEASE, generation: 0 }, { ...LEASE, generation: 1.5 }, { ...LEASE, generation: '1' }, { ...LEASE, generation: null }, { ...LEASE, desktopSessionId: 'bad id' }]) {
      assert.deepEqual(shapeOf((() => { try { checkInputRequest({ vmId: 'room-1', action: CLICK, lease }); } catch (error) { return error; } })()), { code: 'desktop_input_rejected', outcome: 'not_applied', brokerCode: undefined }, JSON.stringify(lease));
    }
    for (const action of [undefined, {}, { action: 'screenshot' }, { action: 'left_click', coordinate: [5000, 1] }, { action: 'left_click', extra: 1 }, { action: 'type', text: 'é' }]) {
      assert.equal((() => { try { checkInputRequest({ vmId: 'room-1', action, lease: LEASE }); } catch (error) { return error.code; } })(), 'desktop_input_rejected', JSON.stringify(action));
    }
  });

  it('reads the IHDR of a PNG and nothing else', () => {
    assert.deepEqual({ ...readPngHeader(syntheticPng(64, 48)) }, { width: 64, height: 48 });
    const png = syntheticPng(64, 48);
    assert.equal(readPngHeader(png.subarray(0, 32)), null, 'a truncated header');
    assert.equal(readPngHeader(Buffer.concat([Buffer.from('xPNG'), png.subarray(4)])), null, 'a wrong signature');
    const notIhdr = Buffer.from(png);
    notIhdr.write('IDAT', 12, 'latin1');
    assert.equal(readPngHeader(notIhdr), null, 'the first chunk is not IHDR');
    assert.equal(readPngHeader('PNG'), null);
  });

  it('builds errors that carry a code, an outcome and at most a brokerCode, never text', () => {
    const error = desktopClientError('desktop_unavailable', 'bogus', 'denied');
    assert.deepEqual({ ...error }, { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'denied' });
    assert.equal(error.message, 'desktop_unavailable');
    assert.deepEqual(Object.keys(desktopClientError('x', 'not_applied')), ['code', 'outcome']);
  });
});

describe('fake and real desktop client are interchangeable (the Driver accepts both; the same arguments are refused the same way)', () => {
  const pairs = () => [['fake', createFakeDesktopBrokerClient({ computers: ['room-1'] })], ['real over a scripted helper', clientOver(scriptedHelper())]];

  it('is a plain object of data properties, which is what HyperVDesktopDriver takes as its broker, and captures through the Driver', async () => {
    for (const [label, client] of pairs()) {
      const driver = new HyperVDesktopDriver({ broker: client, resolveCurrentLease: () => ({ desktopSessionId: 'op-1', ownerType: 'AI', ownerId: 'agent-1', generation: 1, expiresAt: '2999-01-01T00:00:00.000Z' }), screen: { width: 640, height: 480 } });
      const lease = { desktopSessionId: 'op-1', ownerType: 'AI', ownerId: 'agent-1', generation: 1, expiresAt: '2999-01-01T00:00:00.000Z' };
      const shot = await driver.capture({ vmId: 'room-1', lease });
      assert.deepEqual({ width: shot.width, height: shot.height }, { width: 640, height: 480 }, label);
      await client.close();
    }
  });

  it('refuses a bad computer id, size, action and lease before anything is sent, with the same code', async () => {
    for (const [label, client] of pairs()) {
      assert.deepEqual(shapeOf(await failure(client.captureVmScreen({ ...ROOM, vmId: 'bad id' }))), { code: 'desktop_vm_not_found', outcome: 'not_applied', brokerCode: undefined }, label);
      await assert.rejects(client.captureVmScreen({ ...ROOM, width: 30 }), TypeError, label);
      assert.deepEqual(shapeOf(await failure(client.sendVmInput({ vmId: 'room-1', action: { action: 'screenshot' }, lease: LEASE }))), { code: 'desktop_input_rejected', outcome: 'not_applied', brokerCode: undefined }, label);
      assert.deepEqual(shapeOf(await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK }))), { code: 'desktop_input_rejected', outcome: 'not_applied', brokerCode: undefined }, label);
      await client.close();
    }
  });

  it('the Fake plays the Broker\'s lease rules: input only for the current lease of that computer, a newer grant replaces it, expiry ends it, capture of an unknown computer is denied', async () => {
    const fake = createFakeDesktopBrokerClient({ computers: ['room-1', 'room-2'] });
    const refused = (request) => failure(fake.sendVmInput(request)).then(shapeOf);
    const denied = { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'denied' };
    assert.deepEqual(await refused({ vmId: 'room-1', action: CLICK, lease: LEASE }), denied, 'no lease yet');
    assert.equal(fake.grantLease('room-1', 'op-1'), 1);
    assert.deepEqual(await fake.sendVmInput({ vmId: 'room-1', action: CLICK, lease: LEASE }), { ok: true });
    assert.deepEqual(await refused({ vmId: 'room-2', action: CLICK, lease: LEASE }), denied, 'the lease is the computer\'s own');
    assert.deepEqual(await refused({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-1', generation: 2 } }), denied, 'another generation');
    assert.equal(fake.grantLease('room-1', 'op-2'), 2);
    assert.deepEqual(await refused({ vmId: 'room-1', action: CLICK, lease: LEASE }), denied, 'replaced by a newer claim');
    assert.equal(fake.grantLease('room-2', 'op-3'), 1, 'generations count per computer');
    fake.expireLeases();
    assert.deepEqual(await refused({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-2', generation: 2 } }), denied, 'expired');
    assert.deepEqual(shapeOf(await failure(fake.captureVmScreen({ ...ROOM, vmId: 'room-9' }))), denied);
    fake.failNext('desktop_broker_timeout');
    assert.deepEqual(shapeOf(await failure(fake.captureVmScreen(ROOM))), { code: 'desktop_broker_timeout', outcome: 'unknown', brokerCode: 'transport_error' });
    assert.equal(fake.inputs.length, 1);
    await fake.close();
    assert.deepEqual(shapeOf(await failure(fake.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'closed' });
  });
});

describe('windows desktop broker client over a scripted helper', () => {
  it('starts the helper in desktop mode with a shell-free spawn and sends one start frame: the desktop pipe name, the expectation, the timeouts and a view open', async () => {
    const scripted = scriptedHelper();
    const client = clientOver(scripted, { openTimeoutMs: 4000, captureTimeoutMs: 15_000 });
    const png = await client.captureVmScreen(ROOM);
    assert.deepEqual({ ...readPngHeader(png) }, { width: 640, height: 480 });
    assert.equal(scripted.log.spawns.length, 1);
    const { command, args, options } = scripted.log.spawns[0];
    assert.ok(command.endsWith('.exe'));
    assert.deepEqual(args, ['desktop']);
    assert.equal(options.shell, false);
    assert.deepEqual(scripted.log.frames[0].request, { pipeName: 'ALBERA_Test_abc_desktop', timeoutMs: 4000, requestTimeoutMs: 15_000, expect: EXPECT, open: { computerId: 'room-1', mode: 'view' } });
    assert.deepEqual(scripted.log.frames[1].request, { capture: { width: 640, height: 480 } });
    await client.close();
  });

  it('keeps one session per computer for every capture, and runs concurrent requests one at a time in order', async () => {
    const scripted = scriptedHelper();
    const client = clientOver(scripted);
    await Promise.all([client.captureVmScreen(ROOM), client.captureVmScreen({ ...ROOM, width: 320, height: 240 }), client.captureVmScreen(ROOM)]);
    await client.captureVmScreen(ROOM);
    assert.equal(scripted.log.spawns.length, 1, 'one helper for four captures');
    assert.deepEqual(scripted.log.frames.slice(1).map(({ request }) => request.capture.width), [640, 320, 640, 640]);
    await client.captureVmScreen({ ...ROOM, vmId: 'room-2' });
    assert.equal(scripted.log.spawns.length, 2, 'another computer, another session');
    await client.close();
  });

  it('does not write the next request until the previous one was answered', async () => {
    let held = null;
    const scripted = scriptedHelper((request, ctx) => (ctx.index === 1 ? (held = () => healthy(request, ctx)) : healthy(request, ctx)));
    const client = clientOver(scripted);
    const first = client.captureVmScreen(ROOM);
    const second = client.captureVmScreen({ ...ROOM, width: 320, height: 240 });
    await until(() => scripted.log.frames.length === 2);
    await settle(); await settle();
    assert.equal(scripted.log.frames.length, 2, 'open and the first capture only');
    held();
    await Promise.all([first, second]);
    assert.equal(scripted.log.frames.length, 3);
    await client.close();
  });

  it('opens an act session with the lease, sends the planned steps, and a newer lease for the computer closes the older session', async () => {
    const scripted = scriptedHelper();
    const client = clientOver(scripted);
    assert.deepEqual(await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: LEASE }), { ok: true });
    assert.deepEqual(scripted.log.frames[0].request.open, { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 1 });
    assert.deepEqual(scripted.log.frames[1].request, { input: { steps: JSON.parse(JSON.stringify(planDesktopInput(CLICK, { width: 4096, height: 4096 }))) } });
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: LEASE });
    assert.equal(scripted.log.spawns.length, 1, 'the same lease keeps its session');
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-2', generation: 2 } });
    assert.equal(scripted.log.spawns.length, 2);
    await settle();
    assert.equal(scripted.log.ended, 1, 'the older lease\'s helper had its stdin closed');
    assert.deepEqual(scripted.log.frames.filter(({ spawn }) => spawn === 1)[0].request.open, { computerId: 'room-1', mode: 'act', operationId: 'op-2', leaseGeneration: 2 });
    await client.close();
  });

  it('a lease without a generation opens an act session without one and learns the generation from the Broker\'s reply; a lease the Broker joins at a newer generation replaces the older session', async () => {
    const joined = new Map([['op-1', 4], ['op-2', 5]]);
    const scripted = scriptedHelper((request, ctx) => (ctx.index === 0 ? ctx.reply(openReply(request.open, joined.get(request.open.operationId))) : healthy(request, ctx)));
    const client = clientOver(scripted);
    assert.deepEqual(await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-1' } }), { ok: true });
    assert.deepEqual(scripted.log.frames[0].request.open, { computerId: 'room-1', mode: 'act', operationId: 'op-1' }, 'no leaseGeneration key at all');
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-1' } });
    assert.equal(scripted.log.spawns.length, 1, 'the same operation keeps its session');
    // the room hands the driver a full lease (its own job number as the generation): the wiring leaves that out, but a caller that names one is checked against the Broker's reply
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-2' } });
    assert.equal(scripted.log.spawns.length, 2);
    await settle();
    assert.equal(scripted.log.ended, 1, 'generation 5 replaced generation 4: the older helper had its stdin closed');
    await client.close();
  });

  it('a call with an older lease never closes the session of a newer one (Zaku LOW of #168): it fails before anything is sent, and the newer session keeps working', async () => {
    const scripted = scriptedHelper();
    const client = clientOver(scripted);
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-2', generation: 2 } });
    const spawned = scripted.log.spawns.length;
    const stale = await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-1', generation: 1 } }));
    assert.deepEqual(shapeOf(stale), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'lease_superseded' });
    assert.equal(scripted.log.spawns.length, spawned, 'no session was opened for the stale lease');
    await settle();
    assert.equal(scripted.log.ended, 0, 'and the newer lease\'s session was not closed');
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-2', generation: 2 } });
    assert.equal(scripted.log.spawns.length, spawned, 'still the same session');
    // another computer is its own business
    await client.sendVmInput({ vmId: 'room-2', action: CLICK, lease: { desktopSessionId: 'op-1', generation: 1 } });
    assert.equal(scripted.log.spawns.length, spawned + 1);
    await client.close();
  });

  it('an open that joins an older generation than the live session\'s loses: its helper is closed, the call fails with nothing sent, the live session stays', async () => {
    const joined = new Map([['op-new', 7], ['op-old', 3]]);
    const scripted = scriptedHelper((request, ctx) => (ctx.index === 0 ? ctx.reply(openReply(request.open, joined.get(request.open.operationId))) : healthy(request, ctx)));
    const client = clientOver(scripted);
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-new' } });
    const error = await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-old' } }));
    assert.deepEqual(shapeOf(error), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'lease_superseded' });
    assert.equal(scripted.log.frames.filter(({ request }) => request.input).length, 1, 'the stale call sent no input');
    await settle();
    assert.equal(scripted.log.ended, 1, 'only the loser\'s helper was closed');
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-new' } });
    assert.equal(scripted.log.spawns.length, 2, 'the live session served the next call');
    await client.close();
  });

  it('a Broker restart is not a "newer lease" problem: when the live session is gone, a lease with a smaller generation opens normally', async () => {
    const scripted = scriptedHelper();
    const client = clientOver(scripted);
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-9', generation: 9 } });
    scripted.log.children[0].emit('close', 1); // the Broker (and so the helper) went away
    await settle();
    assert.deepEqual(await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: { desktopSessionId: 'op-1', generation: 1 } }), { ok: true });
    await client.close();
  });

  const badActReplies = [
    ['no generation in the reply', { ok: true }], ['a generation other than the one named', { ok: true, leaseGeneration: 2 }], ['a generation of 0', { ok: true, leaseGeneration: 0 }],
    ['a fractional generation', { ok: true, leaseGeneration: 1.5 }], ['a string generation', { ok: true, leaseGeneration: '1' }], ['an unsafe integer', { ok: true, leaseGeneration: 2 ** 53 }],
    ['an extra key', { ok: true, leaseGeneration: 1, extra: 1 }],
  ];
  for (const [label, reply] of badActReplies) {
    it(`an act open answered with ${label} is not accepted: invalid_response, nothing applied`, async () => {
      const client = clientOver(scriptedHelper((request, ctx) => (ctx.index === 0 ? ctx.reply(reply) : healthy(request, ctx))));
      assert.deepEqual(shapeOf(await failure(client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: LEASE }))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'invalid_response' });
      await client.close();
    });
  }

  it('a view open answered with a generation is not accepted either', async () => {
    const client = clientOver(scriptedHelper((request, ctx) => (ctx.index === 0 ? ctx.reply({ ok: true, leaseGeneration: 1 }) : healthy(request, ctx))));
    assert.deepEqual(shapeOf(await failure(client.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'invalid_response' });
    await client.close();
  });

  it('a pinned helper build (helperSha256) must be the one the manifest records: another digest means no helper is started', async () => {
    const helperPath = makeHelper('the pinned build');
    const pinned = createHash('sha256').update('the pinned build').digest('hex');
    const scripted = scriptedHelper();
    const good = clientOver(scripted, { helperPath, helperSha256: pinned });
    await good.captureVmScreen(ROOM);
    assert.equal(scripted.log.spawns.length, 1);
    await good.close();
    const other = scriptedHelper();
    const wrong = clientOver(other, { helperPath, helperSha256: 'b'.repeat(64) });
    assert.deepEqual(shapeOf(await failure(wrong.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'helper_unavailable' });
    assert.equal(other.log.spawns.length, 0);
    await wrong.close();
  });

  it('a capture never uses an act session and an input never uses a view session', async () => {
    const scripted = scriptedHelper();
    const client = clientOver(scripted);
    await client.captureVmScreen(ROOM);
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: LEASE });
    assert.deepEqual(scripted.log.frames.filter(({ request }) => request.open).map(({ request }) => request.open.mode), ['view', 'act']);
    await client.close();
  });

  const cases = [
    // [label, script, call, expected]
    ['the helper refuses the server (identity mismatch) at open', () => failingAt(0, (ctx) => { ctx.reply({ ok: false, code: 'server_identity_mismatch' }); ctx.exit(0); }), 'capture', { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'server_identity_mismatch' }],
    ['the helper cannot establish the identity', () => failingAt(0, (ctx) => { ctx.reply({ ok: false, code: 'server_identity_unavailable' }); ctx.exit(70); }), 'capture', { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'server_identity_unavailable' }],
    ['no Broker is listening', () => failingAt(0, (ctx) => { ctx.reply({ ok: false, code: 'broker_unavailable' }); ctx.exit(0); }), 'capture', { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'broker_unavailable' }],
    ['the Broker denies the open (no such computer, no lease, a wrong generation)', () => failingAt(0, (ctx) => { ctx.reply({ ok: false, code: 'denied' }); ctx.exit(0); }), 'input', { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'denied' }],
    ['the Broker denies a capture', () => failingAt(1, (ctx) => { ctx.reply({ ok: false, code: 'denied' }); ctx.exit(0); }), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'denied' }],
    ['the Broker denies an input (it may have run some steps)', () => failingAt(1, (ctx) => { ctx.reply({ ok: false, code: 'denied' }); ctx.exit(0); }), 'input', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'denied' }],
    ['the helper times out on a request', () => failingAt(1, (ctx) => { ctx.reply({ ok: false, code: 'timeout' }); ctx.exit(0); }), 'input', { code: 'desktop_broker_timeout', outcome: 'unknown', brokerCode: 'timeout' }],
    ['the helper rejects a request frame as malformed (nothing was written for it)', () => failingAt(1, (ctx) => { ctx.reply({ ok: false, code: 'invalid_request' }); ctx.exit(64); }), 'input', { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'invalid_request' }],
    ['the helper reports a transport error', () => failingAt(1, (ctx) => { ctx.reply({ ok: false, code: 'transport_error' }); ctx.exit(70); }), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'transport_error' }],
    ['the helper dies without a word', () => failingAt(1, (ctx) => ctx.exit(1)), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'transport_error' }],
    ['the helper sends a code that is not in its fixed set', () => failingAt(1, (ctx) => { ctx.reply({ ok: false, code: SECRET }); ctx.exit(0); }), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['the helper sends text that is not JSON', () => failingAt(1, (ctx) => ctx.reply(Buffer.from(SECRET))), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['the open reply has an extra key', () => failingAt(0, (ctx) => ctx.reply({ ok: true, extra: 1 })), 'capture', { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'invalid_response' }],
    ['a header frame above 256 bytes', () => failingAt(1, (ctx) => ctx.reply(Buffer.alloc(257, 0x20))), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'response_too_large' }],
    ['an empty frame', () => failingAt(1, (ctx) => ctx.reply(Buffer.alloc(0))), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['a capture header with another size than asked', () => failingAt(1, (ctx) => ctx.reply(...captureReply(320, 240))), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['a capture header with an extra key', () => failingAt(1, (ctx) => ctx.reply({ ...captureReply(640, 480)[0], extra: 1 }, syntheticPng(640, 480))), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['a capture header that announces more PNG bytes than the frame holds', () => failingAt(1, (ctx) => { const png = syntheticPng(640, 480); ctx.reply({ ok: true, width: 640, height: 480, bytes: png.length + 1 }, png); }), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['a capture header that announces more than 8 MiB', () => failingAt(1, (ctx) => { const png = syntheticPng(640, 480); ctx.reply({ ok: true, width: 640, height: 480, bytes: 8 * 1024 * 1024 + 1 }, png); }), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['a PNG frame announcing more than 8 MiB', () => failingAt(1, (ctx) => { const head = Buffer.alloc(4); head.writeInt32LE(8 * 1024 * 1024 + 1); ctx.reply({ ok: true, width: 640, height: 480, bytes: 8 * 1024 * 1024 }); ctx.raw(head); }), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'response_too_large' }],
    ['a PNG whose own size is not the announced one', () => failingAt(1, (ctx) => ctx.reply(...captureReply(640, 480, syntheticPng(320, 240)))), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['bytes that are not a PNG', () => failingAt(1, (ctx) => ctx.reply(...captureReply(640, 480, Buffer.alloc(100, 0x41)))), 'capture', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
    ['an input answered with more than { ok: true }', () => failingAt(1, (ctx) => ctx.reply({ ok: true, width: 640 })), 'input', { code: 'desktop_unavailable', outcome: 'unknown', brokerCode: 'invalid_response' }],
  ];
  for (const [label, script, call, expected] of cases) {
    it(`${label}: ${expected.code}, ${expected.outcome}, ${expected.brokerCode}; no helper text reaches the caller, the session ends`, async () => {
      const scripted = scriptedHelper(script());
      const client = clientOver(scripted);
      const send = () => (call === 'input' ? client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: LEASE }) : client.captureVmScreen(ROOM));
      const error = await failure(send());
      assert.deepEqual(shapeOf(error), expected);
      assert.equal(error.message, expected.code);
      assert.equal(JSON.stringify({ ...error }).includes('SYNTHETIC'), false);
      assert.deepEqual(Object.keys(error).sort(), ['brokerCode', 'code', 'outcome']);
      await settle();
      assert.ok(scripted.log.children.every((child) => child.stdout.writableEnded), 'every helper is gone');
      await client.close();
    });
  }

  it('a frame nobody asked for ends the session: the answer already given is kept, and the next call opens a new session', async () => {
    const scripted = scriptedHelper((request, ctx) => { healthy(request, ctx); if (ctx.index === 1 && ctx.spawnIndex === 0) ctx.reply({ ok: false, code: 'timeout' }); });
    const client = clientOver(scripted);
    assert.deepEqual({ ...readPngHeader(await client.captureVmScreen(ROOM)) }, { width: 640, height: 480 });
    await settle();
    assert.deepEqual({ ...readPngHeader(await client.captureVmScreen(ROOM)) }, { width: 640, height: 480 });
    assert.equal(scripted.log.spawns.length, 2, 'the first session was discarded');
    await client.close();
  });

  it('after a failure the next call opens a new session, verified again from scratch', async () => {
    const scripted = scriptedHelper((request, ctx) => (ctx.spawnIndex === 0 && ctx.index === 1 ? (ctx.reply({ ok: false, code: 'denied' }), ctx.exit(0)) : healthy(request, ctx)));
    const client = clientOver(scripted);
    assert.equal((await failure(client.captureVmScreen(ROOM))).brokerCode, 'denied');
    assert.equal((await client.captureVmScreen(ROOM)).length > 0, true);
    assert.equal(scripted.log.spawns.length, 2);
    assert.equal(scripted.log.frames.filter(({ request }) => request.open).length, 2, 'the second session sent its own start frame');
    await client.close();
  });

  it('refuses a helper whose bytes no longer match the manifest, before it is started, every time a session opens', async () => {
    const scripted = scriptedHelper();
    const helperPath = makeHelper('original');
    const client = clientOver(scripted, { helperPath, idleCloseMs: 1000 });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await client.captureVmScreen(ROOM);
      assert.equal(scripted.log.spawns.length, 1);
      appendFileSync(helperPath, Buffer.from([0]));
      mock.timers.tick(1000); // the idle close ends the session; the next call needs a new one
      await settle();
    } finally { mock.timers.reset(); }
    assert.deepEqual(shapeOf(await failure(client.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'helper_unavailable' });
    assert.equal(scripted.log.spawns.length, 1, 'no second helper was started');
    await client.close();
  });

  it('a missing manifest, a malformed manifest and a spawn that throws are helper_unavailable, nothing applied', async () => {
    const noManifest = path.join(root, 'no-manifest.exe');
    writeFileSync(noManifest, 'x');
    const malformed = makeHelper();
    writeFileSync(`${malformed}.manifest.json`, '{"sha256":"zz"}');
    for (const [label, options] of [['missing', { helperPath: noManifest }], ['malformed', { helperPath: malformed }], ['spawn throws', { spawnImpl: () => { throw new Error(SECRET); } }]]) {
      const client = createWindowsDesktopBrokerClient({ pipeName: 'ALBERA_Test_abc', expect: EXPECT, helperPath: makeHelper(), spawnImpl: scriptedHelper().spawnImpl, ...options });
      const error = await failure(client.captureVmScreen(ROOM));
      assert.deepEqual(shapeOf(error), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'helper_unavailable' }, label);
      assert.equal(JSON.stringify({ ...error }).includes('SYNTHETIC'), false, label);
    }
  });

  it('a helper that fails to start (error before spawn) is helper_unavailable, nothing applied', async () => {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      setImmediate(() => child.emit('error', Object.assign(new Error(SECRET), { code: 'ENOENT' })));
      return child;
    };
    const client = clientOver(scriptedHelper(), { spawnImpl });
    assert.deepEqual(shapeOf(await failure(client.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'helper_unavailable' });
  });

  it('gives up on a helper that says nothing: the open after its own timeout plus a grace (nothing applied), a request likewise (outcome unknown), and kills it', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const silentOpen = scriptedHelper((request, ctx) => { if (ctx.index > 0) healthy(request, ctx); });
      const client = clientOver(silentOpen, { openTimeoutMs: 100 });
      const opening = failure(client.captureVmScreen(ROOM));
      await until(() => silentOpen.log.frames.length === 1);
      mock.timers.tick(100 + 3000);
      assert.deepEqual(shapeOf(await opening), { code: 'desktop_broker_timeout', outcome: 'not_applied', brokerCode: 'timeout' });
      assert.equal(silentOpen.log.killed, 1);

      const silentRequest = scriptedHelper(failingAt(1, () => {}));
      const second = clientOver(silentRequest, { captureTimeoutMs: 1000 });
      const capturing = failure(second.captureVmScreen(ROOM));
      await until(() => silentRequest.log.frames.length === 2);
      mock.timers.tick(1000 + 3000);
      assert.deepEqual(shapeOf(await capturing), { code: 'desktop_broker_timeout', outcome: 'unknown', brokerCode: 'timeout' });
      assert.equal(silentRequest.log.killed, 1);
    } finally { mock.timers.reset(); }
  });

  it('closes an unused session after idleCloseMs (the helper sees end of input), and the next call opens a new one without an error', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const scripted = scriptedHelper();
      const client = clientOver(scripted, { idleCloseMs: 1000 });
      await client.captureVmScreen(ROOM);
      mock.timers.tick(999);
      assert.equal(scripted.log.ended, 0);
      await client.captureVmScreen(ROOM); // use restarts the clock
      mock.timers.tick(999);
      assert.equal(scripted.log.ended, 0);
      mock.timers.tick(1);
      await settle();
      assert.equal(scripted.log.ended, 1);
      await client.captureVmScreen(ROOM);
      assert.equal(scripted.log.spawns.length, 2);
      await client.close();
    } finally { mock.timers.reset(); }
  });

  it('close() ends every helper, is idempotent and makes later calls fail with nothing applied', async () => {
    const scripted = scriptedHelper();
    const client = clientOver(scripted);
    await client.captureVmScreen(ROOM);
    await client.sendVmInput({ vmId: 'room-1', action: CLICK, lease: LEASE });
    await client.close();
    await client.close();
    assert.equal(scripted.log.ended, 2);
    assert.deepEqual(shapeOf(await failure(client.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'closed' });
    assert.equal(scripted.log.spawns.length, 2);
  });

  it('validates its options when it is created', () => {
    const good = { pipeName: 'ALBERA_Test_abc', expect: EXPECT, helperPath: makeHelper(), spawnImpl: () => {} };
    assert.doesNotThrow(() => createWindowsDesktopBrokerClient(good));
    assert.doesNotThrow(() => createWindowsDesktopBrokerClient({ ...good, expect: { serviceName: 'AlberaHostBroker', imageSha256: 'a'.repeat(64) } }));
    const bad = [
      { pipeName: undefined }, { pipeName: '' }, { pipeName: 'a\\b' }, { pipeName: 'a.b' }, { pipeName: 'x'.repeat(121) }, { pipeName: 'ALBERA_x_desktop\\..' },
      { expect: undefined }, { expect: {} }, { expect: { ownerSid: SID } }, { expect: { ...EXPECT, serviceName: 'x' } }, { expect: { ownerSid: 'nope', pid: 1 } }, { expect: { ...EXPECT, extra: 1 } },
      { openTimeoutMs: 99 }, { openTimeoutMs: 30_001 }, { openTimeoutMs: 1.5 }, { captureTimeoutMs: 999 }, { captureTimeoutMs: 120_001 }, { inputTimeoutMs: 0 },
      { idleCloseMs: 999 }, { idleCloseMs: 55_001 }, { helperPath: 7 }, { spawnImpl: 'spawn' }, { helperSha256: 'A'.repeat(64) }, { helperSha256: 'ab' }, { helperSha256: 7 },
    ];
    for (const override of bad) assert.throws(() => createWindowsDesktopBrokerClient({ ...good, ...override }), { name: 'TypeError', message: 'invalid_desktop_broker_client_options' }, JSON.stringify(override));
    assert.throws(() => createWindowsDesktopBrokerClient(), TypeError);
  });

  it('exposes only the interface the Driver and the room need: two calls and close', () => {
    const client = createWindowsDesktopBrokerClient({ pipeName: 'ALBERA_Test_abc', expect: EXPECT, helperPath: makeHelper(), spawnImpl: () => {} });
    assert.deepEqual(Object.keys(client).sort(), ['captureVmScreen', 'close', 'sendVmInput']);
    assert.equal(Object.isFrozen(client), true);
    assert.equal(DESKTOP_BROKER_LIMITS.maxPngBytes, 8 * 1024 * 1024);
  });

  it('on a non-Windows host with the default spawn it refuses at once: nothing is started', { skip: process.platform === 'win32' }, async () => {
    const client = createWindowsDesktopBrokerClient({ pipeName: 'ALBERA_Test_abc', expect: EXPECT, helperPath: makeHelper() });
    assert.deepEqual(shapeOf(await failure(client.captureVmScreen(ROOM))), { code: 'desktop_unavailable', outcome: 'not_applied', brokerCode: 'unsupported_platform' });
  });

  it('source guard: one launch site, after the helper was verified, in desktop mode only, with no shell and no pipe of its own; the Fake and the contract start nothing', () => {
    const read = (name) => readFileSync(new URL(`../src/runtime/${name}`, import.meta.url), 'utf8');
    const client = read('windows-desktop-broker-client.mjs');
    assert.equal(/node:net|net\.createConnection|\bexec\w*\(|\bfork\(|spawnSync|shell\s*:\s*true/u.test(client), false, 'no direct pipe and no shell');
    assert.deepEqual(client.match(/^import .*child_process.*$/gmu), ["import { spawn } from 'node:child_process';"]);
    assert.equal([...client.matchAll(/\bconfig\.spawnImpl\(/gu)].length, 1, 'one launch site');
    assert.match(client, /config\.spawnImpl\(config\.helperPath, \['desktop'\], \{ shell: false,/u, 'the helper is started in desktop mode, without a shell');
    assert.ok(client.indexOf('await verifyHelper(config.helperPath, config.helperSha256)') > 0 && client.indexOf('await verifyHelper(config.helperPath, config.helperSha256)') < client.indexOf('config.spawnImpl('), 'the digest (and the pinned one, if any) is verified before the helper is launched');
    for (const name of ['fake-desktop-broker-client.mjs', 'desktop-broker-client-contract.mjs']) assert.equal(/child_process|node:net|\bspawn\b/u.test(read(name)), false, `${name} starts nothing`);
  });
});
