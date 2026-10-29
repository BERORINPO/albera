#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows Job Guardian build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_job_guardian_requires_x64');

const project = path.join(root, 'src', 'runtime', 'windows-job-guardian', 'Albera.WindowsJobGuardian.csproj');
const output = path.join(root, 'src', 'runtime', 'windows-job-guardian', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
const result = spawnSync('dotnet', ['publish', project, '--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output, '-p:EnableWindowsTargeting=true'], {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true,
});
if (result.error || result.status !== 0) {
  process.stderr.write('Windows Job Guardian publish failed\n');
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const guardian = path.join(output, 'albera-windows-job-guardian.exe');
const identity = await captureExecutableIdentity(guardian);
await writeFile(`${guardian}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
const probe = spawnSync('dotnet', ['build', path.join(root, 'test', 'windows-job-probe', 'WindowsJobProbe.csproj'), '--configuration', 'Release', '-p:EnableWindowsTargeting=true'], {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true,
});
if (probe.error || probe.status !== 0) {
  process.stderr.write('Windows Job probe build failed\n');
  if (probe.stdout) process.stderr.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  process.exit(probe.status ?? 1);
}
console.log('Windows Job Guardian published for win-x64 (build output is ignored by Git)');
