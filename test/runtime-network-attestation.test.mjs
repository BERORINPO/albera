// Issue #115 step 2: the Broker-produced network attestation (contract, Broker side, provider seams). The consumer (the Approval Authority, step 3b) has its own tests; these pin what the statement says, how it is bound, and that nothing a Control Plane sends can change it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DIGEST_DOMAIN } from '../src/runtime/broker-contract/action-digest.mjs';
import {
  ATTESTATION_DOMAIN, DEFAULT_TTL_SECONDS, MAX_OBSERVED_SKEW_SECONDS, MAX_TTL_SECONDS, NETWORK_VALUES, NetworkAttestationError,
  canonicalizeNetworkAttestation, classifyNetworkAdapters, computeNetworkAttestationDigest, createNetworkAttestation, readSignedNetworkAttestation,
  signNetworkAttestation, validateNetworkAttestation, verifyNetworkAttestation,
} from '../src/runtime/broker-contract/network-attestation.mjs';
import { LocalEnvironmentHostBroker } from '../src/runtime/environment-host-broker.mjs';
import { EnvironmentProvider } from '../src/runtime/environment-provider.mjs';
import { createFakeAttestationSigner } from '../src/runtime/fake-attestation-signer.mjs';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { HyperVEnvironmentProvider } from '../src/runtime/hyperv-environment-provider.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';

const contractDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'runtime', 'broker-contract');
const vectors = JSON.parse(fs.readFileSync(path.join(contractDir, 'network-attestation-vectors.json'), 'utf8'));
const scriptText = fs.readFileSync(path.join(path.dirname(contractDir), 'hyperv-env', 'env-io.ps1'), 'utf8');

const VM = '11111111-2222-4333-8444-555555555555';
const T0 = 1793404800; // Unix seconds
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const BODY = Object.freeze({ v: 1, network: 'none', computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, observedAt: T0, expiresAt: T0 + 60 });
const EXPECTED = Object.freeze({ computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7 });
const A = (connected, switchType) => ({ connected, switchType });

const codeOf = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof NetworkAttestationError, String(error)); return `${error.code}${error.field ? `:${error.field}` : ''}`; } return 'ok'; };

// ---- contract: vectors, digest, classification ----

test('vectors: every digest vector reproduces its digest and exact preimage, or its refusal', () => {
  assert.equal(vectors.contract, 'albera.network-attestation.vectors');
  assert.ok(vectors.digestVectors.length >= 25 && vectors.classificationVectors.length >= 20);
  const names = [...vectors.digestVectors, ...vectors.classificationVectors].map((v) => v.name);
  assert.equal(new Set(names).size, names.length, 'vector names are unique');
  for (const v of vectors.digestVectors) {
    if (v.expected.ok) {
      assert.equal(computeNetworkAttestationDigest(v.body), v.expected.digest, v.name);
      assert.equal(canonicalizeNetworkAttestation(v.body).toString('hex'), v.expected.preimageHex, v.name);
    }
    else assert.equal(codeOf(() => canonicalizeNetworkAttestation(v.body)), `${v.expected.code}${v.expected.field ? `:${v.expected.field}` : ''}`, v.name);
  }
});

test('vectors: the pinned digest of the base body, and its preimage built by hand', () => {
  const pinned = vectors.digestVectors.find((v) => v.name === 'none-ttl-60');
  assert.deepEqual(pinned.body, BODY);
  assert.equal(pinned.expected.digest, 'sha256:6e81fd3a7a5d7bc45bf126dac1c8072fa15f8fd26a1d1421e25eed873d5b620b');
  const s = (text) => { const b = Buffer.from(text, 'utf8'); const head = Buffer.alloc(5); head[0] = 0x53; head.writeUInt32BE(b.length, 1); return Buffer.concat([head, b]); };
  const i = (n) => { const b = Buffer.alloc(9); b[0] = 0x49; b.writeBigInt64BE(BigInt(n), 1); return b; };
  const head = Buffer.alloc(5); head[0] = 0x4d; head.writeUInt32BE(10, 1);
  const fields = [['computerId', s('pc-01')], ['expiresAt', i(T0 + 60)], ['generation', i(3)], ['leaseGeneration', i(7)], ['leaseId', s('lease-1')], ['network', s('none')], ['observedAt', i(T0)], ['projectId', s('proj-alpha')], ['v', i(1)], ['vmId', s(VM)]];
  const preimage = Buffer.concat([Buffer.from('albera.network-attestation.v1', 'utf8'), Buffer.from([0]), head, ...fields.flatMap(([k, v]) => [s(k), v])]);
  assert.equal(preimage.toString('hex'), pinned.expected.preimageHex);
  assert.equal(`sha256:${createHash('sha256').update(preimage).digest('hex')}`, pinned.expected.digest);
});

test('digest: domain-separated from the action digest, and every bound field and the network value change it', () => {
  assert.equal(ATTESTATION_DOMAIN, 'albera.network-attestation.v1');
  assert.notEqual(ATTESTATION_DOMAIN, DIGEST_DOMAIN);
  assert.equal(canonicalizeNetworkAttestation(BODY).subarray(0, ATTESTATION_DOMAIN.length + 1).toString('latin1'), `${ATTESTATION_DOMAIN}\0`);
  const base = computeNetworkAttestationDigest(BODY);
  const other = { network: 'present', computerId: 'pc-02', vmId: '99999999-8888-4777-8666-555555555555', generation: 4, projectId: 'proj-beta', leaseId: 'lease-2', leaseGeneration: 8, observedAt: T0 + 1, expiresAt: T0 + 61 };
  const digests = new Set([base]);
  for (const [field, value] of Object.entries(other)) digests.add(computeNetworkAttestationDigest({ ...BODY, [field]: value }));
  assert.equal(digests.size, 1 + Object.keys(other).length, 'each change gives its own digest');
  assert.equal(computeNetworkAttestationDigest({ ...BODY }), base, 'stable across calls and key order');
  const reordered = Object.fromEntries(Object.entries(BODY).reverse());
  assert.equal(computeNetworkAttestationDigest(reordered), base);
});

