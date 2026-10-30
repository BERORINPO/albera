#!/usr/bin/env node
// Builds the Host Broker prototype (ADR-002, Proposed / NOT VERIFIED) on demand, like the Job Guardian.
// It only builds: nothing here installs, registers, elevates or starts the Broker. Output is git-ignored.
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows Broker build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_broker_requires_x64');

const project = path.join(root, 'src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj');
const output = path.join(root, 'src', 'runtime', 'windows-broker', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
const result = spawnSync('dotnet', ['publish', project, '--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output, '-p:EnableWindowsTargeting=true', '-p:RestorePackagesWithLockFile=true', '-p:RestoreLockedMode=true', '-p:AlberaBrokerTestFaults=false'], {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true,
});
if (result.error || result.status !== 0) {
  process.stderr.write('Windows Broker publish failed\n');
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const broker = path.join(output, 'albera-windows-broker.exe');
const identity = await captureExecutableIdentity(broker);
await writeFile(`${broker}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
console.log('Windows Broker published for win-x64 (build output is ignored by Git; not installed, not started)');
