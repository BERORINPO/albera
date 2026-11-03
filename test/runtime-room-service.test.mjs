import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSubmitRequestText } from '../src/runtime/approval-authority-client.mjs';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { RUNTIME_HELP, parseRuntimeArgs } from '../src/runtime/entry.mjs';
import { authorityPort } from '../src/runtime/room-approval-wiring.mjs';
import { roomBootstrapAcl } from '../src/runtime/room-bootstrap-file.mjs';
import { parseRoomServiceArgs, runRoomService, startRoomService } from '../src/runtime/room-service-wiring.mjs';
import { CP_SID, OWNER_SID, TEST_TOKEN, makeServiceWorld, settle, until } from './helpers/room-service-world.mjs';

// `room-service` end to end with Fakes (src/runtime/room-service-wiring.mjs): the REAL room host, routes, approval flow, hands and Claude Code driver; a Fake claude (a node script), a Fake
// desktop client, a Fake secret store, a Fake bootstrap file. No real claude, no VM, no service, no pipe, no DPAPI, no network beyond this machine's loopback. What these prove is the WIRING (which
// part gets which input, in which order, and what is refused); the integration lab proves the real parts.
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src/runtime');
const TASK = 'open notepad and write hello';

/** Sign in to the room like the page does and ask for a job on computer-a; resolves the job's view. */
async function startJob(room, computerId = 'computer-a', task = TASK) {
  const res = await room.call('POST', 'api/jobs', { computerId, task });
  assert.equal(res.status, 202, res.text);
  return res.json.job;
}
const jobState = async (room, jobId) => (await room.call('GET', 'api/jobs')).json.jobs.find((j) => j.jobId === jobId)?.state;

// ---- arguments ----

test('arguments: exactly --data-root <absolute path>; help is listed; the command is reachable through parseRuntimeArgs', () => {
  assert.deepEqual({ ...parseRoomServiceArgs(['--data-root', 'C:\\ProgramData\\Albera'], 'win32') }, { command: 'room-service', dataRoot: 'C:\\ProgramData\\Albera', help: false });
  const root = process.platform === 'win32' ? String.raw`C:\ProgramData\Albera` : '/var/albera';
  assert.deepEqual({ ...parseRuntimeArgs(['room-service', '--data-root', root]) }, { command: 'room-service', dataRoot: root, help: false });
  for (const [args, code] of [
    [[], 'room_service_needs_data_root'], [['--data-root'], 'runtime_option_requires_value'], [['--data-root', 'relative\\dir'], 'runtime_path_must_be_absolute'],
    [['--data-root', 'C:\\a', '--data-root', 'C:\\b'], 'runtime_option_must_be_unique'], [['--data-root', 'C:\\a', '--port', '80'], 'invalid_runtime_option'], [['--root', 'C:\\a'], 'invalid_runtime_option'],
  ]) assert.throws(() => parseRoomServiceArgs(args, 'win32'), { message: code }, args.join(' '));
  assert.equal(parseRoomServiceArgs(['--help']).help, true);
  assert.match(RUNTIME_HELP, /albera-runtime room-service --data-root <absolute path>/u);
  assert.match(RUNTIME_HELP, /Without the bootstrap file it refuses to start/u);
});

// ---- acceptance 1: a sink is required; nothing about the listener is printed ----

test('a missing or broken bootstrap sink refuses the start before anything is opened', async (t) => {
  const w = await makeServiceWorld(t);
  for (const sink of [null, undefined, {}, { publish() {} }, { clear() {} }]) {
    await assert.rejects(startRoomService({ dataRoot: w.dataRoot }, { ...w.deps, bootstrapSink: sink }), { message: 'room_service_sink_required' }, String(sink));
  }
  const noUi = await makeServiceWorld(t, { servicePatch: { ui: undefined } }); // no `ui` block: no sink can be built from the settings
  await assert.rejects(startRoomService({ dataRoot: noUi.dataRoot }, noUi.deps), { message: 'room_service_config_ui' });
  for (const world of [w, noUi]) {
    assert.deepEqual([world.approval.stores, world.approval.calls, world.bootstrap.writes, world.bootstrap.removes], [0, [], [], []], 'no store, no pipe, no file was touched');
  }
});