test('classification vectors: no adapters = none; any adapter, connected or not = present; unreadable or malformed = unknown', () => {
  for (const v of vectors.classificationVectors) assert.equal(classifyNetworkAdapters(v.adaptersOmitted ? undefined : v.adapters), v.expected, v.name);
  assert.equal(classifyNetworkAdapters([]), 'none');
  assert.equal(classifyNetworkAdapters([A(false, null)]), 'present', 'a disconnected adapter can be reconnected');
  assert.equal(classifyNetworkAdapters([A(true, 'Private')]), 'present');
  assert.equal(classifyNetworkAdapters(null), 'unknown');
  assert.equal(classifyNetworkAdapters([{ connected: 'yes' }]), 'unknown');
  assert.deepEqual(NETWORK_VALUES, ['none', 'present', 'unknown']);
});

test('classification does not read hostile input: accessors, symbols, exotic prototypes are unknown, never a throw', () => {
  const getter = Object.defineProperty({ switchType: null }, 'connected', { enumerable: true, get() { throw new Error('boom'); } });
  assert.equal(classifyNetworkAdapters([getter]), 'unknown');
  assert.equal(classifyNetworkAdapters([Object.create({ connected: false, switchType: null })]), 'unknown');
  assert.equal(classifyNetworkAdapters([{ connected: false, switchType: null, [Symbol('x')]: 1 }]), 'unknown');
  assert.equal(classifyNetworkAdapters(new Proxy([], { get() { throw new Error('boom'); } })), 'unknown');
});

test('createNetworkAttestation: the TTL defaults to 60 s and is capped at 300 s; observedAt is whatever the Broker clock gave', () => {
  assert.equal(DEFAULT_TTL_SECONDS, 60);
  assert.equal(MAX_TTL_SECONDS, 300);
  const body = createNetworkAttestation({ ...EXPECTED, network: 'none', observedAt: T0 });
  assert.deepEqual(body, BODY);
  assert.ok(Object.isFrozen(body));
  assert.equal(createNetworkAttestation({ ...EXPECTED, network: 'none', observedAt: T0, ttlSeconds: 300 }).expiresAt, T0 + 300);
  assert.equal(codeOf(() => createNetworkAttestation({ ...EXPECTED, network: 'none', observedAt: T0, ttlSeconds: 301 })), 'ttl:expiresAt');
  assert.equal(codeOf(() => createNetworkAttestation({ ...EXPECTED, network: 'none', observedAt: T0, ttlSeconds: 0 })), 'ttl:expiresAt');
  assert.equal(codeOf(() => createNetworkAttestation({ ...EXPECTED, network: 'none', observedAt: 1.5 })), 'malformed:observedAt');
  assert.equal(codeOf(() => validateNetworkAttestation({ ...BODY, extra: true })), 'malformed:$extra');
});

// ---- contract: sign and verify ----

const signed = async (body = BODY, signer = createFakeAttestationSigner()) => ({ signer, envelope: await signNetworkAttestation(body, signer) });
const ctx = (signer, at = T0 + 10, expected = EXPECTED) => ({ clock: () => at, verify: signer.verify, expected });

test('Fake signer round-trip: sign, read, verify returns the attestation; the envelope has exactly four keys', async () => {
  const { signer, envelope } = await signed();
  assert.deepEqual(Object.keys(envelope).sort(), ['attestation', 'digest', 'keyId', 'signature']);
  assert.deepEqual(envelope.attestation, BODY);
  assert.equal(envelope.digest, computeNetworkAttestationDigest(BODY));
  assert.equal(envelope.keyId, signer.keyId);
  assert.match(envelope.signature, /^[A-Za-z0-9_-]{43}$/, 'unpadded base64url of 32 bytes');
  assert.ok(Object.isFrozen(envelope));
  const read = readSignedNetworkAttestation(JSON.parse(JSON.stringify(envelope)));
  assert.equal(read.digest, envelope.digest);
  assert.deepEqual(verifyNetworkAttestation(JSON.parse(JSON.stringify(envelope)), ctx(signer)), BODY);
});

test('Fake signer: a fresh random secret per instance, no key material in the module; a signature never verifies under another instance', async () => {
  const first = createFakeAttestationSigner();
  const second = createFakeAttestationSigner();
  const bytes = canonicalizeNetworkAttestation(BODY);
  assert.notDeepEqual(await first.sign(bytes), await second.sign(bytes));
  assert.equal(first.verify(first.keyId, bytes, await first.sign(bytes)), true);
  assert.equal(second.verify(first.keyId, bytes, await first.sign(bytes)), false);
  const source = fs.readFileSync(path.join(path.dirname(contractDir), 'fake-attestation-signer.mjs'), 'utf8');
  assert.ok(!/BEGIN (?:EC |RSA )?PRIVATE KEY/.test(source) && !/[0-9a-f]{64}/.test(source), 'no key material in the source');
});

test('verify refuses an expired attestation (at expiresAt and after), and one not valid yet', async () => {
  const { signer, envelope } = await signed();
  assert.equal(verifyNetworkAttestation(envelope, ctx(signer, T0 + 59)).network, 'none', 'last second before expiresAt');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 60))), 'expired:expiresAt');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 3600))), 'expired:expiresAt');
  assert.equal(verifyNetworkAttestation(envelope, ctx(signer, T0 - MAX_OBSERVED_SKEW_SECONDS)).network, 'none', 'observedAt exactly now + skew');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 - MAX_OBSERVED_SKEW_SECONDS - 1))), 'not_yet_valid:observedAt');
});

test('verify refuses each mismatched binding: computerId, vmId, generation, projectId, leaseId, leaseGeneration', async () => {
  const { signer, envelope } = await signed();
  const wrong = { computerId: 'pc-02', vmId: '99999999-8888-4777-8666-555555555555', generation: 4, projectId: 'proj-beta', leaseId: 'lease-2', leaseGeneration: 8 };
  for (const [field, value] of Object.entries(wrong)) {
    assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, [field]: value }))), `binding:${field}`, field);
  }
});

