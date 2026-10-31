// Issue #115 step 4: the task-start attestation (network none + a Production checkpoint) that lets the Authority sign task.start without a person at the standard tier.
// Here: the contract (vectors, domain separation from the network attestation), the Hyper-V Broker side (attestTaskStart over a stand-in for env-io.ps1) and a source guard on the
// `checkpoint` op of env-io.ps1. The Authority's decision has its own checks in test/approval-authority-harness (AttestationChecks.cs), run by runtime-approval-authority-unit.test.mjs.
// Nothing here runs Hyper-V; the real-host check is the lead's.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DIGEST_DOMAIN, computeActionDigest, encMap } from '../src/runtime/broker-contract/action-digest.mjs';
import {
  ATTESTATION_DOMAIN, createNetworkAttestation, readSignedNetworkAttestation, signNetworkAttestation, verifyNetworkAttestation,
} from '../src/runtime/broker-contract/network-attestation.mjs';
import {
  CHECKPOINT_TYPES, TASK_START_ATTESTATION_DOMAIN, TASK_START_ATTESTATION_VERSION, TaskStartAttestationError, canonicalizeTaskStartAttestation, computeTaskStartAttestationDigest, createTaskStartAttestation,
  provesCheckpointedNoNetwork, readSignedTaskStartAttestation, signTaskStartAttestation, validateTaskStartAttestation, verifyTaskStartAttestation,
} from '../src/runtime/broker-contract/task-start-attestation.mjs';
import { createEcdsaAttestationSigner, createEcdsaAttestationVerifier } from '../src/runtime/ecdsa-attestation-signer.mjs';
import { createFakeAttestationSigner } from '../src/runtime/fake-attestation-signer.mjs';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { createRetirementJournal } from '../src/runtime/environment-retirement-journal.mjs';

const contractDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'runtime', 'broker-contract');
const vectors = JSON.parse(fs.readFileSync(path.join(contractDir, 'task-start-attestation-vectors.json'), 'utf8'));
const scriptText = fs.readFileSync(path.join(path.dirname(contractDir), 'hyperv-env', 'env-io.ps1'), 'utf8');

const VM = '11111111-2222-4333-8444-555555555555';
const CKPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const T0 = 1793404800;
// The action digests of {action: task.start, projectId: proj-alpha, computerId: pc-01, args: {expectedGeneration: 3, task, vmId}} for two different tasks (computed, not typed in).
const dtoOf = (task) => ({ action: 'task.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { expectedGeneration: 3, task, vmId: VM } });
const ACT = computeActionDigest('guest.command', dtoOf('build the project'));
const ACT2 = computeActionDigest('guest.command', dtoOf('delete everything'));
const BODY = Object.freeze({
  v: 2, network: 'none', computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, operationId: 'op-0001', actionDigest: ACT,
  checkpointId: CKPT, checkpointType: 'production', observedAt: T0, expiresAt: T0 + 60,
});
const EXPECTED = Object.freeze({ computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, operationId: 'op-0001', actionDigest: ACT });
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const codeOf = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof TaskStartAttestationError, String(error)); return `${error.code}${error.field ? `:${error.field}` : ''}`; } return 'ok'; };
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- contract: vectors ----

test('vectors: every digest vector reproduces its digest and exact preimage, or its refusal', () => {
  assert.equal(vectors.contract, 'albera.task-start-attestation.vectors');
  assert.equal(vectors.version, 2);
  assert.ok(vectors.digestVectors.length >= 50 && vectors.verifyVectors.cases.length >= 75);
  const names = vectors.digestVectors.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, 'vector names are unique');
  for (const v of vectors.digestVectors) {
    if (v.expected.ok) {
      assert.equal(computeTaskStartAttestationDigest(v.body), v.expected.digest, v.name);
      assert.equal(canonicalizeTaskStartAttestation(v.body).toString('hex'), v.expected.preimageHex, v.name);
    }
    else assert.equal(codeOf(() => canonicalizeTaskStartAttestation(v.body)), `${v.expected.code}${v.expected.field ? `:${v.expected.field}` : ''}`, v.name);
  }
});

test('vectors: the pinned digest of the base body, and its preimage built by hand', () => {
  const pinned = vectors.digestVectors.find((v) => v.name === 'none-production-ttl-60');
  assert.deepEqual(pinned.body, BODY);
  const s = (text) => { const b = Buffer.from(text, 'utf8'); const head = Buffer.alloc(5); head[0] = 0x53; head.writeUInt32BE(b.length, 1); return Buffer.concat([head, b]); };
  const i = (n) => { const b = Buffer.alloc(9); b[0] = 0x49; b.writeBigInt64BE(BigInt(n), 1); return b; };
  const head = Buffer.alloc(5); head[0] = 0x4d; head.writeUInt32BE(14, 1);
  const fields = [
    ['actionDigest', s(ACT)], ['checkpointId', s(CKPT)], ['checkpointType', s('production')], ['computerId', s('pc-01')], ['expiresAt', i(T0 + 60)], ['generation', i(3)], ['leaseGeneration', i(7)], ['leaseId', s('lease-1')],
    ['network', s('none')], ['observedAt', i(T0)], ['operationId', s('op-0001')], ['projectId', s('proj-alpha')], ['v', i(2)], ['vmId', s(VM)],
  ];
  const preimage = Buffer.concat([Buffer.from('albera.task-start-attestation.v2', 'utf8'), Buffer.from([0]), head, ...fields.flatMap(([k, v]) => [s(k), v])]);
  assert.equal(preimage.toString('hex'), pinned.expected.preimageHex);
  assert.equal(`sha256:${createHash('sha256').update(preimage).digest('hex')}`, pinned.expected.digest);
});

