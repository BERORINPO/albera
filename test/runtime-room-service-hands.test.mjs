import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeControlPlaneSecretStore } from '../src/runtime/fake-control-plane-secret-store.mjs';
import { SecretStoreError } from '../src/runtime/control-plane-secret-store.mjs';
import { CREDENTIAL_NAME, createRoomServiceHands } from '../src/runtime/room-service-hands.mjs';

// The hands of the room service (src/runtime/room-service-hands.mjs) with a Fake driver: what these prove is the order of the steps and the rules between them (the VM check first, a new empty
// configuration folder per run that is always removed, the credential from the secret store only, one run per computer, stop). The real driver against the Fake claude is in
// runtime-room-service.test.mjs. Nothing here starts a process.
const TOKEN = 'TEST-ONLY-oauth-token-0123456789abcdef';
const VM = '0a1b2c3d-1111-4222-8333-444455556666';
const BROKER = { pipeName: 'ALBERA_HostBroker', serviceName: 'AlberaHostBroker', helperPath: path.resolve(path.sep, 'albera-test', 'pipe-client.exe'), helperSha256: 'e'.repeat(64) };
const CLAUDE = { executable: path.resolve(path.sep, 'albera-test', 'claude.exe'), executableSha256: 'c'.repeat(64), model: null, maxMs: 60_000, maxToolCalls: 20 };
const roots = [];
process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A driver factory that records what it was given (and what the two folders held at that moment) and ends when the test says so. */
function fakeDrivers() {
  const made = [];
  return {
    made,
    create(options) {
      const done = defer();
      const rec = { options, stops: [], configEntries: readdirSync(options.configDir), workEntries: readdirSync(options.workDir), finish: done.resolve };
      made.push(rec);
      return {
        async run() { options.onEvent({ type: 'start', pid: 4242 }); return done.promise; },
        stop(reason) { rec.stops.push(reason); done.resolve({ outcome: 'stopped', reason, claim: '', toolCalls: 0 }); },
      };
    },
  };
}

function setup({ targets, token = TOKEN, claude = CLAUDE, createDriver, ...rest } = {}) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-hands-')));
  roots.push(base);
  const runRoot = path.join(base, 'control-plane', 'claude-run');
  const drivers = fakeDrivers();
  const secretStore = rest.secretStore ?? createFakeControlPlaneSecretStore();
  const loads = [];
  const store = { load: async (name) => { loads.push(name); return secretStore.load(name); } };
  const events = [];
  const logs = [];
  let n = 0;
  const hands = createRoomServiceHands({
    targets: targets ?? new Map([['albera-computer-a', { computerId: 'computer-a' }], ['albera-computer-b', { computerId: 'computer-b' }]]),
    secretStore: store, runRoot, claude, mcp: { command: process.execPath, entryPath: path.join(base, 'mcp-main.mjs'), broker: BROKER },
    claudeGuard: rest.claudeGuard ?? { check: async () => true },
    onEvent: (vm, event) => events.push([vm, event]), log: (line) => logs.push(line), createDriver: createDriver ?? ((options) => drivers.create(options)),
    newRunId: () => `run-${String(++n).padStart(16, '0')}`,
  });
  return { base, runRoot, drivers, secretStore, loads, events, logs, hands, ready: token === null || rest.secretStore ? Promise.resolve() : secretStore.save(CREDENTIAL_NAME, token) };
}
const eventTypes = (world) => world.events.map(([vm, e]) => `${vm}:${e.type}`);

// ---- acceptance 3: the VM is checked before anything is read, made or started ----

test('the VM check comes first: a mismatch in either direction is vm_unknown and no credential is opened, no folder made, no driver built', async () => {
  const named = new Map([['albera-computer-a', { computerId: 'computer-a', vmId: VM, expectedGeneration: 3 }]]);
  const plain = new Map([['albera-computer-a', { computerId: 'computer-a' }]]);
  const cases = [
    ['the approved action names a VM the settings do not', plain, { vmId: VM, expectedGeneration: 3 }],
    ['the settings name a VM the approval did not', named, {}],
    ['another VM', named, { vmId: 'ffffffff-1111-4222-8333-444455556666', expectedGeneration: 3 }],
    ['another generation', named, { vmId: VM, expectedGeneration: 4 }],
    ['the VM without its generation', named, { vmId: VM }],
    ['a computer the settings do not know', plain, { computerId: 'computer-zzz' }],
  ];
  for (const [label, targets, patch] of cases) {
    const w = setup({ targets });
    await w.ready;
    const answer = await w.hands.start({ computerId: 'computer-a', task: 'open notepad', operationId: 'start-1', ...patch });
    assert.deepEqual(answer, { ok: false, code: 'vm_unknown' }, label);
    assert.deepEqual([w.loads, w.drivers.made, w.events, existsSync(w.runRoot)], [[], [], [], false], `${label}: nothing was read, made or started`);
  }
});

