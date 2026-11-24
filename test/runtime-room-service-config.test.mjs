import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CLAUDE_INSTALL_DIR, CLAUDE_LIMITS, MAX_SERVICE_CONFIG_BYTES, loadServiceConfig, parseServiceConfig, roomServicePaths } from '../src/runtime/room-service-config.mjs';

// What room-service reads from AlberaControlPlane.service.json and where it looks (src/runtime/room-service-config.mjs). Pure parsing: no file is read except through the injected `io`.
const CP_SID = 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555';
const OWNER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
const INSTALL = path.resolve(path.sep, 'albera-test'); // stands in for the install folder (CLAUDE_INSTALL_DIR); the real default is checked in its own test
const EXE = path.join(INSTALL, 'claude.exe');
const parse = (text) => parseServiceConfig(text, { installDir: INSTALL });
const SHA = 'a'.repeat(64);
const valid = (patch = {}) => ({
  host: { nodePath: 'ignored by the room', nodeSha256: 'ignored' },
  claude: { executable: EXE, executableSha256: SHA },
  ui: { controlPlaneSid: CP_SID, approverSid: OWNER_SID },
  ...patch,
});
const codeOf = (fn) => { try { fn(); } catch (error) { return error.message; } return 'no error'; };

test('paths: everything comes from the data root alone', () => {
  const root = path.resolve(path.sep, 'albera-test', 'ProgramData', 'Albera');
  const p = roomServicePaths(root);
  assert.deepEqual({ ...p }, {
    dataRoot: root,
    serviceConfig: path.join(root, 'control-plane-config', 'AlberaControlPlane.service.json'),
    approvalFile: path.join(root, 'control-plane-config', 'albera.approval.json'),
    secretsDir: path.join(root, 'secrets'),
    uiFile: path.join(root, 'ui', 'room.json'),
    runRoot: path.join(root, 'control-plane', 'claude-run'),
    wsl2QuarantineRoot: path.join(root, 'control-plane', 'wsl2-quarantine'),
    wsl2ResultsRoot: path.join(root, 'control-plane', 'wsl2-results'),
  });
  for (const bad of ['relative', '', undefined, null, 5, '\\\\server\\share\\x', `${root}${path.sep}..${path.sep}x`]) assert.equal(codeOf(() => roomServicePaths(bad)), 'room_service_config_data_root', String(bad));
});

test('a valid file: claude limits default to the contract\'s 15 minutes and 120 calls, the host block is ignored, the ACL is the two-entry protected one', () => {
  const config = parse(JSON.stringify(valid()));
  assert.deepEqual({ ...config.claude }, { executable: EXE, executableSha256: SHA, model: null, maxMs: 15 * 60_000, maxToolCalls: 120 });
  assert.deepEqual(config.ui.acl, { protectedDacl: true, entries: [{ sid: CP_SID, right: 'Modify' }, { sid: OWNER_SID, right: 'Read' }] });
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.claude));
  const full = parse(JSON.stringify(valid({ claude: { executable: EXE, executableSha256: SHA, model: 'claude-haiku-5-5', maxMinutes: CLAUDE_LIMITS.maxMinutes, maxToolCalls: CLAUDE_LIMITS.maxToolCalls } })));
  assert.deepEqual([full.claude.model, full.claude.maxMs, full.claude.maxToolCalls], ['claude-haiku-5-5', 55 * 60_000, 400]);
  assert.equal(parse(`﻿${JSON.stringify(valid())}`).claude.executable, EXE, 'a BOM is tolerated');
  assert.equal(parse(JSON.stringify({ claude: valid().claude, ui: valid().ui })).claude.executable, EXE, 'the host block may be absent here (the host validates its own)');
});

test('every wrong field is refused with its own fixed code; the error never carries the content', () => {
  const secret = 'TOPSECRET-do-not-print';
  const claude = (patch) => valid({ claude: { executable: EXE, executableSha256: SHA, ...patch } });
  const ui = (patch) => valid({ ui: { controlPlaneSid: CP_SID, approverSid: OWNER_SID, ...patch } });
  const table = [
    ['not json', '{ nope', 'room_service_config_not_json'],
    ['an array', '[]', 'room_service_config_invalid'],
    ['too big', ' '.repeat(MAX_SERVICE_CONFIG_BYTES + 1), 'room_service_config_too_big'],
    ['an unknown top-level key', JSON.stringify(valid({ apiKey: secret })), 'room_service_config_unknown_key'],
    ['no claude block', JSON.stringify({ ui: valid().ui }), 'room_service_config_claude'],
    ['a relative executable', JSON.stringify(claude({ executable: 'claude.exe' })), 'room_service_config_claude'],
    ['an executable that is not normalized', JSON.stringify(claude({ executable: `${EXE}${path.sep}..${path.sep}x.exe` })), 'room_service_config_claude'],
    ['a hash in capitals', JSON.stringify(claude({ executableSha256: 'A'.repeat(64) })), 'room_service_config_claude'],
    ['a hash of 63 characters', JSON.stringify(claude({ executableSha256: 'a'.repeat(63) })), 'room_service_config_claude'],
    ['an unknown claude key (no way to give an API key or an environment here)', JSON.stringify(claude({ env: { ANTHROPIC_API_KEY: secret } })), 'room_service_config_claude'],
    ['a model with a space', JSON.stringify(claude({ model: 'a b' })), 'room_service_config_claude'],
    ['zero minutes', JSON.stringify(claude({ maxMinutes: 0 })), 'room_service_config_claude'],
    ['56 minutes (above the Broker\'s 60 minute lease, minus slack)', JSON.stringify(claude({ maxMinutes: 56 })), 'room_service_config_claude'],
    ['a fraction of a minute', JSON.stringify(claude({ maxMinutes: 1.5 })), 'room_service_config_claude'],
    ['401 calls', JSON.stringify(claude({ maxToolCalls: 401 })), 'room_service_config_claude'],
    ['no ui block', JSON.stringify({ claude: valid().claude }), 'room_service_config_ui'],
    ['a ui key that is not a SID', JSON.stringify(ui({ approverSid: 'Yosuke' })), 'room_service_config_ui'],
    ['the same SID for both', JSON.stringify(ui({ approverSid: CP_SID })), 'room_service_config_ui'],
    ['an unknown ui key', JSON.stringify(ui({ everyone: 'S-1-1-0' })), 'room_service_config_ui'],
    ['a missing ui key', JSON.stringify({ ...valid(), ui: { controlPlaneSid: CP_SID } }), 'room_service_config_ui'],
  ];
  for (const [label, text, code] of table) {
    const got = codeOf(() => parse(text));
    assert.equal(got, code, label);
    assert.ok(!got.includes(secret));
  }
});

