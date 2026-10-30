import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const signerFixture = path.join(repositoryRoot, 'scripts', 'issue-22-approval-authority-fixture.mjs');
const project = path.join(repositoryRoot, 'src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj');
const whoami = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe');
const unavailableReason = getUnavailableReason();

test('Node Control Plane uses an independent .NET Broker over a real Named Pipe and durable signed claims', { skip: unavailableReason }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'albera-issue22-broker-'));
  let active;
  try {
    const output = path.join(root, 'out'), intermediate = path.join(root, 'obj');
    execFileSync('dotnet', ['restore', project, '--property:RestorePackagesWithLockFile=true', `--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
    execFileSync('dotnet', ['build', project, '--configuration', 'Release', '--no-restore', '--output', output, `--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
    const dll = path.join(output, 'albera-windows-broker.dll');
    const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/u)?.[0];
    assert.ok(sid);
    const db = path.join(root, 'broker-owned-journal.sqlite');
    const accepted = signReceipt(makeReceipt('accepted-op', 'approval-accepted', 'receipt-accepted'));
    let pipe = pipeName();
    active = startBroker(dll, pipe, db, accepted.publicKey, sid, 7, false);
    await waitForLine(active, 'BROKER_READY');
    assert.deepEqual(await request(pipe, accepted.receipt, accepted.signature), { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' });
    await waitForExit(active); active = null;
    pipe = pipeName();
    active = startBroker(dll, pipe, db, accepted.publicKey, sid, 7, false);
    await waitForLine(active, 'BROKER_READY');
    assert.deepEqual(await request(pipe, accepted.receipt, accepted.signature), { ok: false, code: 'denied' });
    await waitForExit(active); active = null;
    assert.equal(inspectClaimCount(dll, db), 1);

    const crashDb = path.join(root, 'broker-owned-crash-journal.sqlite');
    const crashed = signReceipt(makeReceipt('restart-replay-op', 'approval-restart-1', 'receipt-restart-1'));
    pipe = pipeName();
    active = startBroker(dll, pipe, crashDb, crashed.publicKey, sid, 7, true);
    await waitForLine(active, 'BROKER_READY');
    const pending = request(pipe, crashed.receipt, crashed.signature);
    await waitForLine(active, 'CLAIM=PERSISTED_UNKNOWN');
    active.kill(); // durable claim, intentionally lost response
    await pending.catch(() => {}); await waitForExit(active); active = null;

    const retryPipe = pipeName();
    active = startBroker(dll, retryPipe, crashDb, crashed.publicKey, sid, 7, false);
    await waitForLine(active, 'BROKER_READY');
    assert.deepEqual(await request(retryPipe, crashed.receipt, crashed.signature), { ok: false, code: 'denied' });
    await waitForExit(active); active = null;
    assert.equal(inspectClaimCount(dll, crashDb), 1);

    const altered = Buffer.from(accepted.receipt, 'base64').toString('utf8').replace('synthetic.noop', 'shell.exec');
    await assertDenied(dll, root, sid, accepted.receipt, Buffer.from(altered).toString('base64'), accepted.publicKey, accepted.signature);
    await assertDenied(dll, root, sid, makeReceipt('expired-op', 'expired-approval', 'expired-receipt', { expiresAt: 1 }));
    await assertDenied(dll, root, sid, makeReceipt('stale-op', 'stale-approval', 'stale-receipt', { leaseGeneration: 6 }));
    const secretDb = path.join(root, 'secret-denial.sqlite'), secretPipe = pipeName();
    active = startBroker(dll, secretPipe, secretDb, accepted.publicKey, sid, 7, false);
    const secretBroker = active;
    await waitForLine(active, 'BROKER_READY');
    assert.deepEqual(await request(secretPipe, 'SYNTHETIC_SECRET_MARKER', 'SYNTHETIC_SECRET_MARKER', { error: 'SYNTHETIC_SECRET_MARKER' }), { ok: false, code: 'denied' });
    await waitForExit(active); active = null;
    assert.equal(secretBroker.lines.join('|').includes('SYNTHETIC_SECRET_MARKER'), false);
    assert.equal(inspectClaimCount(dll, secretDb), 0);
    process.stdout.write('BROKER_TRANSPORT=real local Windows Named Pipe; peer SID from OS impersonation token\n');
    process.stdout.write('APPROVAL=separate ephemeral ECDSA signer; tampered, expired, stale-generation receipts denied\n');
    process.stdout.write('ERRORS=fixed denial; synthetic secret marker absent from broker response/logs\n');
    process.stdout.write('ACCEPT=authorized exact fixed-action receipt stored as UNKNOWN; normal duplicate denied\n');
    process.stdout.write('RESTART_REPLAY=force-killed after durable claim; restart denied same signed receipt; crash journal rows=1\n');
    process.stdout.write('PROVIDER=synthetic noop; no provider process, Hyper-V or side effect\n');
    process.stdout.write('LIMITS=same-user ephemeral token proof only; service identity and persistent ACL NOT_VERIFIED\n');
  } finally {
    if (active) { active.kill(); await waitForExit(active); }
    rmSync(root, { recursive: true, force: true });
  }
});

function getUnavailableReason() {
  if (process.platform !== 'win32') return 'Windows-only .NET Broker Named Pipe integration';
  try {
    if (!execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some(x => /^10\./u.test(x))) return '.NET 10 SDK unavailable';
    if (!execFileSync('dotnet', ['--list-runtimes'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some(x => /^Microsoft\.NETCore\.App 10\./u.test(x))) return '.NET 10 runtime unavailable';
  } catch { return 'dotnet unavailable'; }
  return false;
}
function startBroker(dll, pipe, db, key, sid, generation, hold) {
  const child = spawn('dotnet', [dll, 'serve', pipe, db, key, sid, String(generation), hold ? 'hold' : 'normal'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.lines = []; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', x => child.lines.push(...x.split(/\r?\n/u).filter(Boolean)));
  child.stderr.on('data', x => child.lines.push(...x.split(/\r?\n/u).filter(Boolean)));
  return child;
}
function waitForLine(child, line) {
  if (child.lines.includes(line)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${line}: ${child.lines.join('|')}`)), 15_000);
    const check = () => { if (child.lines.includes(line)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check); child.stderr.on('data', check);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`broker exited ${code} while waiting for ${line}: ${child.lines.join('|')}`)); });
  });
}
function waitForExit(child) { return child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)); }
function request(pipe, receipt, signature, extra = {}) {
  const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`), body = Buffer.from(JSON.stringify({ receipt, signature, ...extra }));
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('connect', () => { const size = Buffer.alloc(4); size.writeInt32LE(body.length); socket.write(Buffer.concat([size, body])); });
    socket.on('data', x => chunks.push(x));
    socket.on('end', () => { const data = Buffer.concat(chunks); if (data.length < 4 || data.readInt32LE() !== data.length - 4) return reject(new Error('invalid response frame')); resolve(JSON.parse(data.subarray(4).toString('utf8'))); });
    socket.on('error', reject);
  });
}
function makeReceipt(operationId, approvalId, receiptId, overrides = {}) {
  const action = overrides.action ?? 'synthetic.noop';
  return Buffer.from(JSON.stringify({ issuer: 'albera-test-approval-authority', audience: 'ALBERA-HostBroker', approvalId, receiptId, operationId, idempotencyKey: `idem-${operationId}`, action, actionDigest: digest(action), leaseId: 'test-lease', leaseGeneration: 7, policyVersion: 'test-policy-v1', expiresAt: Math.floor(Date.now() / 1000) + 120, ...overrides })).toString('base64');
}
function signReceipt(receipt) {
  return { ...JSON.parse(execFileSync(process.execPath, [signerFixture, receipt], { encoding: 'utf8', timeout: 10_000, windowsHide: true })), receipt };
}
async function assertDenied(dll, root, sid, receipt, alteredReceipt = receipt, publicKey, signature) {
  const db = path.join(root, `${pipeName()}.sqlite`), pipe = pipeName();
  const signed = signature ? { receipt: alteredReceipt, publicKey, signature } : { ...signReceipt(receipt), receipt };
  const broker = startBroker(dll, pipe, db, signed.publicKey, sid, 7, false);
  try { await waitForLine(broker, 'BROKER_READY'); assert.deepEqual(await request(pipe, signed.receipt, signed.signature), { ok: false, code: 'denied' }); }
  finally { await waitForExit(broker); }
  assert.equal(inspectClaimCount(dll, db), 0);
}
function inspectClaimCount(dll, db) { return Number(execFileSync('dotnet', [dll, 'inspect', db], { encoding: 'utf8', windowsHide: true }).trim()); }
function digest(value) { return createHash('sha256').update(value).digest('hex').toUpperCase(); }
function pipeName() { return `ALBERA_Issue22_${randomBytes(8).toString('hex')}`; }