test('the same VM and generation as the settings start the run', async () => {
  const w = setup({ targets: new Map([['albera-computer-a', { computerId: 'computer-a', vmId: VM, expectedGeneration: 3 }]]) });
  await w.ready;
  const started = await w.hands.start({ computerId: 'computer-a', task: 'open notepad', operationId: 'start-1', vmId: VM, expectedGeneration: 3 });
  assert.deepEqual(started, { ok: true });
  assert.equal(w.drivers.made.length, 1);
});

// ---- acceptance 4: a new empty configuration folder per run, removed afterwards ----

test('every run gets its own new, empty config and work folders, and they are gone when the run is over (done, stopped, or a driver that throws)', async () => {
  const w = setup();
  await w.ready;
  const seen = [];
  for (const how of ['done', 'stopped', 'throws']) {
    const answer = await w.hands.start({ computerId: 'computer-a', task: `task ${how}`, operationId: `start-${how}` });
    assert.deepEqual(answer, { ok: true }, how);
    const rec = w.drivers.made.at(-1);
    seen.push(rec.options.configDir);
    assert.deepEqual([rec.configEntries, rec.workEntries], [[], []], `${how}: both folders were empty when the driver got them`);
    assert.ok(existsSync(rec.options.configDir) && existsSync(rec.options.workDir), `${how}: they exist while the run lasts`);
    assert.equal(path.dirname(rec.options.configDir), path.dirname(rec.options.workDir));
    assert.equal(path.dirname(path.dirname(rec.options.configDir)), w.runRoot);
    writeFileSync(path.join(rec.options.configDir, 'left-behind.txt'), 'x'); // whatever the run leaves
    if (how === 'done') rec.finish({ outcome: 'claimed_done', reason: 'end_turn', claim: 'DONE', toolCalls: 2 });
    else w.hands.stopAll();
    await w.hands.fleet.idle('albera-computer-a');
    assert.equal(existsSync(path.dirname(rec.options.configDir)), false, `${how}: the run folder was deleted`);
  }
  assert.equal(new Set(seen).size, 3, 'a different folder every time');
  assert.deepEqual(readdirSync(w.runRoot), []);
  const t = setup({ createDriver: () => { throw new Error('boom with C:\\secret\\path'); } });
  await t.ready;
  assert.deepEqual(await t.hands.start({ computerId: 'computer-a', task: 'x', operationId: 'start-1' }), { ok: false, code: 'start_error' });
  await t.hands.fleet.idle('albera-computer-a');
  assert.deepEqual(readdirSync(t.runRoot), [], 'a driver that could not be built leaves no folder');
  assert.ok(!JSON.stringify(t.logs).includes('secret'), 'the cause is not logged');
});

test('a folder name that already exists is never reused', async () => {
  const w = setup();
  await w.ready;
  mkdirSync(path.join(w.runRoot, 'run-0000000000000001'), { recursive: true });
  writeFileSync(path.join(w.runRoot, 'run-0000000000000001', 'old.txt'), 'x');
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'x', operationId: 'start-1' }), { ok: false, code: 'start_error' });
  assert.equal(w.drivers.made.length, 0);
});

test('sweep() removes the leftovers of a killed service (run-<16 hex> folders only) and nothing else', async () => {
  const w = setup();
  mkdirSync(path.join(w.runRoot, 'run-00000000deadbeef', 'config'), { recursive: true });
  writeFileSync(path.join(w.runRoot, 'run-00000000deadbeef', 'config', 'x'), 'x');
  mkdirSync(path.join(w.runRoot, 'keep-me'));
  mkdirSync(path.join(w.runRoot, 'run-short'));
  assert.equal(await w.hands.sweep(), 1);
  assert.deepEqual(readdirSync(w.runRoot).sort(), ['keep-me', 'run-short']);
  assert.equal(await setup().hands.sweep(), 0, 'no folder at all is not an error');
});