test('verify refuses a bad expected, a bad context, a missing verifier and a verifier that does not return exactly true', async () => {
  const { signer, envelope } = await signed();
  const { vmId: _omit, ...partial } = EXPECTED;
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 10, partial))), 'invalid_expected:$extra');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, leaseGeneration: 0 }))), 'invalid_expected:leaseGeneration');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, extra: 1 }))), 'invalid_expected:$extra');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, { clock: () => T0, expected: EXPECTED })), 'invalid_context');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, { verify: signer.verify, expected: EXPECTED })), 'invalid_context');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, { ...ctx(signer), clock: () => 1.5 })), 'invalid_context:clock');
  for (const verify of [() => 1, () => 'true', () => undefined, () => { throw new Error('boom'); }]) {
    assert.equal(codeOf(() => verifyNetworkAttestation(envelope, { ...ctx(signer), verify })), 'signature:signature');
  }
});

test('verify refuses tampering: body, digest, signature, key id, another key, extra or missing envelope keys', async () => {
  const { signer, envelope } = await signed();
  const plain = JSON.parse(JSON.stringify(envelope));
  const run = (patch) => codeOf(() => verifyNetworkAttestation({ ...plain, ...patch }, ctx(signer)));
  assert.equal(run({ attestation: { ...plain.attestation, network: 'present' } }), 'digest:digest', 'a changed body no longer matches the digest');
  assert.equal(run({ attestation: { ...plain.attestation, network: 'present' }, digest: computeNetworkAttestationDigest({ ...BODY, network: 'present' }) }), 'signature:signature', 'a recomputed digest still lacks a signature');
  assert.equal(run({ digest: `sha256:${'0'.repeat(64)}` }), 'digest:digest');
  assert.equal(run({ signature: Buffer.alloc(32).toString('base64url') }), 'signature:signature');
  assert.equal(run({ keyId: 'albera-test-other' }), 'signature:signature');
  assert.equal(run({ extra: 1 }), 'malformed:$extra');
  assert.equal(run({ signature: `${plain.signature}=` }), 'malformed:signature');
  assert.equal(run({ signature: '' }), 'malformed:signature');
  assert.equal(run({ digest: plain.digest.toUpperCase() }), 'malformed:digest');
  const { signature: _drop, ...noSignature } = plain;
  assert.equal(codeOf(() => verifyNetworkAttestation(noSignature, ctx(signer))), 'malformed:$extra');
  const otherSigner = createFakeAttestationSigner({ keyId: signer.keyId });
  assert.equal(codeOf(() => verifyNetworkAttestation(plain, ctx(otherSigner))), 'signature:signature', 'same key id, another key');
  for (const hostile of [null, 'x', [], 7, Object.create(plain)]) assert.equal(codeOf(() => verifyNetworkAttestation(hostile, ctx(signer))), 'malformed');
});

test('the signer port is checked: a failing, throwing or ill-shaped signer produces no attestation', async () => {
  const good = createFakeAttestationSigner();
  const bad = [
    { keyId: good.keyId, sign: async () => { throw new Error('hsm down'); } },
    { keyId: good.keyId, sign: async () => 'not bytes' },
    { keyId: good.keyId, sign: async () => new Uint8Array(0) },
    { keyId: good.keyId, sign: async () => new Uint8Array(129) },
    { keyId: good.keyId, sign: async () => undefined },
  ];
  for (const signer of bad) await assert.rejects(signNetworkAttestation(BODY, signer), (e) => e instanceof NetworkAttestationError && e.code === 'signer_failed');
  for (const signer of [null, {}, { keyId: good.keyId }, { sign: good.sign }, { keyId: 'bad id', sign: good.sign }]) {
    await assert.rejects(signNetworkAttestation(BODY, signer), (e) => e instanceof NetworkAttestationError && e.code === 'signer_invalid');
  }
  await assert.rejects(signNetworkAttestation({ ...BODY, network: 'maybe' }, good), (e) => e.code === 'malformed' && e.field === 'network');
});

