import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CLAUDE_LIMITS, MAX_SERVICE_CONFIG_BYTES, loadServiceConfig, parseServiceConfig, roomServicePaths } from '../src/runtime/room-service-config.mjs';

// What room-service reads from AlberaControlPlane.service.json and where it looks (src/runtime/room-service-config.mjs). Pure parsing: no file is read except through the injected `io`.
const CP_SID = 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555';
const OWNER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
const EXE = path.resolve(path.sep, 'albera-test', 'claude.exe');
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
  });
  for (const bad of ['relative', '', undefined, null, 5, '\\\\server\\share\\x', `${root}${path.sep}..${path.sep}x`]) assert.equal(codeOf(() => roomServicePaths(bad)), 'room_service_config_data_root', String(bad));
});

test('a valid file: claude limits default to the contract\'s 15 minutes and 120 calls, the host block is ignored, the ACL is the two-entry protected one', () => {
  const config = parseServiceConfig(JSON.stringify(valid()));
  assert.deepEqual({ ...config.claude }, { executable: EXE, executableSha256: SHA, model: null, maxMs: 15 * 60_000, maxToolCalls: 120 });
  assert.deepEqual(config.ui.acl, { protectedDacl: true, entries: [{ sid: CP_SID, right: 'Modify' }, { sid: OWNER_SID, right: 'Read' }] });
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.claude));
  const full = parseServiceConfig(JSON.stringify(valid({ claude: { executable: EXE, executableSha256: SHA, model: 'claude-haiku-5-5', maxMinutes: CLAUDE_LIMITS.maxMinutes, maxToolCalls: CLAUDE_LIMITS.maxToolCalls } })));
  assert.deepEqual([full.claude.model, full.claude.maxMs, full.claude.maxToolCalls], ['claude-haiku-5-5', 55 * 60_000, 400]);
  assert.equal(parseServiceConfig(`﻿${JSON.stringify(valid())}`).claude.executable, EXE, 'a BOM is tolerated');
  assert.equal(parseServiceConfig(JSON.stringify({ claude: valid().claude, ui: valid().ui })).claude.executable, EXE, 'the host block may be absent here (the host validates its own)');
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
    const got = codeOf(() => parseServiceConfig(text));
    assert.equal(got, code, label);
    assert.ok(!got.includes(secret));
  }
});

test('loadServiceConfig: a regular small file only; the error names no path', () => {
  const file = path.resolve(path.sep, 'albera-test', 'AlberaControlPlane.service.json');
  const io = (over = {}) => ({ statSync: () => ({ isFile: () => true, size: 100 }), readFileSync: () => JSON.stringify(valid()), ...over });
  assert.equal(loadServiceConfig(file, io()).claude.executable, EXE);
  for (const over of [{ statSync: () => { throw new Error(`ENOENT ${file}`); } }, { statSync: () => ({ isFile: () => false, size: 1 }) }, { statSync: () => ({ isFile: () => true, size: MAX_SERVICE_CONFIG_BYTES + 1 }) },
    { readFileSync: () => { throw new Error(`EACCES ${file}`); } }]) {
    const got = codeOf(() => loadServiceConfig(file, io(over)));
    assert.equal(got, 'room_service_config_unreadable');
  }
});