test('vectors: every signed case gives its verdict through the production ECDSA verifier (the ephemeral key in the file); the C# twin runs the same file', () => {
  const { keyId, publicKeySpki, cases } = vectors.verifyVectors;
  const verifier = createEcdsaAttestationVerifier({ keyId, publicKey: publicKeySpki });
  const names = cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const c of cases) {
    let result = { ok: true };
    try { verifyTaskStartAttestation(c.signed, { clock: () => c.now, verify: verifier.verify, expected: c.expected }); }
    catch (error) { assert.ok(error instanceof TaskStartAttestationError, c.name); result = { ok: false, code: error.code, ...(error.field ? { field: error.field } : {}) }; }
    assert.deepEqual(result, c.result, c.name);
  }
  assert.ok(!/PRIVATE KEY/.test(JSON.stringify(vectors)), 'no private key in the file');
});

// ---- contract: domain separation, the body, sign and verify ----

test('domain: its own string, distinct from the network attestation and the action digest, and every field (also operationId, actionDigest, checkpointId, checkpointType) changes the digest', () => {
  assert.equal(TASK_START_ATTESTATION_DOMAIN, 'albera.task-start-attestation.v2', 'the body gained actionDigest (#133), so the domain and the version moved together');
  assert.equal(BODY.v, TASK_START_ATTESTATION_VERSION);
  assert.notEqual(TASK_START_ATTESTATION_DOMAIN, ATTESTATION_DOMAIN);
  assert.notEqual(TASK_START_ATTESTATION_DOMAIN, DIGEST_DOMAIN);
  assert.equal(canonicalizeTaskStartAttestation(BODY).subarray(0, TASK_START_ATTESTATION_DOMAIN.length + 1).toString('latin1'), `${TASK_START_ATTESTATION_DOMAIN}\0`);
  const base = computeTaskStartAttestationDigest(BODY);
  const other = {
    network: 'present', computerId: 'pc-02', vmId: '99999999-8888-4777-8666-555555555555', generation: 4, projectId: 'proj-beta', leaseId: 'lease-2', leaseGeneration: 8, operationId: 'op-0002', actionDigest: ACT2,
    checkpointId: '99999999-8888-4777-8666-555555555555', checkpointType: 'standard', observedAt: T0 + 1, expiresAt: T0 + 61,
  };
  const digests = new Set([base]);
  for (const [field, value] of Object.entries(other)) digests.add(computeTaskStartAttestationDigest({ ...BODY, [field]: value }));
  assert.equal(digests.size, 1 + Object.keys(other).length, 'each change gives its own digest');
  assert.deepEqual(CHECKPOINT_TYPES, ['production', 'standard']);
});

test('createTaskStartAttestation: the type defaults to production, the TTL to 60 s (at most 300 s); only Production with network none counts', () => {
  const body = createTaskStartAttestation({ ...EXPECTED, network: 'none', checkpointId: CKPT, observedAt: T0 });
  assert.deepEqual(body, BODY);
  assert.ok(Object.isFrozen(body));
  assert.equal(createTaskStartAttestation({ ...EXPECTED, network: 'none', checkpointId: CKPT, observedAt: T0, ttlSeconds: 300 }).expiresAt, T0 + 300);
  assert.equal(codeOf(() => createTaskStartAttestation({ ...EXPECTED, network: 'none', checkpointId: CKPT, observedAt: T0, ttlSeconds: 301 })), 'ttl:expiresAt');
  assert.equal(codeOf(() => validateTaskStartAttestation({ ...BODY, extra: true })), 'malformed:$extra');
  assert.equal(provesCheckpointedNoNetwork(BODY), true);
  for (const patch of [{ network: 'present' }, { network: 'unknown' }, { checkpointType: 'standard' }, { network: 'present', checkpointType: 'standard' }]) assert.equal(provesCheckpointedNoNetwork({ ...BODY, ...patch }), false, JSON.stringify(patch));
  assert.equal(provesCheckpointedNoNetwork(null), false);
});

const ecdsa = () => createEcdsaAttestationSigner({ keyId: 'albera-test-broker-1', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
const verifierOf = (signer) => createEcdsaAttestationVerifier({ keyId: signer.keyId, publicKey: signer.publicKeySpki });
const ctx = (signer, at = T0 + 10, expected = EXPECTED) => ({ clock: () => at, verify: verifierOf(signer).verify, expected });

test('sign / verify round trip with the ECDSA signer; the envelope has exactly four keys and verifies only with the matching bindings', async () => {
  const signer = ecdsa();
  const envelope = plain(await signTaskStartAttestation(BODY, signer));
  assert.deepEqual(Object.keys(envelope).sort(), ['attestation', 'digest', 'keyId', 'signature']);
  assert.equal(envelope.digest, computeTaskStartAttestationDigest(BODY));
  assert.deepEqual(verifyTaskStartAttestation(envelope, ctx(signer)), BODY);
  const wrong = { computerId: 'pc-02', vmId: '99999999-8888-4777-8666-555555555555', generation: 4, projectId: 'proj-beta', leaseId: 'lease-2', leaseGeneration: 8, operationId: 'op-0002', actionDigest: ACT2 };
  for (const [field, value] of Object.entries(wrong)) assert.equal(codeOf(() => verifyTaskStartAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, [field]: value }))), `binding:${field}`, field);
  assert.equal(codeOf(() => verifyTaskStartAttestation(envelope, ctx(signer, T0 + 60))), 'expired:expiresAt');
  assert.equal(codeOf(() => verifyTaskStartAttestation(envelope, ctx(signer, T0 - 31))), 'not_yet_valid:observedAt');
  const { operationId: _omit, ...partial } = EXPECTED;
  assert.equal(codeOf(() => verifyTaskStartAttestation(envelope, ctx(signer, T0 + 10, partial))), 'invalid_expected:$extra');
  assert.equal(codeOf(() => verifyTaskStartAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, operationId: 'has space' }))), 'invalid_expected:operationId');
});

