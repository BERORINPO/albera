#!/usr/bin/env node
// Builds the WSL bridge (ADR-012, Proposed / NOT VERIFIED) on demand, like the Host Broker. It only builds: nothing here
// installs, registers, elevates or starts it, creates a key or touches wsl.exe. Output is git-ignored. The test seam is compiled
// out (the switch is pinned off as a global MSBuild property, because MSBuild would otherwise read an environment variable of the same name).
// dotnet runs through scripts/dotnet-build-env.mjs (trusted dotnet.exe, -noAutoResponse, sanitised environment, locked restore with the repo NuGet config).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../src/runtime/executable-identity.mjs';
import { createBuildContextOrExit, printBuildIdentity, requireHostBuildSdk, restoreAndBuild } from './dotnet-build-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.log('WSL bridge build skipped on non-Windows host');
  process.exit(0);
}
if (process.arch !== 'x64') throw new Error('windows_wsl_bridge_requires_x64');

const directory = 'windows-wsl-bridge';
const executableName = 'albera-wsl-bridge.exe';
const project = path.join(root, 'src', 'runtime', directory, 'Albera.WslBridge.csproj');
const output = path.join(root, 'src', 'runtime', directory, 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
const context = createBuildContextOrExit(root);
const sdk = requireHostBuildSdk(context);   // before restore: a wrong SDK fails here, not as a tree hash mismatch at install
restoreAndBuild(context, {
  label: 'WSL bridge', project, runtime: 'win-x64',
  args: ['--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', output],
  properties: ['-p:EnableWindowsTargeting=true', '-p:SelfContained=true', '-p:RestorePackagesWithLockFile=true', '-p:RestoreLockedMode=true', '-p:AlberaWslBridgeTestSeams=false'],
});
const executable = path.join(output, executableName);
const identity = await captureExecutableIdentity(executable);
await writeFile(`${executable}.manifest.json`, `${JSON.stringify({ sha256: identity.sha256 }, null, 2)}\n`, 'utf8');
printBuildIdentity({ sdk, root, file: executable, sha256: identity.sha256 });
console.log('WSL bridge published for win-x64 (build output is ignored by Git; not installed, not started, no wsl.exe call)');
