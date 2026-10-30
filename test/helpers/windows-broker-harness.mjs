// Shared plumbing for the Windows-only Broker integration tests: build the .NET programs into a temp folder, start them,
// read their output. Nothing here installs, registers or elevates anything; pipe names are random and same-user.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from '../../src/runtime/executable-identity.mjs';

export const repositoryRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const sources = {
  broker: path.join(repositoryRoot, 'src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj'),
  pipeClient: path.join(repositoryRoot, 'src', 'runtime', 'windows-broker-pipe-client', 'Albera.WindowsBrokerPipeClient.csproj'),
  probe: path.join(repositoryRoot, 'test', 'windows-pipe-server-probe', 'WindowsPipeServerProbe.csproj'),
};
const whoami = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe');

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

/** Restore (locked when the project has a lock file) and build one program. Returns its `.exe` apphost path. */
export function buildProgram(kind, outputDirectory, assemblyName, { locked = true } = {}) {
  const project = sources[kind];
  const intermediate = `${outputDirectory}-obj`;
  const properties = [`--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`];
  const restore = locked ? ['--locked-mode', '--property:RestorePackagesWithLockFile=true'] : [];
  execFileSync('dotnet', ['restore', project, ...restore, ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
  execFileSync('dotnet', ['build', project, '--configuration', 'Release', '--no-restore', '--output', outputDirectory, ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true });
  return path.join(outputDirectory, `${assemblyName}.exe`);
}

export const buildBroker = (dir) => buildProgram('broker', dir, 'albera-windows-broker');
export const buildProbe = (dir) => buildProgram('probe', dir, 'albera-windows-pipe-server-probe', { locked: false });

/** Build the pipe client helper and record its SHA-256 next to it, as `npm run build:windows-broker` does. */
export async function buildPipeClient(dir) {
  const helper = buildProgram('pipeClient', dir, 'albera-windows-broker-pipe-client');
  writeFileSync(`${helper}.manifest.json`, `${JSON.stringify({ sha256: (await captureExecutableIdentity(helper)).sha256 })}\n`);
  return helper;
}

/** Start a program and collect its output lines (`child.lines`). */
export function startProcess(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.lines = [];
  child.closeCode = undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.once('close', (code) => { child.closeCode = code; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (x) => child.lines.push(...x.split(/\r?\n/u).filter(Boolean)));
  return child;
}

export function startBroker(brokerExe, pipe, db, publicKey, ownerSid, generation, hold = false) {
  return startProcess(brokerExe, ['serve', pipe, db, publicKey, ownerSid, String(generation), hold ? 'hold' : 'normal']);
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

export const GENERATION = 7;
export const digest = (value) => createHash('sha256').update(value).digest('hex').toUpperCase();
const signerFixture = path.join(repositoryRoot, 'scripts', 'issue-22-approval-authority-fixture.mjs');

/** A base64 receipt the Broker prototype accepts (fixed `synthetic.noop` action, generation 7). */
export function makeReceipt(operationId, approvalId, receiptId, overrides = {}) {
  const action = overrides.action ?? 'synthetic.noop';
  return Buffer.from(JSON.stringify({ issuer: 'albera-test-approval-authority', audience: 'ALBERA-HostBroker', approvalId, receiptId, operationId, idempotencyKey: `idem-${operationId}`, action, actionDigest: digest(action), leaseId: 'test-lease', leaseGeneration: GENERATION, policyVersion: 'test-policy-v1', expiresAt: Math.floor(Date.now() / 1000) + 120, ...overrides })).toString('base64');
}

/** Sign with the ephemeral test authority; returns { receipt, signature, publicKey }. */
export function signReceipt(receipt) {
  return { ...JSON.parse(execFileSync(process.execPath, [signerFixture, receipt], { encoding: 'utf8', timeout: 10_000, windowsHide: true })), receipt };
}
