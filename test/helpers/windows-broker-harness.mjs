// Shared plumbing for the Windows-only Broker integration tests: build the .NET programs into a temp folder, start them,
// read their output. Nothing here installs, registers or elevates anything; pipe names are random and same-user.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../../src/runtime/executable-identity.mjs';
import { sendBrokerFence, sendBrokerInspect, sendBrokerRequest } from '../../src/runtime/windows-broker-client.mjs';
import { signedReceipt, SYNTHETIC_LEASE_ID, SYNTHETIC_POLICY_VERSION } from '../../scripts/issue-22-approval-authority-fixture.mjs';

export const repositoryRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const sources = {
  broker: path.join(repositoryRoot, 'src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj'),
  pipeClient: path.join(repositoryRoot, 'src', 'runtime', 'windows-broker-pipe-client', 'Albera.WindowsBrokerPipeClient.csproj'),
  probe: path.join(repositoryRoot, 'test', 'windows-pipe-server-probe', 'WindowsPipeServerProbe.csproj'),
  serviceLab: path.join(repositoryRoot, 'test', 'windows-service-lab', 'AlberaLabServiceShim.csproj'),
};
const whoami = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe');

const icacls = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'icacls.exe');
const LOCAL_SYSTEM_SID = 'S-1-5-18';

/** Run icacls on a folder this process owns (a temp folder it just made): no elevation, never a path outside the caller's own temp tree. */
export function icaclsOn(directory, ...args) {
  execFileSync(icacls, [directory, ...args], { stdio: 'pipe', windowsHide: true });
}

/**
 * A fresh temp folder in its long form (the Broker refuses 8.3 paths) whose DACL is only this user and SYSTEM, inheritance cut. The service
 * host refuses a config or journal folder that anyone else can write, and the machine's own temp folder may grant other accounts Modify, so a
 * test that needs a TRUSTED folder builds it this way. The production rule trusts the service's own per-service SID (S-1-5-80-..., from the service name)
 * and SYSTEM / Administrators, never the token user. A host test has no service SID, so the test-faults builds are told to stand in the signed-in user
 * for it (`standInService`); the folder is trusted because its owner and its writers are that user and SYSTEM.
 */
