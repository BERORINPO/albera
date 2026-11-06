import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import {
  brokerSession, buildBrokerWithTestSeams, buildPipeClient, buildProbe, createTestAuthority, currentUserSid, getUnavailableReason, inspectClaimCount, makeTrustedTempDirectory,
  standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from './helpers/windows-broker-harness.mjs';

// Windows-only, same-user, unprivileged. The real Broker service loop (the test-faults build's `serve-loop`, where end of stdin plays SERVICE_CONTROL_STOP) with a `computers` config, and
// a raw client on the desktop pipe (ADR-002 Amendment 2026-11-03, "Desktop pipe" and "Desktop lease"): view sessions, then act sessions and the Broker-held lease, whose only source is a
// task.start claim made over the real claim pipe. No VM is touched: the configured VM GUID does not exist, so a capture or an input that passes every check ends in
// `desktop_unavailable` (which is how these tests tell "refused by the Broker" from "reached the adapter"). The capture SUCCESS path needs a real VM and is the opt-in live test at the bottom
// (ALBERA_HYPERV_DESKTOP_VM_ID, read only); no input is ever sent to a real VM, and a fake WMI would need a seam in the shipped binary, and there is none (the key-release retry is tested
// against a fake in windows-broker-hyperv-desktop.test.mjs). The test build has knobs for time only (idle close; a hold inside the capture slot and inside an input turn; the lease's
// lifetime), see DesktopPipe.cs.
const DENIED = { ok: false, code: 'denied' };
const OPENED = { ok: true };
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const EXIT_PIPE_UNAVAILABLE = 70;
const STOP_BUDGET_MS = 5000;
const INSTANCES = 16;
const NO_SUCH_VM = '0123abcd-4567-89ab-cdef-000000000001'; // a GUID that no Hyper-V host has
const OTHER_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555'; // virtual-account shaped, never the signed-in user
const COMPUTERS = [{ computerId: 'room-1', vmId: NO_SUCH_VM }];
const OPEN = { open: { computerId: 'room-1', mode: 'view' } };
const ACT_OPEN = { open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 1 } };
/** `leaseGeneration` null leaves the key out: the open joins the current lease of that operation. */
const actOpen = (operationId, leaseGeneration = 1, computerId = 'room-1') => ({ open: { computerId, mode: 'act', operationId, ...(leaseGeneration === null ? {} : { leaseGeneration }) } });
const CAPTURE = { capture: { width: 640, height: 480 } };
const TAP = { op: 'tap', vk: 65 };
const input = (...steps) => ({ input: { steps } });

/** One frame: 4-byte little-endian length + UTF-8 JSON. A Buffer is sent as is (to build a malformed frame), a string as raw text. */
function frame(body) {
  if (Buffer.isBuffer(body)) return body;
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const size = Buffer.alloc(4);
  size.writeInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}
const lengthOnly = (length) => { const size = Buffer.alloc(4); size.writeInt32LE(length); return size; };

/** A raw client on a pipe: `next()` is the next complete frame body, or null once the connection has ended without one. */
function wrap(socket) {
  let buffer = Buffer.alloc(0);
  let ended = false;
  const waiting = [];
  const settle = () => {
    while (waiting.length > 0) {
      if (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0);
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        waiting.shift()(body);
      } else if (ended) waiting.shift()(null);
      else break;
    }
  };
  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); settle(); });
  socket.on('error', () => {}); // a Disconnect() reaches the client as EPIPE; 'close' follows and decides
  const closed = new Promise((resolve) => socket.once('close', () => { ended = true; settle(); resolve(); }));
  const next = () => new Promise((resolve) => { waiting.push(resolve); settle(); });
  return {
    socket, closed, next,
    send: (body) => socket.write(frame(body)),
    json: async () => { const body = await next(); return body === null ? null : JSON.parse(body.toString('utf8')); },
  };
}