test('loadServiceConfig: a regular small file only; the error names no path', () => {
  const file = path.resolve(path.sep, 'albera-test', 'AlberaControlPlane.service.json');
  const io = (over = {}) => ({ statSync: () => ({ isFile: () => true, size: 100 }), readFileSync: () => JSON.stringify(valid()), ...over });
  assert.equal(loadServiceConfig(file, io(), { installDir: INSTALL }).claude.executable, EXE);
  for (const over of [{ statSync: () => { throw new Error(`ENOENT ${file}`); } }, { statSync: () => ({ isFile: () => false, size: 1 }) }, { statSync: () => ({ isFile: () => true, size: MAX_SERVICE_CONFIG_BYTES + 1 }) },
    { readFileSync: () => { throw new Error(`EACCES ${file}`); } }]) {
    const got = codeOf(() => loadServiceConfig(file, io(over), { installDir: INSTALL }));
    assert.equal(got, 'room_service_config_unreadable');
  }
});

// ---- zaku SEC-001: claude.exe lives in the administrator-only install folder ----

test('the install folder is a fixed Program Files path, not an environment variable', () => {
  assert.equal(CLAUDE_INSTALL_DIR, 'C:\\Program Files\\Albera\\bin\\claude');
  const saved = process.env.ProgramFiles;
  process.env.ProgramFiles = 'D:\\Somewhere\\Else'; // a variable must not move the folder
  try {
    const text = (executable) => JSON.stringify(valid({ claude: { executable, executableSha256: SHA } }));
    if (process.platform === 'win32') {
      assert.equal(parseServiceConfig(text('C:\\Program Files\\Albera\\bin\\claude\\claude.exe')).claude.executable, 'C:\\Program Files\\Albera\\bin\\claude\\claude.exe');
      assert.equal(codeOf(() => parseServiceConfig(text('D:\\Somewhere\\Else\\Albera\\bin\\claude\\claude.exe'))), 'room_service_config_claude');
    }
    assert.equal(codeOf(() => parseServiceConfig(text(EXE))), 'room_service_config_claude', 'a path outside the install folder is refused by the default');
  } finally { if (saved === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = saved; }
});

test('an executable outside the install folder is refused: a sibling, a parent, the folder itself, a look-alike name, a dot-dot path, another drive; inside it (any depth, any case) is accepted', () => {
  const text = (executable) => JSON.stringify(valid({ claude: { executable, executableSha256: SHA } }));
  const root = path.parse(INSTALL).root;
  const outside = [
    path.join(root, 'albera-other', 'claude.exe'), path.join(root, 'claude.exe'), INSTALL, `${INSTALL}-evil${path.sep}claude.exe`, `${INSTALL}x${path.sep}claude.exe`,
    `${INSTALL}${path.sep}..${path.sep}claude.exe`, path.join(os_tmp(), 'claude.exe'),
  ];
  for (const executable of outside) assert.equal(codeOf(() => parse(text(executable))), 'room_service_config_claude', executable);
  assert.equal(parse(text(path.join(INSTALL, 'sub', 'claude.exe'))).claude.executable, path.join(INSTALL, 'sub', 'claude.exe'));
  if (process.platform === 'win32') assert.equal(parse(text(EXE.toUpperCase())).claude.executable, EXE.toUpperCase(), 'Windows compares paths without case');
});
function os_tmp() { return process.env.TEMP ?? process.env.TMPDIR ?? path.resolve(path.sep, 'tmp'); }

test('a job always ends inside its lease: the longest run is shorter than the longest lease', async () => {
  const { MAX_RUN_LEASE_TTL_SECONDS } = await import('../src/runtime/broker-contract/wsl2-run-lease.mjs');
  assert.ok(CLAUDE_LIMITS.maxMinutes * 60 + 120 <= MAX_RUN_LEASE_TTL_SECONDS, 'or bundle answers lease_expired and every result is lost');
});