export function makeTrustedTempDirectory(prefix) {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  icaclsOn(directory, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)F`, `*${LOCAL_SYSTEM_SID}:(OI)(CI)F`);
  return directory;
}

let signedInUserSid;
/**
 * The leading arguments that make a TEST-FAULTS build (Broker or Approval Authority; the shipped build does not have them) trust `sid` as "the service" in its
 * ServicePathGuard, in place of the per-service SID a host test cannot have in its token. Without them the production rule applies.
 */
export const trustSid = (sid, ...args) => ['--trust-sid', sid, ...args];
/** `trustSid` with the signed-in user as the stand-in: what every host test that needs a running or checked service uses. */
export const standInService = (...args) => trustSid(signedInUserSid ??= currentUserSid(), ...args);

/** Why the .NET integration cannot run here, or `false` when it can. */
export function getUnavailableReason() {
  if (process.platform !== 'win32') return 'Windows-only .NET Broker Named Pipe integration';
  try {
    if (!execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some((x) => /^10\./u.test(x))) return '.NET 10 SDK unavailable';
    if (!execFileSync('dotnet', ['--list-runtimes'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some((x) => /^Microsoft\.NETCore\.App 10\./u.test(x))) return '.NET 10 runtime unavailable';
  } catch { return 'dotnet unavailable'; }
  return false;
}

export function currentUserSid() {
  const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/u)?.[0];
  assert.ok(sid);
  return sid;
}

/**
 * Owner SID of a pipe this Node process creates with the default security descriptor: the token's default owner. That is the user SID for a
 * normal token but BUILTIN\Administrators for an elevated one (CI runners), so tests that expect a Node-made pipe's owner must not assume the user SID.
 */
export function nodePipeOwnerSid() {
  const powershell = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const sid = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().Owner.Value'],
    { encoding: 'utf8', windowsHide: true }).trim();
  assert.match(sid, /^S-1-[0-9-]+$/u);
  return sid;
}

/** Restore (locked when the project has a lock file) and build one program. Returns its `.exe` apphost path. */
export function buildProgram(kind, outputDirectory, assemblyName, { locked = true, properties: extraProperties = [] } = {}) {
  const project = sources[kind];
  const intermediate = `${outputDirectory}-obj`;
  const properties = [`--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`];
  const restore = locked ? ['--locked-mode', '--property:RestorePackagesWithLockFile=true'] : [];
  execFileSync('dotnet', ['restore', project, ...restore, ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
  execFileSync('dotnet', ['build', project, '--configuration', 'Release', '--no-restore', '--output', outputDirectory, ...extraProperties, ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true });
  return path.join(outputDirectory, `${assemblyName}.exe`);
}

export const buildBroker = (dir) => buildProgram('broker', dir, 'albera-windows-broker');
/** The Broker with the test-only seams (`serve-fault`, `serve-loop`). Never the shipped build. */
export const buildBrokerWithTestSeams = (dir) => buildProgram('broker', dir, 'albera-windows-broker', { properties: ['--property:AlberaBrokerTestFaults=true'] });
export const buildProbe =(dir) => buildProgram('probe', dir, 'albera-windows-pipe-server-probe', { locked: false });
export const buildServiceLab = (dir) => buildProgram('serviceLab', dir, 'albera-lab-service-shim', { locked: false });

/** Build the pipe client helper and record its SHA-256 next to it, as `npm run build:windows-broker` does. */
export async function buildPipeClient(dir) {
  const helper = buildProgram('pipeClient', dir, 'albera-windows-broker-pipe-client');
  writeFileSync(`${helper}.manifest.json`, `${JSON.stringify({ sha256: (await captureExecutableIdentity(helper)).sha256 })}\n`);
  return helper;
}

/** Start a program and collect its output lines (`child.lines`). `{ stdin: true }` keeps stdin open as a pipe (`child.stdin`). */
export function startProcess(executable, args, { stdin = false, env } = {}) {
  const child = spawn(executable, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
  child.lines = [];
  child.closeCode = undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.once('close', (code) => { child.closeCode = code; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (x) => child.lines.push(...x.split(/\r?\n/u).filter(Boolean)));
  return child;
}

/** `authorityKeys` is the `kid=spki[,kid=spki]` argument of the one-shot `serve` (createTestAuthority().serveArgument); it serves LEASE_ID under POLICY_VERSION. */
export function startBroker(brokerExe, pipe, db, authorityKeys, ownerSid, generation, hold = false) {
  return startProcess(brokerExe, ['serve', pipe, db, authorityKeys, ownerSid, String(generation), hold ? 'hold' : 'normal', ...LEASE_ARGS]);
}

/** Resolves with the first output line matching `pattern` (string or RegExp), or rejects on exit / timeout. */
export function waitForLine(child, pattern) {
  const matches = (line) => (typeof pattern === 'string' ? line === pattern : pattern.test(line));
  const found = () => child.lines.find(matches);
  if (found()) return Promise.resolve(found());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${pattern}: ${child.lines.join('|')}`)), 15_000);
    const check = () => { const line = found(); if (line) { clearTimeout(timer); resolve(line); } };
    child.stdout.on('data', check); child.stderr.on('data', check);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`process exited ${code} while waiting for ${pattern}: ${child.lines.join('|')}`)); });
  });
}

/** Resolves with the exit code once the process has exited and its output streams are drained. */
export function waitForExit(child) {
  if (child.closeCode !== undefined) return Promise.resolve(child.closeCode);
  return new Promise((resolve) => child.once('close', resolve));
}

export function inspectClaimCount(brokerExe, db) {
  return Number(execFileSync(brokerExe, ['inspect', db], { encoding: 'utf8', windowsHide: true }).trim());
}


// ---- receipt v2: the Broker issues the challenge (fence), the test authority signs, the client sends -------------------------------------------------------
export const GENERATION = 7;
export const COMPUTER_ID = 'computer-1';
export const LEASE_ID = SYNTHETIC_LEASE_ID;
export const POLICY_VERSION = SYNTHETIC_POLICY_VERSION;
/** The `leaseId` / `policyVersion` keys of a Broker service config. */
export const LEASE_CONFIG = Object.freeze({ leaseId: LEASE_ID, policyVersion: POLICY_VERSION });
/** The trailing `<leaseId> <policyVersion>` arguments of the one-shot `serve` / `serve-fault`. */
export const LEASE_ARGS = Object.freeze([LEASE_ID, POLICY_VERSION]);
export { PRODUCTION_ISSUER, TEST_ISSUER, buildReceiptFields, createTestAuthority, signedReceipt, stableUuid } from '../../scripts/issue-22-approval-authority-fixture.mjs';

