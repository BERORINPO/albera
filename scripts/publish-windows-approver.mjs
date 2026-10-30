#!/usr/bin/env node
// Builds the approver app (AlberaApprover.exe; ADR-002 "Receipt v2" / Approval Authority, Proposed / NOT VERIFIED) on demand, like the Host Broker and the Authority. It only
// builds: nothing here installs, registers, elevates or starts it, enrols Windows Hello or creates a key. Output is git-ignored. The test fakes (the in-memory "Hello" signer
// and the test options) are compiled out: the switch is pinned off as a global MSBuild property, because MSBuild would otherwise read an environment variable of the same name.
// The shipped build signs with Windows Hello (WinRT KeyCredentialManager, via the Windows SDK projection pack Microsoft.Windows.SDK.NET.Ref that the Windows target framework restores from NuGet, pinned in the csproj).
// dotnet runs through scripts/dotnet-build-env.mjs (trusted dotnet.exe, -noAutoResponse, sanitised environment, locked restore with the repo NuGet config).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createBuildContextOrExit, printBuildIdentity, restoreAndBuild, sdkVersion } from './dotnet-build-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows approver build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_approver_requires_x64');

const directory = 'windows-approver';
const executableName = 'AlberaApprover.exe';
const project = path.join(root, 'src', 'runtime', directory, 'Albera.Approver.csproj');
const output = path.join(root, 'src', 'runtime', directory, 'bin', 'Release', 'net10.0-windows10.0.19041.0', 'win-x64', 'publish');
const context = createBuildContextOrExit(root);
restoreAndBuild(context, {
  label: 'Windows approver', project, runtime: 'win-x64',
  args: ['--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output],
  properties: ['-p:EnableWindowsTargeting=true', '-p:SelfContained=true', '-p:RestorePackagesWithLockFile=true', '-p:RestoreLockedMode=true', '-p:AlberaApproverTestFaults=false'],
});
const executable = path.join(output, executableName);
const identity = await captureExecutableIdentity(executable);
await writeFile(`${executable}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
printBuildIdentity({ sdk: sdkVersion(context), root, file: executable, sha256: identity.sha256 });
console.log('Windows approver published for win-x64 (build output is ignored by Git; not installed, not started, no key created, no Windows Hello touched)');
