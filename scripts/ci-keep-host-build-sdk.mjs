// CI only: leaves HOST_BUILD_SDK as the one .NET SDK next to the trusted dotnet.exe, so that the host builds pick it.
// The hosted Windows image ships its own SDKs (from 2026-11 a .NET 11 SDK, 11.0.100) in the same folder that actions/setup-dotnet installs into, and without a
// global.json (an ambient file the build refuses, spec/architecture.md 2026-11-02+host-build-sdk) dotnet picks the newest SDK there, so requireHostBuildSdk stopped
// every host build with sdk_mismatch. This removes every other folder under <dotnet>\sdk on the throwaway runner, then checks that `dotnet --version` is HOST_BUILD_SDK.
// The dotnet folder is found exactly as the build finds it (resolveTrustedDotnet: HKLM, no PATH). Never run it on a machine you keep: it deletes installed SDKs.
// Both workflows run it right after setup-dotnet and before the first build (test/dotnet-build-env.test.mjs checks the order).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HOST_BUILD_SDK, resolveTrustedDotnet, sdkMismatch } from './dotnet-build-env.mjs';

/** @returns {string[]} the entries of the sdk folder to remove: every one but `keep`. Throws when `keep` is not there (setup-dotnet did not install it). */
export function sdkFoldersToRemove(entries, keep = HOST_BUILD_SDK) {
  if (!entries.includes(keep)) throw new Error(`missing_host_build_sdk: ${keep} is not installed next to the trusted dotnet (found: ${entries.join(', ') || 'nothing'})`);
  return entries.filter((name) => name !== keep);
}

function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('ci_only: this removes installed .NET SDKs; it runs only on a GitHub Actions runner');
  const { dotnet } = resolveTrustedDotnet();
  const sdkFolder = path.win32.join(path.win32.dirname(dotnet), 'sdk');
  for (const name of sdkFoldersToRemove(fs.readdirSync(sdkFolder))) {
    fs.rmSync(path.win32.join(sdkFolder, name), { recursive: true, force: true });
    console.log(`removed .NET SDK ${name}`);
  }
  const result = spawnSync(dotnet, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`dotnet --version failed: ${result.error?.message ?? result.stderr}`);
  const refusal = sdkMismatch(result.stdout.trim());
  if (refusal) throw new Error(refusal);
  console.log(`dotnet sdk ${HOST_BUILD_SDK} is the only one left`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