test('the service prints no port, no URL and no code: not in its own output, not in the log lines it hands the host', async (t) => {
  const w = await makeServiceWorld(t);
  const printed = [];
  const spy = () => (...args) => { printed.push(args.map(String).join(' ')); };
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const lines = { log: [], error: [] };
  let service = null;
  try {
    console.log = spy(); console.error = spy(); console.warn = spy(); console.info = spy();
    service = await runRoomService({ dataRoot: w.dataRoot }, w.deps, { log: (l) => lines.log.push(l), error: (l) => lines.error.push(l) });
    const room = await w.open();
    const job = await startJob(room);
    await until(async () => (await jobState(room, job.jobId)) === 'started', 'job started');
    await until(() => lines.log.some((l) => l.includes('hands ended')), 'the run to end');
  } finally {
    Object.assign(console, saved);
    await service?.close();
  }
  assert.ok(service, 'it started');
  const everything = JSON.stringify([printed, lines]);
  assert.deepEqual(lines.log, ['ALBERA room-service: started', 'ALBERA room-service: hands ended outcome=claimed_done reason=end_turn']);
  assert.deepEqual([lines.error, printed], [[], []]);
  const { port, code } = JSON.parse(w.bootstrap.writes[0].text);
  assert.ok(port > 0 && code, 'the port and the code did go to the bootstrap file');
  for (const secret of [String(port), code, '127.0.0.1', 'localhost', 'http', '/room/']) assert.ok(!everything.includes(secret), `output must not contain ${secret}`);
});

test('a start that fails prints one fixed code and sets the exit code (2 for settings, 1 for the rest); it never prints a path or a value', async (t) => {
  const w = await makeServiceWorld(t);
  const lines = [];
  const out = { log: (l) => lines.push(l), error: (l) => lines.push(l) };
  const saved = process.exitCode;
  try {
    assert.equal(await runRoomService({ dataRoot: w.dataRoot }, { ...w.deps, bootstrapSink: null }, out), null);
    assert.equal(process.exitCode, 2);
    w.bootstrap.failWrites(1);
    assert.equal(await runRoomService({ dataRoot: w.dataRoot }, w.deps, out), null);
    assert.equal(process.exitCode, 1);
    assert.equal(await runRoomService({ dataRoot: path.join(w.base, 'nowhere') }, w.deps, out), null);
    assert.equal(process.exitCode, 2);
  } finally { process.exitCode = saved; }
  assert.deepEqual(lines, ['ALBERA room-service: room_service_sink_required', 'ALBERA room-service: bootstrap_publish_failed', 'ALBERA room-service: room_service_bootstrap_failed', 'ALBERA room-service: room_service_config_unreadable']);
  assert.ok(w.approval.storeClosed >= 1 && w.approval.desktopClosed >= 1, 'a start that failed late closed what it had opened');
});

// ---- acceptance 6: ui\room.json ----

