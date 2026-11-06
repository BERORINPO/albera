// The WSL2 run lease (ADR-012, decision 4): the contract, pinned by vectors its C# twin must reproduce too (runtime-broker-contract-dotnet.test.mjs), and the rules a vector cannot show.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSignedNetworkAttestation } from '../src/runtime/broker-contract/network-attestation.mjs';
import { readSignedTaskStartAttestation } from '../src/runtime/broker-contract/task-start-attestation.mjs';
import {
  MAX_RUN_LEASE_TTL_SECONDS, WSL2_ISOLATION, WSL2_RUN_LEASE_DOMAIN, Wsl2RunLeaseError, authenticateWsl2RunLease, canonicalizeWsl2RunLease, computeWsl2RunLeaseDigest, createWsl2RunLease, isGitOid, readSignedWsl2RunLease,
  requireWsl2RunLeaseBinding, signWsl2RunLease, validateWsl2RunLease,
} from '../src/runtime/broker-contract/wsl2-run-lease.mjs';
import { createEcdsaAttestationSigner, createEcdsaAttestationVerifier } from '../src/runtime/ecdsa-attestation-signer.mjs';

const contractDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'runtime', 'broker-contract');
const vectors = JSON.parse(fs.readFileSync(path.join(contractDir, 'wsl2-run-lease-vectors.json'), 'utf8'));
const OID = 'a'.repeat(40);
const T0 = 1793404800;
const INPUT = Object.freeze({ operationId: 'op-0001', actionDigest: `sha256:${'d'.repeat(64)}`, leaseGeneration: 7, computerId: 'pc-wsl', repositoryId: 'repo-alpha', baseOid: OID, maxCalls: 200, issuedAt: T0, ttlSeconds: 1800 });
const EXPECTED = Object.freeze({ baseOid: OID, computerId: 'pc-wsl', minLeaseGeneration: 7, operationId: 'op-0001', repositoryId: 'repo-alpha' });
const bothSteps = (signed, ctx, expected) => requireWsl2RunLeaseBinding(authenticateWsl2RunLease(signed, ctx), expected);
const codeOf = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof Wsl2RunLeaseError, String(error)); return `${error.code}${error.field ? `:${error.field}` : ''}`; } return 'ok'; };

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signer = createEcdsaAttestationSigner({ keyId: 'test-broker', privateKey });
  return { signer, verifier: createEcdsaAttestationVerifier({ keyId: 'test-broker', publicKey }) };
}

test('digest vectors: every body gives its digest and exact preimage, or its refusal', () => {
  assert.equal(vectors.contract, 'albera.wsl2-run-lease.vectors');
  assert.ok(vectors.digestVectors.length >= 40);
  const names = vectors.digestVectors.map((v) => v.name);
  assert.equal(new Set(names).size, names.length);
  for (const v of vectors.digestVectors) {
    if (v.expected.ok) {
      assert.equal(computeWsl2RunLeaseDigest(v.body), v.expected.digest, v.name);
      assert.equal(canonicalizeWsl2RunLease(v.body).toString('hex'), v.expected.preimageHex, v.name);
    } else assert.equal(codeOf(() => canonicalizeWsl2RunLease(v.body)), `${v.expected.code}${v.expected.field ? `:${v.expected.field}` : ''}`, v.name);
  }
});

test('verify vectors: every case gives its verdict with the vector key', () => {
  const verifier = createEcdsaAttestationVerifier({ keyId: vectors.verifyVectors.keyId, publicKey: vectors.verifyVectors.publicKeySpki });
  assert.ok(vectors.verifyVectors.cases.length >= 30);
  for (const c of vectors.verifyVectors.cases) {
    const got = codeOf(() => bothSteps(c.signed, { clock: () => c.now, verify: verifier.verify }, c.expected));
    assert.equal(got, c.result.ok ? 'ok' : `${c.result.code}${c.result.field ? `:${c.result.field}` : ''}`, c.name);
  }
});

test('the vectors cover each way a lease can be wrong, and the good cases are really good', () => {
  const results = new Map(vectors.verifyVectors.cases.map((c) => [c.name, c.result]));
  assert.deepEqual(results.get('valid'), { ok: true });
  for (const [name, code, field] of [['expired-at-the-second', 'expired', 'expiresAt'], ['not-yet-valid-31', 'not_yet_valid', 'issuedAt'], ['wrong-base-oid', 'binding', 'baseOid'], ['wrong-computer', 'binding', 'computerId'],
    ['wrong-operation', 'binding', 'operationId'], ['wrong-repository', 'binding', 'repositoryId'], ['signature-other-key', 'signature', 'signature'], ['body-changed-calls', 'digest', 'digest'], ['generation-under-the-floor', 'generation', 'leaseGeneration'], ['signature-non-canonical', 'malformed', 'signature'], ['digest-newline', 'malformed', 'digest'], ['key-id-newline', 'malformed', 'keyId']]) {
    assert.deepEqual(results.get(name), { ok: false, code, field }, name);
  }
  assert.equal(results.get('network-attestation-is-malformed-here').code, 'malformed');
  assert.equal(results.get('cross-domain-signature').code, 'signature');
});