// ---- acceptance 5: the credential comes from the secret store ----

test('the token is read from the secret store for each run and handed to the driver; the process environment is never asked', async () => {
  const w = setup();
  await w.ready;
  process.env.ANTHROPIC_API_KEY = 'ENV-API-KEY-MUST-NOT-BE-READ';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ENV-OAUTH-TOKEN-MUST-NOT-BE-READ';
  try {
    await w.hands.start({ computerId: 'computer-a', task: 'one', operationId: 'start-1' });
    w.hands.stopAll();
    await w.hands.fleet.idle('albera-computer-a');
    await w.hands.start({ computerId: 'computer-a', task: 'two', operationId: 'start-2' });
    w.hands.stopAll();
    await w.hands.fleet.idle('albera-computer-a');
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  assert.deepEqual(w.loads, [CREDENTIAL_NAME, CREDENTIAL_NAME], 'one read per run, of the one credential name');
  assert.deepEqual(w.drivers.made.map((d) => d.options.oauthToken), [TOKEN, TOKEN]);
  for (const rec of w.drivers.made) assert.ok(!JSON.stringify(rec.options).includes('ENV-'), 'nothing from the environment reached the driver');
  assert.ok(!JSON.stringify([w.events, w.logs]).includes(TOKEN), 'the token is in no event and no log line');
});

test('no usable credential: a fixed code, the run ends as an error, and no folder is made and no driver is built', async () => {
  const unreadable = createFakeControlPlaneSecretStore();
  await unreadable.save(CREDENTIAL_NAME, TOKEN);
  unreadable.markUnreadable(CREDENTIAL_NAME);
  const cases = [['credential_missing', null, undefined], ['credential_unreadable', TOKEN, unreadable], ['credential_invalid', 'short', undefined], ['credential_error', TOKEN, { load: async () => { throw new SecretStoreError('timeout'); } }]];
  for (const [reason, token, secretStore] of cases) {
    const w = setup({ token, secretStore });
    await w.ready;
    assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'x', operationId: 'start-1' }), { ok: false, code: 'start_error' }, reason);
    assert.deepEqual([w.drivers.made, existsSync(w.runRoot)], [[], false], reason);
    const end = w.events.find(([, e]) => e.type === 'end')[1];
    assert.deepEqual([end.outcome, end.reason, end.usd], ['error', reason, 0]);
    assert.ok(w.logs.some((line) => line.includes(reason)));
  }
});

test('the MCP server gets the approved computer and operation, the pinned broker, and no secret; the limits are the configured ones', async () => {
  const w = setup({ claude: { ...CLAUDE, model: 'claude-haiku-5-5', maxMs: 90_000, maxToolCalls: 33 } });
  await w.ready;
  await w.hands.start({ computerId: 'computer-b', task: 'rename the report', operationId: 'start-7' });
  const { options } = w.drivers.made[0];
  assert.equal(options.task, 'rename the report');
  assert.deepEqual([options.executable, options.executableSha256, options.model, options.limits], [CLAUDE.executable, CLAUDE.executableSha256, 'claude-haiku-5-5', { maxMs: 90_000, maxToolCalls: 33 }]);
  assert.equal(options.mcpServer.command, process.execPath);
  assert.deepEqual(options.mcpServer.args.slice(1), ['--computer', 'computer-b', '--operation', 'start-7', '--screen', '1024x768', '--pipe-name', 'ALBERA_HostBroker', '--service-name', 'AlberaHostBroker',
    '--helper', BROKER.helperPath, '--helper-sha256', BROKER.helperSha256]);
  assert.ok(!JSON.stringify(options.mcpServer).includes(TOKEN));
  w.hands.stopAll();
  await w.hands.close();
});

// ---- one run per computer, stop, events ----