const connectOnce = (pipe) => new Promise((resolve, reject) => {
  const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`);
  socket.once('connect', () => resolve(socket));
  socket.once('error', reject);
});

/** Connects, retrying while the pipe is momentarily without a listening instance (ENOENT before the server is up, EBUSY between a disconnect and the next wait). */
async function connect(pipe, attempts = 60) {
  for (let attempt = 0; ; attempt += 1) {
    try { return wrap(await connectOnce(pipe)); } catch (error) {
      if (!['ENOENT', 'EBUSY'].includes(error.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 10_000) {
  const limit = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > limit) throw new Error(`timeout: ${what}`);
    await sleep(25);
  }
}

const reasonsOf = (child) => child.lines.filter((line) => line.startsWith('DESKTOP_DENY=')).map((line) => line.slice('DESKTOP_DENY='.length));
const countOf = (child, line) => child.lines.filter((x) => x === line).length;

// SDDL writes the built-in local Administrator / Guest of the machine as LA / LG instead of the full SID (CI runs as that Administrator).
function parseSddl(sddl, self) {
  const resolve = (sid) => (sid === 'LA' ? `${self.slice(0, self.lastIndexOf('-'))}-500` : sid);
  return {
    owner: resolve(/^O:([^D]+)D:/u.exec(sddl)?.[1]),
    aces: [...sddl.matchAll(/\(([A-Z]+);[^;]*;([^;]+);[^;]*;[^;]*;([^)]+)\)/gu)].map((m) => ({ type: m[1], mask: Number(m[2]), sid: resolve(m[3]) })),
  };
}

describe('Broker desktop pipe, view and act sessions (seam build, stdin EOF = SERVICE_CONTROL_STOP)', { skip: getUnavailableReason() }, () => {
  let root, loopExe, helper, probeExe, sid;
  const authority = createTestAuthority();
  const running = new Set();
  const clients = new Set();
  before(async () => {
    root = makeTrustedTempDirectory('albera-desktop-pipe-');
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    probeExe = buildProbe(path.join(root, 'probe'));
    sid = currentUserSid();
  });
  after(async () => {
    for (const client of clients) client.socket.destroy();
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const unique = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
  const track = (child) => { running.add(child); child.once('close', () => running.delete(child)); return child; };
  const open = async (pipe) => { const client = await connect(pipe); clients.add(client); return client; };
  /** An opened view session: connected, `open` sent, accepted. */
  async function openSession(pipe) {
    const client = await open(pipe);
    client.send(OPEN);
    assert.deepEqual(await client.json(), OPENED);
    return client;
  }

  function validConfig(name, overrides = {}) {
    return { pipeName: unique('ALBERA_Desk'), database: path.join(root, `${name}.sqlite`), authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG, computers: COMPUTERS, ...overrides };
  }
  function writeConfig(name, config) {
    const file = path.join(root, `${name}.config.json`);
    writeFileSync(file, JSON.stringify(config));
    return file;
  }
  const spawnLoop = (name, config, env) => track(startProcess(loopExe, standInService('serve-loop', writeConfig(name, config)), { stdin: true, env }));
  /** Starts the service loop and waits for BROKER_READY. `env` reaches the test build's two time knobs. */
  async function start(name, overrides, env) {
    const config = validConfig(name, overrides);
    const child = spawnLoop(name, config, env);
    await waitForLine(child, 'BROKER_READY');
    return { child, config, desktop: `${config.pipeName}_desktop`, claims: () => brokerSession({ helper, sid, pipeName: config.pipeName, pid: child.pid, authority }) };
  }
  async function stop(child) {
    const asked = Date.now();
    child.stdin.end();
    return { code: await waitForExit(child), ms: Date.now() - asked };
  }

  it('is made only when the config has computers: the claim pipe alone otherwise, and the claim pipe works either way', async () => {
    for (const [name, computers] of [['none', undefined], ['empty', []]]) {
      const { child, desktop, claims } = await start(name, { computers });
      await assert.rejects(connectOnce(desktop), { code: 'ENOENT' }, `${name}: no desktop pipe`);
      assert.deepEqual((await claims().claim(`no-desktop-${name}`)).result, SUCCESS);
      assert.equal((await stop(child)).code, 0);
    }
    const { child, config, desktop, claims } = await start('some');
    await openSession(desktop);
    assert.deepEqual((await claims().claim('with-desktop')).result, SUCCESS, 'the claim pipe is another pipe: an open desktop session does not stand in its way');
    assert.equal(inspectClaimCount(loopExe, config.database), 1);
    assert.equal((await stop(child)).code, 0);
  });

  it('refuses a config whose desktop pipe name would not be a plain pipe name, but only when that pipe would exist', () => {
    const check = (name, pipeName, computers) => spawnSync(loopExe, standInService('service-check', writeConfig(name, validConfig(name, { pipeName, computers }))), { encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.equal(check('long-ok', 'x'.repeat(120), COMPUTERS), 'SERVICE_CONFIG=ok', '120 + "_desktop" = 128');
    assert.equal(check('long-bad', 'x'.repeat(121), COMPUTERS), 'SERVICE_CONFIG=invalid:pipe_name');
    assert.equal(check('long-no-desktop', 'x'.repeat(128), []), 'SERVICE_CONFIG=ok', 'no computers, no desktop pipe: the old limit stays');
  });

  it('opens a view session, and ends a capture of a VM the host does not have with the fixed denied frame and a closed connection; the reason is in the Broker log only', async () => {
    const { child, desktop } = await start('capture-absent');
    const client = await openSession(desktop);
    client.send(CAPTURE);
    assert.deepEqual(await client.json(), DENIED, 'whatever the reason, the wire says the same thing');
    assert.equal(await client.next(), null, 'and the connection is closed');
    await until(() => reasonsOf(child).length === 1, 'the logged reason');
    assert.deepEqual(reasonsOf(child), ['desktop_unavailable']);
    assert.ok(child.lines.includes('DESKTOP_PEER=authenticated') && child.lines.includes('DESKTOP=OPENED'));
    assert.equal(child.lines.join('\n').includes(NO_SUCH_VM), false, 'the log names no VM GUID');
    assert.equal((await stop(child)).code, 0);
  });

  // [label, frames, reason]. Every frame but the last is answered {"ok":true} (an accepted open); the last is answered with denied, and then the connection is closed.
  const junk = Buffer.concat([lengthOnly(16 * 1024), Buffer.alloc(16 * 1024, 'x')]);
  const cases = [
    ...[
      ['an empty object', {}], ['an array', []], ['a number', 7], ['not JSON', 'not json'], ['open is not an object', { open: 1 }], ['an empty open', { open: {} }],
      ['no mode', { open: { computerId: 'room-1' } }], ['no computerId', { open: { mode: 'view' } }], ['an extra key in open', { open: { computerId: 'room-1', mode: 'view', extra: 1 } }],
      ['an extra top-level key', { open: OPEN.open, extra: 1 }], ['an unknown mode', { open: { computerId: 'room-1', mode: 'edit' } }], ['a mode that is not a string', { open: { computerId: 'room-1', mode: 7 } }],
      ['a computerId that is not an id', { open: { computerId: 'bad id', mode: 'view' } }], ['a computerId that is not a string', { open: { computerId: 5, mode: 'view' } }],
      ['a view open with an operationId', { open: { computerId: 'room-1', mode: 'view', operationId: 'op-1' } }],
      ['a repeated key', '{"open":{"computerId":"room-1","mode":"view","mode":"view"}}'], ['trailing text', `${JSON.stringify(OPEN)} x`],
      ['a lone surrogate escape in computerId', '{"open":{"computerId":"\\ud800","mode":"view"}}'], ['a lone surrogate escape in mode', '{"open":{"computerId":"room-1","mode":"\\ud800"}}'],
      ['a lone surrogate escape in a key', '{"open":{"computerId":"room-1","mo\\ud800de":"view"}}'], ['bytes that are not UTF-8', Buffer.concat([lengthOnly(6), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])])],
      ['a capture before any open', CAPTURE], ['an input before any open', { input: { steps: [{ op: 'move', x: 1, y: 1 }] } }],
      ['a full 16 KiB frame of junk (read in full, then refused for its shape)', junk],
    ].map(([label, first]) => [`open: ${label}`, [first], 'open_shape']),
    ...[
      ['bare', { computerId: 'room-1', mode: 'act' }], ['no operationId', { computerId: 'room-1', mode: 'act', leaseGeneration: 1, extra: 1 }], ['no leaseGeneration', { computerId: 'room-1', mode: 'act', operationId: 'op-1', extra: 1 }],
      ['an extra key', { ...ACT_OPEN.open, extra: 1 }], ['an operationId that is not an id', { ...ACT_OPEN.open, operationId: 'bad id' }], ['an operationId that is not a string', { ...ACT_OPEN.open, operationId: 5 }],
      ['a leaseGeneration that is a string', { ...ACT_OPEN.open, leaseGeneration: '1' }], ['a leaseGeneration of 0', { ...ACT_OPEN.open, leaseGeneration: 0 }], ['a negative leaseGeneration', { ...ACT_OPEN.open, leaseGeneration: -1 }],
      ['a leaseGeneration with a fraction', { ...ACT_OPEN.open, leaseGeneration: 1.5 }], ['a leaseGeneration beyond int64', { ...ACT_OPEN.open, leaseGeneration: 2 ** 63 }], ['a null leaseGeneration', { ...ACT_OPEN.open, leaseGeneration: null }],
      ['a computerId that is not an id', { ...ACT_OPEN.open, computerId: 'bad id' }],
    ].map(([label, body]) => [`open: act with ${label}`, [{ open: body }], 'open_shape']),
    ['open: act, a repeated leaseGeneration', ['{"open":{"computerId":"room-1","mode":"act","operationId":"op-1","leaseGeneration":1,"leaseGeneration":1}}'], 'open_shape'],
    ['open: a view open that names a leaseGeneration', [{ open: { computerId: 'room-1', mode: 'view', leaseGeneration: 1 } }], 'open_shape'],
    ['open: act for a computer that is not configured', [{ open: { ...ACT_OPEN.open, computerId: 'room-9' } }], 'computer_unknown'],
    ['open: act for an operation nobody claimed', [ACT_OPEN], 'lease_unknown'],
    ['open: a computer that is not in the config', [{ open: { computerId: 'room-2', mode: 'view' } }], 'computer_unknown'],
    ['open: a VM GUID instead of a computerId', [{ open: { computerId: NO_SUCH_VM, mode: 'view' } }], 'computer_unknown'],
    ['open: the computerId in another case', [{ open: { computerId: 'ROOM-1', mode: 'view' } }], 'computer_unknown'],
    ...[['zero', 0], ['negative', -1], ['one byte over 16 KiB', 16 * 1024 + 1], ['int32 maximum', 2 ** 31 - 1]].map(([label, length]) => [`frame size: first frame ${label}`, [lengthOnly(length)], 'frame_size']),
    ['frame size: a request above 16 KiB after an open', [OPEN, lengthOnly(16 * 1024 + 1)], 'frame_size'],
    ['view session: input', [OPEN, { input: { steps: [{ op: 'move', x: 1, y: 1 }] } }], 'view_input'],
    ['view session: input with no steps', [OPEN, { input: {} }], 'view_input'],
    ...[
      ['an empty object', {}], ['an unknown request', { snapshot: {} }], ['a second open', OPEN], ['an act open on a view session', ACT_OPEN], ['an array', []], ['input and capture in one frame', { input: {}, capture: CAPTURE.capture }],
      ['two captures in one frame (a repeated key)', '{"capture":{"width":640,"height":480},"capture":{"width":640,"height":480}}'], ['a lone surrogate escape in the request name', '{"cap\\ud800ture":{}}'],
    ].map(([label, second]) => [`request: ${label}`, [OPEN, second], 'request_shape']),
    ...[
      ['no height', { capture: { width: 640 } }], ['a fraction', { capture: { width: 640.5, height: 480 } }], ['an exponent', '{"capture":{"width":6.4e2,"height":480}}'], ['a string', { capture: { width: '640', height: 480 } }],
      ['an extra key', { capture: { width: 640, height: 480, extra: 1 } }], ['not an object', { capture: 5 }], ['null', { capture: null }], ['a repeated width', '{"capture":{"width":640,"width":640}}'], ['a lone surrogate escape in a size name', '{"capture":{"wid\\ud800th":640,"height":480}}'],
      ['beyond int32', { capture: { width: 2 ** 31, height: 480 } }],
    ].map(([label, second]) => [`capture: ${label}`, [OPEN, second], 'capture_shape']),
    ...[
      ['width 63', 63, 480], ['height 63', 640, 63], ['width 1921', 1921, 480], ['height 1921', 640, 1921], ['zero', 0, 0], ['negative', -640, 480], ['int32 maximum', 2147483647, 2147483647],
      ['inside the contract bounds but over the pixel cap (1920x1081)', 1920, 1081],
    ].map(([label, width, height]) => [`capture size: ${label}`, [OPEN, { capture: { width, height } }], 'capture_size']),
  ];

  it(`answers each of ${cases.length} malformed, unsupported or forbidden requests with the fixed denied frame, logs the reason word only, and keeps serving`, async () => {
    const { child, desktop, claims } = await start('denied');
    for (const [label, frames, reason] of cases) {
      const logged = reasonsOf(child).length;
      const client = await open(desktop);
      for (const [index, body] of frames.entries()) {
        client.send(body);
        if (index < frames.length - 1) assert.deepEqual(await client.json(), OPENED, `${label}: the open before it was accepted`);
      }
      assert.deepEqual(await client.json(), DENIED, label);
      assert.equal(await client.next(), null, `${label}: closed after the refusal`);
      await until(() => reasonsOf(child).length > logged, `${label}: logged`);
      assert.equal(reasonsOf(child)[logged], reason, label);
    }
    assert.equal(countOf(child, 'DESKTOP=OPENED'), cases.filter(([, frames]) => frames.length > 1).length, 'only the accepted opens were opened');
    assert.equal(child.lines.some((line) => /capture_enter/u.test(line)), false, 'nothing reached the capture slot');
    assert.equal(child.lines.some((line) => /SESSION_FAILED|SLOT_FAILED/u.test(line)), false, 'no request made a session or a slot fail: every one was refused by the grammar');
    assert.deepEqual((await claims().claim('after-denied')).result, SUCCESS);
    assert.equal((await stop(child)).code, 0);
  });

  it('checks the peer on every connection before reading the request: another principal gets denied and nothing of its request is looked at', async () => {
    const { child, desktop } = await start('peer', { controlPlaneSid: OTHER_SID }); // this user is on the DACL (it owns the pipe) but is not the configured Control Plane
    const client = await open(desktop);
    client.send(OPEN);
    assert.deepEqual(await client.json(), DENIED);
    assert.equal(await client.next(), null);
    await until(() => reasonsOf(child).length === 1, 'the logged reason');
    assert.deepEqual(reasonsOf(child), ['peer']);
    assert.ok(child.lines.includes('DESKTOP_PEER=denied'));
    assert.equal(child.lines.includes('DESKTOP=OPENED'), false, 'the request was never parsed');
    // The same on a second connection, also with a frame length no request may have: the peer is refused first, so the reason is still the peer.
    const second = await open(desktop);
    second.send(lengthOnly(2 ** 31 - 1));
    assert.deepEqual(await second.json(), DENIED);
    await until(() => reasonsOf(child).length === 2, 'the second logged reason');
    assert.deepEqual(reasonsOf(child), ['peer', 'peer']);
    // An act open is no different: the same check comes first, so a peer that is not the Control Plane never gets as far as the lease (no `lease_*` word is logged for it).
    const third = await open(desktop);
    third.send(ACT_OPEN);
    assert.deepEqual(await third.json(), DENIED);
    await until(() => reasonsOf(child).length === 3, 'the third logged reason');
    assert.deepEqual(reasonsOf(child), ['peer', 'peer', 'peer']);
    assert.equal(child.lines.includes('DESKTOP=ACT'), false);
    assert.equal((await stop(child)).code, 0);
  });

  it('has the claim pipe\'s owner and DACL: owned by the Broker, the Broker with full control, the Control Plane SID with exactly 0x00120083', async () => {
    const { child, desktop } = await start('dacl', { controlPlaneSid: OTHER_SID });
    const reader = startProcess(probeExe, ['dacl', desktop]);
    const { owner, aces } = parseSddl((await waitForLine(reader, /^SDDL=/u)).slice('SDDL='.length), sid);
    await waitForExit(reader);
    assert.equal(owner, sid);
    assert.deepEqual(aces.map(({ type, sid: who }) => ({ type, sid: who })), [{ type: 'A', sid }, { type: 'A', sid: OTHER_SID }]);
    assert.equal(aces[0].mask, 0x001f019f);
    assert.equal(aces[1].mask, 0x00120083);
    assert.equal(aces[1].mask & (0x4 | 0x40000000 | 0x10000000), 0, 'no FILE_CREATE_PIPE_INSTANCE and no generic right for the client');
    assert.equal((await stop(child)).code, 0);
  });

  it('closes a session that is idle (the test build shortens the 60 s to one second), before and after the open, without a reply', async () => {
    const { child, desktop } = await start('idle', {}, { ALBERA_BROKER_TEST_DESKTOP_IDLE_MS: '1000' });
    const silent = await open(desktop);
    const waitedSilent = Date.now();
    assert.equal(await silent.next(), null, 'closed without a frame');
    assert.ok(Date.now() - waitedSilent >= 700, `not closed at once (${Date.now() - waitedSilent} ms)`);
    const session = await openSession(desktop);
    const waited = Date.now();
    assert.equal(await session.next(), null, 'closed without a frame');
    await session.closed;
    const idleMs = Date.now() - waited;
    assert.ok(idleMs >= 700 && idleMs < STOP_BUDGET_MS, `closed after ${idleMs} ms`);
    await until(() => countOf(child, 'DESKTOP=IDLE_CLOSED') === 2, 'both idle closes logged');
    assert.deepEqual(reasonsOf(child), [], 'an idle close is not a refusal');
    const again = await openSession(desktop);
    again.send(CAPTURE);
    assert.deepEqual(await again.json(), DENIED, 'the slot that closed an idle session serves the next client');
    assert.equal((await stop(child)).code, 0);
  });

  it(`serves at most ${INSTANCES} sessions at once, the next client waits for a free instance, the claim pipe is unaffected, and STOP is prompt with sessions open`, async () => {
    const { child, desktop, claims } = await start('limit');
    const held = [];
    for (let i = 0; i < INSTANCES; i += 1) held.push(await openSession(desktop));
    await until(() => countOf(child, 'DESKTOP=OPENED') === INSTANCES, 'all sessions logged as opened');
    let seventeenth;
    const state = { connected: false, error: undefined };
    const attempt = connectOnce(desktop).then((socket) => { state.connected = true; seventeenth = wrap(socket); }, (error) => { state.error = error.code; });
    await sleep(1500);
    assert.equal(state.connected, false, 'all instances are in use: the system does not hand out a 17th');
    assert.deepEqual((await claims().claim('while-sixteen-held')).result, SUCCESS, 'a claim is not queued behind the desktop sessions');
    held[0].socket.destroy(); // one session ends: its slot resets its instance and the waiting client gets it
    await attempt;
    seventeenth ??= await connect(desktop);
    clients.add(seventeenth);
    seventeenth.send(OPEN);
    assert.deepEqual(await seventeenth.json(), OPENED, 'the freed instance serves the waiting client');
    const stopped = await stop(child);
    assert.deepEqual([stopped.code, stopped.ms < STOP_BUDGET_MS], [0, true], `stopped in ${stopped.ms} ms with ${INSTANCES} sessions open`);
    assert.ok(child.lines.includes('BROKER_STOPPED'));
    await assert.rejects(connectOnce(desktop), { code: 'ENOENT' }, 'both pipes are gone');
  });

  it('runs one capture at a time in the whole Broker: concurrent sessions queue for the single slot, never overlap, and each still ends in the fixed denied frame', async () => {
    const hold = 600;
    const { child, desktop } = await start('one-capture', {}, { ALBERA_BROKER_TEST_DESKTOP_CAPTURE_HOLD_MS: String(hold) });
    const sessions = [];
    for (let i = 0; i < 4; i += 1) sessions.push(await openSession(desktop));
    const started = Date.now();
    for (const session of sessions) session.send(CAPTURE);
    assert.deepEqual(await Promise.all(sessions.map((session) => session.json())), Array(4).fill(DENIED));
    const elapsed = Date.now() - started;
    const marks = child.lines.filter((line) => line.startsWith('DESKTOP_TEST=')).map((line) => line.slice('DESKTOP_TEST='.length));
    assert.deepEqual(marks, Array(4).fill(['capture_enter', 'capture_exit']).flat(), 'enter, exit, enter, exit ...: never two inside the slot');
    assert.ok(elapsed >= 4 * hold - 100, `four held captures took ${elapsed} ms: they ran one after the other`);
    assert.equal((await stop(child)).code, 0);
  });

  // ---- act sessions and the Broker-held lease -------------------------------------------------------------------------------------------------------------------------------------
  // The lease comes from one thing only: a task.start claim recorded over the real claim pipe (the three-key frame). `${name}-op` is the operationId of the claim called `name`.
  const TASK_SUCCESS = { ok: true, state: 'UNKNOWN', action: 'task.start' };
  const TWO_COMPUTERS = [...COMPUTERS, { computerId: 'room-2', vmId: '0123abcd-4567-89ab-cdef-000000000002' }];
  const PLAIN_ARGS = { task: 'build the project' };
  const dtoOf = (computerId, args = PLAIN_ARGS) => ({ action: 'task.start', projectId: 'project-1', computerId, args });
  /** Prepares (fence + sign) and sends a task.start claim; `request` can be sent again as an exact replay. `args` is the attested form { task, vmId, expectedGeneration } when it names a VM. */
  async function claimTaskStart(session, name, computerId = 'room-1', args = PLAIN_ARGS) {
    const prepared = await session.prepare(name, { purpose: 'guest.command', action: 'task.start', args, computerId });
    const request = { ...prepared, action: dtoOf(computerId, args) };
    return { operationId: `${name}-op`, request, reply: await session.send(request) };
  }
  // A wsl2 computer (ADR-012, decision 4): its task.start must name its target, and that form fits no other computer. Neither can stand in for the other.
  describe('a wsl2 computer on the claim pipe', () => {
    const WSL = 'wsl-1';
    const TARGET = { task: 'build the project', isolation: 'wsl2', repositoryId: 'repo-alpha', baseOid: 'a'.repeat(40) };
    const withWsl2 = { computers: [{ computerId: 'room-1', vmId: NO_SUCH_VM }, { computerId: WSL, kind: 'wsl2' }] };
    const send = async (session, name, computerId, args) => session.send({ ...(await session.prepare(name, { purpose: 'guest.command', action: 'task.start', args, computerId })), action: dtoOf(computerId, args) });

    it('takes the wsl2 form for a wsl2 computer, and makes no desktop lease for it', async () => {
      const { child, desktop, claims } = await start('wsl2-good', withWsl2);
      assert.deepEqual(await send(claims(), 'wsl2-good', WSL, TARGET), { ok: true, state: 'UNKNOWN', action: 'task.start' });
      assert.equal(child.lines.includes('LEASE=GRANTED'), false);
      for (const mode of ['view', 'act']) {
        const client = await connect(desktop);
        client.send({ open: { computerId: WSL, mode, ...(mode === 'act' ? { operationId: 'wsl2-good-op', leaseGeneration: 1 } : {}) } });
        assert.deepEqual(await client.json(), DENIED, `${mode}: a wsl2 computer has no desktop`);
        client.socket.destroy();
      }
      await stop(child);
    });

    it('refuses every other form for a wsl2 computer, and the wsl2 form for a VM', async () => {
      const { child, claims } = await start('wsl2-bad', withWsl2);
      const session = claims();
      const cases = [
        ['the task alone', WSL, { task: TARGET.task }], ['a VM', WSL, { task: TARGET.task, vmId: NO_SUCH_VM, expectedGeneration: 1 }], ['another isolation', WSL, { ...TARGET, isolation: 'vm' }],
        ['no commit', WSL, { task: TARGET.task, isolation: 'wsl2', repositoryId: 'repo-alpha' }], ['a branch name for a commit', WSL, { ...TARGET, baseOid: 'main' }], ['a short commit', WSL, { ...TARGET, baseOid: 'a'.repeat(39) }],
        ['a path for a repository', WSL, { ...TARGET, repositoryId: 'C:/repo' }], ['one more arg', WSL, { ...TARGET, extra: 'x' }], ['a VM beside the target', WSL, { ...TARGET, vmId: NO_SUCH_VM }],
        ['the wsl2 form for a VM computer', 'room-1', TARGET],
      ];
      for (const [label, computerId, args] of cases) assert.deepEqual(await send(session, `bad-${cases.findIndex((c) => c[0] === label)}`, computerId, args), DENIED, label);
      assert.equal(child.lines.filter((line) => line === 'DENY=action_invalid').length, cases.length);
      await stop(child);
    });

    it('opens no desktop pipe for a config with only wsl2 computers', async () => {
      const { child, desktop, claims } = await start('wsl2-only', { computers: [{ computerId: WSL, kind: 'wsl2' }] });
      assert.deepEqual(await send(claims(), 'wsl2-only', WSL, TARGET), { ok: true, state: 'UNKNOWN', action: 'task.start' });
      await assert.rejects(connectOnce(desktop), { code: 'ENOENT' }, 'no desktop pipe');
      await stop(child);
    });
  });

  async function claimed(session, name, computerId, args) {
    const claim = await claimTaskStart(session, name, computerId, args);
    assert.deepEqual(claim.reply, TASK_SUCCESS, `claim ${name}`);
    return claim;
  }
  /** An act session that was opened and accepted; the reply names the generation of the lease it joined (`expected`: the one the test knows the lease has, whether or not the open named it). */
  async function openAct(desktop, operationId, leaseGeneration = 1, computerId = 'room-1', expected = leaseGeneration) {
    const client = await open(desktop);
    client.send(actOpen(operationId, leaseGeneration, computerId));
    assert.deepEqual(await client.json(), { ok: true, leaseGeneration: expected }, `act open ${operationId} generation ${leaseGeneration}`);
    return client;
  }
  /** `send` returns the client that was just sent something refusable: the next frame must be the fixed denied one, the connection must close, and the logged word must be `reason`. */
  async function refused(child, label, reason, send) {
    const before = reasonsOf(child).length;
    const client = await send();
    assert.deepEqual(await client.json(), DENIED, label);
    assert.equal(await client.next(), null, `${label}: closed after the refusal`);
    await until(() => reasonsOf(child).length > before, `${label}: logged`);
    assert.equal(reasonsOf(child)[before], reason, label);
  }
  const refusedOpen = (child, desktop, body, label, reason) => refused(child, label, reason, async () => { const client = await open(desktop); client.send(body); return client; });
  const marks = (child) => child.lines.filter((line) => line.startsWith('DESKTOP_TEST=')).map((line) => line.slice('DESKTOP_TEST='.length));
  /** The reason is `desktop_unavailable` when a request got past every check of the Broker and reached the adapter (the configured VM does not exist). */
  const REACHED_ADAPTER = 'desktop_unavailable';

  it('an act open is refused until a task.start claim has been recorded: no claim, a synthetic.noop claim, a refused task.start claim', async () => {
    const { child, desktop, claims } = await start('act-no-claim');
    const session = claims();
    await refusedOpen(child, desktop, actOpen('nobody-op'), 'no claim at all', 'lease_unknown');
    assert.deepEqual((await session.claim('syn')).result, SUCCESS);
    await refusedOpen(child, desktop, actOpen('syn-op'), 'a recorded synthetic.noop claim', 'lease_unknown');
    // A task.start claim the Broker refuses (the DTO names another computer than the receipt) is not recorded, so it makes nothing.
    const prepared = await session.prepare('bad', { purpose: 'guest.command', action: 'task.start', args: { task: 'build the project' }, computerId: 'room-1' });
    assert.deepEqual(await session.send({ ...prepared, action: dtoOf('room-2') }), DENIED);
    await refusedOpen(child, desktop, actOpen('bad-op'), 'a refused task.start claim', 'lease_unknown');
    assert.equal(countOf(child, 'LEASE=GRANTED'), 0);
    assert.equal(countOf(child, 'DESKTOP=ACT'), 0);
    assert.equal((await stop(child)).code, 0);
  });

  it('a recorded task.start claim creates the lease for the operation and the computer it names: the open is accepted, and both capture and input are accepted in the session (they reach the adapter)', async () => {
    const { child, desktop, claims } = await start('act-granted');
    const session = claims();
    const { operationId } = await claimed(session, 'a1');
    assert.equal(countOf(child, 'LEASE=GRANTED'), 1);
    await refused(child, 'capture in an act session', REACHED_ADAPTER, async () => { const act = await openAct(desktop, operationId); act.send(CAPTURE); return act; });
    await refused(child, 'input in an act session', REACHED_ADAPTER, async () => { const act = await openAct(desktop, operationId); act.send(input(TAP)); return act; });
    assert.deepEqual(marks(child).filter((mark) => mark.startsWith('input')), ['input_enter', 'input_exit'], 'the input was handed to the adapter once');
    assert.equal(countOf(child, 'DESKTOP=ACT'), 2);
    // The lease is the act session's alone: a view session of the same computer still cannot send input, claim or no claim.
    const view = await openSession(desktop);
    await refused(child, 'input in a view session', 'view_input', async () => { view.send(input(TAP)); return view; });
    assert.equal(marks(child).filter((mark) => mark === 'input_enter').length, 1, 'and nothing of it reached the adapter');
    assert.equal((await stop(child)).code, 0);
  });

  it('refuses a generation that is not the current one, an operation that is not the current lease\'s, and a computer that has no lease', async () => {
    const { child, desktop, claims } = await start('act-generation', { computers: TWO_COMPUTERS });
    const { operationId } = await claimed(claims(), 'g1');
    for (const generation of [2, 3, 1000]) await refusedOpen(child, desktop, actOpen(operationId, generation), `generation ${generation}`, 'lease_generation');
    await refusedOpen(child, desktop, actOpen('g1-op2'), 'another operation, same generation', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(operationId, 1, 'room-2'), 'the other configured computer, which has no lease', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(operationId.toUpperCase()), 'the operation id in another case', 'lease_unknown');
    (await openAct(desktop, operationId)).socket.destroy(); // and the right one opens
    assert.equal((await stop(child)).code, 0);
  });

  // Zaku MEDIUM 3 of #166: an attested task.start names its VM in the signed args; the lease is made only when that is the VM the config binds to the computer.
  it('makes a lease for a claim that names the configured VM or none, and none for a claim that names another VM: the claim itself is answered the same, one fixed word is logged', async () => {
    const { child, desktop, claims } = await start('act-vm-binding', { computers: TWO_COMPUTERS });
    const session = claims();
    const attested = (vmId) => ({ task: 'build the project', vmId, expectedGeneration: 1 });
    const OTHER_VM = '0123abcd-4567-89ab-cdef-00000000ffff';
    const wrong = await claimed(session, 'v1', 'room-1', attested(OTHER_VM)); // not a VM of the config at all
    const swapped = await claimed(session, 'v2', 'room-1', attested(TWO_COMPUTERS[1].vmId)); // room-2's VM named for room-1
    assert.equal(countOf(child, 'LEASE=VM_MISMATCH'), 2);
    assert.equal(countOf(child, 'LEASE=GRANTED'), 0);
    await refusedOpen(child, desktop, actOpen(wrong.operationId), 'a claim that named an unknown VM', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(swapped.operationId), 'a claim that named the other computer\'s VM', 'lease_unknown');
    // The right VM makes the lease, and it is generation 1: the refused claims spent no generation.
    const right = await claimed(session, 'v3', 'room-1', attested(COMPUTERS[0].vmId));
    assert.equal(countOf(child, 'LEASE=GRANTED'), 1);
    (await openAct(desktop, right.operationId, 1)).socket.destroy();
    // A claim that names the wrong VM later leaves the standing lease as it is (it is not replaced and its session is not closed).
    const live = await openAct(desktop, right.operationId, 1);
    await claimed(session, 'v4', 'room-1', attested(OTHER_VM));
    assert.equal(countOf(child, 'LEASE=VM_MISMATCH'), 3);
    await refused(child, 'the session open during a mismatching claim', REACHED_ADAPTER, async () => { live.send(input(TAP)); return live; });
    (await openAct(desktop, right.operationId, 1)).socket.destroy();
    // The plain { task } form names no VM and makes a lease, as before.
    const plain = await claimed(session, 'v5', 'room-2');
    (await openAct(desktop, plain.operationId, 1, 'room-2')).socket.destroy();
    assert.equal(countOf(child, 'LEASE=GRANTED'), 2);
    assert.equal(child.lines.some((line) => line.includes(OTHER_VM) || line.includes(TWO_COMPUTERS[1].vmId)), false, 'the log names no VM GUID');
    assert.equal((await stop(child)).code, 0);
  });

  it('counts the generation per computer, and a newer claim for a computer makes the older lease unusable', async () => {
    const { child, desktop, claims } = await start('act-newer', { computers: TWO_COMPUTERS });
    const session = claims();
    const first = await claimed(session, 'n1');
    const second = await claimed(session, 'n2'); // same computer: generation 2
    const other = await claimed(session, 'n3', 'room-2'); // another computer counts from 1 on its own
    await refusedOpen(child, desktop, actOpen(first.operationId, 1), 'the older lease', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(first.operationId, 2), 'the older operation with the new generation', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(second.operationId, 1), 'the new operation with the old generation', 'lease_generation');
    (await openAct(desktop, second.operationId, 2)).socket.destroy();
    (await openAct(desktop, other.operationId, 1, 'room-2')).socket.destroy();
    assert.equal(countOf(child, 'LEASE=GRANTED'), 3);
    assert.equal((await stop(child)).code, 0);
  });

  it('an act open without leaseGeneration joins the lease that is current for its operation and the reply names the generation; a stale or unknown operation is refused as before', async () => {
    const { child, desktop, claims } = await start('act-omitted', { computers: TWO_COMPUTERS });
    const session = claims();
    const first = await claimed(session, 'o1');
    (await openAct(desktop, first.operationId, null, 'room-1', 1)).socket.destroy();
    const second = await claimed(session, 'o2'); // the same computer's generation 2 replaces the first lease
    const elsewhere = await claimed(session, 'o3', 'room-2'); // another computer counts from 1 on its own
    const live = await openAct(desktop, second.operationId, null, 'room-1', 2);
    (await openAct(desktop, elsewhere.operationId, null, 'room-2', 1)).socket.destroy();
    await refusedOpen(child, desktop, actOpen(first.operationId, null), 'the older operation, no generation named', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen('nobody-op', null), 'an operation nobody claimed', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(second.operationId, null, 'room-2'), 'the operation of another computer\'s lease', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(second.operationId.toUpperCase(), null), 'the operation id in another case', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(second.operationId, 1), 'naming a generation is still an exact match (the lease is generation 2)', 'lease_generation');
    // a session that joined without naming the generation is bound to that lease like any other: a newer claim ends it
    const third = await claimed(session, 'o4');
    assert.deepEqual(await live.json(), DENIED);
    assert.equal(await live.next(), null);
    (await openAct(desktop, third.operationId, null, 'room-1', 3)).socket.destroy();
    assert.equal((await stop(child)).code, 0);
  });

  it('an act open that names no generation still carries exactly operationId, computerId and mode: an extra key is a shape error', async () => {
    const { child, desktop } = await start('act-omitted-shape');
    for (const [label, body] of [
      ['an extra key', { ...actOpen('op-1', null).open, extra: 1 }], ['a view-shaped open with a stray operationId', { computerId: 'room-1', mode: 'view', operationId: 'op-1' }],
      ['no operationId and no generation', { computerId: 'room-1', mode: 'act' }], ['a null generation', { ...actOpen('op-1', null).open, leaseGeneration: null }],
    ]) await refusedOpen(child, desktop, { open: body }, label, 'open_shape');
    assert.equal((await stop(child)).code, 0);
  });

  it('a newer claim for the computer closes its open act sessions (the fixed denied frame, then the connection) and leaves view sessions and other computers alone', async () => {
    const { child, desktop, claims } = await start('act-closes', { computers: TWO_COMPUTERS });
    const session = claims();
    const first = await claimed(session, 'c1');
    const elsewhere = await claimed(session, 'c2', 'room-2');
    const [a, b] = [await openAct(desktop, first.operationId), await openAct(desktop, first.operationId)];
    const room2 = await openAct(desktop, elsewhere.operationId, 1, 'room-2');
    const view = await openSession(desktop);
    const logged = reasonsOf(child).length;
    await claimed(session, 'c3'); // room-1 again
    for (const client of [a, b]) {
      assert.deepEqual(await client.json(), DENIED, 'told, with the one fixed frame');
      assert.equal(await client.next(), null, 'and closed');
    }
    await until(() => reasonsOf(child).length >= logged + 2, 'both closes logged');
    assert.deepEqual(reasonsOf(child).slice(logged), ['lease_revoked', 'lease_revoked']);
    // The others are still open and still work: room-2's act session reaches the adapter, and so does the view session's capture.
    await refused(child, 'room-2 session after room-1\'s new claim', REACHED_ADAPTER, async () => { room2.send(input(TAP)); return room2; });
    await refused(child, 'view session after the new claim', REACHED_ADAPTER, async () => { view.send(CAPTURE); return view; });
    assert.equal((await stop(child)).code, 0);
  });

  it('an exact replay of a claim does not create a lease again, does not bump the generation, and does not bring back an older lease', async () => {
    const { child, desktop, claims } = await start('act-replay');
    const session = claims();
    const one = await claimed(session, 'r1');
    const two = await claimed(session, 'r2'); // generation 2 now
    assert.equal(countOf(child, 'LEASE=GRANTED'), 2);
    assert.deepEqual(await session.send(one.request), { ...TASK_SUCCESS, replayed: true });
    assert.deepEqual(await session.send(two.request), { ...TASK_SUCCESS, replayed: true });
    assert.equal(countOf(child, 'LEASE=GRANTED'), 2, 'a replay made no lease');
    assert.equal(countOf(child, 'REPLAY=RECORDED_OUTCOME'), 2);
    await refusedOpen(child, desktop, actOpen(one.operationId, 1), 'the replayed older claim is still not the lease', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(one.operationId, 3), 'nor with a generation a replay would have made', 'lease_unknown');
    await refusedOpen(child, desktop, actOpen(two.operationId, 3), 'the current lease did not move to generation 3', 'lease_generation');
    (await openAct(desktop, two.operationId, 2)).socket.destroy();
    // A replay does not end an open act session either.
    const live = await openAct(desktop, two.operationId, 2);
    assert.deepEqual(await session.send(two.request), { ...TASK_SUCCESS, replayed: true });
    await refused(child, 'the session open during a replay', REACHED_ADAPTER, async () => { live.send(input(TAP)); return live; });
    assert.equal((await stop(child)).code, 0);
  });

  it('loses every lease when the Broker restarts: the same operation and generation are refused, and replaying the recorded claim does not bring the lease back', async () => {
    const first = await start('act-restart');
    const claim = await claimed(first.claims(), 'x1');
    const live = await openAct(first.desktop, claim.operationId);
    assert.equal((await stop(first.child)).code, 0);
    assert.equal(await live.next(), null, 'the old Broker is gone');
    const second = await start('act-restart'); // the same journal: the claim is still recorded there
    assert.equal(inspectClaimCount(loopExe, second.config.database), 1);
    await refusedOpen(second.child, second.desktop, actOpen(claim.operationId), 'after the restart', 'lease_unknown');
    assert.deepEqual(await second.claims().send(claim.request), { ...TASK_SUCCESS, replayed: true }, 'the claim is recorded, so it replays');
    assert.equal(countOf(second.child, 'LEASE=GRANTED'), 0);
    await refusedOpen(second.child, second.desktop, actOpen(claim.operationId), 'after the replay too', 'lease_unknown');
    // A new claim on the new Broker starts a new lease from generation 1: an old client holding generation 1 of the OLD operation gets nothing from it.
    const fresh = await claimed(second.claims(), 'x2');
    await refusedOpen(second.child, second.desktop, actOpen(claim.operationId), 'the old operation next to a new lease', 'lease_unknown');
    (await openAct(second.desktop, fresh.operationId)).socket.destroy();
    assert.equal((await stop(second.child)).code, 0);
  });

  it('expires the lease: an open session is closed with a refusal when it runs out, and a new open is refused (the test build shortens the 60 minutes to 2 seconds)', async () => {
    const { child, desktop, claims } = await start('act-expiry', {}, { ALBERA_BROKER_TEST_DESKTOP_LEASE_SECONDS: '2' });
    const { operationId } = await claimed(claims(), 'e1');
    const live = await openAct(desktop, operationId);
    const opened = Date.now();
    const other = await openAct(desktop, operationId); // a second session, to see that every one is closed
    assert.deepEqual(await live.json(), DENIED, 'closed with the fixed frame when the lease ran out');
    assert.equal(await live.next(), null);
    assert.deepEqual(await other.json(), DENIED);
    const lived = Date.now() - opened;
    assert.ok(lived >= 500 && lived < 6000, `the session lived ${lived} ms (2 s lifetime, counted in whole seconds from the claim)`);
    await until(() => reasonsOf(child).length >= 2, 'both expiries logged');
    assert.deepEqual(reasonsOf(child), ['lease_expired', 'lease_expired']);
    await refusedOpen(child, desktop, actOpen(operationId), 'a new open after the expiry', 'lease_expired');
    // A claim after the expiry starts the next generation, which opens.
    const next = await claimed(claims(), 'e2');
    (await openAct(desktop, next.operationId, 2)).socket.destroy();
    assert.equal((await stop(child)).code, 0);
  });

  // [label, steps, reason]: the reason is what the Broker logs. `desktop_unavailable` = every check passed and the adapter got it.
  const taps = (count) => Array.from({ length: count }, () => TAP);
  const accepted = [
    ['256 steps', taps(256)], ['a 512-character text', [{ op: 'text', text: '~'.repeat(512) }]], ['10000 ms and 2000 ms of sleep (12000 in all)', [{ op: 'sleep', ms: 10000 }, { op: 'sleep', ms: 2000 }]],
    ['every range at its edge', [{ op: 'move', x: 0, y: 4095 }, { op: 'move', x: 4095, y: 0 }, { op: 'wheel', delta: 1200 }, { op: 'wheel', delta: -1200 }, { op: 'down', button: 3 }, { op: 'up', button: 1 },
      { op: 'press', vk: 254 }, { op: 'release', vk: 1 }, { op: 'tap', vk: 1 }, { op: 'sleep', ms: 0 }]],
    ['one of each op', [{ op: 'move', x: 1, y: 2 }, { op: 'down', button: 1 }, { op: 'up', button: 1 }, { op: 'press', vk: 16 }, { op: 'release', vk: 16 }, TAP, { op: 'wheel', delta: -120 }, { op: 'text', text: 'hi' }, { op: 'sleep', ms: 5 }]],
  ];
  const refusedSteps = [
    ...[
      ['257 steps', taps(257)], ['no steps', []], ['a virtual key of 0', [{ op: 'tap', vk: 0 }]], ['a virtual key of 255', [{ op: 'press', vk: 255 }]], ['button 0', [{ op: 'down', button: 0 }]], ['button 4', [{ op: 'up', button: 4 }]],
      ['x of -1', [{ op: 'move', x: -1, y: 0 }]], ['y of 4096', [{ op: 'move', x: 0, y: 4096 }]], ['a wheel of 1201', [{ op: 'wheel', delta: 1201 }]], ['a wheel of -1201', [{ op: 'wheel', delta: -1201 }]],
      ['an empty text', [{ op: 'text', text: '' }]], ['a 513-character text', [{ op: 'text', text: 'a'.repeat(513) }]], ['a text that is not ASCII', [{ op: 'text', text: 'café' }]], ['a text with a tab', [{ op: 'text', text: 'a\tb' }]],
      ['a sleep of 10001 ms', [{ op: 'sleep', ms: 10001 }]], ['a negative sleep', [{ op: 'sleep', ms: -1 }]], ['sleeps adding up to 12001 ms', [{ op: 'sleep', ms: 6001 }, { op: 'sleep', ms: 6000 }]],
      ['an unknown op (ctrlaltdel)', [{ op: 'ctrlaltdel' }]], ['an op in another case', [{ op: 'Move', x: 1, y: 1 }]], ['a move with a stray vk', [{ op: 'move', x: 1, y: 1, vk: 65 }]], ['a tap without a vk', [{ op: 'tap' }]],
      ['a text with a stray ms', [{ op: 'text', text: 'a', ms: 5 }]], ['a bad step after good ones', [TAP, { op: 'move', x: 1, y: 1 }, { op: 'tap', vk: 0 }]],
    ].map(([label, steps]) => [label, input(...steps), 'input_steps']),
    ...[
      ['no steps key', { input: {} }], ['steps that is not an array', { input: { steps: {} } }], ['an extra key beside steps', { input: { steps: [TAP], extra: 1 } }], ['input that is not an object', { input: 5 }],
      ['a step that is a number', input(5)], ['a step that is an array', input([])], ['a step that is null', input(null)], ['an unknown field in a step', input({ op: 'tap', vk: 65, foo: 1 })],
      ['a coordinate that is a string', input({ op: 'move', x: '1', y: 1 })], ['a coordinate with a fraction', input({ op: 'move', x: 1.5, y: 1 })], ['a coordinate with an exponent', '{"input":{"steps":[{"op":"move","x":1e1,"y":1}]}}'],
      ['a coordinate beyond int64', input({ op: 'move', x: 2 ** 63, y: 1 })], ['a null coordinate', input({ op: 'move', x: null, y: 1 })], ['an op that is a number', input({ op: 7 })], ['no op', input({ vk: 65 })],
      ['a text that is a number', input({ op: 'text', text: 5 })], ['a repeated key in a step', '{"input":{"steps":[{"op":"tap","vk":65,"vk":65}]}}'], ['a repeated steps key', '{"input":{"steps":[],"steps":[]}}'],
      ['a lone surrogate escape in a text', '{"input":{"steps":[{"op":"text","text":"\\ud800"}]}}'],
    ].map(([label, body]) => [label, body, 'input_shape']),
  ]; // (a frame above 16 KiB is refused by its length alone, in any session: see "frame size" above)

  it(`takes input in an act session up to the adapter's limits (${accepted.length} accepted shapes) and refuses each of ${refusedSteps.length} requests beyond them before the adapter is reached`, async () => {
    const { child, desktop, claims } = await start('act-input');
    const { operationId } = await claimed(claims(), 'i1');
    for (const [label, steps] of accepted) {
      await refused(child, label, REACHED_ADAPTER, async () => { const act = await openAct(desktop, operationId); act.send(input(...steps)); return act; });
    }
    assert.equal(marks(child).filter((mark) => mark === 'input_enter').length, accepted.length, 'every accepted request was handed to the adapter');
    for (const [label, body, reason] of refusedSteps) {
      await refused(child, label, reason, async () => { const act = await openAct(desktop, operationId); act.send(body); return act; });
    }
    assert.equal(marks(child).filter((mark) => mark === 'input_enter').length, accepted.length, 'and none of the refused ones was');
    assert.equal(child.lines.some((line) => /SESSION_FAILED|SLOT_FAILED|INPUT_HUNG/u.test(line)), false);
    assert.equal((await stop(child)).code, 0);
  });

  it('runs one input request at a time per computer: two act sessions of one lease take turns, and never overlap', async () => {
    const hold = 600;
    const { child, desktop, claims } = await start('act-turns', {}, { ALBERA_BROKER_TEST_DESKTOP_INPUT_HOLD_MS: String(hold) });
    const { operationId } = await claimed(claims(), 't1');
    const sessions = [await openAct(desktop, operationId), await openAct(desktop, operationId), await openAct(desktop, operationId)];
    const started = Date.now();
    for (const act of sessions) act.send(input(TAP));
    assert.deepEqual(await Promise.all(sessions.map((act) => act.json())), Array(3).fill(DENIED));
    const elapsed = Date.now() - started;
    assert.deepEqual(marks(child), Array(3).fill(['input_enter', 'input_exit']).flat(), 'enter, exit, enter, exit ...: never two inside a turn');
    assert.ok(elapsed >= 3 * hold - 100, `three held requests took ${elapsed} ms: one after the other`);
    assert.deepEqual(reasonsOf(child), Array(3).fill(REACHED_ADAPTER));
    assert.equal((await stop(child)).code, 0);
  });

  it('ends a request that waits for its turn when the lease ends, and stops the one that holds the turn before it sends a step: a claim that replaced the lease meanwhile', async () => {
    const { child, desktop, claims } = await start('act-recheck', {}, { ALBERA_BROKER_TEST_DESKTOP_INPUT_HOLD_MS: '4000' }); // long enough for a fence + claim through the helper process while the first request holds the turn
    const session = claims();
    const { operationId } = await claimed(session, 'k1');
    const sessions = [await openAct(desktop, operationId), await openAct(desktop, operationId)];
    for (const act of sessions) act.send(input(TAP));
    await until(() => marks(child).includes('input_enter'), 'the first request holds the turn');
    await claimed(session, 'k2'); // replaces the lease while one request runs and the other waits
    assert.deepEqual(await Promise.all(sessions.map((act) => act.json())), [DENIED, DENIED]);
    await until(() => reasonsOf(child).length === 2, 'both reasons logged');
    assert.deepEqual(reasonsOf(child), ['lease_revoked', 'lease_revoked'], 'the one that was running was stopped before the adapter sent a step (it would have ended desktop_unavailable); the other never reached the adapter');
    assert.equal(marks(child).filter((mark) => mark === 'input_enter').length, 1);
    // The waiting request did not wait for the turn: its refusal came while the first request still held it (the hold is in the test build only).
    const logged = child.lines.filter((line) => line === 'DESKTOP_DENY=lease_revoked' || line === 'DESKTOP_TEST=input_exit');
    assert.deepEqual(logged.slice(0, 2), ['DESKTOP_DENY=lease_revoked', 'DESKTOP_TEST=input_exit'], 'the waiting request was refused before the running one left its turn');
    assert.equal((await stop(child)).code, 0);
  });

  it(`exits ${EXIT_PIPE_UNAVAILABLE} before READY, and never touches the journal, when the desktop pipe's name is already taken`, async () => {
    const config = validConfig('squat');
    const squatter = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(`\\\\.\\pipe\\${config.pipeName}_desktop`, resolve); });
    try {
      const child = spawnLoop('squat', config);
      assert.equal(await waitForExit(child), EXIT_PIPE_UNAVAILABLE, child.lines.join('|'));
      assert.deepEqual(child.lines, ['BROKER_FATAL=PIPE_UNAVAILABLE', 'BROKER_STOPPED']);
      assert.equal(inspectClaimCount(loopExe, config.database), 0, 'no epoch was begun');
    } finally { await new Promise((resolve) => squatter.close(resolve)); }
  });
});