test('a body is signed under its own domain, and the isolation class is fixed by the constructor', () => {
  const body = createWsl2RunLease(INPUT);
  assert.equal(body.isolation, WSL2_ISOLATION);
  assert.equal(body.expiresAt, T0 + 1800);
  assert.ok(canonicalizeWsl2RunLease(body).subarray(0, WSL2_RUN_LEASE_DOMAIN.length + 1).equals(Buffer.from(`${WSL2_RUN_LEASE_DOMAIN}\0`)));
  assert.equal(WSL2_RUN_LEASE_DOMAIN, 'albera.wsl2-run-lease.v1');
  assert.equal(codeOf(() => createWsl2RunLease({ ...INPUT, ttlSeconds: MAX_RUN_LEASE_TTL_SECONDS + 1 })), 'ttl:expiresAt');
  assert.equal(codeOf(() => createWsl2RunLease({ ...INPUT, issuedAt: 'now' })), 'malformed:issuedAt');
});

test('sign then verify round trip with a real key, and a lease body is frozen', async () => {
  const { signer, verifier } = keys();
  const signed = await signWsl2RunLease(createWsl2RunLease(INPUT), signer);
  const lease = bothSteps(JSON.parse(JSON.stringify(signed)), { clock: () => T0 + 1, verify: verifier.verify }, EXPECTED);
  assert.equal(lease.maxCalls, 200);
  assert.ok(Object.isFrozen(lease));
  assert.equal(readSignedWsl2RunLease(signed).digest, signed.digest);
});

test('a lease is not an attestation, whatever its signature', async () => {
  const signed = await signWsl2RunLease(createWsl2RunLease(INPUT), keys().signer);
  for (const read of [readSignedNetworkAttestation, readSignedTaskStartAttestation]) assert.throws(() => read(signed), (error) => error.code === 'malformed');
});

test('a signer that fails or is missing refuses, and never yields a lease', async () => {
  const body = createWsl2RunLease(INPUT);
  await assert.rejects(signWsl2RunLease(body, null), (e) => e.code === 'signer_invalid');
  await assert.rejects(signWsl2RunLease(body, { keyId: 'a b', sign: async () => new Uint8Array(64) }), (e) => e.code === 'signer_invalid');
  await assert.rejects(signWsl2RunLease(body, { keyId: 'k', sign: async () => { throw new Error('secret text'); } }), (e) => e.code === 'signer_failed' && !e.message.includes('secret'));
  await assert.rejects(signWsl2RunLease(body, { keyId: 'k', sign: async () => new Uint8Array(0) }), (e) => e.code === 'signer_failed');
  await assert.rejects(signWsl2RunLease(body, { keyId: 'k', sign: async () => 'text' }), (e) => e.code === 'signer_failed');
});

test('a verifier that throws or answers anything but true is a refusal, and the clock is read after it', async () => {
  const { signer } = keys();
  const signed = await signWsl2RunLease(createWsl2RunLease(INPUT), signer);
  const context = { clock: () => T0 };
  assert.equal(codeOf(() => authenticateWsl2RunLease(signed, { ...context, verify: () => { throw new Error('x'); } })), 'signature:signature');
  assert.equal(codeOf(() => authenticateWsl2RunLease(signed, { ...context, verify: () => 1 })), 'signature:signature');
  const order = [];
  authenticateWsl2RunLease(signed, { verify: () => { order.push('verify'); return true; }, clock: () => { order.push('clock'); return T0; } });
  assert.deepEqual(order, ['verify', 'clock']);
});

test('an unusable context fails closed', async () => {
  const signed = await signWsl2RunLease(createWsl2RunLease(INPUT), keys().signer);
  const verify = () => true;
  assert.equal(codeOf(() => authenticateWsl2RunLease(signed, undefined)), 'invalid_context');
  assert.equal(codeOf(() => authenticateWsl2RunLease(signed, { clock: () => T0 })), 'invalid_context');
  assert.equal(codeOf(() => authenticateWsl2RunLease(signed, { clock: () => -1, verify })), 'invalid_context:clock');
  assert.equal(codeOf(() => authenticateWsl2RunLease(signed, { clock: () => Number.NaN, verify })), 'invalid_context:clock');
  assert.equal(codeOf(() => authenticateWsl2RunLease(signed, { clock: () => { throw new Error('x'); }, verify })), 'invalid_context:clock');
  assert.equal(codeOf(() => requireWsl2RunLeaseBinding(createWsl2RunLease(INPUT), { ...EXPECTED, extra: 1 })), 'invalid_expected:$extra');
  assert.equal(codeOf(() => requireWsl2RunLeaseBinding(createWsl2RunLease(INPUT), undefined)), 'invalid_expected');
});

test('objects that are not plain data are refused', () => {
  const body = { ...createWsl2RunLease(INPUT) };
  class Lease { constructor() { Object.assign(this, body); } }
  assert.equal(codeOf(() => validateWsl2RunLease(new Lease())), 'malformed');
  assert.equal(codeOf(() => validateWsl2RunLease(Object.defineProperty({ ...body, baseOid: undefined }, 'baseOid', { get: () => OID, enumerable: true }))), 'malformed');
  assert.equal(codeOf(() => validateWsl2RunLease(null)), 'malformed');
});

test('a git object id is a full lowercase hash, never a name', () => {
  for (const good of ['a'.repeat(40), 'f'.repeat(64)]) assert.equal(isGitOid(good), true);
  for (const bad of ['HEAD', 'main', 'a'.repeat(39), 'a'.repeat(63), 'A'.repeat(40), `${'a'.repeat(40)}\n`, null, 1]) assert.equal(isGitOid(bad), false);
});
