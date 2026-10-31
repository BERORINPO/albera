// Issue #115 step 3b: the real signature scheme of the network attestation (ECDSA P-256 / SHA-256 over the canonical bytes). The signed verify vectors in
// network-attestation-vectors.json are made with an EPHEMERAL key (only its public half is in the file); the C# twin reproduces the same results in the dotnet contract test.
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  NetworkAttestationError, canonicalizeNetworkAttestation, createNetworkAttestation, signNetworkAttestation, verifyNetworkAttestation,
} from '../src/runtime/broker-contract/network-attestation.mjs';
import { createEcdsaAttestationSigner, createEcdsaAttestationVerifier } from '../src/runtime/ecdsa-attestation-signer.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contractDir = path.join(repositoryRoot, 'src', 'runtime', 'broker-contract');
const vectorsText = fs.readFileSync(path.join(contractDir, 'network-attestation-vectors.json'), 'utf8');
const vectors = JSON.parse(vectorsText);
const { verifyVectors } = vectors;

const KEY_ID = 'albera-test-broker-1';
const VM = '11111111-2222-4333-8444-555555555555';
const T0 = 1793404800;
const BODY = createNetworkAttestation({ network: 'none', computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, observedAt: T0 });
const EXPECTED = Object.freeze({ computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7 });
const generate = (namedCurve = 'prime256v1') => generateKeyPairSync('ec', { namedCurve });
const plain = (value) => JSON.parse(JSON.stringify(value));
const REFUSED_AS_SIGNATURE = Object.freeze({ ok: false, code: 'signature', field: 'signature' });

const outcomeOf = (fn) => {
  try { fn(); return { ok: true }; } catch (error) {
    assert.ok(error instanceof NetworkAttestationError, String(error));
    return { ok: false, code: error.code, ...(error.field ? { field: error.field } : {}) };
  }
};
const verdict = (signed, verifier, now = T0 + 1, expected = EXPECTED) => outcomeOf(() => verifyNetworkAttestation(plain(signed), { clock: () => now, verify: verifier.verify, expected }));

test('verify vectors: every signed case gives its pinned result with the public key from the vector file (the C# twin gives the same)', () => {
  assert.equal(vectors.contract, 'albera.network-attestation.vectors');
  assert.ok(verifyVectors.cases.length >= 40);
  const names = verifyVectors.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'case names are unique');
  const verifier = createEcdsaAttestationVerifier({ keyId: verifyVectors.keyId, publicKey: verifyVectors.publicKeySpki });
  for (const c of verifyVectors.cases) assert.deepEqual(verdict(c.signed, verifier, c.now, c.expected), c.result, c.name);
  // The boundaries the vectors must keep covering.
  const result = (name) => verifyVectors.cases.find((c) => c.name === name).result;
  assert.deepEqual(result('valid-none'), { ok: true });
  assert.deepEqual(result('signature-one-bit-flipped'), REFUSED_AS_SIGNATURE);
  assert.deepEqual(result('signed-by-another-key-same-key-id'), REFUSED_AS_SIGNATURE);
  assert.deepEqual(result('wrong-key-id'), REFUSED_AS_SIGNATURE);
  assert.deepEqual(result('expired-exactly-at-expiresAt'), { ok: false, code: 'expired', field: 'expiresAt' });
  assert.deepEqual(result('valid-expected-vmId-null-does-not-compare-the-vm'), { ok: true });
  assert.deepEqual(result('bad-signature-is-reported-before-expiry'), REFUSED_AS_SIGNATURE);
  for (const field of ['computerId', 'generation', 'leaseGeneration', 'leaseId', 'projectId', 'vmId']) assert.deepEqual(result(`binding-${field}`), { ok: false, code: 'binding', field }, field);
});

test('the vector file holds a public key and signatures only: no private key material, and the key is a named P-256 SPKI', () => {
  assert.ok(!/PRIVATE|BEGIN [A-Z ]*KEY/u.test(vectorsText));
  const spki = Buffer.from(verifyVectors.publicKeySpki, 'base64');
  assert.equal(spki.length, 91, 'a P-256 SubjectPublicKeyInfo is 91 bytes');
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.deepEqual([key.asymmetricKeyType, key.asymmetricKeyDetails.namedCurve], ['ec', 'prime256v1']);
});

test('sign through the ECDSA port and verify with the pinned key: a 64-byte P1363 signature over exactly the canonical bytes', async () => {
  const signer = createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generate().privateKey });
  const verifier = createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: signer.publicKeySpki });
  const signed = await signNetworkAttestation(BODY, signer);
  assert.equal(Buffer.from(signed.signature, 'base64url').length, 64);
  assert.equal(signed.keyId, KEY_ID);
  assert.deepEqual(verdict(signed, verifier), { ok: true });
  assert.equal(verifier.verify(KEY_ID, canonicalizeNetworkAttestation(BODY), Buffer.from(signed.signature, 'base64url')), true);
  // ECDSA is randomised: two signatures differ and both verify.
  const again = await signNetworkAttestation(BODY, signer);
  assert.notEqual(again.signature, signed.signature);
  assert.deepEqual(verdict(again, verifier), { ok: true });
});