test('the bootstrap code goes to ui\\room.json with the contract ACL, an old file is replaced at start, and the file is gone after close', async (t) => {
  const w = await makeServiceWorld(t);
  const staleAcl = roomBootstrapAcl({ cpSid: CP_SID, approverSid: OWNER_SID });
  const STALE = 'STALE-CODE-from-the-last-run-0123456789';
  w.bootstrap.files.set(w.paths.uiFile, { text: JSON.stringify({ port: 1, code: STALE, pid: 1, writtenAt: '2026-11-02T00:00:00.000Z' }), acl: staleAcl });
  const service = await w.start();
  const file = w.bootstrap.read(w.paths.uiFile);
  assert.ok(w.bootstrap.removes.includes(w.paths.uiFile), 'the old file was removed first');
  assert.deepEqual(Object.keys(file).sort(), ['code', 'pid', 'port', 'writtenAt']);
  assert.notEqual(file.code, STALE);
  assert.notEqual(file.port, 1);
  assert.equal(file.pid, process.pid);
  assert.deepEqual(w.bootstrap.files.get(w.paths.uiFile).acl, staleAcl, 'protected, the Control Plane SID Modify, the owner Read, nobody else');
  assert.equal(w.bootstrap.files.get(w.paths.uiFile).acl.entries.length, 2);
  const origin = `http://127.0.0.1:${file.port}`;
  const post = (code) => fetch(`${origin}/room/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ bootstrapCode: code }) });
  assert.equal((await post(STALE)).status, 403, 'the old code opens nothing');
  assert.equal((await post(file.code)).status, 200);
  assert.notEqual(w.bootstrap.read(w.paths.uiFile).code, file.code, 'the code is replaced after its one use');
  await service.close();
  assert.equal(w.bootstrap.read(w.paths.uiFile), null, 'the file is deleted when the service stops');
});

test('a file that cannot be removed is still replaced by the new port and code (listen() writes it); a write that fails ends the start', async (t) => {
  const w = await makeServiceWorld(t);
  w.bootstrap.files.set(w.paths.uiFile, { text: JSON.stringify({ port: 1, code: 'OLD', pid: 1 }), acl: roomBootstrapAcl({ cpSid: CP_SID, approverSid: OWNER_SID }) });
  const stuck = { ...w.bootstrap, remove: async () => { throw new Error('locked'); }, write: w.bootstrap.write, files: w.bootstrap.files };
  const service = await startRoomService({ dataRoot: w.dataRoot }, { ...w.deps, createBootstrapStore: () => stuck });
  w.track(service);
  assert.notEqual(w.bootstrap.read(w.paths.uiFile).port, 1);
  const failing = await makeServiceWorld(t);
  failing.bootstrap.failWrites(1);
  await assert.rejects(failing.start(), { message: 'room_service_bootstrap_failed' });
  assert.equal(failing.bootstrap.read(failing.paths.uiFile), null);
});

// ---- zaku SEC-002: a start that fails leaves no old room.json behind ----

test('a start that fails at any step leaves no ui\\room.json of an earlier run: the file goes before the approval wiring is opened, and again when no host was made', async (t) => {
  const stale = () => ({ text: JSON.stringify({ port: 1, code: 'STALE-CODE-from-the-last-run-0123456789', pid: 1 }), acl: roomBootstrapAcl({ cpSid: CP_SID, approverSid: OWNER_SID }) });
  // (a) the approval wiring cannot open (the flow's journal is unavailable): the file is already gone, and it went before the store was asked for
  const a = await makeServiceWorld(t);
  a.bootstrap.files.set(a.paths.uiFile, stale());
  let removedBeforeStore = null;
  a.approval.deps.openStore = async () => { removedBeforeStore = a.bootstrap.read(a.paths.uiFile) === null; throw new Error('EPERM'); };
  await assert.rejects(startRoomService({ dataRoot: a.dataRoot }, a.deps), { message: 'runtime_room_approval_journal_unavailable' });
  assert.equal(removedBeforeStore, true, 'removed before openRoomApproval ran');
  assert.equal(a.bootstrap.read(a.paths.uiFile), null);
  // (b) a failure after the approval wiring but before a host exists, and the first removal failed: the catch removes it again
  const b = await makeServiceWorld(t);
  b.bootstrap.files.set(b.paths.uiFile, stale());
  let removals = 0;
  const flaky = { ...b.bootstrap, files: b.bootstrap.files, write: b.bootstrap.write, remove: async (file) => { removals += 1; if (removals === 1) throw new Error('locked'); return b.bootstrap.remove(file); } };
  await assert.rejects(startRoomService({ dataRoot: b.dataRoot }, { ...b.deps, secretStore: {}, createBootstrapStore: () => flaky }), { message: 'invalid_room_service_hands_dependencies' });
  assert.equal(removals, 2, 'once at the start (it failed), once in the catch');
  assert.equal(b.bootstrap.read(b.paths.uiFile), null);
  assert.ok(b.approval.storeClosed >= 1 && b.approval.desktopClosed >= 1, 'what had been opened is closed');
  // (c) a failure of the settings themselves, before any sink exists, touches no file
  const c = await makeServiceWorld(t, { servicePatch: { extra: 1 } });
  c.bootstrap.files.set(c.paths.uiFile, stale());
  await assert.rejects(startRoomService({ dataRoot: c.dataRoot }, c.deps), { message: 'room_service_config_unknown_key' });
  assert.deepEqual(c.bootstrap.removes, [], 'nothing was decided about a file the settings could not even be read for');
});

// ---- zaku SEC-001 at the wiring level ----

test('an executable the guard does not trust: the job is approved, the start fails with a fixed code, the credential is never opened and nothing runs; the guard is asked for the pinned executable on every run', async (t) => {
  const w = await makeServiceWorld(t);
  await w.start();
  const room = await w.open();
  w.claudeGuard.trusted = false;
  const first = await startJob(room);
  await until(async () => (await jobState(room, first.jobId)) === 'start_failed', 'start_failed');
  assert.deepEqual([w.driverSeen.length, existsSync(w.recordTo), existsSync(w.paths.runRoot)], [0, false, false]);
  assert.ok(w.logs.includes('hands ended outcome=error reason=claude_untrusted'));
  w.claudeGuard.trusted = true;
  const second = await startJob(room);
  await until(async () => (await jobState(room, second.jobId)) === 'started', 'started once it is trusted');
  await until(() => w.logs.filter((l) => l.startsWith('hands ended')).length === 2, 'the run to end');
  assert.deepEqual(w.claudeGuard.checked, [process.execPath, process.execPath], 'asked for each run, for the executable the settings pin');
});

test('the default guard is the real one for the settings\' install folder: a claude.exe outside C:\\Program Files\\Albera\\bin\\claude is refused when the settings are read', async (t) => {
  const w = await makeServiceWorld(t);
  const { claudeInstallDir, claudeGuard, ...rest } = w.deps; // the real defaults: the fixed install folder, the real ACL check
  await assert.rejects(startRoomService({ dataRoot: w.dataRoot }, rest), { message: 'room_service_config_claude' });
  assert.ok(claudeInstallDir && claudeGuard);
});

// ---- acceptance 7: loopback only ----

test('the room answers on 127.0.0.1 only: this machine\'s other addresses and ::1 refuse the connection', async (t) => {
  const w = await makeServiceWorld(t);
  await w.start();
  const room = await w.open();
  assert.equal(room.unlocked, 200);
  const { port } = room.file;
  const refused = (host) => new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 700 });
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
    socket.once('error', (error) => resolve(error.code));
  });
  assert.equal(await refused('127.0.0.1'), 'connected');
  assert.notEqual(await refused('::1'), 'connected');
  const external = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  for (const address of external) assert.notEqual(await refused(address), 'connected', `not reachable on ${address}`);
  t.diagnostic(`non-loopback IPv4 addresses checked: ${external.length}`);
});

test('source guard: the new modules open no listener of their own and never name a wildcard address', () => {
  for (const file of ['room-service-wiring.mjs', 'room-service-hands.mjs', 'room-service-approvals.mjs', 'room-service-config.mjs', 'room-service-folder-guard.mjs']) {
    const code = readFileSync(path.join(SRC, file), 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line)).join('\n');
    // the environment is never a source of a credential or a trust decision: the only variable read is the OS directory, to find powershell.exe
    const env = [...code.matchAll(/process\.env(?:\.\w+|\[[^\]]*\])?/gu)].map((m) => m[0]);
    assert.deepEqual([...new Set(env)], file === 'room-service-folder-guard.mjs' ? ['process.env.SystemRoot', 'process.env.SYSTEMROOT'] : [], `${file}: environment reads`);
    assert.doesNotMatch(code, /ANTHROPIC|CLAUDE_CODE_OAUTH_TOKEN|ProgramFiles/u, `${file}: no credential variable, no Program Files variable`);
    assert.doesNotMatch(code, /createServer|node:http|node:net|0\.0\.0\.0|'::'|"::"/u, file);
    assert.deepEqual([...code.matchAll(/console\.|process\.std(?:out|err)/gu)], [], `${file}: prints only through the \`out\` it is given`);
    assert.deepEqual([...code.matchAll(/\.listen\(/gu)].length, file === 'room-service-wiring.mjs' ? 1 : 0, `${file}: the one listen() is the room host's, on port 0`);
  }
  assert.match(readFileSync(path.join(SRC, 'room-service-wiring.mjs'), 'utf8'), /await room\.listen\(0\)/u);
  assert.match(readFileSync(path.join(SRC, 'room-host.mjs'), 'utf8'), /server\.listen\(port, '127\.0\.0\.1'/u);
});

// ---- acceptance 2: the digest check on every submit ----

test('every submit asks for the digest check: includeDigest is on and the request the client builds carries the digest the room itself computes', async (t) => {
  const w = await makeServiceWorld(t);
  await w.start();
  const room = await w.open();
  const job = await startJob(room);
  const test1 = await room.call('POST', 'api/jobs/approval-test', {});
  assert.equal(test1.status, 202, test1.text);
  await until(async () => (await jobState(room, job.jobId)) === 'started' && (await room.call('GET', 'api/jobs')).json.jobs.every((j) => !['submitting', 'awaiting_approval', 'starting'].includes(j.state)), 'both jobs decided');
  assert.equal(w.approval.submissions.length, 2);
  for (const submitted of w.approval.submissions) {
    assert.equal(submitted.includeDigest, true, `${submitted.purpose}: includeDigest`);
    const wire = JSON.parse(buildSubmitRequestText(submitted));
    assert.equal(wire.expectedDigest, computeActionDigest(submitted.purpose, submitted.action), 'the real client sends expectedDigest, and it is the shared contract\'s digest');
  }
  assert.deepEqual(w.approval.submissions.map((s) => [s.purpose, s.action.action]), [['guest.command', 'task.start'], ['broker.operation', 'synthetic.noop']]);
  const shown = (await room.call('GET', 'api/jobs')).json.jobs.find((j) => j.jobId === job.jobId);
  assert.equal(shown.actionDigest, computeActionDigest('guest.command', w.approval.submissions[0].action), 'the room shows the digest it computed from the submitted request');
  assert.match(shown.matchCode, /^\d{4}$/u);
});

// ---- acceptance 3, 4, 5 through the whole path ----

test('a job: approval, then Claude Code runs in a new empty config folder with the token from the secret store only, and the folder is removed', async (t) => {
  const w = await makeServiceWorld(t, { script: { steps: [{ tool: 'screenshot' }, { sayEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }, { result: `DONE: finished ${TEST_TOKEN}` }] } });
  await w.start();
  const room = await w.open();
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'ENV-API-KEY-MUST-NOT-BE-READ';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ENV-OAUTH-TOKEN-MUST-NOT-BE-READ';
  let job;
  try {
    w.approval.approved = false; // a person has not decided yet
    job = await startJob(room);
    assert.equal(job.state, 'awaiting_approval');
    await settle(100);
    assert.equal(w.driverSeen.length, 0, 'nothing runs before the approval');
    w.approval.approved = true;
    await until(async () => (await jobState(room, job.jobId)) === 'started', 'job started');
    await until(() => w.logs.some((l) => l.startsWith('hands ended')), 'the run to end');
  } finally {
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['CLAUDE_CODE_OAUTH_TOKEN', saved.token]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  const record = w.record();
  assert.equal(record.task, TASK, 'the hands got exactly the approved task');
  assert.equal(record.env.CLAUDE_CODE_OAUTH_TOKEN, TEST_TOKEN, 'the token is the secret store\'s, not the environment\'s');
  assert.deepEqual(Object.keys(record.env).filter((k) => /^ANTHROPIC_/iu.test(k)), [], 'no ANTHROPIC_* variable reaches the child');
  assert.ok(!JSON.stringify(record.env).includes('ENV-'), 'nothing of this process\'s environment reaches the child');
  assert.ok(!JSON.stringify(record.argv).includes(TEST_TOKEN), 'not on the command line');
  const [seen] = w.driverSeen;
  assert.deepEqual([seen.configEntries, seen.workEntries], [[], []], 'both folders were empty at the start');
  assert.equal(record.env.CLAUDE_CONFIG_DIR, seen.configDir);
  assert.equal(record.cwd, seen.workDir);
  assert.equal(path.dirname(path.dirname(seen.configDir)), w.paths.runRoot);
  assert.deepEqual(seen.mcpServer.args.slice(1, 5), ['--computer', 'computer-a', '--operation', 'room-start-1'], 'the MCP server is bound to the approved computer and operation');
  assert.equal(existsSync(path.dirname(seen.configDir)), false, 'the run folder is gone once the run is over');
  assert.deepEqual(readdirSync(w.paths.runRoot), []);
});

test('each job gets a different, empty config folder; a credential saved through the room is the one the next job uses; stop all ends a running job and removes its folder', async (t) => {
  const w = await makeServiceWorld(t, { token: null, script: { steps: [{ tool: 'screenshot' }, { hang: true }] } });
  await w.start();
  const room = await w.open();
  // no credential yet: the job is approved, the start fails with a fixed code, nothing was made or run
  const first = await startJob(room);
  await until(async () => (await jobState(room, first.jobId)) === 'start_failed', 'start_failed');
  assert.equal((await room.call('GET', 'api/jobs')).json.jobs[0].code, 'start_error');
  assert.deepEqual([w.driverSeen.length, existsSync(w.recordTo), existsSync(w.paths.runRoot)], [0, false, false]);
  assert.ok(w.logs.includes('hands ended outcome=error reason=credential_missing'));
  // the owner types the credential into the room; the next job reads it from the store
  const saved = await room.call('POST', 'api/settings/credential', { name: 'claude-oauth-token', value: TEST_TOKEN });
  assert.equal(saved.status, 200, saved.text);
  assert.ok(!saved.text.includes(TEST_TOKEN));
  const second = await startJob(room);
  await until(async () => (await jobState(room, second.jobId)) === 'started', 'second job started');
  await until(() => existsSync(w.recordTo), 'the fake claude to be running');
  assert.equal(w.driverSeen.length, 1);
  assert.equal(w.driverSeen[0].oauthToken, TEST_TOKEN);
  const stopped = await room.call('POST', 'api/jobs/stop-all', {});
  assert.deepEqual([stopped.status, stopped.json.stopped], [200, 1]);
  await until(() => w.logs.includes('hands ended outcome=stopped reason=stopped_by_human'), 'the run to stop');
  assert.equal(existsSync(path.dirname(w.driverSeen[0].configDir)), false);
  // zaku SEC-003 with the real driver: on Windows the driver never CONFIRMS a tree stop (taskkill's exit code is not proof), so a run that was killed keeps its computer busy until a person stops it
  const unconfirmed = w.logs.includes('hands tree_stop_unconfirmed');
  assert.equal(unconfirmed, process.platform === 'win32', 'this is what the driver reports on this platform');
  if (unconfirmed) {
    const blocked = await startJob(room);
    await until(async () => (await jobState(room, blocked.jobId)) === 'start_failed', 'start_failed (busy)');
    assert.equal((await room.call('GET', 'api/jobs')).json.jobs.find((j) => j.jobId === blocked.jobId).code, 'busy');
    assert.equal(w.driverSeen.length, 1, 'no second run next to a tree that may still be alive');
    const released = await room.call('POST', 'api/jobs/stop-all', {});
    assert.deepEqual([released.status, released.json.stopped], [200, 0], 'the person\'s stop releases it; nothing was running');
  }
  // a third job: a new folder again
  const third = await startJob(room);
  await until(async () => (await jobState(room, third.jobId)) === 'started', 'third job started');
  await until(() => w.driverSeen.length === 2, 'the second run');
  assert.notEqual(w.driverSeen[1].configDir, w.driverSeen[0].configDir);
  assert.deepEqual([w.driverSeen[1].configEntries, w.driverSeen[1].workEntries], [[], []]);
  await room.call('POST', 'api/jobs/stop-all', {});
  await until(() => w.logs.filter((l) => l.startsWith('hands ended')).length === 3, 'the third run to stop');
  assert.deepEqual(readdirSync(w.paths.runRoot), []);
});

test('start sweeps the run folders an earlier service left behind, and only those', async (t) => {
  const w = await makeServiceWorld(t);
  mkdirSync(path.join(w.paths.runRoot, 'run-00000000deadbeef', 'config'), { recursive: true });
  writeFileSync(path.join(w.paths.runRoot, 'run-00000000deadbeef', 'config', 'left.txt'), 'x');
  mkdirSync(path.join(w.paths.runRoot, 'someone-else'));
  await w.start();
  assert.deepEqual(readdirSync(w.paths.runRoot), ['someone-else']);
});

// ---- the settings files ----

test('settings that are wrong stop the start with a fixed code and open nothing: a stranger key, a missing claude block, no desktop section', async (t) => {
  for (const [label, servicePatch, settingsPatch, code] of [
    ['an unknown top-level key', { extra: 1 }, {}, 'room_service_config_unknown_key'],
    ['no claude block', { claude: undefined }, {}, 'room_service_config_claude'],
    ['a claude executable that is not absolute', { claude: { executable: 'claude.exe', executableSha256: 'a'.repeat(64) } }, {}, 'room_service_config_claude'],
    ['an unknown claude key', { claude: { executable: process.execPath, executableSha256: 'a'.repeat(64), apiKey: 'x' } }, {}, 'room_service_config_claude'],
    ['more minutes than the ceiling', { claude: { executable: process.execPath, executableSha256: 'a'.repeat(64), maxMinutes: 56 } }, {}, 'room_service_config_claude'],
    ['the same SID twice', { ui: { controlPlaneSid: OWNER_SID, approverSid: OWNER_SID } }, {}, 'room_service_config_ui'],
    ['no desktop section in the approval settings', {}, { desktop: undefined }, 'runtime_room_approval_desktop'],
  ]) {
    const w = await makeServiceWorld(t, { servicePatch, settingsPatch });
    await assert.rejects(startRoomService({ dataRoot: w.dataRoot }, w.deps), { message: code }, label);
    assert.deepEqual([w.approval.calls, w.bootstrap.writes], [[], []], label);
  }
});

// ---- the one change to the shared approval wiring ----

test('authorityPort: without options the submit is exactly what it was (approval-check); with includeDigest it adds only that flag, and a listener that throws does not break the flow', async () => {
  const settings = { authority: { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } } };
  const seen = [];
  const clients = { submitApproval: async (options) => { seen.push(options); return { ok: true, approvalId: 'a' }; }, getApprovalStatus: async () => ({ ok: true }) };
  const fields = { purpose: 'broker.operation', operationId: 'op-1' };
  assert.deepEqual(await authorityPort(settings, clients).submit(fields), { ok: true, approvalId: 'a' });
  const heard = [];
  const port = authorityPort(settings, clients, { includeDigest: true, onSubmitted: (f, reply) => { heard.push([f.operationId, reply.approvalId]); throw new Error('listener failed'); } });
  assert.deepEqual(await port.submit(fields), { ok: true, approvalId: 'a' });
  assert.deepEqual(seen.map((o) => 'includeDigest' in o), [false, true]);
  assert.deepEqual(seen[1], { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: settings.authority.expect, ...fields, includeDigest: true });
  assert.deepEqual(heard, [['op-1', 'a']]);
  clients.submitApproval = async () => ({ ok: false, code: 'queue_full' });
  assert.deepEqual(await port.submit(fields), { ok: false, code: 'queue_full' });
  assert.equal(heard.length, 1, 'a refused submit is not announced');
});
