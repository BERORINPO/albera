import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';

// Windows-only: the Node client drives the REAL built .NET Broker over a real Named Pipe (same-user, ephemeral pipe, temp journal).
// Skipped where the .NET 10 SDK/runtime is unavailable. The Broker is started here by the test, never by the client.
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const signerFixture = path.join(repositoryRoot, 'scripts', 'issue-22-approval-authority-fixture.mjs');
const project = path.join(repositoryRoot, 'src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj');
const whoami = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe');
const GENERATION = 7;
const SUCCESS = { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' };
const DENIED = { ok: false, code: 'denied' };

describe('Node client against the real .NET Host Broker Named Pipe', { skip: getUnavailableReason() }, () => {
  let root, dll, sid;
  const running = new Set();

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-broker-client-'));
    const output = path.join(root, 'out'), intermediate = path.join(root, 'obj');
    const properties = [`--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`];
    execFileSync('dotnet', ['restore', project, '--locked-mode', '--property:RestorePackagesWithLockFile=true', ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
    execFileSync('dotnet', ['build', project, '--configuration', 'Release', '--no-restore', '--output', output, ...properties], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
    dll = path.join(output, 'albera-windows-broker.dll');
    sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/u)?.[0];
    assert.ok(sid);
  });

  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Start one Broker (it serves exactly one connection), run `use(pipeName, child)`, then wait for it to exit. */
  async function withBroker(db, signed, use, { generation = GENERATION, hold = false } = {}) {
    const pipeName = `ALBERA_ClientTest_${randomBytes(8).toString('hex')}`;
    const child = startBroker(dll, pipeName, db, signed.publicKey, sid, generation, hold);
    running.add(child);
    try {
      await waitForLine(child, 'BROKER_READY');
      const value = await use(pipeName, child);
      if (!hold) await waitForExit(child);
      return { value, lines: [...child.lines] };
    } finally {
      if (hold || child.exitCode === null) { child.kill(); await waitForExit(child); }
      running.delete(child);
    }
  }
  const send = (pipeName, signed, extra = {}) => sendBrokerRequest({ pipeName, receipt: signed.receipt, signature: signed.signature, timeoutMs: 10_000, ...extra });
  const freshDb = () => path.join(root, `journal-${randomBytes(6).toString('hex')}.sqlite`);
  const claims = (db) => Number(execFileSync('dotnet', [dll, 'inspect', db], { encoding: 'utf8', windowsHide: true }).trim());

  it('authorized request succeeds exactly once; a replay of the same request and a second receipt for the same operation are denied', async () => {
    const db = freshDb();
    const signed = signReceipt(makeReceipt('client-op', 'client-approval', 'client-receipt'));
    const first = await withBroker(db, signed, (pipe) => send(pipe, signed));
    assert.deepEqual(first.value, SUCCESS);
    assert.ok(first.lines.includes('PEER=authenticated') && first.lines.includes('CLAIM=PERSISTED_UNKNOWN'), first.lines.join('|'));
    assert.equal(claims(db), 1);

    const replay = await withBroker(db, signed, (pipe) => send(pipe, signed));
    assert.deepEqual(replay.value, DENIED);
    assert.ok(replay.lines.includes('DENY=duplicate'), replay.lines.join('|'));

    const sameOperation = signReceipt(makeReceipt('client-op', 'other-approval', 'other-receipt'));
    const duplicate = await withBroker(db, sameOperation, (pipe) => send(pipe, sameOperation));
    assert.deepEqual(duplicate.value, DENIED);
    assert.ok(duplicate.lines.includes('DENY=duplicate'), duplicate.lines.join('|'));
    assert.equal(claims(db), 1, 'no second claim row');
  });

  it('stale generation and a tampered digest are denied and leave no claim', async () => {
    const db = freshDb();
    const stale = signReceipt(makeReceipt('stale-op', 'stale-approval', 'stale-receipt', { leaseGeneration: GENERATION - 1 }));
    const staleRun = await withBroker(db, stale, (pipe) => send(pipe, stale));
    assert.deepEqual(staleRun.value, DENIED);
    assert.ok(staleRun.lines.includes('DENY=receipt-policy'), staleRun.lines.join('|'));

    const wrongDigest = signReceipt(makeReceipt('digest-op', 'digest-approval', 'digest-receipt', { actionDigest: digest('shell.exec') }));
    const digestRun = await withBroker(db, wrongDigest, (pipe) => send(pipe, wrongDigest));
    assert.deepEqual(digestRun.value, DENIED);
    assert.ok(digestRun.lines.includes('DENY=receipt-policy'), digestRun.lines.join('|'));

    const signedOk = signReceipt(makeReceipt('edited-op', 'edited-approval', 'edited-receipt'));
    const edited = { ...signedOk, receipt: Buffer.from(Buffer.from(signedOk.receipt, 'base64').toString('utf8').replace(digest('synthetic.noop'), digest('shell.exec'))).toString('base64') };
    const editedRun = await withBroker(db, edited, (pipe) => send(pipe, edited));
    assert.deepEqual(editedRun.value, DENIED);
    assert.ok(editedRun.lines.includes('DENY=signature'), editedRun.lines.join('|'));
    assert.equal(claims(db), 0);
  });

  it('an oversized message is refused by the client before the pipe is used, and the Broker is still free for a valid request', async () => {
    const db = freshDb();
    const signed = signReceipt(makeReceipt('size-op', 'size-approval', 'size-receipt'));
    const { value, lines } = await withBroker(db, signed, async (pipe, child) => {
      const oversized = await sendBrokerRequest({ pipeName: pipe, receipt: 'A'.repeat(4096), signature: signed.signature });
      assert.deepEqual(oversized, { ok: false, code: 'request_too_large' });
      assert.equal(child.lines.some((line) => line.startsWith('PEER=')), false, 'the Broker never saw a connection');
      return send(pipe, signed);
    });
    assert.deepEqual(value, SUCCESS);
    assert.equal(lines.filter((line) => line === 'CLAIM=PERSISTED_UNKNOWN').length, 1);
    assert.equal(claims(db), 1);
  });

  it('a missing pipe and a Broker that holds its answer map to fixed codes; the held claim stays durable', async () => {
    const signed = signReceipt(makeReceipt('hold-op', 'hold-approval', 'hold-receipt'));
    assert.deepEqual(await send(`ALBERA_ClientTest_missing_${randomBytes(4).toString('hex')}`, signed, { timeoutMs: 2000 }), { ok: false, code: 'broker_unavailable' });
    const db = freshDb();
    const { value, lines } = await withBroker(db, signed, async (pipe, child) => {
      const pending = send(pipe, signed, { timeoutMs: 1500 });
      await waitForLine(child, 'CLAIM=PERSISTED_UNKNOWN');
      return pending;
    }, { hold: true });
    assert.deepEqual(value, { ok: false, code: 'timeout' });
    assert.ok(lines.includes('CLAIM=PERSISTED_UNKNOWN'));
    assert.equal(claims(db), 1);
  });
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
function makeReceipt(operationId, approvalId, receiptId, overrides = {}) {
  const action = overrides.action ?? 'synthetic.noop';
  return Buffer.from(JSON.stringify({ issuer: 'albera-test-approval-authority', audience: 'ALBERA-HostBroker', approvalId, receiptId, operationId, idempotencyKey: `idem-${operationId}`, action, actionDigest: digest(action), leaseId: 'test-lease', leaseGeneration: GENERATION, policyVersion: 'test-policy-v1', expiresAt: Math.floor(Date.now() / 1000) + 120, ...overrides })).toString('base64');
}
function signReceipt(receipt) {
  return { ...JSON.parse(execFileSync(process.execPath, [signerFixture, receipt], { encoding: 'utf8', timeout: 10_000, windowsHide: true })), receipt };
}
function digest(value) { return createHash('sha256').update(value).digest('hex').toUpperCase(); }
