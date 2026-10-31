// Issue #128 (follow-ups from the review of #115 step 3b), the Node side of items 1 and 2:
//  1. an environment.start that runs under an ATTESTED-POLICY receipt (no person asked, a Broker attestation named a VM) must carry that receipt's vmId, taken from the verified receipt's action
//     and never from the Control Plane; an attested start without a vmId is refused, and so is a vmId that differs from the receipt's;
//  2. an attested start re-reads the network adapters in the provider right before it starts (an adapter added after the attestation refuses the start).
// What this does NOT exercise: the Windows Broker. It only records claims today, so nothing there executes a start; the binding is enforced where execution exists
// (bindStartToReceipt -> validateEnvironmentOperation -> the providers). The Hyper-V prototype's side of items 1 and 2 is in runtime-hyperv-environment-broker.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeActionDigest, validateActionDto } from '../src/runtime/broker-contract/action-digest.mjs';
import { validateReceipt } from '../src/runtime/broker-contract/receipt-v3.mjs';
import { EnvironmentOperationCoordinator, bindStartToReceipt } from '../src/runtime/environment-operations.mjs';
import { validateEnvironmentOperation } from '../src/runtime/environment-provider.mjs';
import { createFakeAttestationSigner } from '../src/runtime/fake-attestation-signer.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';

const VM_A = '11111111-2222-4333-8444-555555555555';
const VM_B = '99999999-8888-4777-8666-555555555555';
const NOW = 1_800_000_000;
const PURPOSE = 'broker.operation';
const ATTESTATION_DIGEST = `sha256:${'24'.repeat(32)}`;

/** The action the receipt is for, validated the way the Broker validates it (the receipt binds its digest). */
const dtoFor = (args, overrides = {}) => validateActionDto(PURPOSE, { action: 'environment.start', projectId: 'project-a', computerId: 'computer-1', args, ...overrides });

/** A receipt that the contract validator has really accepted (signature checking is the Broker's job outside this module): basis policy (attested) or presence. */
function verifiedReceipt(dto, { basis = 'policy', action = dto.action } = {}) {
  const body = {
    v: 3, kid: 'authority-key-2026-10', issuer: 'albera-approval-authority', audience: 'albera-host-broker', purpose: PURPOSE,
    approvalId: '3f2b8c1e-5a47-4d0e-9b36-7c1d2e4f5a60', receiptId: '9a1c7e52-0b3d-4f68-8e21-5d4c3b2a1f09', nonce: 'ABEiM0RVZneImaq7zN3u_w',
    operationId: 'operation-start-1', idempotencyKey: 'idem-start-1', action, actionDigest: computeActionDigest(PURPOSE, dto), projectId: dto.projectId, computerId: dto.computerId,
    leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: '_-7dzLuqmYh3ZlVEMyIRAA', policyVersion: `sha256:${'33'.repeat(32)}`, basis,
    approverKeyId: 'hello-key-yosuke-01', iat: NOW - 10, exp: NOW + 110, ...(basis === 'policy' ? { attestationDigest: ATTESTATION_DIGEST } : {}),
  };
  const expected = { audience: 'albera-host-broker', purpose: PURPOSE, operationId: body.operationId, idempotencyKey: body.idempotencyKey, leaseId: 'lease-1', leaseGeneration: 7, brokerEpoch: 3, brokerChallenge: body.brokerChallenge };
  const verdict = validateReceipt(Buffer.from(JSON.stringify(body)), { clock: () => NOW, environment: 'production', expected, action: dto });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  return verdict.receipt;
}

function startOperation(overrides = {}) {
  return {
    operationId: 'operation-start-1', idempotencyKey: 'idem-start-1', subjectId: 'human-local', projectId: 'project-a', taskId: 'task-1', runId: 'run-1', computerId: 'computer-1',
    providerId: 'mock', leaseId: 'lease-1', expectedGeneration: 1, policyVersion: 1, action: 'start', ...overrides,
  };
}