test('ONE statement backs ONE action (#133): the same operation with another task is a binding mismatch on actionDigest, and the digest is the Authority-style digest of the DTO', async () => {
  const signer = ecdsa();
  const first = plain(await signTaskStartAttestation(BODY, signer));
  assert.deepEqual(verifyTaskStartAttestation(first, ctx(signer)), BODY);
  assert.notEqual(ACT, ACT2, 'the two tasks have two action digests');
  // Same computer, project, lease, lease generation, VM, generation and operationId; only the task differs.
  assert.equal(codeOf(() => verifyTaskStartAttestation(first, ctx(signer, T0 + 10, { ...EXPECTED, actionDigest: ACT2 }))), 'binding:actionDigest');
  // ... and a second statement for the second task does not verify for the first.
  const second = plain(await signTaskStartAttestation({ ...BODY, actionDigest: ACT2 }, signer));
  assert.deepEqual(verifyTaskStartAttestation(second, ctx(signer, T0 + 10, { ...EXPECTED, actionDigest: ACT2 })).actionDigest, ACT2);
  assert.equal(codeOf(() => verifyTaskStartAttestation(second, ctx(signer))), 'binding:actionDigest');
  assert.notEqual(first.digest, second.digest);
  // The digest covers the whole DTO (a different task text), not only the action name or the VM.
  assert.equal(ACT, computeActionDigest('guest.command', dtoOf('build the project')));
  assert.notEqual(ACT, computeActionDigest('guest.command', { ...dtoOf('build the project'), args: { expectedGeneration: 4, task: 'build the project', vmId: VM } }));
  // actionDigest is a "sha256:" digest and nothing else; editing it after signing breaks the digest check, and re-signing a malformed one is refused at signing time.
  for (const bad of [undefined, null, 7, '', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(64)}`, ` ${ACT}`, `${ACT}\n`]) {
    assert.equal(codeOf(() => validateTaskStartAttestation({ ...BODY, actionDigest: bad })), 'malformed:actionDigest', String(bad));
  }
  assert.equal(codeOf(() => validateTaskStartAttestation((({ actionDigest, ...rest }) => rest)(BODY))), 'malformed:$extra', 'a previous-version body (no actionDigest) is not accepted');
  assert.equal(codeOf(() => validateTaskStartAttestation({ ...BODY, v: 1 })), 'malformed:v', 'nor is version 1');
  assert.equal(codeOf(() => verifyTaskStartAttestation({ ...first, attestation: { ...first.attestation, actionDigest: ACT2 } }, ctx(signer))), 'digest:digest');
});

test('invalid_expected names the field for every caller value (also the ids and counters) in a fixed order, and counters are safe integers (#133, the C# twin does the same)', async () => {
  const signer = ecdsa();
  const envelope = plain(await signTaskStartAttestation(BODY, signer));
  const run = (patch) => codeOf(() => verifyTaskStartAttestation(envelope, ctx(signer, T0 + 10, { ...EXPECTED, ...patch })));
  for (const [field, value] of [
    ['computerId', 'has space'], ['projectId', ''], ['leaseId', 'lease/1'], ['operationId', 'x'.repeat(65)], ['vmId', 'AAAAAAAA-2222-4333-8444-555555555555'], ['actionDigest', 'sha256:abc'], ['actionDigest', ACT.toUpperCase()],
    ['generation', 0], ['generation', -1], ['generation', 1.5], ['generation', '3'], ['generation', MAX_SAFE + 1], ['generation', Number.POSITIVE_INFINITY], ['generation', Number.NaN],
    ['leaseGeneration', 0], ['leaseGeneration', MAX_SAFE + 1], ['leaseGeneration', null],
  ]) assert.equal(run({ [field]: value }), `invalid_expected:${field}`, `${field}=${String(value)}`);
  assert.equal(run({ generation: MAX_SAFE }), 'binding:generation', 'the largest safe integer is a valid expectation (a plain mismatch)');
  assert.equal(run({ computerId: 'has space', vmId: 'nope', generation: 0 }), 'invalid_expected:computerId');
  assert.equal(run({ vmId: 'nope', actionDigest: 'nope' }), 'invalid_expected:vmId');
  assert.equal(run({ actionDigest: 'nope', generation: 0 }), 'invalid_expected:actionDigest');
  assert.equal(run({ generation: 0, leaseGeneration: 0 }), 'invalid_expected:generation');
  assert.equal(codeOf(() => verifyTaskStartAttestation({ ...envelope, signature: 'AA' }, ctx(signer, T0 + 10, { ...EXPECTED, generation: 0 }))), 'invalid_expected:generation', 'checked before the statement is read');
  const { actionDigest: _omit, ...partial } = EXPECTED;
  assert.equal(codeOf(() => verifyTaskStartAttestation(envelope, ctx(signer, T0 + 10, partial))), 'invalid_expected:$extra');
});

test('DOMAIN SEPARATION: a network attestation is never a task-start attestation, and a task-start attestation is never a network attestation (shape, digest and signature all differ)', async () => {
  const signer = ecdsa();
  const verifier = verifierOf(signer);
  const netBody = createNetworkAttestation({ network: 'none', computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, observedAt: T0 });
  const net = plain(await signNetworkAttestation(netBody, signer));
  const task = plain(await signTaskStartAttestation(BODY, signer));
  // a genuine, correctly signed network attestation presented as a task-start one
  assert.equal(codeOf(() => verifyTaskStartAttestation(net, ctx(signer))), 'malformed:$extra');
  assert.equal(codeOf(() => readSignedTaskStartAttestation(net)), 'malformed:$extra');
  // and the other way round
  assert.throws(() => readSignedNetworkAttestation(task), (error) => error.code === 'malformed' && error.field === '$extra');
  assert.throws(() => verifyNetworkAttestation(task, { clock: () => T0 + 10, verify: verifier.verify, expected: { computerId: 'pc-01', vmId: VM, generation: 3, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7 } }),
    (error) => error.code === 'malformed');
  // same body keys, other domain: a task-start body signed under the network domain, with the network-domain digest, or with the task-start digest, is refused
  const underNetworkDomain = Buffer.concat([Buffer.from(ATTESTATION_DOMAIN, 'utf8'), Buffer.from([0]), encMap(BODY)]);
  const forgedSignature = { ...task, signature: Buffer.from(await signer.sign(underNetworkDomain)).toString('base64url') };
  assert.equal(codeOf(() => verifyTaskStartAttestation(forgedSignature, ctx(signer))), 'signature:signature');
  const forgedDigest = { ...forgedSignature, digest: `sha256:${createHash('sha256').update(underNetworkDomain).digest('hex')}` };
  assert.equal(codeOf(() => verifyTaskStartAttestation(forgedDigest, ctx(signer))), 'digest:digest');
  // the digests of the two kinds can never coincide for related content
  assert.notEqual(net.digest, task.digest);
});

test('verify refuses a forged, other-key, wrong-key-id, tampered or malformed envelope, and a verifier that does not return exactly true', async () => {
  const signer = ecdsa();
  const envelope = plain(await signTaskStartAttestation(BODY, signer));
  const run = (patch, c = ctx(signer)) => codeOf(() => verifyTaskStartAttestation({ ...envelope, ...patch }, c));
  const stranger = ecdsa();
  assert.equal(run({}, { ...ctx(signer), verify: verifierOf(stranger).verify }), 'signature:signature', 'an unpinned key');
  assert.equal(run({ keyId: 'albera-test-other' }), 'signature:signature');
  assert.equal(run({ signature: Buffer.alloc(64, 1).toString('base64url') }), 'signature:signature');
  assert.equal(run({ attestation: { ...BODY, checkpointType: 'standard' } }), 'digest:digest');
  assert.equal(run({ attestation: { ...BODY, checkpointType: 'standard' }, digest: computeTaskStartAttestationDigest({ ...BODY, checkpointType: 'standard' }) }), 'signature:signature', 'a recomputed digest still lacks a signature');
  assert.equal(run({ extra: 1 }), 'malformed:$extra');
  for (const verify of [() => 1, () => 'true', () => undefined, () => { throw new Error('boom'); }]) assert.equal(run({}, { ...ctx(signer), verify }), 'signature:signature');
  assert.equal(codeOf(() => verifyTaskStartAttestation(envelope, { clock: () => T0, expected: EXPECTED })), 'invalid_context');
});

// ---- Hyper-V Broker prototype with a stand-in for env-io.ps1 ----

const DIGEST = `sha256:${'a'.repeat(64)}`;
const notesFor = (extra = {}) => JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 3, imageDigest: DIGEST, projectId: 'proj-alpha', ...extra });
const INPUT = Object.freeze({ computerId: 'pc-01', projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, generation: 3, vmId: VM, operationId: 'op-0001', actionDigest: ACT });
const tmpRoot = path.join(os.tmpdir(), 'albera-task-start-attest-never-created');

/**
 * Stand-in for env-io.ps1 'network' and 'checkpoint': one VM. `vm` (network reads) is the VM as the script emits it, `script` scripts deviations: `network` entries are used per
 * 'network' call in order (a patch of the VM, or null for "no VM"), `checkpoint` is a function or a result.
 */
function checkpointScript({ vm = {}, networks = [], checkpoint } = {}) {
  const calls = [];
  const queue = [...networks];
  const run = async (request) => {
    calls.push(request);
    if (request.method === 'network') {
      const patch = queue.length > 0 ? queue.shift() : {};
      return patch === null ? { ok: true, exists: false } : { ok: true, exists: true, state: 'Running', notes: notesFor(), vmId: VM.toUpperCase(), adapters: [], ...vm, ...patch };
    }
    if (request.method === 'checkpoint') {
      if (typeof checkpoint === 'function') return checkpoint(request);
      return checkpoint ?? { ok: true, checkpointId: CKPT, vmId: VM, state: 'Running' };
    }
    return { ok: false, code: 'invalid_provider_state', notApplied: true };
  };
  return { run, calls, methods: () => calls.map((c) => c.method) };
}

const journals = [];
test.after(() => { for (const journal of journals) journal.close(); });

function hvBroker(scriptOptions = {}, options = {}) {
  const script = checkpointScript(scriptOptions);
  const signer = ecdsa();
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [DIGEST]: { path: path.join(os.tmpdir(), 'albera-task-start-golden', 'base.vhdx'), os: 'windows', architecture: 'x64' } },
    cloneRoot: tmpRoot, runPowerShell: script.run, now: () => new Date((T0 + 5) * 1000), attestationSigner: signer, ...options,
  });
  return { broker, script, signer };
}

test('attestTaskStart: network, then the fixed checkpoint op, then the network again; the signed statement is bound to the computer, the VM, the project, the lease and the operation', async () => {
  const { broker, script, signer } = hvBroker();
  const envelope = await broker.attestTaskStart({ ...INPUT });
  assert.deepEqual(script.methods(), ['network', 'checkpoint', 'network']);
  assert.deepEqual(script.calls[0], { method: 'network', vmName: 'albera-pc-01' });
  assert.deepEqual(script.calls[2], { method: 'network', vmName: 'albera-pc-01' });
  const name = `albera-task-${createHash('sha256').update('op-0001', 'utf8').digest('hex').slice(0, 24)}`;
  assert.deepEqual(script.calls[1], { method: 'checkpoint', vmName: 'albera-pc-01', expect: { computerId: 'pc-01', generation: 3, vmId: VM, identity: 'vm' }, checkpointName: name });
  assert.match(script.calls[1].checkpointName, /^albera-task-[0-9a-f]{24}$/);
  const verified = verifyTaskStartAttestation(plain(envelope), ctx(signer, T0 + 10));
  assert.deepEqual(verified, { ...BODY, observedAt: T0 + 5, expiresAt: T0 + 65 }, 'observedAt is the Broker clock after the checkpoint; the checkpoint id is what the script returned');
  assert.equal(provesCheckpointedNoNetwork(verified), true);
  assert.equal(verified.checkpointType, 'production');
});

test('attestTaskStart: the checkpoint name comes from the operationId alone and an operationId cannot put anything else into the request', async () => {
  const names = new Set();
  for (const operationId of ['op-0001', 'op-0002', 'a'.repeat(64), 'x.y:z-1', 'op"; Remove-VM *']) {
    const { broker, script } = hvBroker();
    const result = await broker.attestTaskStart({ ...INPUT, operationId });
    if (operationId.includes('"')) { assert.equal(result, null, 'not an id'); assert.equal(script.calls.length, 0); continue; }
    assert.ok(result, operationId);
    names.add(script.calls[1].checkpointName);
    assert.deepEqual(Object.keys(script.calls[1]).sort(), ['checkpointName', 'expect', 'method', 'vmName']);
    assert.match(script.calls[1].checkpointName, /^albera-task-[0-9a-f]{24}$/);
  }
  assert.equal(names.size, 4, 'another operation, another name');
});

test('attestTaskStart: the statement carries the action digest it was asked for (one statement per action, #133) and the digest never reaches PowerShell', async () => {
  const { broker, script, signer } = hvBroker();
  const first = await broker.attestTaskStart({ ...INPUT });
  const second = await broker.attestTaskStart({ ...INPUT, actionDigest: ACT2 });
  assert.equal(first.attestation.actionDigest, ACT);
  assert.equal(second.attestation.actionDigest, ACT2);
  assert.notEqual(first.digest, second.digest);
  assert.equal(codeOf(() => verifyTaskStartAttestation(plain(first), ctx(signer, T0 + 10, { ...EXPECTED, actionDigest: ACT2 }))), 'binding:actionDigest', 'the first statement does not back the second task');
  assert.equal(verifyTaskStartAttestation(plain(second), ctx(signer, T0 + 10, { ...EXPECTED, actionDigest: ACT2 })).actionDigest, ACT2);
  for (const call of script.calls) assert.equal(JSON.stringify(call).includes('sha256'), false, 'no digest in any request to the script');
});

test('attestTaskStart: never an error to the caller: every failure is null, and nothing is taken when the VM is not attestable before the checkpoint', async () => {
  const before = [
    ['the network is present', { vm: { adapters: [{ connected: false, switchType: null }] } }],
    ['the adapters cannot be read', { vm: { adapters: null } }],
    ['no such VM', { networks: [null] }],
    ['another VM id than the one the approval names', { vm: { vmId: '99999999-8888-4777-8666-555555555555' } }],
    ['no VM id reported', { vm: { vmId: undefined } }],
    ['Notes of another computer', { vm: { notes: JSON.stringify({ albera: 1, computerId: 'pc-02', generation: 3, imageDigest: DIGEST, projectId: 'proj-alpha' }) } }],
    ['another generation', { vm: { notes: notesFor({ generation: 4 }) } }],
    ['Notes of another project', { vm: { notes: notesFor({ projectId: 'proj-other' }) } }],
    ['Notes without a project (a VM made before step 2)', { vm: { notes: JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 3, imageDigest: DIGEST }) } }],
    ['Notes that are not ours', { vm: { notes: 'not json' } }],
  ];
  for (const [label, script] of before) {
    const { broker, script: ps } = hvBroker(script);
    assert.equal(await broker.attestTaskStart({ ...INPUT }), null, label);
    assert.deepEqual(ps.methods().filter((m) => m !== 'network'), [], `${label}: no checkpoint was taken`);
  }
  const after = [
    ['the network turned present after the checkpoint', { networks: [{}, { adapters: [{ connected: true, switchType: 'Private' }] }] }],
    ['the adapters became unreadable after the checkpoint', { networks: [{}, { adapters: undefined }] }],
    ['the VM id changed after the checkpoint', { networks: [{}, { vmId: '99999999-8888-4777-8666-555555555555' }] }],
    ['the VM vanished after the checkpoint', { networks: [{}, null] }],
    ['the Notes changed project after the checkpoint', { networks: [{}, { notes: notesFor({ projectId: 'proj-other' }) }] }],
  ];
  for (const [label, script] of after) {
    const { broker, script: ps } = hvBroker(script);
    assert.equal(await broker.attestTaskStart({ ...INPUT }), null, label);
    assert.deepEqual(ps.methods(), ['network', 'checkpoint', 'network'], `${label}: the checkpoint was taken, no statement was made`);
  }
});

test('attestTaskStart: a checkpoint op that fails, throws, is slow-failing, reports another VM or returns no / a malformed snapshot id gives no attestation', async () => {
  const cases = {
    'not applied': { checkpoint: { ok: false, code: 'invalid_provider_state', notApplied: true } },
    'unavailable': { checkpoint: { ok: false, code: 'provider_unavailable', notApplied: false } },
    'a thrown error': { checkpoint: () => { throw Object.assign(new Error('provider_timeout'), { code: 'provider_timeout' }); } },
    'a rejected promise': { checkpoint: () => Promise.reject(new Error('down')) },
    'no snapshot id': { checkpoint: { ok: true, vmId: VM } },
    'a snapshot id that is not a GUID': { checkpoint: { ok: true, checkpointId: 'snapshot-1', vmId: VM } },
    'a snapshot id that is a number': { checkpoint: { ok: true, checkpointId: 7, vmId: VM } },
    'another VM id in the reply': { checkpoint: { ok: true, checkpointId: CKPT, vmId: '99999999-8888-4777-8666-555555555555' } },
    'no VM id in the reply': { checkpoint: { ok: true, checkpointId: CKPT } },
  };
  for (const [label, script] of Object.entries(cases)) {
    const { broker, script: ps } = hvBroker(script);
    assert.equal(await broker.attestTaskStart({ ...INPUT }), null, label);
    const steps = ps.methods();
    assert.deepEqual(steps, ['network', 'checkpoint'], `${label}: the checkpoint reply is judged before any second observation`);
  }
  const upper = hvBroker({ checkpoint: { ok: true, checkpointId: CKPT.toUpperCase(), vmId: VM.toUpperCase() } });
  assert.equal((await upper.broker.attestTaskStart({ ...INPUT })).attestation.checkpointId, CKPT, 'the script reports GUIDs in any case; the statement carries the lowercase form');
});

test('attestTaskStart: bad input, no signer, a failing signer and a retired computer id are null; extra, missing and malformed fields never reach the script', async () => {
  for (const [label, input] of [
    ['null', null], ['a string', 'x'], ['an array', []], ['an extra field', { ...INPUT, extra: 1 }], ['a smuggled network claim', { ...INPUT, network: 'none' }],
    ['a smuggled checkpoint id', { ...INPUT, checkpointId: CKPT }], ['no operationId', (({ operationId, ...r }) => r)(INPUT)], ['no vmId', (({ vmId, ...r }) => r)(INPUT)],
    ['an uppercase vmId', { ...INPUT, vmId: 'AAAAAAAA-2222-4333-8444-555555555555' }], ['a vmId that is not a GUID', { ...INPUT, vmId: 'vm-1' }], ['generation 0', { ...INPUT, generation: 0 }],
    ['generation as text', { ...INPUT, generation: '3' }], ['leaseGeneration 1.5', { ...INPUT, leaseGeneration: 1.5 }], ['a computerId outside the VM-name alphabet', { ...INPUT, computerId: 'pc_01' }],
    ['a computerId with a path', { ...INPUT, computerId: '..\\pc' }], ['an empty projectId', { ...INPUT, projectId: '' }], ['a leaseId with a space', { ...INPUT, leaseId: 'lease 1' }],
    ['an operationId with a quote', { ...INPUT, operationId: 'op"x' }], ['an operationId of 65 characters', { ...INPUT, operationId: 'o'.repeat(65) }],
    ['no actionDigest (#133)', (({ actionDigest, ...r }) => r)(INPUT)], ['an actionDigest that is not a digest', { ...INPUT, actionDigest: 'sha256:abc' }],
    ['an uppercase actionDigest', { ...INPUT, actionDigest: ACT.toUpperCase().replace('SHA256', 'sha256') }], ['an actionDigest as a number', { ...INPUT, actionDigest: 7 }],
  ]) {
    const { broker, script } = hvBroker();
    assert.equal(await broker.attestTaskStart(input), null, label);
    assert.equal(script.calls.length, 0, `${label}: nothing reached the script`);
  }
  const unsigned = hvBroker({}, { attestationSigner: undefined });
  assert.equal(await unsigned.broker.attestTaskStart({ ...INPUT }), null);
  assert.equal(unsigned.script.calls.length, 0, 'without a signer not even the network is read');
  const broken = hvBroker({}, { attestationSigner: { keyId: 'albera-test-x', sign: async () => { throw new Error('down'); } } });
  assert.equal(await broken.broker.attestTaskStart({ ...INPUT }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-ts-retire-'));
  try {
    const journal = createRetirementJournal({ path: path.join(dir, 'retire.sqlite') });
    journals.push(journal);
    journal.retire({ computerId: 'pc-01', projectId: 'proj-alpha', generation: 3, vmId: VM });
    const retired = hvBroker({}, { retirements: journal });
    assert.equal(await retired.broker.attestTaskStart({ ...INPUT }), null, 'a retired computer id is never attested');
    assert.equal(retired.script.calls.length, 0);
  } finally { journals.length = 0; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attestTaskStart: an unusable Broker clock is null, and the TTL is the configured one', async () => {
  assert.equal(await hvBroker({}, { now: () => new Date(Number.NaN) }).broker.attestTaskStart({ ...INPUT }), null);
  const long = await hvBroker({}, { attestationTtlSeconds: 300 }).broker.attestTaskStart({ ...INPUT });
  assert.equal(long.attestation.expiresAt - long.attestation.observedAt, 300);
  const fake = hvBroker({}, { attestationSigner: createFakeAttestationSigner() });
  assert.ok(await fake.broker.attestTaskStart({ ...INPUT }), 'the signer is a port: any { keyId, sign } works');
});

// ---- env-io.ps1: the `checkpoint` op ----

const functionBody = (name) => {
  const start = scriptText.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = scriptText.indexOf('\nfunction ', start + 1);
  return scriptText.slice(start, end < 0 ? scriptText.indexOf('\ntry {', start) : end);
};

test('env-io.ps1 checkpoint op: the exact cmdlets and arguments it may use, a fixed name shape, the VM id mandatory, ASCII only', () => {
  const body = functionBody('Invoke-Checkpoint');
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  // The only commands: our own helpers, and exactly three Hyper-V cmdlets with exactly these arguments (Set-VM twice: borrow ProductionOnly, then put the previous value back).
  assert.ok(lines.includes('if ($previousType -ne \'ProductionOnly\') { Set-VM -VM $vm -CheckpointType ProductionOnly -ErrorAction Stop; $changedType = $true }'), 'Set-VM only ever sets ProductionOnly going in');
  assert.ok(lines.includes('if ($changedType) { try { Set-VM -VM $vm -CheckpointType $previousType -ErrorAction Stop } catch { $restoreFailed = $true } }'), 'and puts back only the value it read, and only if it changed it');
  assert.ok(lines.includes('else { $snapshots = @(Checkpoint-VM -VM $vm -SnapshotName $Req.checkpointName -Passthru -ErrorAction Stop) }'), 'Checkpoint-VM with the validated name, only in the branch where the type was read back');
  assert.ok(lines.includes('if ([string](Get-VM -Id $vm.Id -ErrorAction Stop).CheckpointType -ne \'ProductionOnly\') { $typeNotSet = $true }'), 'the type is read back, by VM id');
  assert.ok(lines.includes('$after = Get-VM -Name $Req.vmName -ErrorAction Stop'), 'Get-VM re-reads the VM id');
  for (const line of lines.filter((l) => /\b(?:Set-VM|Get-VM|Get-VMSnapshot|Checkpoint-VM|Remove-VMSnapshot)\b/u.test(l))) assert.match(line, /-ErrorAction Stop/u, `every Hyper-V call fails loudly, even if the preference were not inherited: ${line}`);
  const cmdlets = [...lines.slice(1).join('\n').matchAll(/\b([A-Z][a-z]+-[A-Za-z]+)\b/gu)].map((m) => m[1]); // the function's own header is not a command, and comments (the restore op's comment block follows this function) are not code
  // #133: after the checkpoint is verified the prune lists this VM's snapshots and removes some (Where-Object is the filter); nothing else was added.
  assert.deepEqual([...new Set(cmdlets)].sort(), ['Checkpoint-VM', 'Get-VM', 'Get-VMSnapshot', 'Remove-VMSnapshot', 'Require-Vm', 'Set-VM', 'Where-Object']);
  assert.deepEqual(cmdlets.filter((c) => c === 'Set-VM' || c === 'Checkpoint-VM'), ['Set-VM', 'Checkpoint-VM', 'Set-VM'], 'borrow, checkpoint, put back');
  assert.equal(body.match(/Set-VM -VM \$vm -CheckpointType (\S+)/gu).length, 2);
  assert.equal(/Set-VM(?![^\n]*-CheckpointType)/u.test(body), false, 'Set-VM is never used for anything but CheckpointType');
  // The name is the fixed shape or nothing, and the identity is mandatory before any VM is touched.
  assert.match(scriptText, /\$CheckpointNameRe = '\^albera-task-\[0-9a-f\]\{24\}\$'/u);
  assert.ok(body.indexOf('$Req.checkpointName -cnotmatch $CheckpointNameRe') < body.indexOf('Require-Vm'));
  assert.ok(body.indexOf("[string]$Req.expect.identity -ne 'vm' -or $null -eq $Req.expect.vmId") < body.indexOf('Require-Vm'), 'the VM id is mandatory, checked before the VM is looked up');
  assert.ok(body.indexOf('Require-Vm') < body.indexOf('Checkpoint-VM'), 'ownership (Notes + VM id) is checked before the checkpoint');
  assert.match(scriptText, /'checkpoint' \{ Invoke-Checkpoint \$req \}/u);
  // Not one other checkpoint verb anywhere in the script: nothing is merged, exported, renamed or reconfigured. Since #133 exactly one Remove-VMSnapshot (the prune), one Restore-VMSnapshot (the restore op)
  // and two Get-VMSnapshot (one in each) exist; test/runtime-task-checkpoint-lifecycle.test.mjs pins each of them.
  const anywhere = [...scriptText.matchAll(/\b([A-Z][a-z]+-VM[A-Za-z]*)\b/gu)].map((m) => m[1]);
  for (const forbidden of ['Remove-VMCheckpoint', 'Get-VMCheckpoint', 'Export-VMSnapshot', 'Rename-VMSnapshot', 'Set-VMSnapshot', 'Merge-VHD', 'Convert-VHD']) {
    assert.ok(!anywhere.includes(forbidden), forbidden);
  }
  assert.equal(anywhere.filter((c) => c === 'Checkpoint-VM').length, 1, 'Checkpoint-VM appears once, in Invoke-Checkpoint');
  assert.equal(/Invoke-Expression|\biex\b|Start-Process|-Command|\$Req\.(?:notes|cloneRoot|vmDir|parentPath|childPath)/iu.test(body), false, 'no string-built command and no path input');
  assert.equal([...Buffer.from(scriptText, 'utf8')].every((b) => b < 128), true, 'ASCII only');
});

test('env-io.ps1 checkpoint op leaves the VM\'s CheckpointType as it found it (#133): read first, borrowed only when different, put back in finally, a failed put-back is an unknown outcome', () => {
  const body = functionBody('Invoke-Checkpoint');
  const at = (needle) => { const n = body.indexOf(needle); assert.ok(n >= 0, needle); return n; };
  assert.ok(at('$previousType = [string]$vm.CheckpointType') < at('Set-VM -VM $vm -CheckpointType ProductionOnly'), 'the previous value is read before anything is changed');
  assert.ok(at('$changedType = $false') < at('Set-VM -VM $vm -CheckpointType ProductionOnly'), 'nothing is put back unless this call changed it');
  assert.match(body, /try \{\s+if \(\$previousType -ne 'ProductionOnly'\)[^\n]*\n(?:\s+#[^\n]*\n)*\s+if \(\[string\]\(Get-VM[^\n]*\n\s+else \{ \$snapshots = @\(Checkpoint-VM[^\n]*\n\s+\} catch \{ Abort 'provider_unavailable' \}\s+finally \{\s+if \(\$changedType\) \{ try \{ Set-VM -VM \$vm -CheckpointType \$previousType -ErrorAction Stop \} catch \{ \$restoreFailed = \$true \} \}\s+\}/u,
    'the put-back is the finally of the very try that borrows and checkpoints, so it runs when the checkpoint fails too');
  assert.ok(at('finally') > at('Checkpoint-VM'), 'after the checkpoint');
  assert.ok(at('if ($restoreFailed) { Abort \'provider_state_unknown\' }') > at('finally'), 'a put-back that failed is judged right after it ...');
  assert.ok(at('if ($restoreFailed)') < at('$snapshots.Count -ne 1') && at('$snapshots.Count -ne 1') < at('$after = Get-VM'), '... before any success is reported');
  assert.equal((body.match(/\$restoreFailed = \$true/gu) ?? []).length, 1, 'only the put-back sets it');
  // #133 review: the type is observed, not assumed. Read back after the borrow and before the checkpoint; if it is not ProductionOnly there is no checkpoint and no attestation.
  assert.ok(at("(Get-VM -Id $vm.Id -ErrorAction Stop).CheckpointType -ne 'ProductionOnly'") > at('Set-VM -VM $vm -CheckpointType ProductionOnly') && at('(Get-VM -Id $vm.Id') < at('Checkpoint-VM'), 'read back between the borrow and the checkpoint');
  assert.ok(at('$typeNotSet = $false') < at('try {'), 'starts false');
  assert.equal((body.match(/\$typeNotSet = \$true/gu) ?? []).length, 1, 'only the read-back sets it');
  assert.ok(at("if ($typeNotSet) { Abort 'provider_unavailable' }") > at('finally') && at('if ($typeNotSet)') < at('$snapshots.Count -ne 1'), 'a type that did not take is a failure, judged after the put-back and before any success');
  // The comment that explains what is NOT observed must stay with the op (a reader of the script must see it), and the script still never lists snapshots.
  assert.match(scriptText, /the snapshot's SnapshotType is NOT used/u);
  assert.match(scriptText, /SnapshotType Standard for a ProductionOnly checkpoint/u);
});

test('env-io.ps1 checkpoint op observes that the new checkpoint holds no saved memory (#133 b): the snapshot State is Off, else no attestation', () => {
  const body = functionBody('Invoke-Checkpoint');
  const at = (needle) => { const n = body.indexOf(needle); assert.ok(n >= 0, needle); return n; };
  // Real host 2026-11-01, VM running: a Standard checkpoint records State Saved, a ProductionOnly one State Off (SnapshotType is Standard for both).
  assert.ok(at("if ([string]$snapshots[0].State -ne 'Off') { Abort 'provider_state_unknown' }") > at('$snapshots.Count -ne 1'), 'judged on the one snapshot that came back ...');
  assert.ok(at("[string]$snapshots[0].State -ne 'Off'") < at('$after = Get-VM'), '... before any success is reported');
  assert.equal((body.match(/\$snapshots\[0\]\.State/gu) ?? []).length, 1);
  assert.match(scriptText, /snapshot State Saved/u, 'the comment says what the signal is and where it was observed');
});

test('env-io.ps1 checkpoint op: the reply carries the lowercase snapshot id and the VM id, and every failure is a fixed code', () => {
  const body = functionBody('Invoke-Checkpoint');
  assert.match(body, /@\{ ok = \$true; checkpointId = \$checkpointId; vmId = \(\[string\]\$after\.Id\)\.ToLowerInvariant\(\); state = \[string\]\$after\.State; pruned = \$pruned; pruneFailed = \$pruneFailed \}/u);
  assert.match(body, /\$checkpointId -cnotmatch \$GuidRe/u);
  assert.match(body, /if \(\$snapshots\.Count -ne 1\) \{ Abort 'provider_state_unknown' \}/u, 'exactly one snapshot came back');
  assert.match(body, /catch \{ Abort 'provider_unavailable' \}/u);
  for (const code of [...body.matchAll(/(?:Reject|Abort) '([a-z_]+)'/gu)].map((m) => m[1])) assert.ok(['invalid_provider_state', 'provider_unavailable', 'provider_state_unknown'].includes(code), code);
  assert.match(body, /ProductionOnly/u, 'a Production checkpoint that would fall back to Standard fails instead (the guest memory never goes to the host disk)');
});
