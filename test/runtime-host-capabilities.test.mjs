import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { classify, describeChecklist, describeLevel, fileState, probeHost, probeReport, runFixed } from '../src/runtime/host-capabilities.mjs';
import { explainMissingWork, parseRuntimeArgs } from '../src/runtime/entry.mjs';

const ENTRY = new URL('../src/runtime/entry.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const windows = { platform: 'win32', hyperV: 'present', edition: 'Professional', services: 'present' };

test('classify: Hyper-V and the services give Work', () => {
  assert.deepEqual(classify(windows), { level: 'work', work: { available: true, reason: null } });
});

test('classify: each missing piece gives Watch and its reason', () => {
  const reasonOf = (facts) => {
    const result = classify({ ...windows, ...facts });
    assert.equal(result.level, 'watch');
    assert.equal(result.work.available, false);
    return result.work.reason;
  };
  assert.equal(reasonOf({ hyperV: 'missing', edition: 'Core' }), 'home_edition');
  assert.equal(reasonOf({ hyperV: 'missing', edition: 'CoreSingleLanguage' }), 'home_edition');
  assert.equal(reasonOf({ hyperV: 'missing', edition: 'Professional' }), 'role_off');
  assert.equal(reasonOf({ hyperV: 'missing', edition: null }), 'role_off');
  assert.equal(reasonOf({ services: 'missing' }), 'not_installed');
  assert.equal(reasonOf({ platform: 'darwin' }), 'platform');
  assert.equal(reasonOf({ platform: 'linux', hyperV: 'unknown' }), 'platform');
});

test('classify: anything unknown is not available', () => {
  assert.equal(classify({ ...windows, hyperV: 'unknown' }).work.reason, 'unknown');
  assert.equal(classify({ ...windows, services: 'unknown' }).work.reason, 'unknown');
  assert.equal(classify({ ...windows, hyperV: 'surprise' }).work.available, false);
  assert.equal(classify({}).work.available, false);
});

const fakeRun = (answers) => async (file, args) => {
  const key = `${file.split('\\').at(-1)} ${args.at(-1)}`;
  if (!Object.hasOwn(answers, key)) throw new Error(`unexpected ${key}`);
  const answer = answers[key];
  if (answer instanceof Error) throw answer;
  return answer;
};
const EDITION = 'reg.exe EditionID';
const home = { [EDITION]: { code: 0, stdout: '    EditionID    REG_SZ    Core\r\n' } };

test('probeHost: a service that is not there is exit 1060', async () => {
  const run = fakeRun({ ...home, 'sc.exe vmms': { code: 1060, stdout: '' }, 'sc.exe AlberaControlPlane': { code: 1060, stdout: '' } });
  assert.equal((await probeHost({ platform: 'win32', systemRoot: 'C:\\Windows', run })).work.reason, 'home_edition');
});

test('probeHost: Hyper-V without ALBERA is not_installed', async () => {
  const run = fakeRun({ ...home, 'sc.exe vmms': { code: 0, stdout: '' }, 'sc.exe AlberaControlPlane': { code: 1060, stdout: '' } });
  assert.equal((await probeHost({ platform: 'win32', systemRoot: 'C:\\Windows', run })).work.reason, 'not_installed');
});

test('probeHost: a failed or strange answer is unknown, never Work', async () => {
  const failed = fakeRun({ ...home, 'sc.exe vmms': new Error('timeout'), 'sc.exe AlberaControlPlane': { code: 0, stdout: '' } });
  assert.equal((await probeHost({ platform: 'win32', systemRoot: 'C:\\Windows', run: failed })).work.reason, 'unknown');
  const strange = fakeRun({ ...home, 'sc.exe vmms': { code: 5, stdout: '' }, 'sc.exe AlberaControlPlane': { code: 0, stdout: '' } });
  assert.equal((await probeHost({ platform: 'win32', systemRoot: 'C:\\Windows', run: strange })).work.reason, 'unknown');
});

test('probeHost: no SystemRoot means nothing is run, and the result is unknown', async () => {
  const run = async () => { throw new Error('must not run'); };
  assert.equal((await probeHost({ platform: 'win32', systemRoot: '', run })).work.reason, 'unknown');
  assert.equal((await probeHost({ platform: 'win32', systemRoot: 'relative\\path', run })).work.reason, 'unknown');
});

test('probeHost: a broken edition lookup only changes the hint', async () => {
  const run = fakeRun({ [EDITION]: new Error('no'), 'sc.exe vmms': { code: 1060, stdout: '' }, 'sc.exe AlberaControlPlane': { code: 1060, stdout: '' } });
  assert.equal((await probeHost({ platform: 'win32', systemRoot: 'C:\\Windows', run })).work.reason, 'role_off');
});

test('probeHost: macOS and Linux run nothing', async () => {
  const run = async () => { throw new Error('must not run'); };
  assert.equal((await probeHost({ platform: 'linux', run })).work.reason, 'platform');
});

test('probeHost: only fixed files under System32 are asked', async () => {
  const files = [];
  const run = async (file, args) => { files.push([file, ...args]); return { code: 1060, stdout: '' }; };
  await probeHost({ platform: 'win32', systemRoot: 'C:\\Windows', run });
  assert.ok(files.every(([file]) => /^C:\\Windows\\System32\\(sc|reg)\.exe$/.test(file)), JSON.stringify(files));
});

const report = (answers, files, extra = {}) => probeReport({
  platform: 'win32', systemRoot: 'C:\\Windows', userProfile: 'C:\\Users\\me', run: fakeRun({ ...home, ...answers }),
  readFile: async (file) => (files.includes(file) ? 'ok' : 'missing'), ...extra,
});
const stateOf = (checklist, item) => checklist.find((row) => row.item === item)?.state;
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const CLAUDE_EXE = 'C:\\Users\\me\\.local\\bin\\claude.exe';
const none = { code: 1060, stdout: '' };
const there = { code: 0, stdout: '' };

test('probeReport: every item is reported at once, on a PC that lacks several', async () => {
  const { result, checklist } = await report({ 'sc.exe vmms': none, 'sc.exe AlberaControlPlane': none }, [NODE_EXE]);
  assert.equal(result.work.reason, 'home_edition');
  assert.deepEqual(checklist.map((row) => row.item), ['hyperV', 'node', 'claude', 'hello', 'services']);
  assert.equal(stateOf(checklist, 'hyperV'), 'missing');
  assert.equal(stateOf(checklist, 'node'), 'ok');
  assert.equal(stateOf(checklist, 'claude'), 'missing');
  assert.equal(stateOf(checklist, 'services'), 'missing');
});

test('probeReport: before the install Hyper-V counts as ok and the VM is listed', async () => {
  const { checklist } = await report({ 'sc.exe vmms': there, 'sc.exe AlberaControlPlane': none }, [NODE_EXE, CLAUDE_EXE]);
  assert.deepEqual(checklist.map((row) => row.item), ['hyperV', 'node', 'claude', 'hello', 'vm', 'services']);
  assert.equal(stateOf(checklist, 'hyperV'), 'ok');
  assert.equal(stateOf(checklist, 'claude'), 'ok');
  assert.equal(stateOf(checklist, 'vm'), 'manual');
});

test('probeReport: after the install Node.js and Claude Code are not asked for, so nothing contradicts the level', async () => {
  const { result, checklist } = await report({ 'sc.exe vmms': there, 'sc.exe AlberaControlPlane': there }, []);
  assert.equal(result.level, 'work');
  assert.deepEqual(checklist.map((row) => row.item), ['hyperV', 'hello', 'vm', 'services']);
  assert.equal(stateOf(checklist, 'services'), 'ok');
  assert.ok(!checklist.some((row) => row.state === 'missing'));
});

test('probeReport: what cannot be read is manual or unknown, never ok', async () => {
  const failed = await report({ 'sc.exe vmms': new Error('timeout'), 'sc.exe AlberaControlPlane': { code: 5, stdout: '' } }, [], {
    userProfile: 'relative', readFile: async () => 'unknown',
  });
  for (const item of ['hyperV', 'node', 'claude', 'services']) assert.equal(stateOf(failed.checklist, item), 'unknown', item);
  assert.equal(stateOf(failed.checklist, 'hello'), 'manual');
  assert.equal(stateOf(failed.checklist, 'vm'), 'manual');
});

test('probeReport: Node.js is looked for where the installer takes it from', async () => {
  const asked = [];
  await report({ 'sc.exe vmms': none, 'sc.exe AlberaControlPlane': none }, [], { readFile: async (file) => { asked.push(file); return 'missing'; } });
  assert.deepEqual(asked.sort(), [CLAUDE_EXE, NODE_EXE].sort());
});

test('fileState: a file is ok, a folder or nothing is missing, anything else is unknown', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'albera-doctor-'));
  try {
    const file = path.join(folder, 'claude.exe');
    writeFileSync(file, 'x');
    assert.equal(await fileState(file), 'ok');
    assert.equal(await fileState(folder), 'missing');
    assert.equal(await fileState(path.join(folder, 'nothing.exe')), 'missing');
    assert.equal(await fileState('bad\0name'), 'unknown');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('probeReport: a profile that is not known gives unknown, without looking', async () => {
  const { checklist } = await report({ 'sc.exe vmms': none, 'sc.exe AlberaControlPlane': none }, [], { userProfile: '' });
  assert.equal(stateOf(checklist, 'claude'), 'unknown');
});

test('probeReport: macOS and Linux have no list and run nothing', async () => {
  const run = async () => { throw new Error('must not run'); };
  const { result, checklist } = await probeReport({ platform: 'linux', run });
  assert.equal(result.work.reason, 'platform');
  assert.deepEqual(describeChecklist(checklist, 'en'), []);
});

test('describeChecklist gives a line for every item and state, in both languages, and says it is no promise', () => {
  for (const lang of ['en', 'ja']) {
    for (const state of ['ok', 'missing', 'unknown', 'manual']) {
      const items = ['hyperV', 'node', 'claude', 'hello', 'vm', 'services'].map((item) => ({ item, state }));
      const lines = describeChecklist(items, lang);
      assert.equal(lines.length, items.length + 2);
      assert.ok(lines.every((line) => line.length > 0 && !/undefined|[A-Z]:\\/.test(line)), lines.join('|'));
    }
  }
});

test('runFixed reports the exit code and stops a process that hangs', async () => {
  const done = await runFixed(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(7)']);
  assert.deepEqual(done, { code: 7, stdout: 'hi' });
  await assert.rejects(runFixed(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }));
});

test('describeLevel gives a reason for every case, in both languages, without paths', () => {
  for (const lang of ['en', 'ja']) {
    for (const reason of ['home_edition', 'role_off', 'not_installed', 'platform', 'unknown']) {
      const lines = describeLevel({ level: 'watch', work: { available: false, reason } }, lang);
      assert.ok(lines.length >= 3, reason);
      assert.ok(lines.every((line) => typeof line === 'string' && line.length > 0 && !/undefined|[A-Z]:\\/.test(line)), reason);
    }
    assert.ok(describeLevel({ level: 'work', work: { available: true, reason: null } }, lang).length >= 1);
  }
});

test('explainMissingWork prints the reason, and nothing when Work is available', async () => {
  const lines = [];
  await explainMissingWork((line) => lines.push(line), async () => classify({ platform: 'linux' }));
  assert.ok(lines.length >= 3);
  lines.length = 0;
  await explainMissingWork((line) => lines.push(line), async () => classify(windows));
  assert.deepEqual(lines, []);
});

test('the real commands: doctor ends with 0 and prints the level; room without a job keeps exit 2', async () => {
  const doctor = await runFixed(process.execPath, ['--no-warnings', ENTRY, 'doctor'], { timeoutMs: 20000 });
  assert.equal(doctor.code, 0);
  assert.ok(doctor.stdout.length > 0);
  if (process.platform === 'win32') assert.match(doctor.stdout, /^ {2}\[[^\]]+\] Hyper-V$/m);
  const room = await runFixed(process.execPath, ['--no-warnings', ENTRY, 'room'], { timeoutMs: 20000 });
  assert.equal(room.code, 2);
});

test('doctor takes no options but --help', () => {
  assert.equal(parseRuntimeArgs(['doctor']).command, 'doctor');
  assert.equal(parseRuntimeArgs(['doctor', '--help']).help, true);
  assert.throws(() => parseRuntimeArgs(['doctor', '--vm', 'x']), /invalid_runtime_option/);
});
