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
// a raw client on the desktop pipe (ADR-002 Amendment 2026-11-03, "Desktop pipe"; `view` sessions only). No VM is touched: the configured VM GUID does not exist, so a capture ends in
// `desktop_unavailable`. The capture SUCCESS path needs a real VM and is the opt-in live test at the bottom (ALBERA_HYPERV_DESKTOP_VM_ID, read only): a fake WMI would need a seam in the
// shipped binary, and there is none. The test build has two knobs for time only (idle close; a hold inside the one capture slot), see DesktopPipe.cs.
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
const CAPTURE = { capture: { width: 640, height: 480 } };

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

describe('Broker desktop pipe, view sessions (seam build, stdin EOF = SERVICE_CONTROL_STOP)', { skip: getUnavailableReason() }, () => {
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
    ['open: act, the shape of the later lease change', [{ open: { computerId: 'room-1', mode: 'act', operationId: 'op-1', leaseGeneration: 1 } }], 'act_unsupported'],
    ['open: act, bare', [{ open: { computerId: 'room-1', mode: 'act' } }], 'act_unsupported'],
    ['open: act for a computer that is not configured', [{ open: { computerId: 'room-9', mode: 'act' } }], 'act_unsupported'],
    ['open: a computer that is not in the config', [{ open: { computerId: 'room-2', mode: 'view' } }], 'computer_unknown'],
    ['open: a VM GUID instead of a computerId', [{ open: { computerId: NO_SUCH_VM, mode: 'view' } }], 'computer_unknown'],
    ['open: the computerId in another case', [{ open: { computerId: 'ROOM-1', mode: 'view' } }], 'computer_unknown'],
    ...[['zero', 0], ['negative', -1], ['one byte over 16 KiB', 16 * 1024 + 1], ['int32 maximum', 2 ** 31 - 1]].map(([label, length]) => [`frame size: first frame ${label}`, [lengthOnly(length)], 'frame_size']),
    ['frame size: a request above 16 KiB after an open', [OPEN, lengthOnly(16 * 1024 + 1)], 'frame_size'],
    ['view session: input', [OPEN, { input: { steps: [{ op: 'move', x: 1, y: 1 }] } }], 'view_input'],
    ['view session: input with no steps', [OPEN, { input: {} }], 'view_input'],
    ...[
      ['an empty object', {}], ['an unknown request', { snapshot: {} }], ['a second open', OPEN], ['an array', []], ['input and capture in one frame', { input: {}, capture: CAPTURE.capture }],
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