test('arch: the contract file stays pure (no clock, env, network or file access)', () => {
  const forbidden = [/\bDate\b/, /\bprocess\./, /\bfetch\(/, /node:(?!crypto)/, /\brequire\(/, /\bperformance\./, /\bsetTimeout\b/, /\bMath\.random\b/];
  const source = fs.readFileSync(path.join(contractDir, 'network-attestation.mjs'), 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const re of forbidden) assert.ok(!re.test(source), `network-attestation.mjs matches ${re}`);
});

// ---- Mock provider (the Broker side in tests) ----

const spec = {
  projectId: 'proj-alpha', kind: 'ephemeral', os: 'linux', architecture: 'x64', imageDigest: `sha256:${'b'.repeat(64)}`,
  capabilities: ['terminal'], networkProfileId: 'isolated-none', securityProfileId: 'guest-restricted-v1', resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
};
const op = (action, overrides = {}) => ({
  operationId: `op-${action}`, idempotencyKey: `key-${action}`, subjectId: 'subject-1', projectId: 'proj-alpha', taskId: 'task-1', runId: 'run-1',
  computerId: 'pc-01', providerId: 'mock', leaseId: 'lease-1', expectedGeneration: 1, policyVersion: 1, action, ...(action === 'create' ? { spec } : {}), ...overrides,
});
const rejectsWith = (promise, code, outcome = 'not_applied') => assert.rejects(promise, (error) => error.code === code && error.outcome === outcome);

async function mockWorld({ ttl } = {}) {
  const clock = { s: T0 };
  const signer = createFakeAttestationSigner();
  const provider = new MockEnvironmentProvider({ now: () => iso(clock.s), attestationSigner: signer, ...(ttl ? { attestationTtlSeconds: ttl } : {}) });
  await provider.create(op('create'));
  return { provider, signer, clock };
}
const expectedFor = (vmId, overrides = {}) => ({ computerId: 'pc-01', vmId, generation: 1, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 5, ...overrides });

test('mock: start with a vmId starts only that VM; a VM that took its computer id, project, lease and generation (another vmId) is refused, not applied', async () => {
  const { provider } = await mockWorld();
  const { attestation } = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  await rejectsWith(provider.start(op('start', { vmId: '99999999-8888-4777-8666-555555555555' })), 'operation_conflict');
  assert.equal((await provider.inspect(op('inspect'))).state, 'off', 'nothing was started');
  assert.equal((await provider.start(op('start', { vmId: attestation.vmId }))).state, 'running');
  provider.setNetworkAdapters('pc-01', []);
  assert.equal((await provider.stop(op('stop'))).state, 'off');
  assert.equal((await provider.start(op('start'))).state, 'running', 'a start that names no VM is as before');
});

test('mock: a freshly created environment is "none" (create removes the default adapter); once an adapter is attached it is "present"', async () => {
  const { provider, signer } = await mockWorld();
  const first = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  assert.equal(first.attestation.network, 'none');
  provider.setNetworkAdapters('pc-01', [A(false, null)]);
  assert.equal((await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 })).attestation.network, 'present');
  provider.setNetworkAdapters('pc-01', []);
  const second = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  assert.equal(second.attestation.network, 'none');
  assert.equal(verifyNetworkAttestation(second, ctx(signer, T0 + 1, expectedFor(second.attestation.vmId))).network, 'none');
  assert.match(second.attestation.vmId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
});

test('mock: none / present (connected) / present (disconnected) / unknown (unreadable, malformed) from the configured adapters', async () => {
  const { provider } = await mockWorld();
  const cases = [
    [[], 'none'], [[A(true, 'Private')], 'present'], [[A(true, 'External')], 'present'], [[A(false, null)], 'present'], [[A(false, null), A(true, 'Internal')], 'present'],
    [null, 'unknown'], ['', 'unknown'], [[{}], 'unknown'], [[A(true, null)], 'unknown'], [{ connected: false, switchType: null }, 'unknown'],
  ];
  for (const [adapters, network] of cases) {
    provider.setNetworkAdapters('pc-01', adapters);
    assert.equal((await provider.attestNetwork(op('inspect'), { leaseGeneration: 1 })).attestation.network, network, JSON.stringify(adapters));
  }
});

test('mock: the statement is bound to computerId, the VM id, generation, projectId and leaseGeneration, with times from the Broker clock', async () => {
  const { provider, clock } = await mockWorld();
  provider.setNetworkAdapters('pc-01', []);
  const result = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  const { vmId, ...rest } = result.attestation;
  assert.deepEqual(rest, { v: 1, network: 'none', computerId: 'pc-01', generation: 1, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 5, observedAt: T0, expiresAt: T0 + 60 });
  clock.s = T0 + 1000;
  const later = await provider.attestNetwork(op('inspect'), { leaseGeneration: 6 });
  assert.equal(later.attestation.vmId, vmId, 'same VM, same id');
  assert.deepEqual([later.attestation.observedAt, later.attestation.expiresAt, later.attestation.leaseGeneration], [T0 + 1000, T0 + 1060, 6]);
  assert.notEqual(later.digest, result.digest);
});

test('mock: the VM id follows the VM, not the name: a restored or re-created environment under the same id gets another vmId', async () => {
  const { provider, signer } = await mockWorld();
  const before = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  provider.restoreComputer('pc-01', { projectId: 'proj-alpha', generation: 1 });
  const after = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  assert.notEqual(before.attestation.vmId, after.attestation.vmId);
  assert.equal(codeOf(() => verifyNetworkAttestation(before, ctx(signer, T0 + 1, expectedFor(after.attestation.vmId)))), 'binding:vmId', 'an old attestation does not carry over');
});

test('mock: nothing a Control Plane sends changes the result; operation fields only name the environment', async () => {
  const { provider } = await mockWorld();
  provider.setNetworkAdapters('pc-01', [A(true, 'External')]);
  const reference = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  assert.equal(reference.attestation.network, 'present');
  const variants = [
    op('inspect', { operationId: 'op-other', idempotencyKey: 'other', subjectId: 'other', taskId: 'other', runId: 'other', policyVersion: 99 }),
    op('inspect', { action: 'inspect' }),
  ];
  for (const variant of variants) {
    const again = await provider.attestNetwork(variant, { leaseGeneration: 5 });
    assert.deepEqual(again.attestation, reference.attestation);
    assert.equal(again.digest, reference.digest);
  }
  // Claims about the network are not fields of an operation, and the options carry only the lease generation.
  for (const claim of [{ network: 'none' }, { adapters: [] }, { networkProfileId: 'isolated-none' }, { attestation: { network: 'none' } }, { spec }, { observedAt: 1 }]) {
    await assert.rejects(provider.attestNetwork(op('inspect', claim), { leaseGeneration: 5 }), (error) => error instanceof TypeError || /invalid|unexpected/.test(error.message));
  }
  const smuggled = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5, network: 'none', adapters: [], observedAt: 1, ttlSeconds: 1, expiresAt: 2 });
  assert.deepEqual(smuggled.attestation, reference.attestation, 'extra option fields are ignored, not read');
  // A create operation that says "isolated-none" does not make the environment "none" either.
  provider.setNetworkAdapters('pc-01', [A(false, null)]);
  assert.equal((await provider.attestNetwork(op('inspect', { operationId: 'op-create' }), { leaseGeneration: 5 })).attestation.network, 'present');
});

