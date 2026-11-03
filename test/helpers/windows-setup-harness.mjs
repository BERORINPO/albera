// Plumbing for the setup program tests (Windows-only .NET): build the in-process unit harness (the setup sources compiled as ordinary .NET, without Program.cs) into a temp
// folder and run it. Nothing here installs, registers or elevates anything. The shipped albera-setup.exe is NativeAOT and can only be made in CI.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { repositoryRoot } from './windows-broker-harness.mjs';

export { getUnavailableReason } from './windows-broker-harness.mjs';

export const setupDirectory = path.join(repositoryRoot, 'src', 'runtime', 'windows-setup');
const harnessProject = path.join(repositoryRoot, 'test', 'windows-setup-harness', 'SetupHarness.csproj');

/** Build the harness into `workDirectory`; returns the path of the dll. */
export function buildSetupHarness(workDirectory) {
  const intermediate = `${path.join(workDirectory, 'obj')}${path.sep}`;
  const output = path.join(workDirectory, 'out');
  execFileSync('dotnet', ['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:SetupDir=${setupDirectory}${path.sep}`,
    `--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo'],
  { encoding: 'utf8', stdio: 'pipe', timeout: 240_000, windowsHide: true });
  return path.join(output, 'SetupHarness.dll');
}

/** Run every unit check: { checks: [{ name, ok, detail }] }. */
export function runSetupUnitHarness(dll) {
  return JSON.parse(execFileSync('dotnet', [dll], { encoding: 'utf8', timeout: 240_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}

/** What the C# attestation policy makes of a `gh attestation verify --format json` output file: { ok, facts } or { ok: false, code, message }. */
export function policyOf(dll, ghOutputFile, sha256) {
  return JSON.parse(execFileSync('dotnet', [dll, 'policy', ghOutputFile, sha256], { encoding: 'utf8', timeout: 60_000, windowsHide: true }));
}

/** The argument list setup gives gh for one file (JSON array), straight from the C# source. */
export function ghArgumentsFromSetup(dll, file, bundle, trustedRoot) {
  return JSON.parse(execFileSync('dotnet', [dll, 'print-gh-args', file, bundle, trustedRoot], { encoding: 'utf8', timeout: 60_000, windowsHide: true }));
}