test('one run per computer; another computer runs at the same time; stopAll ends only what was started here and says how many', async () => {
  const w = setup();
  await w.ready;
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'a', operationId: 'start-1' }), { ok: true });
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'again', operationId: 'start-2' }), { ok: false, code: 'busy' });
  assert.deepEqual(await w.hands.start({ computerId: 'computer-b', task: 'b', operationId: 'start-3' }), { ok: true });
  assert.equal(w.hands.stopAll(), 2);
  assert.deepEqual(w.drivers.made.map((d) => d.stops), [['stopped_by_human'], ['stopped_by_human']]);
  await Promise.all([w.hands.fleet.idle('albera-computer-a'), w.hands.fleet.idle('albera-computer-b')]);
  assert.equal(w.hands.stopAll(), 0);
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'a2', operationId: 'start-4' }), { ok: true }, 'free again once the run is over');
  await w.hands.close();
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'late', operationId: 'start-5' }), { ok: false, code: 'not_started' }, 'a closed service starts nothing');
});

test('a stop that arrives while the credential is still being opened starts no driver', async () => {
  const slow = defer();
  const w = setup({ secretStore: { load: async () => { await slow.promise; return Buffer.from(TOKEN); } } });
  const pending = w.hands.start({ computerId: 'computer-a', task: 'x', operationId: 'start-1' });
  assert.equal(w.hands.stopAll(), 1);
  slow.resolve();
  assert.deepEqual(await pending, { ok: false, code: 'start_error' });
  assert.equal(w.drivers.made.length, 0);
  assert.equal(w.events.find(([, e]) => e.type === 'end')[1].outcome, 'stopped');
});

test('events have the API-key loop\'s shape (start, action, step, end; usd 0) and carry no screen, key or typed text; the end comes after the folder is gone', async () => {
  const w = setup();
  await w.ready;
  await w.hands.start({ computerId: 'computer-a', task: 'open notepad', operationId: 'start-1' });
  const rec = w.drivers.made[0];
  rec.options.onEvent({ type: 'tool_call', count: 1, tool: 'screenshot' });
  rec.options.onEvent({ type: 'tool_call', count: 2, tool: 'type' });
  const runDir = path.dirname(rec.options.configDir);
  rec.finish({ outcome: 'claimed_done', reason: 'end_turn', claim: 'DONE: it is open', toolCalls: 2 });
  await w.hands.fleet.idle('albera-computer-a');
  assert.deepEqual(w.events, [
    ['albera-computer-a', { type: 'start', job: 1, task: 'open notepad' }],
    ['albera-computer-a', { type: 'action', action: 'screenshot' }], ['albera-computer-a', { type: 'step', step: 1, usd: 0, note: '' }],
    ['albera-computer-a', { type: 'action', action: 'type' }], ['albera-computer-a', { type: 'step', step: 2, usd: 0, note: '' }],
    ['albera-computer-a', { type: 'end', outcome: 'claimed_done', claim: 'DONE: it is open', steps: 2, actions: 2, usd: 0, reason: 'end_turn' }],
  ]);
  assert.equal(existsSync(runDir), false);
  assert.deepEqual(w.logs, ['hands ended outcome=claimed_done reason=end_turn'], 'the log line carries codes only');
});

test('the fleet the room host takes: no initial job, a start needs the approved operation as its desktop session, stopVm and idle work by VM name', async () => {
  const w = setup();
  await w.ready;
  const { fleet } = w.hands;
  assert.equal(fleet.initialJobCount, 0);
  assert.deepEqual(fleet.startJob('albera-computer-a', 'x'), { ok: false, code: 'desktop_session_invalid' });
  assert.deepEqual(fleet.startJob('no-such-vm', 'x', { desktopSessionId: 'start-1' }), { ok: false, code: 'vm_unknown' });
  assert.deepEqual(fleet.startJob('albera-computer-a', 'x', { desktopSessionId: 'start 1' }), { ok: false, code: 'not_started' }, 'a session id that is not an id');
  assert.deepEqual(fleet.startJob('albera-computer-a', 'x', { desktopSessionId: 'start-1' }), { ok: true });
  assert.deepEqual(fleet.startJob('albera-computer-a', 'y', { desktopSessionId: 'start-2' }), { ok: false, code: 'busy' });
  await settle(50);
  assert.equal(fleet.stopVm('albera-computer-a'), true);
  assert.equal(fleet.stopVm('albera-computer-b'), false);
  await fleet.idle('albera-computer-a');
  assert.deepEqual(w.drivers.made[0].options.mcpServer.args.slice(3, 5), ['--operation', 'start-1']);
});