// Real-machine test, opt in with ALBERA_HYPERV_DESKTOP_VM_ID=<GUID of a running VM> (Msvm_ComputerSystem.Name, any case). It needs a user that may call the Hyper-V WMI provider (Hyper-V
// Administrators), so it is skipped in CI. READ ONLY: it opens a view session and captures; no input is ever sent (the pipe has no input yet). The picture is checked structurally and discarded.
const liveVm = process.env.ALBERA_HYPERV_DESKTOP_VM_ID;
const liveSkip = getUnavailableReason() || (liveVm ? false : 'set ALBERA_HYPERV_DESKTOP_VM_ID=<VM GUID> to capture one real VM screen through the desktop pipe (read only)');
describe('Broker desktop pipe against a real VM (opt in, read only)', { skip: liveSkip }, () => {
  let root, loopExe, sid, child, desktop;
  before(async () => {
    root = makeTrustedTempDirectory('albera-desktop-live-');
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    sid = currentUserSid();
    const config = {
      pipeName: `ALBERA_DeskLive_${randomBytes(6).toString('hex')}`, database: path.join(root, 'live.sqlite'), authorityKeys: [createTestAuthority().keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG,
      computers: [{ computerId: 'room-live', vmId: String(liveVm).toLowerCase() }],
    };
    const file = path.join(root, 'live.config.json');
    writeFileSync(file, JSON.stringify(config));
    child = startProcess(loopExe, standInService('serve-loop', file), { stdin: true });
    await waitForLine(child, 'BROKER_READY');
    desktop = `${config.pipeName}_desktop`;
  });
  after(async () => {
    child?.stdin.end();
    if (child) await waitForExit(child);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('captures the screen as a PNG of exactly the announced size, twice in one session, and refuses a computer it was not given', async () => {
    const client = await connect(desktop);
    client.send({ open: { computerId: 'room-live', mode: 'view' } });
    assert.deepEqual(await client.json(), OPENED);
    for (let round = 0; round < 2; round += 1) {
      client.send({ capture: { width: 640, height: 480 } });
      const header = await client.json();
      assert.deepEqual(Object.keys(header), ['ok', 'width', 'height', 'bytes'], JSON.stringify(header));
      assert.deepEqual([header.ok, header.width, header.height], [true, 640, 480]);
      assert.ok(header.bytes > 0 && header.bytes <= 8 * 1024 * 1024);
      const png = await client.next();
      assert.equal(png.length, header.bytes, 'the binary frame is exactly `bytes` long');
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [640, 480], 'IHDR');
    }
    client.socket.destroy();
    const stranger = await connect(desktop);
    stranger.send({ open: { computerId: 'room-other', mode: 'view' } });
    assert.deepEqual(await stranger.json(), DENIED);
    stranger.socket.destroy();
  });
});
