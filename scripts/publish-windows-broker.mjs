#!/usr/bin/env node
// Builds the Host Broker prototype (ADR-002, Proposed / NOT VERIFIED) and its trusted pipe client helper on demand, like the Job Guardian.
// It only builds: nothing here installs, registers, elevates or starts either program. Output is git-ignored.
// dotnet runs through scripts/dotnet-build-env.mjs (trusted dotnet.exe, -noAutoResponse, sanitised environment, locked restore with the repo NuGet config).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createBuildContextOrExit, printBuildIdentity, restoreAndBuild, sdkVersion } from './dotnet-build-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('Windows Broker build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_broker_requires_x64');

const targets = [
  { label: 'Broker', directory: 'windows-broker', project: 'Albera.WindowsBroker.csproj', executable: 'albera-windows-broker.exe' },
  { label: 'Broker pipe client', directory: 'windows-broker-pipe-client', project: 'Albera.WindowsBrokerPipeClient.csproj', executable: 'albera-windows-broker-pipe-client.exe' },
];
const context = createBuildContextOrExit(root);
for (const target of targets) {
  const project = path.join(root, 'src', 'runtime', target.directory, target.project);
  const output = path.join(root, 'src', 'runtime', target.directory, 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
  restoreAndBuild(context, {
    label: `Windows ${target.label}`, project, runtime: 'win-x64',
    args: ['--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output],
    properties: ['-p:EnableWindowsTargeting=true', '-p:SelfContained=true', '-p:RestorePackagesWithLockFile=true', '-p:RestoreLockedMode=true', '-p:AlberaBrokerTestFaults=false'],
  });
  const executable = path.join(output, target.executable);
  const identity = await captureExecutableIdentity(executable);
  await writeFile(`${executable}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
  printBuildIdentity({ sdk: sdkVersion(context), root, file: executable, sha256: identity.sha256 });
}
console.log('Windows Broker and its pipe client published for win-x64 (build output is ignored by Git; not installed, not started)');
