#!/usr/bin/env node
// Builds the issue #23 lab tool (service shim + probes, test/windows-service-lab) as a self-contained win-x64 publish, so it can be copied to an
// OFFLINE lab guest, and writes its SHA-256 manifest. It only builds: nothing here installs, registers, elevates or starts anything.
// dotnet runs through scripts/dotnet-build-env.mjs (trusted dotnet.exe, -noAutoResponse, sanitised environment, locked restore with the repo NuGet config).
// Output is git-ignored. Run `npm run build:windows-broker` first for the Broker and the pipe client helper.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createBuildContextOrExit, printBuildIdentity, restoreAndBuild, sdkVersion } from './dotnet-build-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows service lab build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_service_lab_requires_x64');

const project = path.join(root, 'test', 'windows-service-lab', 'AlberaLabServiceShim.csproj');
const output = path.join(root, 'test', 'windows-service-lab', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
const context = createBuildContextOrExit(root);
restoreAndBuild(context, {
  label: 'Windows service lab', project, runtime: 'win-x64',
  args: ['--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output],
  properties: ['-p:EnableWindowsTargeting=true', '-p:SelfContained=true', '-p:RestorePackagesWithLockFile=true', '-p:RestoreLockedMode=true'],
});
const executable = path.join(output, 'albera-lab-service-shim.exe');
const identity = await captureExecutableIdentity(executable);
await writeFile(`${executable}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
printBuildIdentity({ sdk: sdkVersion(context), root, file: executable, sha256: identity.sha256 });
console.log(`Windows service lab tool published for win-x64: ${path.relative(root, output)} (build output is ignored by Git; not installed, not started)`);
