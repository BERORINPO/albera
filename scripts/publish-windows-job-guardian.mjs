#!/usr/bin/env node
// Builds the Windows Job Guardian and the job probe used by its tests. dotnet runs through scripts/dotnet-build-env.mjs (trusted dotnet.exe, -noAutoResponse,
// sanitised environment, locked restore with the repo NuGet config; both projects have a packages.lock.json for that).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createBuildContextOrExit, printBuildIdentity, restoreAndBuild, sdkVersion } from './dotnet-build-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows Job Guardian build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_job_guardian_requires_x64');

const project = path.join(root, 'src', 'runtime', 'windows-job-guardian', 'Albera.WindowsJobGuardian.csproj');
const output = path.join(root, 'src', 'runtime', 'windows-job-guardian', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
const lockProperties = ['-p:EnableWindowsTargeting=true', '-p:RestorePackagesWithLockFile=true', '-p:RestoreLockedMode=true'];
const context = createBuildContextOrExit(root);
restoreAndBuild(context, {
  label: 'Windows Job Guardian', project, runtime: 'win-x64',
  args: ['--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output],
  properties: [...lockProperties, '-p:SelfContained=true'],
});
const guardian = path.join(output, 'albera-windows-job-guardian.exe');
const identity = await captureExecutableIdentity(guardian);
await writeFile(`${guardian}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
printBuildIdentity({ sdk: sdkVersion(context), root, file: guardian, sha256: identity.sha256 });
restoreAndBuild(context, {
  label: 'Windows Job probe', verb: 'build', project: path.join(root, 'test', 'windows-job-probe', 'WindowsJobProbe.csproj'),
  args: ['--configuration', 'Release'],
  properties: lockProperties,
});
console.log('Windows Job Guardian published for win-x64 (build output is ignored by Git)');