test('a statement signed by one key does not verify under another key or another key id, and a changed body does not verify at all', async () => {
  const mine = createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generate().privateKey });
  const pinned = createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: mine.publicKeySpki });
  const theirs = createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generate().privateKey });
  assert.deepEqual(verdict(await signNetworkAttestation(BODY, theirs), pinned), REFUSED_AS_SIGNATURE, 'another key, the same key id');
  const otherId = createEcdsaAttestationSigner({ keyId: 'albera-test-broker-2', privateKey: generate().privateKey });
  assert.deepEqual(verdict(await signNetworkAttestation(BODY, otherId), pinned), REFUSED_AS_SIGNATURE, 'another key id');
  const signed = plain(await signNetworkAttestation(BODY, mine));
  assert.deepEqual(verdict({ ...signed, attestation: { ...signed.attestation, network: 'present' } }, pinned), { ok: false, code: 'digest', field: 'digest' }, 'the digest no longer matches');
  const forged = { ...signed.attestation, network: 'present' };
  assert.deepEqual(verdict({ ...signed, attestation: forged, digest: (await signNetworkAttestation(forged, otherId)).digest }, pinned), REFUSED_AS_SIGNATURE, 'digest recomputed, signature still the old one');
});

test('the signer refuses anything that is not an EC P-256 private key and a malformed key id; the verifier refuses a key that is not P-256', () => {
  const p256 = generate();
  const refuses = (fn) => assert.throws(fn, (error) => error instanceof TypeError && error.message === 'attestation_key_invalid');
  refuses(() => createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: p256.publicKey }));
  refuses(() => createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generate('secp384r1').privateKey }));
  refuses(() => createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generate('secp256k1').privateKey }));
  refuses(() => createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }));
  refuses(() => createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: 'not a key' }));
  refuses(() => createEcdsaAttestationSigner({ keyId: KEY_ID }));
  refuses(() => createEcdsaAttestationSigner());
  for (const keyId of ['', '-bad', 'has space', 'x'.repeat(65), undefined, 7]) refuses(() => createEcdsaAttestationSigner({ keyId, privateKey: p256.privateKey }));
  const p384Spki = generate('secp384r1').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  refuses(() => createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: p384Spki }));
  refuses(() => createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: 'AAAA' }));
  refuses(() => createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: p256.privateKey }));
  refuses(() => createEcdsaAttestationVerifier({ keyId: 'bad id', publicKey: p256.publicKey }));
  refuses(() => createEcdsaAttestationVerifier({ keyId: KEY_ID }));
  assert.equal(createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: p256.publicKey }).keyId, KEY_ID, 'a public key object is accepted as well as its SPKI text');
});

test('the verifier answers true only for the pinned key id and a 64-byte signature, and never throws', async () => {
  const signer = createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generate().privateKey });
  const verifier = createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: signer.publicKeySpki });
  const bytes = canonicalizeNetworkAttestation(BODY);
  const signature = Buffer.from((await signNetworkAttestation(BODY, signer)).signature, 'base64url');
  assert.equal(verifier.verify(KEY_ID, bytes, signature), true);
  assert.equal(verifier.verify('albera-test-broker-2', bytes, signature), false);
  assert.equal(verifier.verify(KEY_ID, bytes, signature.subarray(0, 63)), false);
  assert.equal(verifier.verify(KEY_ID, bytes, Buffer.concat([signature, Buffer.from([0])])), false);
  assert.equal(verifier.verify(KEY_ID, Buffer.concat([bytes, Buffer.from([0])]), signature), false);
  for (const odd of [undefined, null, 'x', 7, {}, []]) assert.equal(verifier.verify(KEY_ID, bytes, odd), false);
  for (const odd of [undefined, null, 'x', 7]) assert.equal(verifier.verify(KEY_ID, odd, signature), false);
  assert.equal(verifier.verify(undefined, bytes, signature), false);
});

test('the Broker side end to end: a provider that signs with the ECDSA port produces a statement the pinned public key accepts, bound to this environment', async () => {
  const signer = createEcdsaAttestationSigner({ keyId: KEY_ID, privateKey: generate().privateKey });
  const verifier = createEcdsaAttestationVerifier({ keyId: KEY_ID, publicKey: signer.publicKeySpki });
  const provider = new MockEnvironmentProvider({ now: () => new Date(T0 * 1000).toISOString(), attestationSigner: signer });
  const spec = {
    projectId: 'proj-alpha', kind: 'ephemeral', os: 'linux', architecture: 'x64', imageDigest: `sha256:${'b'.repeat(64)}`, capabilities: ['terminal'], networkProfileId: 'isolated-none',
    securityProfileId: 'guest-restricted-v1', resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
  };
  const op = (action, extra = {}) => ({
    operationId: `op-${action}`, idempotencyKey: `key-${action}`, subjectId: 'subject-1', projectId: 'proj-alpha', taskId: 'task-1', runId: 'run-1', computerId: 'pc-01', providerId: 'mock',
    leaseId: 'lease-1', expectedGeneration: 1, policyVersion: 1, action, ...extra,
  });
  await provider.create(op('create', { spec }));
  const signed = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  const expected = { computerId: 'pc-01', vmId: signed.attestation.vmId, generation: 1, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 5 };
  assert.deepEqual(verdict(signed, verifier, T0 + 1, expected), { ok: true });
  assert.equal(signed.attestation.network, 'none');
  assert.deepEqual(verdict(signed, verifier, T0 + 1, { ...expected, leaseId: 'lease-2' }), { ok: false, code: 'binding', field: 'leaseId' });
  assert.deepEqual(verdict(signed, verifier, T0 + 1, { ...expected, leaseGeneration: 6 }), { ok: false, code: 'binding', field: 'leaseGeneration' });
});