test('mock: refusals do not sign (not applied): no signer, bad lease generation, missing environment, wrong project, stale generation, non-inspect operation', async () => {
  const { provider } = await mockWorld();
  for (const leaseGeneration of [undefined, 0, -1, 1.5, '5', null]) await rejectsWith(provider.attestNetwork(op('inspect'), { leaseGeneration }), 'invalid_provider_state');
  await rejectsWith(provider.attestNetwork(op('inspect', { computerId: 'pc-99' }), { leaseGeneration: 5 }), 'computer_missing');
  await rejectsWith(provider.attestNetwork(op('inspect', { projectId: 'proj-other' }), { leaseGeneration: 5 }), 'project_mismatch');
  await rejectsWith(provider.attestNetwork(op('inspect', { expectedGeneration: 2 }), { leaseGeneration: 5 }), 'stale_generation');
  await rejectsWith(provider.attestNetwork(op('inspect'), undefined), 'invalid_provider_state');
  const unsigned = new MockEnvironmentProvider();
  await unsigned.create(op('create'));
  await rejectsWith(unsigned.attestNetwork(op('inspect'), { leaseGeneration: 5 }), 'invalid_provider_state');
  assert.throws(() => new MockEnvironmentProvider({ attestationSigner: {} }), TypeError);
  assert.throws(() => new MockEnvironmentProvider({ attestationTtlSeconds: 301 }), TypeError);
  assert.throws(() => new MockEnvironmentProvider({ attestationTtlSeconds: 0 }), TypeError);
});

test('mock: a signer that fails gives no attestation and a not-applied error; the configured TTL is used', async () => {
  const failing = new MockEnvironmentProvider({ now: () => iso(T0), attestationSigner: { keyId: 'albera-test-x', sign: async () => { throw new Error('down'); } } });
  await failing.create(op('create'));
  await rejectsWith(failing.attestNetwork(op('inspect'), { leaseGeneration: 5 }), 'provider_unavailable');
  const { provider } = await mockWorld({ ttl: 30 });
  const result = await provider.attestNetwork(op('inspect'), { leaseGeneration: 5 });
  assert.equal(result.attestation.expiresAt - result.attestation.observedAt, 30);
});

test('the base provider has the stub, and does not make attestNetwork an environment action', async () => {
  await rejectsWith(new EnvironmentProvider('stub').attestNetwork(op('inspect', { providerId: 'stub' }), { leaseGeneration: 1 }), 'provider_not_implemented');
  const { ENVIRONMENT_ACTIONS } = await import('../src/runtime/environment-provider.mjs');
  assert.ok(!ENVIRONMENT_ACTIONS.includes('attestNetwork'));
});

// ---- Hyper-V Broker prototype with a stand-in for env-io.ps1 ----

const DIGEST = `sha256:${'a'.repeat(64)}`;
const notesFor = (extra = {}) => JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST, projectId: 'proj-alpha', ...extra });
const hvOp = (action = 'inspect', overrides = {}) => op(action, { providerId: 'hyperv', ...overrides });

/** Stand-in for env-io.ps1 'network': one VM, returned the way the script emits it. */
function networkScript(vm) {
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    if (request.method !== 'network') return { ok: false, code: 'invalid_provider_state', notApplied: true };
    return vm ? { ok: true, exists: true, state: 'Off', notes: notesFor(), vmId: VM.toUpperCase(), adapters: [], ...vm } : { ok: true, exists: false };
  };
  return { run, calls };
}
const tmpRoot = path.join(os.tmpdir(), 'albera-attest-never-created');
function hvBroker(vm, options = {}) {
  const script = networkScript(vm);
  const signer = createFakeAttestationSigner();
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [DIGEST]: { path: path.join(os.tmpdir(), 'albera-attest-golden', 'base.vhdx'), os: 'windows', architecture: 'x64' } },
    cloneRoot: tmpRoot, runPowerShell: script.run, now: () => new Date(T0 * 1000), attestationSigner: signer, ...options,
  });
  return { broker, script, signer };
}

test('hyper-v broker: adapters become none / present / unknown through the same classifier; the VM id is lowercased from the VM itself', async () => {
  const cases = [
    [{ adapters: [] }, 'none'], [{ adapters: [A(false, null)] }, 'present'], [{ adapters: [A(true, 'Private')] }, 'present'],
    [{ adapters: null }, 'unknown'], [{ adapters: undefined }, 'unknown'], [{ adapters: 'none' }, 'unknown'], [{ adapters: [{ connected: true }] }, 'unknown'], [{ adapters: {} }, 'unknown'],
  ];
  for (const [vm, network] of cases) {
    const { broker, signer } = hvBroker(vm);
    const result = await broker.attestNetwork(hvOp(), { leaseGeneration: 4 });
    assert.equal(result.attestation.network, network, JSON.stringify(vm));
    assert.equal(result.attestation.vmId, VM, 'lowercased');
    assert.deepEqual([result.attestation.observedAt, result.attestation.expiresAt], [T0, T0 + 60]);
    assert.equal(verifyNetworkAttestation(result, ctx(signer, T0 + 5, { ...EXPECTED, generation: 1, leaseGeneration: 4 })).network, network);
  }
});

test('hyper-v broker: only a fixed request reaches the script (method and VM name); operation fields never do', async () => {
  const { broker, script } = hvBroker({ adapters: [] });
  await broker.attestNetwork(hvOp('inspect', { operationId: 'op-zzz', taskId: 'task-zzz', leaseId: 'lease-zzz', policyVersion: 9 }), { leaseGeneration: 4 });
  assert.deepEqual(script.calls, [{ method: 'network', vmName: 'albera-pc-01' }]);
});

