import assert from 'node:assert/strict';
import { sendBrokerRequest } from '../src/runtime/windows-broker-client.mjs';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import {
  brokerSession, buildBrokerWithTestSeams, buildPipeClient, createTestAuthority, currentUserSid, getUnavailableReason, inspectClaimCount, makeTrustedTempDirectory,
  rawRequest, standInService, startProcess, waitForExit, waitForLine, GENERATION, LEASE_CONFIG,
} from './helpers/windows-broker-harness.mjs';
import { authenticateWsl2RunLease, computeWsl2RunLeaseDigest } from '../src/runtime/broker-contract/wsl2-run-lease.mjs';

// Windows-only, same-user, unprivileged. The real Broker (the test-faults build's `serve-loop`) and its real claim pipe, with a `wsl2` computer: a newly recorded wsl2 task.start claim answers with a run lease
// signed by the Broker's attestation key (ADR-012, decision 4; ADR-002 Amendment 2026-11-04). The key is a PKCS#8 file named by the test-only ALBERA_BROKER_TEST_ATTESTATION_PKCS8 variable (compiled into the
// test-faults build only): the production path opens a CNG machine key by name, which needs a key an installer made, and was NOT exercised here (only its refusal of a name that does not exist was).
// Most claims go over a raw same-user socket, so the reply is the Broker's own bytes; two tests run the real pipe client helper.
const WSL = 'wsl-1', VM = 'room-1', KEY_ID = 'broker-attest-test';
const NO_SUCH_VM = '0123abcd-4567-89ab-cdef-000000000001';
const TARGET = { task: 'build the project', isolation: 'wsl2', repositoryId: 'repo-alpha', baseOid: 'a'.repeat(40) };
const EXIT_ATTESTATION_KEY_UNUSABLE = 77;
const dtoOf = (computerId, args) => ({ action: 'task.start', projectId: 'project-1', computerId, args });
const encode = (dto) => Buffer.from(JSON.stringify(dto)).toString('base64');

