import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { classify, describeLevel, probeHost, runFixed } from '../src/runtime/host-capabilities.mjs';
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
  const room = await runFixed(process.execPath, ['--no-warnings', ENTRY, 'room'], { timeoutMs: 20000 });
  assert.equal(room.code, 2);
});

test('doctor takes no options but --help', () => {
  assert.equal(parseRuntimeArgs(['doctor']).command, 'doctor');
  assert.equal(parseRuntimeArgs(['doctor', '--help']).help, true);
  assert.throws(() => parseRuntimeArgs(['doctor', '--vm', 'x']), /invalid_runtime_option/);
});
