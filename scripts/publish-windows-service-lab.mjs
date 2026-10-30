#!/usr/bin/env node
// Builds the issue #23 lab tool (service shim + probes, test/windows-service-lab) as a self-contained win-x64 publish, so it can be copied to an
// OFFLINE lab guest, and writes its SHA-256 manifest. It only builds: nothing here installs, registers, elevates or starts anything.
// Output is git-ignored. Run `npm run build:windows-broker` first for the Broker and the pipe client helper.
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows service lab build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_service_lab_requires_x64');

const project = path.join(root, 'test', 'windows-service-lab', 'AlberaLabServiceShim.csproj');
const output = path.join(root, 'test', 'windows-service-lab', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
const result = spawnSync('dotnet', ['publish', project, '--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output, '-p:EnableWindowsTargeting=true'], {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true,
});
if (result.error || result.status !== 0) {
  process.stderr.write('Windows service lab publish failed\n');
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const executable = path.join(output, 'albera-lab-service-shim.exe');
await writeFile(`${executable}.manifest.json`, `${JSON.stringify({ sha256: (await captureExecutableIdentity(executable)).sha256 }, null, 2)}\n`, 'utf8');
console.log(`Windows service lab tool published for win-x64: ${path.relative(root, output)} (build output is ignored by Git; not installed, not started)`);
