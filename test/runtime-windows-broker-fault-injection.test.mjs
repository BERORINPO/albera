import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

// Failure-injection tests for the Windows Host Broker prototype (ADR-002 Proposed / NOT VERIFIED).
// Exit codes under test (fixed, see Program.cs): 70 = pipe name already taken, 71 = impersonation revert failed.
// Same-user, unprivileged, random pipe names and temp journals only; no service, ACL, admin or Hyper-V.
const EXIT_PIPE_UNAVAILABLE = 70;
const EXIT_IMPERSONATION_REVERT_FAILED = 71;
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const signerFixture = path.join(repositoryRoot, 'scripts', 'issue-22-approval-authority-fixture.mjs');
const project = path.join(repositoryRoot, 'src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj');
const whoami = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe');
const unavailableReason = getUnavailableReason();

describe('Windows Broker failure injection', { skip: unavailableReason }, () => {
  let root, faultDll, productionDll, sid;
  const children = new Set();

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'albera-broker-fault-'));
    faultDll = build(path.join(root, 'fault'), true);
    productionDll = build(path.join(root, 'production'), false);
    sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/u)?.[0];
    assert.ok(sid);
  });
  after(async () => {
    for (const child of children) { child.kill(); await waitForExit(child); }
    rmSync(root, { recursive: true, force: true });
  });

  const launch = (dll, args) => { const child = startProcess(dll, args); children.add(child); return child; };
  const serveFault = (fault, pipe, db, signed, generation = 7) => launch(faultDll, ['serve-fault', fault, pipe, db, signed.publicKey, sid, String(generation), 'normal']);
  const serve = (dll, pipe, db, signed) => launch(dll, ['serve', pipe, db, signed.publicKey, sid, '7', 'normal']);

  test('the shipped build has no fault-injection seam', async () => {
    const signed = signReceipt(makeReceipt('prod-op', 'prod-approval', 'prod-receipt'));
    const probe = launch(productionDll, ['serve-fault', 'RevertFails', pipeName(), path.join(root, 'prod.sqlite'), signed.publicKey, sid, '7', 'normal']);
    assert.equal(await waitForExit(probe), 64);
    assert.deepEqual(probe.lines, []);
    assert.equal(existsSync(path.join(root, 'prod.sqlite')), false);
  });

  test('serve-fault with fault None behaves like serve (the harness itself is sound)', async () => {
    const signed = signReceipt(makeReceipt('control-op', 'control-approval', 'control-receipt'));
    const pipe = pipeName(), db = path.join(root, 'control.sqlite');
    const broker = serveFault('None', pipe, db, signed);
    await waitForLine(broker, 'BROKER_READY');
    assert.deepEqual(await request(pipe, signed.receipt, signed.signature), { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' });
    assert.equal(await waitForExit(broker), 0);
    assert.equal(inspectClaimCount(faultDll, db), 1);
  });

  test('serve-fault rejects an unknown fault name before opening a pipe', async () => {
    const signed = signReceipt(makeReceipt('bogus-op', 'bogus-approval', 'bogus-receipt'));
    const broker = serveFault('NotAFault', pipeName(), path.join(root, 'bogus.sqlite'), signed);
    assert.equal(await waitForExit(broker), 64);
    assert.deepEqual(broker.lines, []);
  });

  for (const fault of ['RevertFails', 'RevertThrows', 'RevertLies']) {
    test(`impersonation revert fault ${fault}: Broker terminates with ${EXIT_IMPERSONATION_REVERT_FAILED}, no claim, no response`, async () => {
      const signed = signReceipt(makeReceipt(`revert-${fault}`, `approval-${fault}`, `receipt-${fault}`));
      const pipe = pipeName(), db = path.join(root, `revert-${fault}.sqlite`);
      const broker = serveFault(fault, pipe, db, signed);
      await waitForLine(broker, 'BROKER_READY');
      const outcome = await request(pipe, signed.receipt, signed.signature).then(value => ({ value }), error => ({ error }));
      assert.equal(await waitForExit(broker), EXIT_IMPERSONATION_REVERT_FAILED);
      assert.ok(outcome.error, `client must not receive any response frame, got ${JSON.stringify(outcome.value)}`);
      assert.ok(broker.lines.includes('BROKER_FATAL=IMPERSONATION_REVERT_FAILED'), broker.lines.join('|'));
      for (const forbidden of ['PEER=authenticated', 'PEER=denied', 'CLAIM=PERSISTED_UNKNOWN', 'REQUEST=DENIED']) {
        assert.equal(broker.lines.includes(forbidden), false, `${forbidden} must not be printed after a revert failure`);
      }
      assert.equal(existsSync(db), false, 'the journal must not even be created');
      assert.equal(inspectClaimCount(faultDll, db), 0);
    });
  }

  test(`pipe squatting: a pre-existing pipe of the same name makes the Broker exit ${EXIT_PIPE_UNAVAILABLE} before BROKER_READY`, async () => {
    const signed = signReceipt(makeReceipt('squat-op', 'squat-approval', 'squat-receipt'));
    const pipe = pipeName(), db = path.join(root, 'squat.sqlite');
    const squatter = await squat(pipe);
    try {
      for (const start of [() => serve(productionDll, pipe, db, signed), () => serveFault('None', pipe, db, signed)]) {
        const broker = start();
        assert.equal(await waitForExit(broker), EXIT_PIPE_UNAVAILABLE, broker.lines.join('|'));
        assert.deepEqual(broker.lines, ['BROKER_FATAL=PIPE_UNAVAILABLE']);
      }
      assert.equal(squatter.state.connections, 0, 'a refusing Broker must not talk to the squatter');
    } finally { await squatter.close(); }
    assert.equal(existsSync(db), false);
  });

  test('concurrent squatting: of two Brokers racing for one pipe name exactly one serves, the other exits 70 untouched', async () => {
    for (let round = 0; round < 3; round += 1) {
      const signed = signReceipt(makeReceipt(`race-op-${round}`, `race-approval-${round}`, `race-receipt-${round}`));
      const pipe = pipeName();
      const dbs = [path.join(root, `race-${round}-a.sqlite`), path.join(root, `race-${round}-b.sqlite`)];
      const brokers = dbs.map(db => serve(productionDll, pipe, db, signed));
      const outcomes = await Promise.all(brokers.map(settle));
      const winners = outcomes.flatMap((outcome, index) => (outcome === 'ready' ? [index] : []));
      assert.equal(winners.length, 1, `round ${round}: expected exactly one winner, got ${outcomes.join(',')}`);
      const [winner] = winners, loser = 1 - winner;
      assert.equal(outcomes[loser], `exit:${EXIT_PIPE_UNAVAILABLE}`);
      assert.deepEqual(brokers[loser].lines, ['BROKER_FATAL=PIPE_UNAVAILABLE']);
      assert.deepEqual(await request(pipe, signed.receipt, signed.signature), { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' });
      assert.equal(await waitForExit(brokers[winner]), 0);
      assert.equal(inspectClaimCount(productionDll, dbs[winner]), 1);
      assert.equal(existsSync(dbs[loser]), false, 'the losing Broker must not create or touch its journal');
    }
  });

  test('a squatter that wins a concurrent race with two Brokers leaves both refusing', async () => {
    const signed = signReceipt(makeReceipt('squat2-op', 'squat2-approval', 'squat2-receipt'));
    const pipe = pipeName(), squatter = await squat(pipe);
    try {
      const brokers = [0, 1].map(index => serve(productionDll, pipe, path.join(root, `squat2-${index}.sqlite`), signed));
      assert.deepEqual(await Promise.all(brokers.map(waitForExit)), [EXIT_PIPE_UNAVAILABLE, EXIT_PIPE_UNAVAILABLE]);
      assert.equal(squatter.state.connections, 0);
    } finally { await squatter.close(); }
  });
});

function build(output, withFaults) {
  const intermediate = `${output}-obj`;
  const props = [`--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`, `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`];
  execFileSync('dotnet', ['restore', project, '--locked-mode', '--property:RestorePackagesWithLockFile=true', ...props], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });
  execFileSync('dotnet', ['build', project, '--configuration', 'Release', '--no-restore', '--output', output, ...(withFaults ? ['--property:AlberaBrokerTestFaults=true'] : []), ...props], { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true });
  return path.join(output, 'albera-windows-broker.dll');
}
function getUnavailableReason() {
  if (process.platform !== 'win32') return 'Windows-only .NET Broker Named Pipe integration';
  try {
    if (!execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some(x => /^10\./u.test(x))) return '.NET 10 SDK unavailable';
    if (!execFileSync('dotnet', ['--list-runtimes'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/u).some(x => /^Microsoft\.NETCore\.App 10\./u.test(x))) return '.NET 10 runtime unavailable';
  } catch { return 'dotnet unavailable'; }
  return false;
}
function startProcess(dll, args) {
  const child = spawn('dotnet', [dll, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.lines = []; child.closeCode = undefined; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.once('close', code => { child.closeCode = code; });
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
// Resolves with the exit code once the process has exited and its output streams are drained.
function waitForExit(child) {
  if (child.closeCode !== undefined) return Promise.resolve(child.closeCode);
  return new Promise(resolve => child.once('close', resolve));
}
// 'ready' once the Broker announced BROKER_READY, otherwise `exit:<code>`.
function settle(child) {
  return new Promise(resolve => {
    const ready = () => { if (child.lines.includes('BROKER_READY')) resolve('ready'); };
    child.stdout.on('data', ready);
    child.once('close', code => resolve(child.lines.includes('BROKER_READY') ? 'ready' : `exit:${code}`));
    ready();
  });
}
// A hostile same-user process that created the pipe name first.
function squat(pipe) {
  const state = { connections: 0 };
  const server = net.createServer(socket => { state.connections += 1; socket.destroy(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\\\\.\\pipe\\${pipe}`, () => resolve({ state, close: () => new Promise(done => server.close(done)) }));
  });
}
function request(pipe, receipt, signature) {
  const socket = net.createConnection(`\\\\.\\pipe\\${pipe}`), body = Buffer.from(JSON.stringify({ receipt, signature }));
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('connect', () => { const size = Buffer.alloc(4); size.writeInt32LE(body.length); socket.write(Buffer.concat([size, body])); });
    socket.on('data', x => chunks.push(x));
    socket.on('end', () => { const data = Buffer.concat(chunks); if (data.length < 4 || data.readInt32LE() !== data.length - 4) return reject(new Error('invalid response frame')); resolve(JSON.parse(data.subarray(4).toString('utf8'))); });
    socket.on('close', () => reject(new Error('connection closed without a response')));
    socket.on('error', reject);
  });
}
function makeReceipt(operationId, approvalId, receiptId) {
  const action = 'synthetic.noop';
  return Buffer.from(JSON.stringify({ issuer: 'albera-test-approval-authority', audience: 'ALBERA-HostBroker', approvalId, receiptId, operationId, idempotencyKey: `idem-${operationId}`, action, actionDigest: digest(action), leaseId: 'test-lease', leaseGeneration: 7, policyVersion: 'test-policy-v1', expiresAt: Math.floor(Date.now() / 1000) + 120 })).toString('base64');
}
function signReceipt(receipt) {
  return { ...JSON.parse(execFileSync(process.execPath, [signerFixture, receipt], { encoding: 'utf8', timeout: 10_000, windowsHide: true })), receipt };
}
function inspectClaimCount(dll, db) { return Number(execFileSync('dotnet', [dll, 'inspect', db], { encoding: 'utf8', windowsHide: true }).trim()); }
function digest(value) { return createHash('sha256').update(value).digest('hex').toUpperCase(); }
function pipeName() { return `ALBERA_Fault_${randomBytes(8).toString('hex')}`; }
