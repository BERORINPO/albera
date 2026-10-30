import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.join(rootDir, 'src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj');
const whoami = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe');
const skip = unavailableReason();

test('Windows Named Pipe DACL denies a restricted token without an allowed restricting SID', { skip }, async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'albera-issue23-restricted-token-'));
  let broker;
  try {
    const output = path.join(temp, 'out'), intermediate = path.join(temp, 'obj');
    execFileSync('dotnet', ['restore', project, '--property:RestorePackagesWithLockFile=true', `--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
    execFileSync('dotnet', ['build', project, '--configuration', 'Release', '--no-restore', '--output', output, `--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
    const dll = path.join(output, 'albera-windows-broker.dll');
    const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/u)?.[0];
    assert.ok(sid);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pipe = `ALBERA_Issue23_${randomBytes(8).toString('hex')}`;
    broker = spawn('dotnet', [dll, 'serve', pipe, path.join(temp, 'unused.sqlite'), publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), sid, '1', 'normal'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    broker.lines = []; broker.stdout.setEncoding('utf8'); broker.stderr.setEncoding('utf8');
    broker.stdout.on('data', x => broker.lines.push(...x.split(/\r?\n/u).filter(Boolean)));
    broker.stderr.on('data', x => broker.lines.push(...x.split(/\r?\n/u).filter(Boolean)));
    await waitForLine(broker, 'BROKER_READY');

    const result = execFileSync('dotnet', [dll, 'restricted-client', pipe], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.match(result, /RESTRICTED_TOKEN_PIPE_DENIAL=true/u);
    assert.match(result, /TOKEN_USER_CHANGED=false/u);
    assert.match(result, /RESTRICTING_SID_MATCHED_PIPE_DACL=false/u);
    process.stdout.write('OS_DACL=access denied to a restricted token over the real local pipe\n');
    process.stdout.write('SCOPE=restricted-SID access check; this is not a different-account/service SID test\n');
  } finally {
    if (broker) { broker.kill(); await waitForExit(broker); }
    rmSync(temp, { recursive: true, force: true });
  }
});

function unavailableReason() {
  if (process.platform !== 'win32') return 'Windows-only OS token and Named Pipe test';
  try {
    if (!execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some(x => /^10\./u.test(x))) return '.NET 10 SDK unavailable';
    if (!execFileSync('dotnet', ['--list-runtimes'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some(x => /^Microsoft\.NETCore\.App 10\./u.test(x))) return '.NET 10 runtime unavailable';
  } catch { return 'dotnet unavailable'; }
  return false;
}
function waitForLine(child, line) {
  if (child.lines.includes(line)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${line}: ${child.lines.join('|')}`)), 15_000);
    const check = () => { if (child.lines.includes(line)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check); child.stderr.on('data', check);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`broker exit ${code}: ${child.lines.join('|')}`)); });
  });
}
function waitForExit(child) { return child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)); }
