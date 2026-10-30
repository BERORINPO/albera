// Plumbing for the approver app tests (Windows-only .NET): build AlberaApprover.exe and the in-process unit harness into temp folders, run the app with the
// test-faults options, and make the throw-away RSA key that stands in for Windows Hello. Nothing here installs, registers or elevates anything. The Authority side
// (build, start, config, Hello key, presence message) comes from approval-authority-harness.mjs.
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { repositoryRoot } from './windows-broker-harness.mjs';

export { VIRTUAL_ACCOUNT_SID, buildAuthority, currentUserSid, getUnavailableReason, helloSignature, makeConfig, makeHelloKey, makeTrustedTempDirectory, presenceMessage, startAuthority } from './approval-authority-harness.mjs';

export const approverDirectory = path.join(repositoryRoot, 'src', 'runtime', 'windows-approver');
const approverProject = path.join(approverDirectory, 'Albera.Approver.csproj');
const harnessProject = path.join(repositoryRoot, 'test', 'approver-harness', 'ApproverHarness.csproj');

/** Restore (locked) and build the app. `faults` adds the fake signer and the test options. Returns the `.exe` path. */
export function buildApprover(outputDirectory, { faults }) {
  const intermediate = `${outputDirectory}-obj${path.sep}`;
  const properties = [`--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`, `--property:AlberaApproverTestFaults=${faults}`];
  execFileSync('dotnet', ['restore', approverProject, '--locked-mode', '--property:RestorePackagesWithLockFile=true', ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
  execFileSync('dotnet', ['build', approverProject, '--configuration', 'Release', '--no-restore', '--output', outputDirectory, ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true });
  return path.join(outputDirectory, 'AlberaApprover.exe');
}

/** Build the in-process unit harness and run it: { checks: [{ name, ok, detail }] }. */
export function runApproverUnitHarness(workDirectory) {
  const intermediate = `${path.join(workDirectory, 'obj')}${path.sep}`;
  const output = path.join(workDirectory, 'out');
  execFileSync('dotnet', ['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:ApproverDir=${approverDirectory}${path.sep}`,
    `--property:ContractDir=${path.join(repositoryRoot, 'src', 'runtime', 'broker-contract')}${path.sep}`, `--property:BaseIntermediateOutputPath=${intermediate}`,
    `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo'], { encoding: 'utf8', stdio: 'pipe', timeout: 240_000, windowsHide: true });
  return JSON.parse(execFileSync('dotnet', [path.join(output, 'ApproverHarness.dll')], { encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}

/** The PKCS#8 form of the Node Hello key, for --test-fake-key (the fake signer holds it in memory only). */
export const fakeKeyArgument = (hello) => hello.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

/** The `--test-*` options that point the test-faults app at one test Authority (same-user owner SID, the serve-loop's PID) and give it the fake Hello key. */
export function testOptions(authority, { sid, hello, pipeRoot = authority.config.pipeRoot, ownerSid = sid, pid = authority.child.pid, presence, timeoutMs } = {}) {
  return ['--test-pipe-root', pipeRoot, '--test-owner-sid', ownerSid, '--test-pid', String(pid),
    ...(hello ? ['--test-fake-key', fakeKeyArgument(hello)] : []), ...(presence ? ['--test-presence', presence] : []), ...(timeoutMs ? ['--test-timeout-ms', String(timeoutMs)] : [])];
}

/** Run the app; resolves with { code, stdout, stderr } (never rejects on a non-zero exit). `stdin` is written and closed. */
export function runApprover(exe, args, { stdin = '', timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(exe, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(new Error(`approver did not run: ${error.message}`, { cause: error }));
      else resolve({ code: error ? error.code : 0, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}
