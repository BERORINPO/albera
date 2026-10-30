#!/usr/bin/env node
// Builds the Approval Authority (ADR-002 "Receipt v2", Proposed / NOT VERIFIED) on demand, like the Host Broker. It only builds: nothing here
// installs, registers, elevates or starts it, creates a signing key or enrols Windows Hello. Output is git-ignored. The test fakes are compiled
// out (the switch is pinned off as a global MSBuild property, because MSBuild would otherwise read an environment variable of the same name).
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows Approval Authority build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_approval_authority_requires_x64');

const directory = 'windows-approval-authority';
const executableName = 'albera-approval-authority.exe';
const project = path.join(root, 'src', 'runtime', directory, 'Albera.ApprovalAuthority.csproj');
const output = path.join(root, 'src', 'runtime', directory, 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
const result = spawnSync('dotnet', ['publish', project, '--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output, '-p:EnableWindowsTargeting=true', '-p:RestorePackagesWithLockFile=true', '-p:RestoreLockedMode=true', '-p:AlberaAuthorityTestFaults=false'], {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true,
});
if (result.error || result.status !== 0) {
  process.stderr.write('Windows Approval Authority publish failed\n');
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const executable = path.join(output, executableName);
const identity = await captureExecutableIdentity(executable);
await writeFile(`${executable}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
console.log('Windows Approval Authority published for win-x64 (build output is ignored by Git; not installed, not started, no key created)');