// ---- zaku SEC-001: the executable's folders are checked before every run ----

test('the guard is asked before every run, before the credential is opened; an untrusted executable never sees the credential and nothing is made or started', async () => {
  const asked = [];
  let trusted = false;
  const w = setup({ claudeGuard: { check: async (executable) => { asked.push(executable); return trusted; } } });
  await w.ready;
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'x', operationId: 'start-1' }), { ok: false, code: 'start_error' });
  assert.deepEqual([asked, w.loads, w.drivers.made, existsSync(w.runRoot)], [[CLAUDE.executable], [], [], false]);
  assert.equal(w.events.find(([, e]) => e.type === 'end')[1].reason, 'claude_untrusted');
  assert.ok(w.logs.includes('hands ended outcome=error reason=claude_untrusted'));
  trusted = true; // fixed by an administrator: the next run goes (it is asked again, not remembered)
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'x', operationId: 'start-2' }), { ok: true });
  assert.deepEqual([asked.length, w.loads.length], [2, 1]);
  w.hands.stopAll();
  await w.hands.close();
  const broken = setup({ claudeGuard: { check: async () => { throw new Error('powershell missing'); } } });
  await broken.ready;
  assert.deepEqual(await broken.hands.start({ computerId: 'computer-a', task: 'x', operationId: 'start-1' }), { ok: false, code: 'start_error' }, 'a check that cannot finish is a refusal');
  assert.deepEqual(broken.loads, []);
});

// ---- zaku SEC-003: a tree stop that was not confirmed keeps the computer busy ----

test('treeStopConfirmed === false keeps that computer busy until a person stops it; the log says so with one fixed word; other computers and confirmed stops are not affected', async () => {
  const w = setup();
  await w.ready;
  const end = (outcome, reason, treeStopConfirmed) => ({ outcome, reason, claim: '', toolCalls: 1, treeStopConfirmed });
  await w.hands.start({ computerId: 'computer-a', task: 'one', operationId: 'start-1' });
  w.drivers.made[0].finish(end('stopped', 'max_ms', false));
  await w.hands.fleet.idle('albera-computer-a');
  assert.deepEqual(w.logs.filter((l) => l.includes('tree_stop')), ['hands tree_stop_unconfirmed'], 'a fixed word, nothing else');
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'two', operationId: 'start-2' }), { ok: false, code: 'busy' });
  assert.deepEqual(w.hands.fleet.startJob('albera-computer-a', 'two', { desktopSessionId: 'start-3' }), { ok: false, code: 'busy' }, 'the card path is refused too');
  assert.equal(w.drivers.made.length, 1, 'no second driver');
  assert.deepEqual(await w.hands.start({ computerId: 'computer-b', task: 'other', operationId: 'start-4' }), { ok: true }, 'another computer is free');
  assert.equal(w.hands.stopAll(), 1, 'stopAll counts the run that is really running, not the one that already ended');
  await w.hands.fleet.idle('albera-computer-b');
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'three', operationId: 'start-5' }), { ok: true }, 'the person\'s stop released the computer');
  w.drivers.made.at(-1).finish(end('claimed_done', 'end_turn', true));
  await w.hands.fleet.idle('albera-computer-a');
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'four', operationId: 'start-6' }), { ok: true }, 'a confirmed tree stop leaves nothing behind');
  w.drivers.made.at(-1).finish(end('claimed_done', 'end_turn', null));
  await w.hands.fleet.idle('albera-computer-a');
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'five', operationId: 'start-7' }), { ok: true }, 'none needed (null) leaves nothing behind either');
  assert.equal(w.logs.filter((l) => l === 'hands tree_stop_unconfirmed').length, 1);
  // stopVm releases a stuck computer as well, and says it stopped nothing that was running
  w.drivers.made.at(-1).finish(end('error', 'spawn_failed', false));
  await w.hands.fleet.idle('albera-computer-a');
  assert.equal(w.hands.fleet.stopVm('albera-computer-a'), false);
  assert.deepEqual(await w.hands.start({ computerId: 'computer-a', task: 'six', operationId: 'start-8' }), { ok: true });
  w.hands.stopAll();
  await w.hands.close();
});