test('hyper-v broker: refused, not applied, when there is nothing trustworthy to attest', async () => {
  for (const [label, vm, overrides, code] of [
    ['no VM', null, {}, 'invalid_provider_state'],
    ['VM id not reported', { vmId: undefined }, {}, 'invalid_provider_state'],
    ['VM id malformed', { vmId: 'vm-1' }, {}, 'invalid_provider_state'],
    ['Notes unreadable', { notes: 'not json' }, {}, 'invalid_provider_state'],
    ['another computer in the Notes', { notes: JSON.stringify({ albera: 1, computerId: 'pc-02', generation: 1, imageDigest: DIGEST }) }, {}, 'invalid_provider_state'],
    ['stale generation', {}, { expectedGeneration: 2 }, 'stale_generation'],
    ['Notes carry another project', { notes: notesFor({ projectId: 'proj-other', incarnationId: 'a'.repeat(32) }) }, {}, 'project_mismatch'],
    ['project B asks about project A\'s VM', {}, { projectId: 'proj-beta' }, 'project_mismatch'],
    ['Notes carry no projectId (a VM made before this change)', { notes: JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST }) }, {}, 'project_unknown'],
    ['Notes carry an incarnation but no project', { notes: JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST, incarnationId: 'a'.repeat(32) }) }, {}, 'invalid_provider_state'],
    ['a non-inspect operation', {}, { action: 'start' }, 'invalid_provider_state'],
    ['another provider', {}, { providerId: 'mock' }, 'invalid_provider_state'],
  ]) {
    const { broker } = hvBroker(vm);
    await assert.rejects(broker.attestNetwork(hvOp('inspect', overrides), { leaseGeneration: 4 }), (error) => error.code === code && error.outcome === 'not_applied', label);
  }
  const { broker } = hvBroker({});
  for (const leaseGeneration of [undefined, 0, 1.5, '4']) await rejectsWith(broker.attestNetwork(hvOp(), { leaseGeneration }), 'invalid_provider_state');
  const retiredOk = hvBroker({ notes: notesFor({ projectId: 'proj-alpha', incarnationId: 'a'.repeat(32) }) });
  assert.equal((await retiredOk.broker.attestNetwork(hvOp(), { leaseGeneration: 4 })).attestation.projectId, 'proj-alpha', 'a retired VM of the same project can be attested');
});

test('hyper-v broker: the script failing is an error, never an attestation; no signer or a failing signer refuses', async () => {
  const failing = createHyperVEnvironmentBrokerPrototype({
    goldenImages: {}, cloneRoot: tmpRoot, attestationSigner: createFakeAttestationSigner(),
    runPowerShell: async () => ({ ok: false, code: 'provider_unavailable' }),
  });
  await assert.rejects(failing.attestNetwork(hvOp(), { leaseGeneration: 4 }), (error) => error.code === 'provider_unavailable');
  const unsigned = hvBroker({ adapters: [] }, { attestationSigner: undefined });
  await rejectsWith(unsigned.broker.attestNetwork(hvOp(), { leaseGeneration: 4 }), 'invalid_provider_state');
  const brokenSigner = hvBroker({ adapters: [] }, { attestationSigner: { keyId: 'albera-test-x', sign: async () => { throw new Error('down'); } } });
  await rejectsWith(brokenSigner.broker.attestNetwork(hvOp(), { leaseGeneration: 4 }), 'provider_unavailable');
  for (const bad of [null, {}, { keyId: 'x' }, { sign() {} }]) assert.throws(() => hvBroker({}, { attestationSigner: bad }), TypeError);
  for (const ttl of [0, 301, 1.5, '60']) assert.throws(() => hvBroker({}, { attestationTtlSeconds: ttl }), TypeError);
  assert.equal((await hvBroker({ adapters: [] }, { attestationTtlSeconds: 300 }).broker.attestNetwork(hvOp(), { leaseGeneration: 4 })).attestation.expiresAt, T0 + 300);
});

// ---- provider and host-broker seams ----

test('HyperVEnvironmentProvider.attestNetwork: read-only seam that returns the signed attestation, bound to the operation', async () => {
  const { broker, signer } = hvBroker({ adapters: [] });
  const provider = new HyperVEnvironmentProvider({ broker });
  const result = await provider.attestNetwork(hvOp(), { leaseGeneration: 4 });
  assert.deepEqual(Object.keys(result).sort(), ['attestation', 'digest', 'keyId', 'signature']);
  assert.ok(Object.isFrozen(result));
  assert.equal(verifyNetworkAttestation(result, ctx(signer, T0 + 1, { ...EXPECTED, generation: 1, leaseGeneration: 4 })).network, 'none');
  await rejectsWith(provider.attestNetwork(hvOp('start'), { leaseGeneration: 4 }), 'provider_operation_mismatch');
  await rejectsWith(provider.attestNetwork(hvOp('inspect', { providerId: 'mock' }), { leaseGeneration: 4 }), 'provider_operation_mismatch');
  await rejectsWith(provider.attestNetwork({ ...hvOp(), extra: 1 }, { leaseGeneration: 4 }), 'invalid_environment_operation');
  await rejectsWith(provider.attestNetwork(hvOp(), { leaseGeneration: 0 }), 'invalid_environment_operation');
  await rejectsWith(provider.attestNetwork(hvOp(), undefined), 'invalid_environment_operation');
});

test('HyperVEnvironmentProvider.attestNetwork: an older Broker client without the method leaves it unimplemented; broker errors keep only an allowlisted code', async () => {
  const noMethod = { createVm() {}, inspectVm() {}, startVm() {}, stopVm() {}, removeVm() {} };
  await rejectsWith(new HyperVEnvironmentProvider({ broker: noMethod }).attestNetwork(hvOp(), { leaseGeneration: 4 }), 'provider_not_implemented');
  const throwing = { ...noMethod, attestNetwork: async () => { throw Object.assign(new Error('C:\\secret\\path'), { code: 'stale_generation', outcome: 'unknown' }); } };
  await rejectsWith(new HyperVEnvironmentProvider({ broker: throwing }).attestNetwork(hvOp(), { leaseGeneration: 4 }), 'stale_generation');
  const odd = { ...noMethod, attestNetwork: async () => { throw Object.assign(new Error('x'), { code: 'C:\\secret' }); } };
  await rejectsWith(new HyperVEnvironmentProvider({ broker: odd }).attestNetwork(hvOp(), { leaseGeneration: 4 }), 'provider_outcome_unknown');
});

