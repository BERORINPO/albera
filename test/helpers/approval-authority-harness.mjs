// Plumbing for the Approval Authority tests (Windows-only .NET): build the service and the unit harness into temp folders, start the test-faults
// build's serve-loop, talk to its pipes with its `request` client, and play the approver's Windows Hello with a Node RSA key. Nothing here
// installs, registers or elevates anything; pipe names are random and same-user. Generic process plumbing comes from windows-broker-harness.mjs.
import { execFile, execFileSync } from 'node:child_process';
import { constants, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { currentUserSid, makeTrustedTempDirectory, repositoryRoot, standInService, startProcess, waitForExit, waitForLine } from './windows-broker-harness.mjs';

export { currentUserSid, getUnavailableReason, icaclsOn, makeTrustedTempDirectory, repositoryRoot, standInService, startProcess, trustSid, waitForExit, waitForLine } from './windows-broker-harness.mjs';

const execFileAsync = promisify(execFile);
export const authorityDirectory = path.join(repositoryRoot, 'src', 'runtime', 'windows-approval-authority');
const authorityProject = path.join(authorityDirectory, 'Albera.ApprovalAuthority.csproj');
const harnessProject = path.join(repositoryRoot, 'test', 'approval-authority-harness', 'ApprovalAuthorityHarness.csproj');
export const SELF_CONTROL_MASK = 0x001f019f; // PipeAccessRights.FullControl
export const CLIENT_MASK = 0x00120083;
export const VIRTUAL_ACCOUNT_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555'; // shaped like a service SID, never resolvable here

/** The machine's built-in Guest account: a real USER SID that is not the signed-in user (a test has no second account). */
export const guestSid = () => { const self = currentUserSid(); return `${self.slice(0, self.lastIndexOf('-'))}-501`; };

/** Restore (locked) and build the service. `faults` adds the test-only fakes and subcommands. Returns the `.exe` path. */
export function buildAuthority(outputDirectory, { faults }) {
  const intermediate = `${outputDirectory}-obj${path.sep}`;
  const properties = [`--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`, `--property:AlberaAuthorityTestFaults=${faults}`];
  execFileSync('dotnet', ['restore', authorityProject, '--locked-mode', '--property:RestorePackagesWithLockFile=true', ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
  execFileSync('dotnet', ['build', authorityProject, '--configuration', 'Release', '--no-restore', '--output', outputDirectory, ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true });
  return path.join(outputDirectory, 'albera-approval-authority.exe');
}

/** Build the in-process unit harness and run it: { checks: [{ name, ok, detail }], digestProbes: [...] }. */
export function runUnitHarness(workDirectory) {
  const intermediate = `${path.join(workDirectory, 'obj')}${path.sep}`;
  const output = path.join(workDirectory, 'out');
  execFileSync('dotnet', ['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:AuthorityDir=${authorityDirectory}${path.sep}`,
    `--property:ContractDir=${path.join(repositoryRoot, 'src', 'runtime', 'broker-contract')}${path.sep}`, `--property:BaseIntermediateOutputPath=${intermediate}`,
    `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo'], { encoding: 'utf8', stdio: 'pipe', timeout: 240_000, windowsHide: true });
  return JSON.parse(execFileSync('dotnet', [path.join(output, 'ApprovalAuthorityHarness.dll')], { encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}

/** The approver's stand-in for Windows Hello: an RSA-2048 key pair. `spki` goes into the Authority config. */
export function makeHelloKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

/** The bytes the Hello key signs for one pending request (docs/architecture/approval-authority.md). */
export const presenceMessage = (entry) => Buffer.from(`albera.presence.v1\0${entry.approvalId}\0${entry.actionDigest}\0${entry.challenge}`, 'utf8');

/** RSA PKCS#1 v1.5 / SHA-256, base64: what a Windows Hello KeyCredential signature looks like on the wire. */
export const helloSignature = (privateKey, message) => sign('sha256', message, { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64');

export const publicKeyOf = (spkiBase64) => createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });

/** A valid config. `overrides` replaces keys; the pipe root is random so parallel tests never collide. */
export function makeConfig(overrides = {}) {
  return {
    pipeRoot: `ALBERA\\ApprovalAuthority\\t${randomBytes(6).toString('hex')}`, controlPlaneSid: currentUserSid(), approverSid: currentUserSid(),
    signingKeyName: 'AlberaApprovalAuthority-test', signingKeyProvider: 'software', kid: 'authority-key-test', approverKeyId: 'hello-key-test',
    approverPublicKey: makeHelloKey().spki, audience: 'albera-host-broker', policyVersion: 'policy-test', ...overrides,
  };
}

export function writeConfig(directory, config, name = 'config.json') {
  const file = path.join(directory, name);
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/** One request/reply over a pipe, through the test build's `request` client. Resolves with the parsed reply JSON. */
export async function pipeCall(exe, pipeName, request, { declaredLength, raw } = {}) {
  const body = raw ?? JSON.stringify(request);
  const args = ['request', pipeName, Buffer.from(body, 'utf8').toString('base64'), ...(declaredLength === undefined ? [] : [String(declaredLength)])];
  let stdout;
  try { ({ stdout } = await execFileAsync(exe, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true })); }
  catch (error) { throw new Error(`request client failed: ${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error }); }
  const line = stdout.split(/\r?\n/u).find((x) => x.startsWith('REPLY='));
  if (!line) throw new Error(`no reply: ${stdout}`);
  return JSON.parse(line.slice('REPLY='.length));
}

/**
 * Start `serve-loop` (real pipes, in-memory signer). Resolves with { child, config, configFile, publicKey, submit, approver, stop }.
 * `submit(request)` / `approver(request)` call the two pipes. `stop()` closes stdin (plays SERVICE_CONTROL_STOP) and returns the exit code.
 */
export async function startAuthority(exe, directory, { config = makeConfig(), presence = 'real', ttl = 120 } = {}) {
  const configFile = writeConfig(directory, config, `config-${randomBytes(4).toString('hex')}.json`);
  const child = startProcess(exe, standInService('serve-loop', configFile, presence, String(ttl)), { stdin: true });
  await waitForLine(child, 'AUTHORITY_READY');
  const publicKey = (await waitForLine(child, /^AUTHORITY_PUBLIC_KEY=/u)).slice('AUTHORITY_PUBLIC_KEY='.length);
  const submitPipe = `${config.pipeRoot}\\submit\\v1`;
  const approverPipe = `${config.pipeRoot}\\approver\\v1`;
  return {
    child, config, configFile, publicKey, submitPipe, approverPipe,
    submit: (request, options) => pipeCall(exe, submitPipe, request, options),
    approver: (request, options) => pipeCall(exe, approverPipe, request, options),
    async stop() { if (child.closeCode === undefined) child.stdin.end(); return waitForExit(child); },
  };
}
