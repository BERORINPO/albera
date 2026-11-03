import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWindowsFolderGuard, foldersToGuard } from '../src/runtime/room-service-folder-guard.mjs';

// The check on the folders `claude.exe` is started from (src/runtime/room-service-folder-guard.mjs, zaku SEC-001). The pure part, the process handling with a Fake powershell, and (on Windows) the
// real script against two folders whose ACLs are known without changing anything: C:\Windows\System32 (TrustedInstaller owns it, only administrators write) and a folder the signed-in user made
// (the user owns it and can write: not trusted).
const INSTALL = 'C:\\Program Files\\Albera\\bin\\claude';

test('foldersToGuard: the executable\'s parent up to the install folder, inclusive; nothing for a path that is not inside it', () => {
  assert.deepEqual(foldersToGuard(`${INSTALL}\\claude.exe`, INSTALL), [INSTALL]);
  assert.deepEqual(foldersToGuard(`${INSTALL}\\v2\\bin\\claude.exe`, INSTALL), [`${INSTALL}\\v2\\bin`, `${INSTALL}\\v2`, INSTALL]);
  assert.deepEqual(foldersToGuard(`${INSTALL.toUpperCase()}\\CLAUDE.EXE`, INSTALL), [INSTALL.toUpperCase()], 'case does not matter');
  for (const executable of [INSTALL, `${INSTALL}-evil\\claude.exe`, 'C:\\Program Files\\Albera\\bin\\claude.exe', 'C:\\Users\\x\\claude.exe', 'D:\\Program Files\\Albera\\bin\\claude\\claude.exe', 'claude.exe', '', `${INSTALL}\\..\\x.exe`]) {
    assert.deepEqual(foldersToGuard(executable, INSTALL), [], executable);
  }
  assert.deepEqual(foldersToGuard(`${INSTALL}\\claude.exe`, 'relative'), []);
});

/** A Fake powershell: records how it was started and what it was sent, and ends with the given exit code. */
function fakeSpawn({ code = 0, throws = false, hang = false } = {}) {
  const seen = { calls: [], stdin: '' };
  const spawnImpl = (file, args, options) => {
    seen.calls.push({ file, args, options });
    if (throws) throw new Error('spawn failed');
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => { seen.stdin += chunk; });
    child.kill = () => { seen.killed = true; };
    if (!hang) child.stdin.once('finish', () => setImmediate(() => child.emit('close', code)));
    return child;
  };
  return { seen, spawnImpl };
}

test('the guard: exit 0 is trusted, any other exit, a spawn that fails or a path outside the install folder is not; the path travels on stdin, never on the command line', async () => {
  process.env.SystemRoot ??= 'C:\\Windows';
  const executable = `${INSTALL}\\claude.exe`;
  const ok = fakeSpawn({ code: 0 });
  assert.equal(await createWindowsFolderGuard({ installDir: INSTALL, platform: 'win32', spawnImpl: ok.spawnImpl }).check(executable), true);
  assert.deepEqual(JSON.parse(ok.seen.stdin), { folders: [INSTALL], file: executable });
  const [{ file, args, options }] = ok.seen.calls;
  assert.match(file, /powershell\.exe$/u);
  assert.ok(!JSON.stringify(args).includes('Albera'), 'no path on the command line');
  assert.deepEqual(Object.keys(options.env).sort(), ['PATH', 'PSModulePath', 'SystemRoot', 'windir']);
  for (const [label, spawnOptions, target, platform] of [['exit 1', { code: 1 }, executable, 'win32'], ['spawn throws', { throws: true }, executable, 'win32'],
    ['outside the install folder', { code: 0 }, 'C:\\Users\\x\\claude.exe', 'win32'], ['not Windows', { code: 0 }, executable, 'linux']]) {
    const fake = fakeSpawn(spawnOptions);
    assert.equal(await createWindowsFolderGuard({ installDir: INSTALL, platform, spawnImpl: fake.spawnImpl }).check(target), false, label);
    if (label === 'outside the install folder' || label === 'not Windows') assert.equal(fake.seen.calls.length, 0, `${label}: nothing is started`);
  }
});

test('the guard: a powershell that never answers is a refusal, and it is stopped', { timeout: 60_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = fakeSpawn({ hang: true });
  const pending = createWindowsFolderGuard({ installDir: INSTALL, platform: 'win32', spawnImpl: hung.spawnImpl }).check(`${INSTALL}\\claude.exe`);
  await new Promise((resolve) => { setImmediate(resolve); });
  t.mock.timers.tick(31_000);
  assert.equal(await pending, false);
  assert.equal(hung.seen.killed, true);
});

test('the real script on Windows: C:\\Windows\\System32 (administrator-only) is trusted; a folder the signed-in user made and can write is not; a file that is not there is a refusal', { skip: process.platform !== 'win32' }, async () => {
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const trustedGuard = createWindowsFolderGuard({ installDir: system32 });
  assert.equal(await trustedGuard.check(path.join(system32, 'cmd.exe')), true);
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-guard-')));
  try {
    writeFileSync(path.join(base, 'claude.exe'), 'x');
    assert.equal(await createWindowsFolderGuard({ installDir: base }).check(path.join(base, 'claude.exe')), false, 'a folder the user owns and writes');
    assert.equal(await trustedGuard.check(path.join(system32, 'no-such-file.exe')), false, 'a file that is not there: the check cannot finish');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