describe('Broker WSL2 run lease on a newly claimed wsl2 task.start (seam build)', { skip: getUnavailableReason() }, () => {
  let root, loopExe, helper, sid;
  const authority = createTestAuthority();
  const running = new Set();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey;
  let keyFile;
  before(async () => {
    root = makeTrustedTempDirectory('albera-wsl2-lease-');
    loopExe = buildBrokerWithTestSeams(path.join(root, 'broker-seams'));
    helper = await buildPipeClient(path.join(root, 'helper'));
    sid = currentUserSid();
    keyFile = path.join(root, 'attestation.pk8');
    writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'der' }));
  });
  after(async () => {
    for (const child of running) { child.kill(); await waitForExit(child); }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  let counter = 0;
  const config = (name, overrides = {}) => ({
    pipeName: `ALBERA_Wsl2Lease_${process.pid}_${counter += 1}`, database: path.join(root, `${name}.sqlite`), authorityKeys: [authority.keyEntry], controlPlaneSid: sid, generation: GENERATION, ...LEASE_CONFIG,
    computers: [{ computerId: VM, vmId: NO_SUCH_VM }, { computerId: WSL, kind: 'wsl2' }], attestation: { keyName: 'albera-test-key', keyId: KEY_ID }, ...overrides,
  });
  const writeConfig = (name, value) => { const file = path.join(root, `${name}.config.json`); writeFileSync(file, JSON.stringify(value)); return file; };
  const serviceCheck = (name, value) => spawnSync(loopExe, standInService('service-check', writeConfig(name, value)), { encoding: 'utf8', windowsHide: true }).stdout.trim();
  /** Starts the loop with the test key (unless `env` says otherwise) and waits for BROKER_READY. */
  async function start(name, overrides, env = { ALBERA_BROKER_TEST_ATTESTATION_PKCS8: keyFile }) {
    const value = config(name, overrides);
    const child = startProcess(loopExe, standInService('serve-loop', writeConfig(name, value)), { stdin: true, env });
    running.add(child);
    child.once('close', () => running.delete(child));
    await waitForLine(child, 'BROKER_READY');
    const session = brokerSession({ helper, sid, pipeName: value.pipeName, pid: child.pid, authority });
    return { child, value, session };
  }
  async function stop(child) { child.stdin.end(); return waitForExit(child); }

  /** fence + sign through the helper, then the claim itself over a raw socket so the reply is the Broker's own bytes. */
  async function claim(started, name, computerId, args, purpose = 'guest.command', action = 'task.start') {
    const prepared = await started.session.prepare(name, { purpose, action, args, computerId });
    const request = { receipt: prepared.receipt, signature: prepared.signature, ...(purpose === 'guest.command' ? { action: encode(dtoOf(computerId, args)) } : {}) };
    const fields = JSON.parse(Buffer.from(prepared.receipt, 'base64').toString('utf8'));
    return { request, fields, fence: prepared.fence, reply: await rawRequest(started.value.pipeName, request) };
  }
  const authenticate = (signed, clock = () => Math.floor(Date.now() / 1000)) => authenticateWsl2RunLease(signed, {
    clock,
    verify: (keyId, bytes, signature) => keyId === KEY_ID && cryptoVerify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature),
  });
  const NO_LEASE = { ok: true, state: 'UNKNOWN', action: 'task.start' };

  it('signs a lease for a new wsl2 claim: the reply has exactly one extra key, and the Node bridge authenticates it', async () => {
    const started = await start('good');
    const before = Math.floor(Date.now() / 1000);
    const { reply, fields, fence } = await claim(started, 'good', WSL, TARGET);
    assert.deepEqual(Object.keys(reply).sort(), ['action', 'lease', 'ok', 'state']);
    assert.deepEqual({ ok: reply.ok, state: reply.state, action: reply.action }, NO_LEASE);
    assert.deepEqual(Object.keys(reply.lease).sort(), ['digest', 'keyId', 'lease', 'signature']);
    assert.equal(reply.lease.keyId, KEY_ID);
    const lease = authenticate(reply.lease); // a lease signed by the C# side authenticates in Node (shape, TTL, digest, ECDSA P-256 / SHA-256 r||s, clock)
    assert.equal(lease.operationId, fields.operationId);
    assert.equal(lease.actionDigest, fields.actionDigest, 'the receipt\'s digest');
    assert.equal(lease.leaseGeneration, fence.leaseGeneration, 'the claim\'s generation');
    assert.equal(lease.leaseGeneration, fields.leaseGeneration);
    assert.deepEqual({ v: lease.v, computerId: lease.computerId, isolation: lease.isolation, repositoryId: lease.repositoryId, baseOid: lease.baseOid, maxCalls: lease.maxCalls },
      { v: 1, computerId: WSL, isolation: 'wsl2', repositoryId: TARGET.repositoryId, baseOid: TARGET.baseOid, maxCalls: 10_000 });
    assert.equal(lease.expiresAt - lease.issuedAt, 3600);
    assert.ok(lease.issuedAt >= before - 1 && lease.issuedAt <= Math.floor(Date.now() / 1000) + 1, 'issuedAt is the Broker\'s now');
    assert.ok(started.child.lines.includes('LEASE=SIGNED'));
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 2048, 'fits the pipe client helper\'s response limit');
    await stop(started.child);
  });

  it('answers a replay of the same claim with the recorded outcome and no lease', async () => {
    const started = await start('replay');
    const first = await claim(started, 'replay', WSL, TARGET);
    assert.ok(first.reply.lease);
    assert.deepEqual(await rawRequest(started.value.pipeName, first.request), { ...NO_LEASE, replayed: true });
    assert.equal(started.child.lines.filter((line) => line === 'LEASE=SIGNED').length, 1);
    assert.equal(inspectClaimCount(loopExe, started.value.database), 1);
    await stop(started.child);
  });

  it('gives no lease to a VM computer or to synthetic.noop, even with a key', async () => {
    const started = await start('others');
    const vm = await claim(started, 'others-vm', VM, { task: 'x' });
    assert.deepEqual(vm.reply, NO_LEASE);
    const synthetic = await claim(started, 'others-noop', 'computer-1', {}, 'broker.operation', 'synthetic.noop');
    assert.deepEqual(synthetic.reply, { ok: true, state: 'UNKNOWN', action: 'synthetic.noop' });
    assert.equal(started.child.lines.some((line) => /^LEASE=(SIGNED|NO_KEY|SIGN_FAILED)$/.test(line)), false, 'neither is a lease decision');
    await stop(started.child);
  });

  it('with no key configured the reply is the old one, stdout says LEASE=NO_KEY and the claim is recorded', async () => {
    const started = await start('nokey', { attestation: undefined });
    const { reply } = await claim(started, 'nokey', WSL, TARGET);
    assert.deepEqual(reply, NO_LEASE);
    assert.ok(started.child.lines.includes('LEASE=NO_KEY'));
    assert.equal(inspectClaimCount(loopExe, started.value.database), 1);
    await stop(started.child);
  });

  it('when signing fails the reply has no lease, stdout says LEASE=SIGN_FAILED and the claim stays recorded', async () => {
    const started = await start('signfail', {}, { ALBERA_BROKER_TEST_ATTESTATION_PKCS8: keyFile, ALBERA_BROKER_TEST_ATTESTATION_SIGN_FAILS: '1' });
    const { reply, fields } = await claim(started, 'signfail', WSL, TARGET);
    assert.deepEqual(reply, NO_LEASE);
    assert.ok(started.child.lines.includes('LEASE=SIGN_FAILED'));
    assert.equal(inspectClaimCount(loopExe, started.value.database), 1);
    assert.deepEqual((await rawRequest(started.value.pipeName, { inspect: { operationId: fields.operationId } })).state, 'UNKNOWN');
    await stop(started.child);
  });

  it('a tampered reply fails Authenticate: any changed body value, the digest, the key id or the signature', async () => {
    const started = await start('tamper');
    const { reply } = await claim(started, 'tamper', WSL, TARGET);
    authenticate(reply.lease);
    const clone = () => structuredClone(reply.lease);
    const flip = (text) => `${text.startsWith('A') ? 'B' : 'A'}${text.slice(1)}`; // the first character: the last one of 86 holds spare bits, and a change there is `malformed`
    const tampered = [
      ['baseOid', (x) => { x.lease.baseOid = 'b'.repeat(40); }, 'digest'], ['computerId', (x) => { x.lease.computerId = 'wsl-2'; }, 'digest'], ['expiresAt', (x) => { x.lease.expiresAt -= 1; }, 'digest'],
      ['maxCalls', (x) => { x.lease.maxCalls = 1; }, 'digest'], ['signature', (x) => { x.signature = flip(x.signature); }, 'signature'], ['keyId', (x) => { x.keyId = 'other-key'; }, 'signature'],
      ['body re-digested but not re-signed', (x) => { x.lease.maxCalls = 9; x.digest = computeWsl2RunLeaseDigest(x.lease); }, 'signature'],
    ];
    for (const [label, change, code] of tampered) {
      const copy = clone();
      change(copy);
      assert.throws(() => authenticate(copy), { code }, label);
    }
    assert.throws(() => authenticate(reply.lease, () => reply.lease.lease.expiresAt), { code: 'expired' }, 'and it expires after 3600 s');
    await stop(started.child);
  });

  it('is relayed unchanged by the real pipe client helper, which now allows a reply of this size', async () => {
    const started = await start('helper');
    const prepared = await started.session.prepare('helper', { purpose: 'guest.command', action: 'task.start', args: TARGET, computerId: WSL });
    const input = JSON.stringify({ pipeName: started.value.pipeName, receipt: prepared.receipt, signature: prepared.signature, action: encode(dtoOf(WSL, TARGET)), timeoutMs: 10_000, expect: { ownerSid: sid, pid: started.child.pid } });
    const result = spawnSync(helper, [], { input, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0);
    const reply = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(reply), ['ok', 'state', 'action', 'lease']);
    assert.ok(Buffer.byteLength(result.stdout) > 256, 'longer than the old 256-byte limit');
    assert.equal(authenticate(reply.lease).operationId, 'helper-op');
    await stop(started.child);
  });

  it('reaches the Control Plane through the real client and the real helper', async () => {
    const started = await start('client');
    const prepared = await started.session.prepare('client', { purpose: 'guest.command', action: 'task.start', args: TARGET, computerId: WSL });
    const send = () => sendBrokerRequest({ pipeName: started.value.pipeName, receipt: prepared.receipt, signature: prepared.signature, action: dtoOf(WSL, TARGET), expect: { ownerSid: sid, pid: started.child.pid }, helperPath: helper, timeoutMs: 10_000 });
    const first = await send();
    assert.equal(first.ok, true);
    assert.equal(authenticate(first.lease).operationId, 'client-op');
    await stop(started.child);
  });

  describe('the attestation config key', () => {
    it('is optional and, when present, exactly { keyName, keyId }', () => {
      assert.equal(serviceCheck('att-ok', config('att-ok')), 'SERVICE_CONFIG=ok');
      assert.equal(serviceCheck('att-absent', config('att-absent', { attestation: undefined })), 'SERVICE_CONFIG=ok');
      assert.equal(serviceCheck('att-edge', config('att-edge', { attestation: { keyName: '.'.repeat(64), keyId: 'a' } })), 'SERVICE_CONFIG=ok');
      const bad = [
        ['empty object', {}], ['a string', 'key'], ['null', null], ['a list', []], ['no keyId', { keyName: 'k' }], ['no keyName', { keyId: KEY_ID }], ['an extra key', { keyName: 'k', keyId: KEY_ID, extra: 1 }],
        ['a name of 65', { keyName: 'k'.repeat(65), keyId: KEY_ID }], ['an empty name', { keyName: '', keyId: KEY_ID }], ['a name with a space', { keyName: 'a b', keyId: KEY_ID }],
        ['a name with a slash', { keyName: 'a/b', keyId: KEY_ID }], ['a name with a backslash', { keyName: 'a\\b', keyId: KEY_ID }], ['a name with a newline', { keyName: 'ab\n', keyId: KEY_ID }],
        ['a name that is a number', { keyName: 5, keyId: KEY_ID }], ['a keyId that is not an id', { keyName: 'k', keyId: 'a b' }], ['a keyId of 65', { keyName: 'k', keyId: 'k'.repeat(65) }],
        ['a keyId that is a number', { keyName: 'k', keyId: 5 }], ['a keyId that is null', { keyName: 'k', keyId: null }],
      ];
      for (const [label, attestation] of bad) assert.equal(serviceCheck('att-bad', config('att-bad', { attestation })), 'SERVICE_CONFIG=invalid:attestation', label);
    });

    it('refuses a repeated key', () => {
      const file = path.join(root, 'att-repeat.config.json');
      writeFileSync(file, JSON.stringify(config('att-repeat')).replace('"keyId":"broker-attest-test"', '"keyId":"broker-attest-test","keyId":"broker-attest-test"'));
      assert.equal(spawnSync(loopExe, standInService('service-check', file), { encoding: 'utf8', windowsHide: true }).stdout.trim(), 'SERVICE_CONFIG=invalid:attestation');
    });
  });

  describe('a configured key that cannot be used stops the start', () => {
    const fatal = async (name, env, overrides) => {
      const value = config(name, overrides);
      const child = startProcess(loopExe, standInService('serve-loop', writeConfig(name, value)), { stdin: true, env });
      running.add(child);
      assert.equal(await waitForExit(child), EXIT_ATTESTATION_KEY_UNUSABLE);
      assert.ok(child.lines.includes('BROKER_FATAL=ATTESTATION_KEY_UNUSABLE'), child.lines.join('|'));
      assert.equal(child.lines.includes('BROKER_READY'), false);
      assert.equal(inspectClaimCount(loopExe, value.database), 0, 'no journal was made');
    };

    it('(production path) a CNG machine key that does not exist', () => fatal('cng-missing', {}, { attestation: { keyName: `albera-no-such-key-${process.pid}`, keyId: KEY_ID } }));

    it('a key that is not ECDSA P-256', () => {
      const other = path.join(root, 'p384.pk8');
      writeFileSync(other, generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'der' }));
      return fatal('p384', { ALBERA_BROKER_TEST_ATTESTATION_PKCS8: other });
    });

    it('a key file that is not a key', () => {
      const junk = path.join(root, 'junk.pk8');
      writeFileSync(junk, 'not a key');
      return fatal('junk', { ALBERA_BROKER_TEST_ATTESTATION_PKCS8: junk });
    });
  });
});