const spec = Object.freeze({
  projectId: 'project-a', kind: 'ephemeral', os: 'linux', architecture: 'x64', imageDigest: `sha256:${'a'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1', resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
});

/** A mock provider with one created computer, and the VM id the "hypervisor" gave it (read the way an attestation reads it). */
async function mockWithComputer() {
  const provider = new MockEnvironmentProvider({ attestationSigner: createFakeAttestationSigner() });
  await provider.create({ ...startOperation({ action: 'create', operationId: 'operation-create-1', idempotencyKey: 'idem-create-1' }), spec });
  const { attestation } = await provider.attestNetwork({ ...startOperation({ action: 'inspect' }) }, { leaseGeneration: 7 });
  return { provider, vmId: attestation.vmId, coordinator: new EnvironmentOperationCoordinator({ provider }) };
}

const codeOf = (fn) => { try { fn(); } catch (error) { return error.code ?? error.message; } return 'ok'; };

// ---- the operation: attestedPolicy is a closed marker, and it needs the VM id ----

test('an operation marked attestedPolicy must be a start that names the VM; the marker is exactly true and nothing else', () => {
  const marked = validateEnvironmentOperation(startOperation({ vmId: VM_A, attestedPolicy: true }));
  assert.equal(marked.attestedPolicy, true);
  assert.equal(marked.vmId, VM_A);
  assert.throws(() => validateEnvironmentOperation(startOperation({ attestedPolicy: true })), /invalid_environment_operation/, 'attested start WITHOUT a vmId is not an operation');
  assert.throws(() => validateEnvironmentOperation(startOperation({ vmId: undefined, attestedPolicy: true })), /invalid_environment_operation/, 'an undefined vmId is no vmId');
  for (const bad of [false, 'true', 1, null, {}, []]) assert.throws(() => validateEnvironmentOperation(startOperation({ vmId: VM_A, attestedPolicy: bad })), /invalid_environment_operation/, String(bad));
  for (const action of ['inspect', 'stop', 'destroy', 'retire', 'purge']) assert.throws(() => validateEnvironmentOperation(startOperation({ action, vmId: VM_A, attestedPolicy: true })), /invalid_environment_operation/, action);
  assert.throws(() => validateEnvironmentOperation(startOperation({ action: 'create', spec, attestedPolicy: true })), /invalid_environment_operation/, 'create is never attested');
  assert.equal(Object.hasOwn(validateEnvironmentOperation(startOperation({ vmId: VM_A })), 'attestedPolicy'), false, 'a start with a vmId and no marker stays as it was');
});

// ---- bindStartToReceipt: the vmId comes from the verified receipt's action ----

test('item 1: an attested-policy start takes its vmId from the verified receipt, not from the Control Plane, and is marked attestedPolicy', () => {
  const dto = dtoFor({ vmId: VM_A, expectedGeneration: 1 });
  const receipt = verifiedReceipt(dto);
  const bound = bindStartToReceipt(startOperation(), { receipt, dto });
  assert.equal(bound.vmId, VM_A, "the receipt's vmId");
  assert.equal(bound.attestedPolicy, true);
  assert.equal(Object.isFrozen(bound), true);
  assert.deepEqual(validateEnvironmentOperation(bound), bound, 'the bound operation is a valid operation');
  // The Control Plane may name the same VM (it filled the arg in); it is compared, never trusted.
  assert.equal(bindStartToReceipt(startOperation({ vmId: VM_A }), { receipt, dto }).vmId, VM_A);
});

test('item 1 (negative): a vmId from the Control Plane that differs from the receipt is refused, and so is any operation that is not the receipt\'s', () => {
  const dto = dtoFor({ vmId: VM_A });
  const receipt = verifiedReceipt(dto);
  const refused = (operation, pair, code) => assert.equal(codeOf(() => bindStartToReceipt(operation, pair)), code);
  refused(startOperation({ vmId: VM_B }), { receipt, dto }, 'operation_conflict');
  refused(startOperation({ computerId: 'computer-2' }), { receipt, dto }, 'operation_conflict');
  refused(startOperation({ projectId: 'project-b' }), { receipt, dto }, 'operation_conflict');
  for (const action of ['stop', 'inspect', 'destroy']) refused(startOperation({ action }), { receipt, dto }, 'operation_conflict');
  // A receipt for another action, or for another DTO than the one presented, cannot drive a start.
  const taskDto = validateActionDto('guest.command', { action: 'task.start', projectId: 'project-a', computerId: 'computer-1', args: { vmId: VM_A, expectedGeneration: 1, task: 'build' } });
  refused(startOperation(), { receipt: { ...receipt, action: 'task.start', purpose: 'guest.command', actionDigest: computeActionDigest('guest.command', taskDto) }, dto: taskDto }, 'operation_conflict');
  refused(startOperation(), { receipt, dto: dtoFor({ vmId: VM_B }) }, 'operation_conflict');
  refused(startOperation(), { receipt: { ...receipt, projectId: 'project-b' }, dto }, 'operation_conflict');
  refused(startOperation(), { receipt, dto: undefined }, 'operation_conflict');
  refused(startOperation(), { receipt: undefined, dto }, 'operation_conflict');
  refused(startOperation(), undefined, 'operation_conflict');
});

test('item 1 (negative): an attested-policy receipt whose action names no well-formed VM never produces an operation (the contract refuses it too; this is the second lock)', () => {
  const dto = dtoFor({ vmId: VM_A });
  const receipt = verifiedReceipt(dto);
  for (const args of [{}, { vmId: 'vm-1' }, { vmId: 'AAAAAAAA-2222-4333-8444-555555555555' }, { expectedGeneration: 1 }]) {
    const bare = dtoFor(args);
    // The contract validator itself refuses to accept such a receipt as attested.
    assert.throws(() => verifiedReceipt(bare), /attestation|vmId/, JSON.stringify(args));
    // Defense in depth: even a receipt object that was never validated, with the digest of that DTO, is refused here.
    const forged = { ...receipt, actionDigest: computeActionDigest(PURPOSE, bare) };
    assert.equal(codeOf(() => bindStartToReceipt(startOperation(), { receipt: forged, dto: bare })), 'attested_start_requires_vm_id', JSON.stringify(args));
    assert.equal(codeOf(() => bindStartToReceipt(startOperation({ vmId: VM_A }), { receipt: forged, dto: bare })), 'attested_start_requires_vm_id', `${JSON.stringify(args)} (with a Control Plane vmId)`);
  }
});

test('a start a PERSON approved (basis presence) is bound the same way when its action names a VM, and is left as it was when it names none', () => {
  const named = dtoFor({ vmId: VM_A });
  const presenceNamed = verifiedReceipt(named, { basis: 'presence' });
  const bound = bindStartToReceipt(startOperation(), { receipt: presenceNamed, dto: named });
  assert.deepEqual([bound.vmId, Object.hasOwn(bound, 'attestedPolicy')], [VM_A, false], 'the approval named the VM, nobody attested anything');
  assert.equal(codeOf(() => bindStartToReceipt(startOperation({ vmId: VM_B }), { receipt: presenceNamed, dto: named })), 'operation_conflict');
  const bare = dtoFor({});
  const presenceBare = verifiedReceipt(bare, { basis: 'presence' });
  const unchanged = bindStartToReceipt(startOperation(), { receipt: presenceBare, dto: bare });
  assert.deepEqual([Object.hasOwn(unchanged, 'vmId'), Object.hasOwn(unchanged, 'attestedPolicy')], [false, false]);
  assert.equal(codeOf(() => bindStartToReceipt(startOperation({ vmId: VM_A }), { receipt: presenceBare, dto: bare })), 'operation_conflict', 'a VM the approval did not name is not added by the Control Plane');
});

// ---- the providers: an attested start without a vmId is refused where execution exists ----

test('item 1 (negative): through the coordinator and the mock provider an attested start without vmId is refused and the computer stays off', async () => {
  const { provider, vmId, coordinator } = await mockWithComputer();
  await assert.rejects(() => coordinator.execute(startOperation({ attestedPolicy: true })), /invalid_environment_operation/);
  await assert.rejects(() => provider.start(startOperation({ attestedPolicy: true })), /invalid_environment_operation/);
  assert.equal((await provider.inspect(startOperation({ action: 'inspect' }))).state, 'off');
  // The bound operation starts.
  const dto = dtoFor({ vmId });
  const started = await coordinator.execute(bindStartToReceipt(startOperation(), { receipt: verifiedReceipt(dto), dto }));
  assert.deepEqual([started.status, started.observedState], ['SUCCEEDED', 'running']);
});

test('item 1 (negative): a bound start for a VM that is no longer the computer\'s own VM (another incarnation under the same id) is refused and nothing starts', async () => {
  const { provider, vmId, coordinator } = await mockWithComputer();
  provider.restoreComputer('computer-1', { projectId: 'project-a', generation: 1 }); // same computer id, project, generation; another VM id
  const dto = dtoFor({ vmId });
  const result = await coordinator.execute(bindStartToReceipt(startOperation(), { receipt: verifiedReceipt(dto), dto }));
  assert.deepEqual([result.status, result.errorCode], ['FAILED', 'operation_conflict']);
  assert.equal((await provider.inspect(startOperation({ action: 'inspect' }))).state, 'off');
});

// ---- item 2: the network is read again right before an attested start ----

test('item 2 (negative): an adapter added between the attestation and the start refuses the attested start; unreadable adapters too; nothing starts', async () => {
  for (const [label, adapters] of [
    ['an unconnected adapter', [{ connected: false, switchType: null }]], ['an external switch', [{ connected: true, switchType: 'External' }]],
    ['unreadable (null)', null], ['unreadable (junk)', 'none'], ['a malformed entry', [{ connected: true }]],
  ]) {
    const { provider, vmId, coordinator } = await mockWithComputer();
    const dto = dtoFor({ vmId });
    const operation = bindStartToReceipt(startOperation(), { receipt: verifiedReceipt(dto), dto });
    provider.setNetworkAdapters('computer-1', adapters); // after the attestation was made, before the start
    const result = await coordinator.execute(operation);
    assert.deepEqual([result.status, result.errorCode], ['FAILED', 'network_not_isolated'], label);
    assert.equal((await provider.inspect(startOperation({ action: 'inspect' }))).state, 'off', label);
  }
});

test('item 2: with no adapter an attested start goes through, and a start a person approved is not held to the network rule', async () => {
  const { vmId, coordinator } = await mockWithComputer();
  const dto = dtoFor({ vmId });
  assert.equal((await coordinator.execute(bindStartToReceipt(startOperation(), { receipt: verifiedReceipt(dto), dto }))).observedState, 'running');
  const person = await mockWithComputer();
  person.provider.setNetworkAdapters('computer-1', [{ connected: true, switchType: 'External' }]);
  const presence = dtoFor({ vmId: person.vmId });
  const started = await person.coordinator.execute(bindStartToReceipt(startOperation(), { receipt: verifiedReceipt(presence, { basis: 'presence' }), dto: presence }));
  assert.deepEqual([started.status, started.observedState], ['SUCCEEDED', 'running'], 'basis presence: a person decided with the network in front of them');
});
