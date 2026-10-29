import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWorkspace, isLabel, validLimit, MAX_WORKSPACE_VMS } from '../src/runtime/workspace.mjs';
import { loadRoomWorkspace, parseRuntimeArgs } from '../src/runtime/entry.mjs';

const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
const r = String.raw;
const vm = (over = {}) => ({ vm: 'albera-clone-01', task: 'Open Notepad.', ...over });
const ws = (over = {}) => JSON.stringify({ version: 1, name: 'demo-room', vms: [vm()], ...over });
const code = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.message; } };

test('workspace: the example file parses, with Japanese labels and checks', () => {
  const text = readFileSync(new URL('../examples/albera.workspace.example.json', import.meta.url), 'utf8');
  const w = parseWorkspace(text, { knownModels: MODELS });
  assert.equal(w.name, 'notepad-and-folders');
  assert.deepEqual(w.jobs.map((job) => job.vmId), ['albera-clone-01', 'albera-clone-02']);
  assert.equal(w.labels['albera-clone-01'], 'メモ帳');
  assert.equal(w.checks['albera-clone-01'][0].path, r`C:\Users\Administrator\Desktop\room1.txt`);
  assert.equal(w.limits.maxUsdTotal, 0.4);
});

test('workspace: a label defaults to the VM name and VMs without checks have none', () => {
  const w = parseWorkspace(ws(), { knownModels: MODELS });
  assert.equal(w.labels['albera-clone-01'], 'albera-clone-01');
  assert.deepEqual(w.checks, {});
  assert.deepEqual(w.limits, {});
});

test('workspace: everything unknown or out of range is refused with a fixed code', () => {
  const cases = [
    ['not json', 'workspace_not_json'],
    [ws({ version: 2 }), 'workspace_version_unsupported'],
    [ws({ name: 'Bad Name' }), 'workspace_name_invalid'],
    [ws({ secret: 'x' }), 'workspace_unknown_field'],
    [ws({ vms: [] }), 'workspace_vms_invalid'],
    [ws({ vms: Array.from({ length: MAX_WORKSPACE_VMS + 1 }, (_, i) => vm({ vm: `vm-${i}` })) }), 'workspace_vms_invalid'],
    [ws({ vms: [vm(), vm()] }), 'workspace_vm_duplicate'],
    [ws({ vms: [vm({ vm: '../x' })] }), 'workspace_vm_invalid'],
    [ws({ vms: [vm({ task: '   ' })] }), 'workspace_task_invalid'],
    [ws({ vms: [vm({ label: 'a\u0007b' })] }), 'workspace_label_invalid'],
    [ws({ vms: [vm({ password: 'x' })] }), 'workspace_unknown_field'],
    [ws({ vms: [vm({ checks: [{ kind: 'run_script', path: r`C:\x` }] })] }), 'workspace_check_invalid'],
    [ws({ vms: [vm({ checks: [] })] }), 'workspace_checks_invalid'],
    [ws({ limits: { model: 'gpt-x' } }), 'workspace_model_unknown'],
    [ws({ limits: { maxSteps: 1.5 } }), 'workspace_limit_invalid'],
    [ws({ limits: { maxUsdPerVm: 5, maxUsdTotal: 1 } }), 'workspace_limit_invalid'],
    [ws({ limits: { apiKey: 'x' } }), 'workspace_unknown_field'],
  ];
  for (const [text, expected] of cases) assert.equal(code(() => parseWorkspace(text, { knownModels: MODELS })), expected, text.slice(0, 80));
});

test('workspace: labels and limits helpers', () => {
  assert.ok(isLabel('予約フォーム'));
  assert.ok(!isLabel(' padded '));
  assert.ok(!isLabel('x'.repeat(33)));
  assert.ok(validLimit('maxSteps', 40));
  assert.ok(!validLimit('maxSteps', 0));
  assert.ok(!validLimit('nope', 1));
});

test('room --workspace: takes no other room options; port and password file only', () => {
  const opts = parseRuntimeArgs(['room', '--workspace', 'w.json', '--guest-password-file', 'pw.txt', '--port', '8820']);
  assert.deepEqual({ ...opts }, { command: 'room', demo: false, help: false, workspaceFile: 'w.json', guestPasswordFile: 'pw.txt', port: 8820 });
  assert.throws(() => parseRuntimeArgs(['room', '--workspace', 'w.json', '--job', 'vm=task']), /runtime_room_workspace_takes_no_other_options/);
  assert.throws(() => parseRuntimeArgs(['room', '--workspace', 'w.json', '--checks', 'c.json']), /runtime_room_workspace_takes_no_other_options/);
});

test('loadRoomWorkspace: limits fill the defaults, checks need a password file, content never in errors', () => {
  const file = (text) => ({ statSync: (p) => ({ isFile: () => p !== 'missing', size: text.length }), readFileSync: () => text });
  const plain = loadRoomWorkspace({ workspaceFile: 'w.json', port: 0 }, file(ws({ limits: { maxUsdTotal: 1 } })));
  assert.equal(plain.maxUsdTotal, 1);
  assert.equal(plain.maxSteps, 40);
  assert.equal(plain.guestPasswordFile, null);
  const withChecks = ws({ vms: [vm({ checks: [{ kind: 'file_exists', path: r`C:\a.txt` }] })] });
  assert.throws(() => loadRoomWorkspace({ workspaceFile: 'w.json' }, file(withChecks)), /runtime_room_workspace_checks_need_password_file/);
  assert.equal(loadRoomWorkspace({ workspaceFile: 'w.json', guestPasswordFile: 'pw.txt' }, file(withChecks)).guestPasswordFile, 'pw.txt');
  const leaky = '{"version":1,"name":"x","vms":[{"vm":"v","task":"t","SECRET_VALUE":1}]}';
  try { loadRoomWorkspace({ workspaceFile: 'w.json' }, file(leaky)); assert.fail('should throw'); }
  catch (error) { assert.equal(error.message, 'runtime_room_workspace_unknown_field'); }
});