/** Between two clients the Broker's single pipe instance is busy: that is a pre-send `broker_unavailable`, safe to retry. */
export async function whileBusy(call, attempts = 40) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await call();
    if (result.code !== 'broker_unavailable' || attempt >= attempts) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The Control Plane side of one running Broker, through the real pipe client helper. `pipeName`, `pid` and `expect` may be reassigned (a restarted Broker
 * has a new PID). `prepare` is fence + sign without sending; `claim` also sends; `send` / `inspect` / `fence` are the three requests.
 */
export function brokerSession({ helper, sid, pipeName, pid, authority, expect }) {
  const session = {
    pipeName, pid, expect,
    common: () => ({ pipeName: session.pipeName, expect: session.expect ?? { ownerSid: sid, pid: session.pid }, helperPath: helper, timeoutMs: 10_000 }),
    fence: (computerId = COMPUTER_ID) => whileBusy(() => sendBrokerFence({ ...session.common(), computerId })),
    send: (request) => whileBusy(() => sendBrokerRequest({ ...session.common(), receipt: request.receipt, signature: request.signature })),
    inspect: (operationId) => whileBusy(() => sendBrokerInspect({ ...session.common(), operationId })),
    /**
     * fence -> build -> sign. `overrides` (an object, or a function of the fence reply) replace receipt fields; `computerId` is also what is fenced unless
     * `fencedComputerId` says otherwise. Returns { receipt, signature, fence }.
     */
    async prepare(name, overrides = {}, fencedComputerId) {
      const fence = await session.fence(fencedComputerId ?? (typeof overrides === 'function' ? undefined : overrides.computerId));
      assert.equal(fence.ok, true, `fence failed: ${JSON.stringify(fence)}`);
      return { ...signedReceipt({ authority, fence, name, ...(typeof overrides === 'function' ? overrides(fence) : overrides) }), fence };
    },
    async claim(name, overrides, fencedComputerId) {
      const request = await session.prepare(name, overrides, fencedComputerId);
      return { request, result: await session.send(request) };
    },
  };
  return session;
}

/** One framed request over a raw same-user socket (no identity checks): for tests that talk to a Broker directly. Rejects when no reply frame arrives. */
export function rawRequest(pipe, body) {
  const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`);
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('connect', () => { const size = Buffer.alloc(4); size.writeInt32LE(bytes.length); socket.write(Buffer.concat([size, bytes])); });
    // The reply is complete once its length prefix is satisfied. The service loop disconnects the instance after the reply, which Node can report as a
    // read error (EPIPE) rather than a clean end, so the frame, not the end of the stream, decides.
    socket.on('data', (x) => {
      chunks.push(x);
      const data = Buffer.concat(chunks);
      if (data.length < 4 || data.length < 4 + data.readInt32LE()) return;
      socket.destroy();
      if (data.length !== 4 + data.readInt32LE()) reject(new Error('invalid response frame'));
      else resolve(JSON.parse(data.subarray(4).toString('utf8')));
    });
    socket.on('close', () => reject(new Error('connection closed without a response')));
    socket.on('error', reject);
  });
}

/**
 * Fence over a raw socket, sign, claim over a raw socket. `overrides` is an object or a function of the fence reply; `mutate(request, fence)` may change the
 * signed request before it is sent (a tampering test). Returns { fence, request, reply }.
 */
export async function rawFencedClaim(pipe, authority, name, overrides = {}, mutate = (request) => request) {
  const fence = await rawRequest(pipe, { fence: { computerId: (typeof overrides === 'function' ? undefined : overrides.computerId) ?? COMPUTER_ID } });
  assert.equal(fence.ok, true, `fence failed: ${JSON.stringify(fence)}`);
  const request = mutate(signedReceipt({ authority, fence, name, ...(typeof overrides === 'function' ? overrides(fence) : overrides) }), fence);
  return { fence, request, reply: await rawRequest(pipe, request) };
}