test('HyperVEnvironmentProvider.attestNetwork: an answer that is malformed or bound to another environment is refused as untrusted boundary data', async () => {
  const { broker } = hvBroker({ adapters: [] });
  const good = await broker.attestNetwork(hvOp(), { leaseGeneration: 4 });
  const noMethod = { createVm() {}, inspectVm() {}, startVm() {}, stopVm() {}, removeVm() {} };
  const answering = (answer) => new HyperVEnvironmentProvider({ broker: { ...noMethod, attestNetwork: async () => answer } });
  const other = async (patch) => {
    const body = { ...good.attestation, ...patch };
    return { ...good, attestation: body, digest: computeNetworkAttestationDigest(body) };
  };
  const answers = [
    null, 'x', [], { ...good, extra: 1 }, { ...good, digest: `sha256:${'0'.repeat(64)}` }, { ...good, signature: '' },
    await other({ computerId: 'pc-02' }), await other({ projectId: 'proj-other' }), await other({ generation: 2 }), await other({ leaseGeneration: 5 }), await other({ leaseId: 'lease-9' }), { ...good, attestation: { ...good.attestation, network: 'maybe' } },
  ];
  for (const answer of answers) await rejectsWith(answering(answer).attestNetwork(hvOp(), { leaseGeneration: 4 }), 'invalid_provider_observation');
  assert.deepEqual((await answering(good).attestNetwork(hvOp(), { leaseGeneration: 4 })).attestation, good.attestation);
});

test('LocalEnvironmentHostBroker.attestNetwork: read-only, no journal claim; only an inspect operation of this provider reaches the provider', async () => {
  const store = { resolveBrokerDispatch() { throw new Error('must not be called'); }, resolveBrokerInspection() { throw new Error('must not be called'); } };
  const { provider, signer } = await mockWorld();
  provider.setNetworkAdapters('pc-01', []);
  const hostBroker = new LocalEnvironmentHostBroker({ store, provider });
  const result = await hostBroker.attestNetwork({ operation: op('inspect'), leaseGeneration: 5 });
  assert.equal(verifyNetworkAttestation(result, ctx(signer, T0 + 1, expectedFor(result.attestation.vmId))).network, 'none');
  await rejectsWith(Promise.resolve().then(() => hostBroker.attestNetwork({ operation: op('start'), leaseGeneration: 5 })), 'provider_operation_mismatch');
  await rejectsWith(Promise.resolve().then(() => hostBroker.attestNetwork({ operation: op('inspect', { providerId: 'hyperv' }), leaseGeneration: 5 })), 'provider_operation_mismatch');
  await rejectsWith(Promise.resolve().then(() => hostBroker.attestNetwork({ operation: { nope: 1 }, leaseGeneration: 5 })), 'invalid_environment_operation');
  await rejectsWith(Promise.resolve().then(() => hostBroker.attestNetwork()), 'invalid_environment_operation');
  await rejectsWith(hostBroker.attestNetwork({ operation: op('inspect'), leaseGeneration: 0 }), 'invalid_provider_state');
});

// ---- the script ----

test('env-io.ps1: a fixed read-only "network" method, ASCII only, with no cmdlet that changes anything and no string-built command', () => {
  assert.ok(/^[\x00-\x7f]*$/.test(scriptText), 'ASCII only (PowerShell 5.1 safe)');
  assert.match(scriptText, /'network' \{ Invoke-Network \$req \}/);
  const start = scriptText.indexOf('function Invoke-Network');
  const body = scriptText.slice(start, scriptText.indexOf('\nfunction Invoke-Create'));
  assert.ok(body.length > 100);
  assert.ok(!/\b(?:Set|Remove|Add|Connect|Disconnect|New|Start|Stop|Restart|Suspend|Resume|Move|Rename|Enable|Disable)-[A-Za-z]+/.test(body), 'only Get-* cmdlets');
  assert.ok(!/Invoke-Expression|\biex\b|Start-Process|&\s*\$|\[scriptblock\]/i.test(body), 'no dynamic command');
  assert.match(body, /Get-VMNetworkAdapter -VM \$vm/);
  assert.match(body, /catch \{ \$adapters = \$null \}/, 'an unreadable adapter list is null, never an empty list');
  assert.match(body, /switchType = \$type/);
});

test('env-io.ps1 create: removes every default network adapter, re-reads and fails the create if one remains; a disconnected adapter is no longer left behind', () => {
  const body = scriptText.slice(scriptText.indexOf('function Invoke-Create'), scriptText.indexOf('\nfunction Invoke-Start'));
  assert.match(body, /Get-VMNetworkAdapter -VM \$vm \| Remove-VMNetworkAdapter/);
  assert.match(body, /if \(@\(Get-VMNetworkAdapter -VM \(Get-VM -Name \$Req\.vmName\)\)\.Count -ne 0\) \{ throw /, 'the adapters are re-read and a remaining one throws');
  assert.ok(body.indexOf('Remove-VMNetworkAdapter') < body.indexOf('Set-VMProcessor'), 'removed before the rest of the setup');
  assert.ok(!/Disconnect-VMNetworkAdapter/.test(scriptText), 'no adapter is merely disconnected');
  const afterThrow = body.slice(body.indexOf('throw '));
  assert.ok(afterThrow.indexOf('catch') > 0 && /Remove-VM -VM \$left/.test(afterThrow), 'the throw lands in the catch that rolls the half-made VM back');
  assert.ok(!/Invoke-Expression|\biex\b|Start-Process|&\s*\$|\[scriptblock\]/i.test(body), 'no dynamic command');
});

// ---- review fixes: project from the Broker's own record, leaseId binding, clock after the signature check ----

test('verify reads the clock AFTER the signature check: a slow verifier cannot let an attestation that expired meanwhile pass', async () => {
  const { signer, envelope } = await signed();
  const clock = { s: T0 + 10 };
  const slow = (keyId, bytes, signature) => { const ok = signer.verify(keyId, bytes, signature); clock.s = T0 + 60; return ok; }; // verification "takes" until expiresAt
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, { clock: () => clock.s, verify: slow, expected: EXPECTED })), 'expired:expiresAt');
  clock.s = T0 + 10;
  const reads = [];
  const counting = { clock: () => { reads.push('clock'); return T0 + 10; }, verify: (...args) => { reads.push('verify'); return signer.verify(...args); }, expected: EXPECTED };
  verifyNetworkAttestation(envelope, counting);
  assert.deepEqual(reads, ['verify', 'clock'], 'the clock is read once, after verify');
  const early = { s: T0 + 10 };
  const fast = (keyId, bytes, signature) => { early.s = T0 - MAX_OBSERVED_SKEW_SECONDS - 1; return signer.verify(keyId, bytes, signature); };
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, { clock: () => early.s, verify: fast, expected: EXPECTED })), 'not_yet_valid:observedAt', 'the same later reading is used for not-yet-valid');
});

test('leaseId is bound: an attestation made under lease A is refused for lease B even at the same generation numbers', async () => {
  const { signer, envelope } = await signed();
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, leaseId: 'lease-2' }))), 'binding:leaseId');
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, leaseId: 'bad id' }))), 'invalid_expected:leaseId');
  const { leaseId: _omit, ...partial } = EXPECTED;
  assert.equal(codeOf(() => verifyNetworkAttestation(envelope, ctx(signer, T0 + 10, partial))), 'invalid_expected:$extra');
  const { provider, signer: mockSigner } = await mockWorld();
  const underA = await provider.attestNetwork(op('inspect', { leaseId: 'lease-A' }), { leaseGeneration: 5 });
  const underB = await provider.attestNetwork(op('inspect', { leaseId: 'lease-B' }), { leaseGeneration: 5 });
  assert.equal(underA.attestation.leaseId, 'lease-A');
  assert.notEqual(underA.digest, underB.digest);
  assert.equal(codeOf(() => verifyNetworkAttestation(underA, ctx(mockSigner, T0 + 1, expectedFor(underA.attestation.vmId, { leaseId: 'lease-B' })))), 'binding:leaseId');
});

// An end-to-end stand-in: create writes the Notes, 'network' reads them back, like the real script.
async function createdWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-attest-'));
  const golden = path.join(dir, 'base.vhdx');
  fs.writeFileSync(golden, 'not a real disk');
  fs.chmodSync(golden, 0o444);
  const vms = new Map();
  const run = async (request) => {
    const vm = vms.get(request.vmName);
    if (request.method === 'create') { vms.set(request.vmName, { notes: request.notes }); return { ok: true, state: 'Off' }; }
    if (request.method === 'inspect') return vm ? { ok: true, exists: true, state: 'Off', notes: vm.notes, vmId: VM } : { ok: true, exists: false };
    if (request.method === 'network') return vm ? { ok: true, exists: true, state: 'Off', notes: vm.notes, vmId: VM, adapters: [] } : { ok: true, exists: false };
    return { ok: false, code: 'invalid_provider_state', notApplied: true };
  };
  const signer = createFakeAttestationSigner();
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [DIGEST]: { path: golden, os: 'windows', architecture: 'x64' } }, cloneRoot: path.join(dir, 'clones'), runPowerShell: run,
    hashFile: async () => 'a'.repeat(64), now: () => new Date(T0 * 1000), attestationSigner: signer,
  });
  const cleanup = () => { fs.chmodSync(golden, 0o666); fs.rmSync(dir, { recursive: true, force: true }); };
  return { broker, vms, signer, cleanup };
}
const hvCreate = (overrides = {}) => hvOp('create', { spec: { ...spec, imageDigest: DIGEST, os: 'windows', capabilities: ['desktop'] }, ...overrides });

test('hyper-v broker: create records the authorized project in the Notes (additively); the attestation takes the project from there, so project B cannot get one for project A\'s VM', async () => {
  const { broker, vms, signer, cleanup } = await createdWorld();
  try {
    await broker.createVm(hvCreate());
    const notes = JSON.parse(vms.get('albera-pc-01').notes);
    assert.deepEqual(notes, { albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST, projectId: 'proj-alpha' });
    const ok = await broker.attestNetwork(hvOp(), { leaseGeneration: 4 });
    assert.equal(ok.attestation.projectId, 'proj-alpha');
    assert.equal(verifyNetworkAttestation(ok, ctx(signer, T0 + 1, { ...EXPECTED, generation: 1, leaseGeneration: 4 })).network, 'none');
    await assert.rejects(broker.attestNetwork(hvOp('inspect', { projectId: 'proj-beta' }), { leaseGeneration: 4 }), (e) => e.code === 'project_mismatch' && e.outcome === 'not_applied');
    // a second create under another project does not take the VM over, and an identical one is still idempotent
    await assert.rejects(broker.createVm(hvCreate({ projectId: 'proj-beta', spec: { ...hvCreate().spec, projectId: 'proj-beta' } })), (e) => e.code === 'operation_conflict');
    assert.equal((await broker.createVm(hvCreate())).state, 'off');
  }
  finally { cleanup(); }
});

test('hyper-v broker: retire refuses another project when the Notes carry one (the Notes\' project is the VM\'s own)', async () => {
  const retirements = { retire() { throw new Error('must not be reached'); }, get: () => null, remove() {}, expired: () => [] };
  const script = networkScript({ state: 'Off' });
  const ps = async (request) => (request.method === 'inspect' ? script.run({ ...request, method: 'network' }) : script.run(request));
  const broker = createHyperVEnvironmentBrokerPrototype({ goldenImages: {}, cloneRoot: tmpRoot, runPowerShell: ps, retirements });
  await assert.rejects(broker.retireVm(hvOp('retire', { projectId: 'proj-beta' })), (e) => e.code === 'operation_conflict' && e.outcome === 'not_applied');
});

test('HyperVEnvironmentProvider.attestNetwork passes the new project codes through (allowlisted)', async () => {
  const noMethod = { createVm() {}, inspectVm() {}, startVm() {}, stopVm() {}, removeVm() {} };
  for (const code of ['project_unknown', 'project_mismatch']) {
    const broker = { ...noMethod, attestNetwork: async () => { throw Object.assign(new Error(code), { code, outcome: 'not_applied' }); } };
    await rejectsWith(new HyperVEnvironmentProvider({ broker }).attestNetwork(hvOp(), { leaseGeneration: 4 }), code);
  }
});
