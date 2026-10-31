import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { HyperVEnvironmentProvider } from '../src/runtime/hyperv-environment-provider.mjs';
import { createRetirementJournal } from '../src/runtime/environment-retirement-journal.mjs';
import { createFakeAttestationSigner } from '../src/runtime/fake-attestation-signer.mjs';
import { verifyNetworkAttestation } from '../src/runtime/broker-contract/network-attestation.mjs';

const HEX = 'a'.repeat(64);
const DIGEST = `sha256:${HEX}`;
const OBSERVED_AT = '2026-10-29T12:00:00.000Z';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-hv-broker-'));
const cloneRoot = path.join(tmp, 'clones');
const golden = path.join(tmp, 'golden', 'base.vhdx');
fs.mkdirSync(path.dirname(golden), { recursive: true });
fs.writeFileSync(golden, 'not a real disk');
fs.chmodSync(golden, 0o444);
const writable = path.join(tmp, 'golden', 'writable.vhdx');
fs.writeFileSync(writable, 'x');
const journals = [];
/** Every journal a test opens is closed afterwards (an open SQLite file cannot be deleted on Windows). */
const makeJournal = (options) => { const journal = createRetirementJournal(options); journals.push(journal); return journal; };
test.after(() => {
  for (const journal of journals) journal.close();
  fs.chmodSync(golden, 0o666);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** In-memory stand-in for env-io.ps1: same request shapes, same ownership rules. */
function fakePowerShell() {
  const vms = new Map();
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    const vm = vms.get(request.vmName);
    const owned = () => {
      const n = vm && JSON.parse(vm.notes);
      const e = request.expect;
      const level = e.identity ?? '';
      if (level !== '' && !['vm', 'full'].includes(level)) return false;
      if (level !== '' && e.vmId === undefined) return false; // identity: "vm" / "full" makes the VM id mandatory
      if (level === 'full' && (e.projectId === undefined || e.incarnationId === undefined)) return false;
      return Boolean(n) && n.computerId === e.computerId && n.generation === e.generation
        && (e.vmId === undefined || vm.id === e.vmId)
        && (e.projectId === undefined || n.projectId === e.projectId)
        && (e.incarnationId === undefined || n.incarnationId === e.incarnationId);
    };
    switch (request.method) {
      case 'inspect': return vm ? { ok: true, exists: true, state: vm.state, notes: vm.notes, vmId: vm.id } : { ok: true, exists: false };
      // 'network' is 'inspect' plus the adapter facts (`adapters`, [] unless a test sets them): read in one call so the VM id and the adapters are one observation.
      case 'network': return vm ? { ok: true, exists: true, state: vm.state, notes: vm.notes, vmId: vm.id, adapters: Object.hasOwn(vm, 'adapters') ? vm.adapters : [] } : { ok: true, exists: false };
      case 'create':
        vms.set(request.vmName, { state: 'Off', notes: request.notes, id: randomUUID() });
        return { ok: true, state: 'Off' };
      case 'start':
        if (!owned()) return { ok: false, code: 'invalid_provider_state', notApplied: true };
        vm.state = 'Running';
        return { ok: true, state: vm.state };
      case 'stop':
        if (!owned()) return { ok: false, code: 'invalid_provider_state', notApplied: true };
        vm.state = 'Off';
        return { ok: true, state: vm.state };
      case 'annotate': {
        if (!owned()) return { ok: false, code: 'invalid_provider_state', notApplied: true };
        const have = JSON.parse(vm.notes).incarnationId; // like the script: blank, or the very one being written
        if (have !== undefined && have !== request.incarnationId) return { ok: false, code: 'invalid_provider_state', notApplied: true };
        vm.notes = request.notes;
        return { ok: true, state: vm.state };
      }
      case 'remove':
        if (vm && !owned()) return { ok: false, code: 'invalid_provider_state', notApplied: true };
        vms.delete(request.vmName);
        return { ok: true, state: 'Missing' };
      default: return { ok: false, code: 'invalid_provider_state', notApplied: true };
    }
  };
  return { run, vms, calls, count: (method) => calls.filter((c) => c.method === method).length };
}

function makeBroker(overrides = {}) {
  const ps = overrides.ps ?? fakePowerShell();
  const hashes = [];
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [DIGEST]: { path: golden, os: 'windows', architecture: 'x64' } },
    cloneRoot,
    runPowerShell: ps.run,
    hashFile: async (file) => { hashes.push(file); return HEX; },
    now: () => new Date(OBSERVED_AT),
    ...overrides.options,
  });
  return { broker, ps, hashes };
}

const baseSpec = () => ({
  projectId: 'proj-1', kind: 'ephemeral', os: 'windows', architecture: 'x64', imageDigest: DIGEST,
  capabilities: ['desktop'], networkProfileId: 'isolated-none', securityProfileId: 'sec-1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 40 },
});
function op(action, overrides = {}) {
  const base = {
    operationId: `op-${action}`, idempotencyKey: `key-${action}`, subjectId: 'subject-1', projectId: 'proj-1',
    taskId: 'task-1', runId: 'run-1', computerId: 'pc-01', providerId: 'hyperv', leaseId: 'lease-1',
    expectedGeneration: 1, policyVersion: 1, action,
  };
  if (action === 'create') base.spec = baseSpec();
  return { ...base, ...overrides };
}
const withSpec = (patch) => op('create', { spec: { ...baseSpec(), ...patch } });

async function rejects(promise, code, outcome) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (outcome) assert.equal(error.outcome, outcome);
    assert.equal(error.message, code, 'the message carries only the code');
    return true;
  });
}

test('the broker is a plain object with exactly the fixed methods as own data properties (five lifecycle, retire / purge, scheduled purge, attestNetwork, attestTaskStart)', () => {
  const { broker } = makeBroker();
  assert.equal(Object.getPrototypeOf(broker), Object.prototype);
  assert.deepEqual(Object.keys(broker).sort(), ['attestNetwork', 'attestTaskStart', 'createVm', 'inspectVm', 'purgeExpiredRetirements', 'purgeVm', 'removeVm', 'retireVm', 'startVm', 'stopVm']);
  for (const d of Object.values(Object.getOwnPropertyDescriptors(broker))) assert.equal(typeof d.value, 'function');
  assert.doesNotThrow(() => new HyperVEnvironmentProvider({ broker }));
});

test('configuration is validated: relative paths, bad ledger keys, and a golden image inside cloneRoot are refused', () => {
  const entry = { path: golden, os: 'windows', architecture: 'x64' };
  const make = (patch) => () => createHyperVEnvironmentBrokerPrototype({ goldenImages: { [DIGEST]: entry }, cloneRoot, ...patch });
  assert.doesNotThrow(make({}));
  assert.throws(make({ cloneRoot: 'relative/clones' }), TypeError);
  assert.throws(make({ goldenImages: { 'not-a-digest': entry } }), TypeError);
  assert.throws(make({ goldenImages: { [DIGEST]: { ...entry, path: 'base.vhdx' } } }), TypeError);
  assert.throws(make({ goldenImages: { [DIGEST]: { ...entry, path: path.join(cloneRoot, 'base.vhdx') } } }), TypeError);
  assert.throws(make({ goldenImages: undefined }), TypeError);
});

test('create refuses a digest that is not in the ledger, before touching PowerShell', async () => {
  const { broker, ps } = makeBroker();
  await rejects(broker.createVm(withSpec({ imageDigest: `sha256:${'b'.repeat(64)}` })), 'invalid_provider_state', 'not_applied');
  assert.equal(ps.calls.length, 0);
});

test('create refuses an os or architecture that disagrees with the ledger', async () => {
  const { broker, ps } = makeBroker();
  await rejects(broker.createVm(withSpec({ os: 'linux' })), 'invalid_provider_state', 'not_applied');
  await rejects(broker.createVm(withSpec({ architecture: 'arm64' })), 'invalid_provider_state', 'not_applied');
  assert.equal(ps.calls.length, 0);
});

test('create accepts only the isolated-none network profile', async () => {
  const { broker, ps } = makeBroker();
  await rejects(broker.createVm(withSpec({ networkProfileId: 'internet' })), 'invalid_provider_state', 'not_applied');
  assert.equal(ps.calls.length, 0);
});

test('computerId must fit the stricter VM-name alphabet', async () => {
  const { broker, ps } = makeBroker();
  for (const computerId of ['pc.01', 'pc_01', 'pc:01', 'a'.repeat(58), 'a'.repeat(64), '..']) {
    await rejects(broker.createVm(op('create', { computerId })), 'invalid_provider_state', 'not_applied');
    await rejects(broker.removeVm(op('destroy', { computerId })), 'invalid_provider_state', 'not_applied');
  }
  assert.equal(ps.calls.length, 0);
  // "albera-" + 57 chars = 64, the longest VM name the desktop driver accepts.
  await broker.createVm(op('create', { computerId: 'A'.repeat(57) }));
  assert.equal(ps.calls[0].vmName, `albera-${'A'.repeat(57)}`);
});

test('an operation of another action or provider is refused', async () => {
  const { broker } = makeBroker();
  await rejects(broker.startVm(op('stop')), 'invalid_provider_state', 'not_applied');
  await rejects(broker.createVm(op('create', { providerId: 'mock' })), 'invalid_provider_state', 'not_applied');
});

test('create refuses a tampered golden image and a writable one', async () => {
  const wrongHash = makeBroker({ options: { hashFile: async () => 'c'.repeat(64) } });
  await rejects(wrongHash.broker.createVm(op('create')), 'invalid_provider_state', 'not_applied');
  assert.equal(wrongHash.ps.count('create'), 0);

  const key = `sha256:${'d'.repeat(64)}`;
  const writableBroker = makeBroker({ options: {
    goldenImages: { [key]: { path: writable, os: 'windows', architecture: 'x64' } },
    hashFile: async () => 'd'.repeat(64),
  } });
  await rejects(writableBroker.broker.createVm(withSpec({ imageDigest: key })), 'invalid_provider_state', 'not_applied');

  const missing = makeBroker({ options: { goldenImages: { [DIGEST]: { path: path.join(tmp, 'gone.vhdx'), os: 'windows', architecture: 'x64' } } } });
  await rejects(missing.broker.createVm(op('create')), 'invalid_provider_state', 'not_applied');
});

test('create sends fixed paths from trusted config, tags the VM, and ignores diskGiB', async () => {
  const { broker, ps } = makeBroker();
  const result = await broker.createVm(op('create', { expectedGeneration: 3 }));
  assert.deepEqual(result, { computerId: 'pc-01', providerId: 'hyperv', state: 'off', generation: 3, observedAt: OBSERVED_AT });
  const request = ps.calls.find((c) => c.method === 'create');
  assert.equal(request.vmName, 'albera-pc-01');
  assert.equal(request.parentPath, golden);
  assert.equal(request.cloneRoot, cloneRoot);
  assert.equal(request.vmDir, path.join(cloneRoot, 'albera-pc-01'));
  assert.equal(request.childPath, path.join(cloneRoot, 'albera-pc-01', 'albera-pc-01.vhdx'));
  assert.equal(request.vcpu, 2);
  assert.equal(request.memoryMiB, 2048);
  assert.equal(Object.hasOwn(request, 'diskGiB'), false);
  assert.deepEqual(JSON.parse(request.notes), { albera: 1, computerId: 'pc-01', generation: 3, imageDigest: DIGEST, projectId: 'proj-1' });
});

test('create is idempotent for the same identity and conflicts otherwise', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  const again = await broker.createVm(op('create'));
  assert.equal(again.state, 'off');
  assert.equal(ps.count('create'), 1);

  await rejects(broker.createVm(op('create', { expectedGeneration: 2 })), 'operation_conflict', 'not_applied');
  const other = `sha256:${'e'.repeat(64)}`;
  const two = makeBroker({ ps, options: {
    goldenImages: { [DIGEST]: { path: golden, os: 'windows', architecture: 'x64' }, [other]: { path: golden, os: 'windows', architecture: 'x64' } },
    hashFile: async () => 'e'.repeat(64),
  } });
  await rejects(two.broker.createVm(withSpec({ imageDigest: other })), 'operation_conflict', 'not_applied');
  assert.equal(ps.count('create'), 1);

  ps.vms.set('albera-pc-02', { state: 'Off', notes: 'someone else wrote this' });
  await rejects(broker.createVm(op('create', { computerId: 'pc-02' })), 'operation_conflict', 'not_applied');
});

test('the golden image hash is computed once per file version within a broker', async () => {
  const { broker, hashes } = makeBroker();
  await broker.createVm(op('create', { computerId: 'pc-01' }));
  await broker.createVm(op('create', { computerId: 'pc-02' }));
  assert.equal(hashes.length, 1);
});

test('inspect: missing VM echoes the expected generation; existing VM reports the Notes generation', async () => {
  const { broker, ps } = makeBroker();
  const missing = await broker.inspectVm(op('inspect', { expectedGeneration: 5 }));
  assert.equal(missing.state, 'missing');
  assert.equal(missing.generation, 5);

  await broker.createVm(op('create', { expectedGeneration: 2 }));
  const existing = await broker.inspectVm(op('inspect', { expectedGeneration: 9 }));
  assert.equal(existing.generation, 2);

  for (const [hyperv, expected] of [['Running', 'running'], ['Off', 'off'], ['Paused', 'paused'], ['Saved', 'paused'], ['Starting', 'unknown'], ['Weird', 'unknown']]) {
    ps.vms.get('albera-pc-01').state = hyperv;
    assert.equal((await broker.inspectVm(op('inspect'))).state, expected, hyperv);
  }
});

test('inspect never touches a same-name VM that is not ours or belongs to another computer', async () => {
  const { broker, ps } = makeBroker();
  ps.vms.set('albera-pc-01', { state: 'Running', notes: 'plain notes' });
  await rejects(broker.inspectVm(op('inspect')), 'invalid_provider_state', 'not_applied');
  ps.vms.set('albera-pc-01', { state: 'Running', notes: JSON.stringify({ albera: 1, computerId: 'pc-99', generation: 1, imageDigest: DIGEST }) });
  await rejects(broker.inspectVm(op('inspect')), 'invalid_provider_state', 'not_applied');
});

test('start and stop refuse a stale generation without calling the mutating script', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create', { expectedGeneration: 2 }));
  await rejects(broker.startVm(op('start', { expectedGeneration: 1 })), 'stale_generation', 'not_applied');
  await rejects(broker.stopVm(op('stop', { expectedGeneration: 3 })), 'stale_generation', 'not_applied');
  assert.equal(ps.count('start') + ps.count('stop'), 0);

  assert.equal((await broker.startVm(op('start', { expectedGeneration: 2 }))).state, 'running');
  assert.equal((await broker.stopVm(op('stop', { expectedGeneration: 2 }))).state, 'off');
  const stop = ps.calls.find((c) => c.method === 'stop');
  assert.ok(stop.waitSeconds >= 1, 'the shutdown wait is bounded');
});

test('start with a vmId (the VM the approval named) starts only that very Hyper-V VM: the VM that took its computer id, project, lease and generation is refused without touching the script', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  const vmA = ps.vms.get('albera-pc-01').id;
  // Swap: another VM (another Hyper-V id) now sits under the same name, with the same Notes identity (computer, generation, project).
  const notes = ps.vms.get('albera-pc-01').notes;
  ps.vms.set('albera-pc-01', { state: 'Off', notes, id: randomUUID() });
  const vmB = ps.vms.get('albera-pc-01').id;
  assert.notEqual(vmA, vmB);
  await rejects(broker.startVm(op('start', { vmId: vmA })), 'operation_conflict', 'not_applied');
  assert.equal(ps.count('start'), 0, 'refused before the mutating script');
  assert.equal(ps.vms.get('albera-pc-01').state, 'Off');
  const started = await broker.startVm(op('start', { vmId: vmB }));
  assert.equal(started.state, 'running');
  const call = ps.calls.find((c) => c.method === 'start');
  assert.deepEqual([call.expect.vmId, call.expect.identity], [vmB, 'vm'], 'the script gets the VM id as a mandatory identity too');
});

test('start without a vmId behaves as before (no identity is added), and a malformed vmId or a vmId on another action is not an operation', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  assert.equal((await broker.startVm(op('start'))).state, 'running');
  assert.equal(ps.calls.find((c) => c.method === 'start').expect.identity, undefined);
  for (const vmId of ['vm-1', '', 7, 'ABCDEF12-2222-4333-8444-555555555555', null]) await rejects(broker.startVm(op('start', { vmId })), 'invalid_provider_state', 'not_applied');
  await rejects(broker.stopVm(op('stop', { vmId: ps.vms.get('albera-pc-01').id })), 'invalid_provider_state', 'not_applied');
});

// ---- #128: an attested-policy start names the VM and re-reads the network right before it starts ----

test('item 1 (#128): an attested start without a vmId is refused before the script, a start with one runs with the VM id as a mandatory identity', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  const vmId = ps.vms.get('albera-pc-01').id;
  const callsBefore = ps.calls.length;
  await rejects(broker.startVm(op('start', { attestedPolicy: true })), 'invalid_provider_state', 'not_applied');
  await rejects(broker.startVm(op('start', { attestedPolicy: true, vmId: 'vm-1' })), 'invalid_provider_state', 'not_applied');
  assert.equal(ps.calls.length, callsBefore, 'nothing reached the script');
  assert.equal(ps.vms.get('albera-pc-01').state, 'Off');
  assert.equal((await broker.startVm(op('start', { attestedPolicy: true, vmId }))).state, 'running');
  const call = ps.calls.find((c) => c.method === 'start');
  assert.deepEqual([call.expect.vmId, call.expect.identity], [vmId, 'vm']);
});

test('item 1 (#128): an attested start for a VM that is not the one under the computer id is refused, with the network read first and no start', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  const vmA = ps.vms.get('albera-pc-01').id;
  ps.vms.set('albera-pc-01', { state: 'Off', notes: ps.vms.get('albera-pc-01').notes, id: randomUUID() });
  await rejects(broker.startVm(op('start', { attestedPolicy: true, vmId: vmA })), 'operation_conflict', 'not_applied');
  assert.equal(ps.count('start'), 0);
});

test('item 2 (#128): the adapters are read again right before an attested start: none starts the VM, an adapter added after the attestation (or unreadable ones) refuses it before the script starts anything', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  const vm = ps.vms.get('albera-pc-01');
  const attested = op('start', { attestedPolicy: true, vmId: vm.id });
  for (const adapters of [[{ connected: false, switchType: null }], [{ connected: true, switchType: 'External' }], [{ connected: true, switchType: 'Private' }], null, 'none', [{ connected: true }], {}]) {
    vm.adapters = adapters; // added between the attestation and this start
    await rejects(broker.startVm(attested), 'network_not_isolated', 'not_applied');
    assert.equal(ps.count('start'), 0, `${JSON.stringify(adapters)}: the script never started anything`);
    assert.equal(vm.state, 'Off');
  }
  vm.adapters = []; // back to no adapter at all
  assert.equal((await broker.startVm(attested)).state, 'running');
  const methods = ps.calls.map((c) => c.method);
  assert.ok(methods.lastIndexOf('network') < methods.indexOf('start'), 'the network was read before the start');
});

test('item 2 (#128): the network rule is for attested starts only: a start a person approved (with or without a vmId) behaves as before and reads with inspect', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  const vm = ps.vms.get('albera-pc-01');
  vm.adapters = [{ connected: true, switchType: 'External' }];
  assert.equal((await broker.startVm(op('start', { vmId: vm.id }))).state, 'running');
  await broker.stopVm(op('stop'));
  assert.equal((await broker.startVm(op('start'))).state, 'running');
  assert.equal(ps.count('network'), 0, 'no network read for a start that is not attested');
});

test('start of a VM that does not exist, or is not ours, is refused', async () => {
  const { broker, ps } = makeBroker();
  await rejects(broker.startVm(op('start')), 'invalid_provider_state', 'not_applied');
  ps.vms.set('albera-pc-01', { state: 'Off', notes: 'x' });
  await rejects(broker.startVm(op('start')), 'invalid_provider_state', 'not_applied');
  assert.equal(ps.count('start'), 0);
});

test('remove: stale generation deletes nothing; missing VM is already gone', async () => {
  const { broker, ps } = makeBroker();
  assert.equal((await broker.removeVm(op('destroy'))).state, 'missing');
  assert.equal(ps.count('remove'), 0);
  await broker.createVm(op('create', { expectedGeneration: 2 }));
  await rejects(broker.removeVm(op('destroy', { expectedGeneration: 1 })), 'stale_generation', 'not_applied');
  assert.equal(ps.count('remove'), 0);
  assert.equal(ps.vms.has('albera-pc-01'), true);
});

test('remove only ever names a folder directly inside cloneRoot and never the golden image', async () => {
  const { broker, ps } = makeBroker();
  await broker.createVm(op('create'));
  const result = await broker.removeVm(op('destroy'));
  assert.equal(result.state, 'missing');
  const request = ps.calls.find((c) => c.method === 'remove');
  assert.equal(path.dirname(request.vmDir), cloneRoot);
  assert.equal(path.basename(request.vmDir), 'albera-pc-01');
  assert.notEqual(path.resolve(request.vmDir), path.resolve(path.dirname(golden)));
  for (const value of Object.values(request).filter((v) => typeof v === 'string')) assert.notEqual(value, golden);
  assert.equal(ps.vms.has('albera-pc-01'), false);
});

test('errors from the script are reduced to the safe code set', async () => {
  const hostile = async () => ({ ok: false, code: 'C:\\secret\\path failed', notApplied: true });
  const { broker } = makeBroker({ options: { runPowerShell: hostile } });
  await rejects(broker.inspectVm(op('inspect')), 'provider_unavailable', 'not_applied');

  const throwing = makeBroker({ options: { runPowerShell: async () => { throw Object.assign(new Error('C:\\x'), { code: 'provider_timeout' }); } } });
  await rejects(throwing.broker.inspectVm(op('inspect')), 'provider_timeout', 'unknown');
});

test('a missing pwsh executable is reported as provider_unavailable, not applied', async () => {
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [DIGEST]: { path: golden, os: 'windows', architecture: 'x64' } },
    cloneRoot, pwsh: path.join(tmp, 'no-such-pwsh'), hashFile: async () => HEX,
  });
  await rejects(broker.inspectVm(op('inspect')), 'provider_unavailable', 'not_applied');
});

test('env-io.ps1 is ASCII only (Windows PowerShell 5.1 reads it without a BOM)', () => {
  const bytes = fs.readFileSync(new URL('../src/runtime/hyperv-env/env-io.ps1', import.meta.url));
  assert.equal(bytes.every((b) => b < 0x80), true);
});

test('HyperVEnvironmentProvider drives create, inspect, start, stop, destroy through the broker', async () => {
  const { broker, ps } = makeBroker();
  const provider = new HyperVEnvironmentProvider({ broker });
  const states = [];
  for (const action of ['create', 'inspect', 'start', 'inspect', 'stop', 'destroy', 'inspect']) {
    const observed = await provider[action](op(action));
    states.push(`${action}:${observed.state}`);
    assert.equal(observed.generation, 1);
  }
  assert.deepEqual(states, ['create:off', 'inspect:off', 'start:running', 'inspect:running', 'stop:off', 'destroy:missing', 'inspect:missing']);
  assert.equal(ps.vms.size, 0);
  await assert.rejects(provider.start(op('start', { expectedGeneration: 1 })), (e) => e.code === 'invalid_provider_state');
});

// Real-machine test: opt in with ALBERA_HYPERV_GOLDEN_VHDX and ALBERA_HYPERV_CLONE_ROOT. Skipped (e.g. in CI) otherwise.
const realGolden = process.env.ALBERA_HYPERV_GOLDEN_VHDX;
const realRoot = process.env.ALBERA_HYPERV_CLONE_ROOT;
async function sha256HexOf(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
test('real Hyper-V: create, start, stop and destroy a clone without touching the golden image', {
  skip: realGolden && realRoot ? false : 'ALBERA_HYPERV_GOLDEN_VHDX and ALBERA_HYPERV_CLONE_ROOT are not set',
  timeout: 20 * 60 * 1000,
}, async () => {
  const digestOf = () => sha256HexOf(realGolden);
  const before = await digestOf();
  const key = `sha256:${before}`;
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [key]: { path: realGolden, os: 'windows', architecture: 'x64' } },
    cloneRoot: realRoot,
  });
  const computerId = `smoke-${Date.now()}`;
  const real = (action) => op(action, { computerId, ...(action === 'create' ? { spec: { ...baseSpec(), imageDigest: key } } : {}) });
  try {
    assert.equal((await broker.createVm(real('create'))).state, 'off');
    assert.equal((await broker.startVm(real('start'))).state, 'running');
    assert.equal((await broker.inspectVm(real('inspect'))).state, 'running');
    assert.equal((await broker.stopVm(real('stop'))).state, 'off');
  }
  finally {
    assert.equal((await broker.removeVm(real('destroy'))).state, 'missing');
  }
  assert.equal((await broker.inspectVm(real('inspect'))).state, 'missing');
  assert.equal(await digestOf(), before, 'the golden image is unchanged');
});

// ---- #115, real machine (same opt-in): no adapter at create, the network attestation, retire, requested purge, scheduled purge ----
// Disposable clones only: every computer id carries this run's id, the golden image is never written (its digest is checked at the end), and each clone is removed in `finally`
// only when its Notes identify it as this run's. The journal file lives under the clone root and is deleted afterwards; the attestation signer is the in-memory fake.
const REAL_SKIP = realGolden && realRoot ? false : 'ALBERA_HYPERV_GOLDEN_VHDX and ALBERA_HYPERV_CLONE_ROOT are not set';
const REAL_OPTIONS = { skip: REAL_SKIP, timeout: 20 * 60 * 1000 };
const ENV_IO_PATH = fileURLToPath(new URL('../src/runtime/hyperv-env/env-io.ps1', import.meta.url));
const REAL_PROJECT = 'proj-1';

/** One direct, read-only look at a VM through the same script, independent of what the Broker makes of it. */
function probeVm(method, vmName) {
  const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', ENV_IO_PATH], { input: JSON.stringify({ method, vmName }), encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return JSON.parse(run.stdout);
}

let realFixtureMemo;
async function realFixture() {
  if (realFixtureMemo) return realFixtureMemo;
  const goldenHex = await sha256HexOf(realGolden);
  const key = `sha256:${goldenHex}`;
  const runId = Date.now().toString(36);
  const journalPath = path.join(realRoot, `.albera-test-journal-${runId}.sqlite`);
  const journal = createRetirementJournal({ filePath: journalPath });
  const signer = createFakeAttestationSigner();
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [key]: { path: realGolden, os: 'windows', architecture: 'x64' } },
    cloneRoot: realRoot, retirements: journal, attestationSigner: signer,
  });
  const ids = [];
  realFixtureMemo = {
    goldenHex, journal, journalPath, signer, broker, ids,
    newId(suffix) { const id = `smoke115-${runId}-${suffix}`; ids.push(id); return id; },
    op: (computerId, action, overrides = {}) => op(action, { computerId, ...(action === 'create' ? { spec: { ...baseSpec(), imageDigest: key } } : {}), ...overrides }),
  };
  return realFixtureMemo;
}
const vmNameOf = (computerId) => `albera-${computerId}`;
const folderOf = (computerId) => path.join(realRoot, vmNameOf(computerId));
const diskOf = (computerId) => path.join(folderOf(computerId), `${vmNameOf(computerId)}.vhdx`);

test.after(() => {
  if (!realFixtureMemo) return;
  realFixtureMemo.journal.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${realFixtureMemo.journalPath}${suffix}`, { force: true });
});

/** Remove a clone of this run, and only that: the Notes must name this run's computer id. Never throws (it runs in `finally`); a failure is printed with what to remove by hand. */
async function removeOwnClone(fx, computerId, t) {
  try {
    const seen = probeVm('inspect', vmNameOf(computerId));
    if (seen.ok !== true || seen.exists !== true) return;
    let notes = null;
    try { notes = JSON.parse(seen.notes); } catch { /* not ours */ }
    if (notes?.albera !== 1 || notes.computerId !== computerId) { t.diagnostic(`cleanup: ${vmNameOf(computerId)} is not this run's clone, left alone`); return; }
    await fx.broker.removeVm(fx.op(computerId, 'destroy'));
  }
  catch (error) {
    t.diagnostic(`CLEANUP FAILED for ${vmNameOf(computerId)} (${error?.code ?? 'error'}): remove the VM and the folder ${folderOf(computerId)} by hand`);
  }
}

const noVmLeft = (computerId) => {
  assert.equal(probeVm('inspect', vmNameOf(computerId)).exists, false, 'the VM is gone');
  assert.equal(fs.existsSync(folderOf(computerId)), false, 'the clone folder is gone');
};

test('real Hyper-V (#115): create leaves no network adapter and attests none; retire keeps the VM; a requested purge deletes it', REAL_OPTIONS, async (t) => {
  const fx = await realFixture();
  const id = fx.newId('a');
  const o = (action, overrides) => fx.op(id, action, overrides);
  try {
    assert.equal((await fx.broker.createVm(o('create'))).state, 'off');
    const facts = probeVm('network', vmNameOf(id));
    assert.deepEqual([facts.ok, facts.exists, facts.adapters], [true, true, []], 'the VM has zero network adapters');
    const created = JSON.parse(facts.notes);
    assert.deepEqual([created.albera, created.computerId, created.generation, created.projectId], [1, id, 1, REAL_PROJECT], 'create wrote the identity and the project into the Notes');
    const vmId = facts.vmId.toLowerCase();
    const attest = async () => {
      const result = await fx.broker.attestNetwork(o('inspect'), { leaseGeneration: 1 });
      const expected = { computerId: id, vmId, generation: 1, projectId: REAL_PROJECT, leaseId: 'lease-1', leaseGeneration: 1 };
      return verifyNetworkAttestation(result, { clock: () => Math.floor(Date.now() / 1000), verify: fx.signer.verify, expected }).network;
    };
    assert.equal(await attest(), 'none');
    t.diagnostic(`create: ${vmNameOf(id)} has 0 adapters, attestation = none, Notes carry project ${REAL_PROJECT}`);

    assert.equal((await fx.broker.startVm(o('start'))).state, 'running');
    const retired = await fx.broker.retireVm(o('retire'));
    assert.equal(retired.state, 'retired');
    assert.equal((await fx.broker.inspectVm(o('inspect'))).state, 'retired');
    assert.equal(probeVm('inspect', vmNameOf(id)).state, 'Off', 'retire stopped the running VM');
    await rejects(fx.broker.startVm(o('start')), 'environment_retired', 'not_applied');
    assert.equal(fs.existsSync(diskOf(id)), true, 'the clone disk is still there');
    const record = fx.journal.get(id);
    const afterRetire = JSON.parse(probeVm('inspect', vmNameOf(id)).notes);
    assert.deepEqual([afterRetire.projectId, afterRetire.incarnationId], [REAL_PROJECT, record.incarnationId], 'the Notes carry the project and the incarnation id');
    assert.equal(record.vmId, vmId, 'the record is bound to the VM own id');
    assert.equal(await attest(), 'none', 'a retired VM still attests none');
    t.diagnostic(`retire: state retired, VM Off, start refused (environment_retired), disk kept, Notes carry project + incarnation ${record.incarnationId}`);

    assert.equal((await fx.broker.purgeVm(o('purge'))).state, 'missing');
    noVmLeft(id);
    assert.equal(fx.journal.get(id), null, 'the retirement record was dropped');
    t.diagnostic('requested purge: VM, disk and clone folder gone, record dropped');
  }
  finally { await removeOwnClone(fx, id, t); }
});

test('real Hyper-V (#115): scheduled purge with an injected clock deletes a retired clone only at its deadline', REAL_OPTIONS, async (t) => {
  const fx = await realFixture();
  const id = fx.newId('b');
  const o = (action, overrides) => fx.op(id, action, overrides);
  try {
    assert.equal((await fx.broker.createVm(o('create'))).state, 'off');
    assert.equal((await fx.broker.retireVm(o('retire'))).state, 'retired');
    const record = fx.journal.get(id);
    assert.deepEqual(await fx.broker.purgeExpiredRetirements({ now: record.deadlineMs - 1 }), [], 'nothing is due before the deadline');
    assert.equal(probeVm('inspect', vmNameOf(id)).exists, true);
    assert.equal(fs.existsSync(diskOf(id)), true);
    assert.deepEqual(await fx.broker.purgeExpiredRetirements({ now: record.deadlineMs }), [{ computerId: id, outcome: 'purged' }]);
    noVmLeft(id);
    assert.equal(fx.journal.get(id), null);
    t.diagnostic(`scheduled purge: nothing at deadline-1ms, purged at the deadline (${new Date(record.deadlineMs).toISOString()}); VM, folder and record gone`);
  }
  finally { await removeOwnClone(fx, id, t); }
});

test('real Hyper-V (#115): destroy of a normal (never retired) clone is unchanged', REAL_OPTIONS, async (t) => {
  const fx = await realFixture();
  const id = fx.newId('c');
  const o = (action, overrides) => fx.op(id, action, overrides);
  try {
    assert.equal((await fx.broker.createVm(o('create'))).state, 'off');
    assert.equal(fx.journal.get(id), null, 'no retirement record');
    assert.equal((await fx.broker.removeVm(o('destroy'))).state, 'missing');
    noVmLeft(id);
    assert.equal((await fx.broker.removeVm(o('destroy'))).state, 'missing', 'destroying it again is still fine');
    t.diagnostic('destroy: VM and folder gone, no record involved, a repeat is a no-op');
  }
  finally { await removeOwnClone(fx, id, t); }
});

test('real Hyper-V (#115): nothing of this run is left and the golden image is unchanged', REAL_OPTIONS, async (t) => {
  const fx = await realFixture();
  for (const id of fx.ids) noVmLeft(id);
  assert.deepEqual(fx.journal.list(), [], 'the journal is empty');
  assert.equal(await sha256HexOf(realGolden), fx.goldenHex, 'the golden image is unchanged');
  t.diagnostic(`clean: ${fx.ids.length} clones removed, journal empty, golden sha256 ${fx.goldenHex.slice(0, 12)}... unchanged`);
});

// ---- #115 step 1: retire / purge / scheduled purge (the retirement record is the Broker's own) ----
const T0 = Date.parse('2026-10-31T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function retiringBroker({ filePath, retentionMs } = {}) {
  const state = { ms: T0 };
  const journal = makeJournal({ filePath, nowMs: () => state.ms, retentionMs });
  const made = makeBroker({ options: { retirements: journal } });
  return { ...made, journal, state };
}

test('retire stops a running VM, keeps its disks, records the retirement, and later start / create are refused', async () => {
  const { broker, ps, journal } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.startVm(op('start'));
  const observed = await broker.retireVm(op('retire'));
  assert.equal(observed.state, 'retired');
  assert.equal(ps.vms.get('albera-pc-01').state, 'Off');
  assert.equal(ps.count('remove'), 0, 'retire keeps every disk');
  const { incarnationId, vmId, ...rest } = journal.get('pc-01');
  assert.match(incarnationId, /^[a-f0-9]{32}$/);
  assert.equal(vmId, ps.vms.get('albera-pc-01').id, 'bound to the VM own hypervisor id');
  assert.deepEqual(rest, { computerId: 'pc-01', projectId: 'proj-1', generation: 1, retiredAtMs: T0, deadlineMs: T0 + 7 * DAY });
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'retired');
  await rejects(broker.startVm(op('start')), 'environment_retired', 'not_applied');
  await rejects(broker.createVm(op('create')), 'operation_conflict', 'not_applied');
  assert.equal(ps.count('start'), 1);
  assert.equal(ps.count('create'), 1);
});

test('retire is idempotent (the first deadline stands) and refuses a missing VM, a stale generation, another project, or a Broker without a journal', async () => {
  const { broker, ps, journal, state } = retiringBroker();
  await rejects(broker.retireVm(op('retire')), 'invalid_provider_state', 'not_applied');
  await broker.createVm(op('create'));
  await rejects(broker.retireVm(op('retire', { expectedGeneration: 2 })), 'stale_generation', 'not_applied');
  await broker.retireVm(op('retire'));
  const first = journal.get('pc-01');
  state.ms += 3 * DAY;
  assert.equal((await broker.retireVm(op('retire'))).state, 'retired');
  assert.deepEqual(journal.get('pc-01'), first);
  await rejects(broker.retireVm(op('retire', { projectId: 'proj-2' })), 'operation_conflict', 'not_applied');

  const bare = makeBroker();
  await bare.broker.createVm(op('create'));
  await rejects(bare.broker.retireVm(op('retire')), 'invalid_provider_state', 'not_applied');
  await rejects(bare.broker.purgeVm(op('purge')), 'invalid_provider_state', 'not_applied');
  assert.equal(bare.ps.vms.get('albera-pc-01').state, 'Off');
  assert.equal(ps.count('remove'), 0);
});

test('purge refuses a VM that is not retired and deletes a retired one; destroy still deletes at once', async () => {
  const { broker, ps, journal } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.startVm(op('start'));
  await rejects(broker.purgeVm(op('purge')), 'environment_not_retired', 'not_applied');
  assert.equal(ps.count('remove'), 0);
  assert.equal(ps.vms.get('albera-pc-01').state, 'Running');

  await broker.retireVm(op('retire'));
  await rejects(broker.purgeVm(op('purge', { projectId: 'proj-2' })), 'environment_not_retired', 'not_applied');
  await rejects(broker.purgeVm(op('purge', { expectedGeneration: 2 })), 'stale_generation', 'not_applied');
  assert.equal(ps.count('remove'), 0);
  const purged = await broker.purgeVm(op('purge'));
  assert.equal(purged.state, 'missing');
  assert.equal(ps.count('remove'), 1);
  assert.equal(ps.vms.has('albera-pc-01'), false);
  assert.deepEqual(journal.list(), []);
  assert.equal((await broker.purgeVm(op('purge'))).state, 'missing', 'repeat is already gone');

  await broker.createVm(op('create'));
  assert.equal((await broker.removeVm(op('destroy'))).state, 'missing', 'destroy needs no retirement');
  assert.equal(ps.count('remove'), 2);
});

test('destroy of a retired VM leaves no record, so the id can be created again and is not retired', async () => {
  const { broker, journal } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  assert.equal((await broker.removeVm(op('destroy'))).state, 'missing');
  assert.deepEqual(journal.list(), []);
  await broker.createVm(op('create'));
  assert.equal((await broker.startVm(op('start'))).state, 'running');
});

test('purge sends the script the same request shape as destroy, plus the full retirement identity: only the fixed folder under cloneRoot, never the golden image', async () => {
  const { broker, ps } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  await broker.purgeVm(op('purge'));
  const request = ps.calls.find((c) => c.method === 'remove');
  assert.equal(path.dirname(request.vmDir), cloneRoot);
  assert.equal(path.basename(request.vmDir), 'albera-pc-01');
  assert.deepEqual({ ...request.expect, incarnationId: undefined, vmId: undefined }, { computerId: 'pc-01', generation: 1, projectId: 'proj-1', incarnationId: undefined, vmId: undefined, identity: 'full' });
  assert.equal(request.expect.vmId, ps.vms.size === 0 ? request.expect.vmId : ps.vms.get('albera-pc-01').id);
  assert.match(request.expect.incarnationId, /^[a-f0-9]{32}$/);
  for (const value of Object.values(request).filter((v) => typeof v === 'string')) assert.notEqual(value, golden);
});

test('scheduled purge removes only VMs whose own record has passed its deadline (clock injected); nothing else is touched', async () => {
  const { broker, ps, journal, state } = retiringBroker();
  for (const id of ['old-one', 'young-one', 'plain-one']) await broker.createVm(op('create', { computerId: id }));
  await broker.startVm(op('start', { computerId: 'plain-one' }));
  await broker.retireVm(op('retire', { computerId: 'old-one' }));
  state.ms += 5 * DAY;
  await broker.retireVm(op('retire', { computerId: 'young-one' }));
  const oldDeadline = journal.get('old-one').deadlineMs;

  assert.deepEqual(await broker.purgeExpiredRetirements({ now: oldDeadline - 1 }), []);
  assert.equal(ps.count('remove'), 0);
  assert.deepEqual(await broker.purgeExpiredRetirements({ now: oldDeadline }), [{ computerId: 'old-one', outcome: 'purged' }]);
  assert.deepEqual([...ps.vms.keys()].sort(), ['albera-plain-one', 'albera-young-one']);
  assert.equal(ps.vms.get('albera-plain-one').state, 'Running', 'a VM with no retirement record is never purged');
  assert.deepEqual(journal.list().map((r) => r.computerId), ['young-one']);
  assert.equal(ps.count('remove'), 1);

  state.ms = oldDeadline + 100 * DAY;
  assert.deepEqual(await broker.purgeExpiredRetirements(), [{ computerId: 'young-one', outcome: 'purged' }], 'without an argument the Broker clock decides');
  assert.deepEqual([...ps.vms.keys()], ['albera-plain-one']);
});

test('scheduled purge reaps a record whose VM is already gone, skips a VM that is not the recorded incarnation, and reports a failed removal', async () => {
  const { broker, ps, journal } = retiringBroker({ retentionMs: 1000 });
  for (const id of ['gone', 'moved', 'broken']) {
    await broker.createVm(op('create', { computerId: id }));
    await broker.retireVm(op('retire', { computerId: id }));
  }
  ps.vms.delete('albera-gone');
  ps.vms.get('albera-moved').notes = JSON.stringify({ albera: 1, computerId: 'moved', generation: 9, imageDigest: DIGEST });
  const failing = makeBroker({
    ps,
    options: {
      retirements: journal,
      runPowerShell: async (request) => (request.method === 'remove' && request.vmName === 'albera-broken' ? { ok: false, code: 'provider_timeout' } : ps.run(request)),
    },
  });
  const results = await failing.broker.purgeExpiredRetirements({ now: T0 + 1000 });
  assert.deepEqual(results, [
    { computerId: 'broken', outcome: 'failed', code: 'provider_timeout' },
    { computerId: 'gone', outcome: 'already_missing' },
    { computerId: 'moved', outcome: 'skipped' },
  ]);
  assert.deepEqual(journal.list().map((r) => r.computerId), ['broken', 'moved'], 'only finished purges drop their record');
  assert.equal(ps.vms.has('albera-moved'), true);
  assert.equal(ps.vms.has('albera-broken'), true);
});

test('a retirement survives a Broker restart: a new Broker over the same file purges from the stored deadline', async () => {
  const filePath = path.join(tmp, 'hv-retirements.sqlite');
  const first = retiringBroker({ filePath });
  await first.broker.createVm(op('create'));
  await first.broker.retireVm(op('retire'));
  const recorded = first.journal.get('pc-01');

  // Restart: new journal object over the same file, the same (fake) hypervisor, a clock one millisecond short of the stored deadline.
  const later = { ms: recorded.deadlineMs - 1 };
  const journal2 = makeJournal({ filePath, nowMs: () => later.ms });
  assert.deepEqual(journal2.get('pc-01'), recorded);
  const second = makeBroker({ ps: first.ps, options: { retirements: journal2 } });
  assert.equal((await second.broker.inspectVm(op('inspect'))).state, 'retired');
  await rejects(second.broker.startVm(op('start')), 'environment_retired', 'not_applied');
  assert.deepEqual(await second.broker.purgeExpiredRetirements(), []);
  later.ms += 1;
  assert.deepEqual(await second.broker.purgeExpiredRetirements(), [{ computerId: 'pc-01', outcome: 'purged' }]);
  assert.equal(first.ps.vms.size, 0);
  assert.deepEqual(makeJournal({ filePath }).list(), []);
});

test('the retirement journal is host configuration: a malformed one is refused when the Broker is built', () => {
  for (const retirements of [null, {}, { retire() {}, get() {}, remove() {} }]) {
    assert.throws(() => makeBroker({ options: { retirements } }), TypeError);
  }
});

test('HyperVEnvironmentProvider drives retire then purge, maps the new safe codes, and leaves them unimplemented on a Broker without the methods', async () => {
  const { broker, ps } = retiringBroker();
  const provider = new HyperVEnvironmentProvider({ broker });
  await provider.create(op('create'));
  await provider.start(op('start'));
  await assert.rejects(provider.purge(op('purge')), (e) => e.code === 'environment_not_retired' && e.outcome === 'not_applied');
  assert.equal((await provider.retire(op('retire'))).state, 'retired');
  await assert.rejects(provider.start(op('start')), (e) => e.code === 'environment_retired' && e.outcome === 'not_applied');
  assert.equal((await provider.purge(op('purge'))).state, 'missing');
  assert.equal(ps.vms.size, 0);

  const { createVm, inspectVm, startVm, stopVm, removeVm } = broker;
  const old = new HyperVEnvironmentProvider({ broker: { createVm, inspectVm, startVm, stopVm, removeVm } });
  await assert.rejects(old.retire(op('retire')), (e) => e.code === 'provider_not_implemented' && e.outcome === 'not_applied');
  await assert.rejects(old.purge(op('purge')), (e) => e.code === 'provider_not_implemented' && e.outcome === 'not_applied');
});

// ---- #115 step 1, review round: incarnation identity, missing-VM purge, two writers, destroy crash safety ----
const noteOf = (ps, name) => JSON.parse(ps.vms.get(name).notes);
const FOREIGN_INCARNATION = 'f'.repeat(32);

test('retire writes the incarnation id and the project into the VM Notes once; a repeat does not rewrite them', async () => {
  const { broker, ps, journal } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  const record = journal.get('pc-01');
  assert.match(record.incarnationId, /^[a-f0-9]{32}$/);
  assert.deepEqual(noteOf(ps, 'albera-pc-01'), {
    albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST, projectId: 'proj-1', incarnationId: record.incarnationId,
  });
  assert.equal(ps.count('annotate'), 1);
  await broker.retireVm(op('retire'));
  assert.equal(ps.count('annotate'), 1);
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'retired');
});

test('retire interrupted after the record was written is finished by a retry; until then nothing matches the VM (finding 1)', async () => {
  const { broker, ps, journal, state } = retiringBroker({ retentionMs: 1000 });
  await broker.createVm(op('create'));
  const failing = makeBroker({
    ps, options: { retirements: journal, runPowerShell: async (request) => (request.method === 'annotate' ? { ok: false, code: 'provider_timeout' } : ps.run(request)) },
  });
  await rejects(failing.broker.retireVm(op('retire')), 'provider_timeout', 'unknown');
  assert.notEqual(journal.get('pc-01'), null, 'the record exists');
  assert.equal(noteOf(ps, 'albera-pc-01').incarnationId, undefined, 'the Notes do not carry it yet');
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'off', 'not reported as retired until the Notes agree');
  await rejects(broker.purgeVm(op('purge')), 'environment_not_retired', 'not_applied');
  assert.deepEqual(await broker.purgeExpiredRetirements({ now: state.ms + 1000 }), [{ computerId: 'pc-01', outcome: 'skipped' }]);
  assert.equal(ps.count('remove'), 0);
  assert.equal((await broker.retireVm(op('retire'))).state, 'retired');
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'retired');
  assert.deepEqual(await broker.purgeExpiredRetirements({ now: state.ms + 1000 }), [{ computerId: 'pc-01', outcome: 'purged' }]);
});

test('a VM that is not the recorded incarnation is never purged: reused id in another project, restored backup, or another incarnation id (finding 1)', async () => {
  const { broker, ps, journal } = retiringBroker({ retentionMs: 1000 });
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  const record = journal.get('pc-01');
  const original = ps.vms.get('albera-pc-01').notes;
  const variants = {
    'restored from before the retirement (no identity in the Notes)': { albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST },
    'same fields, another incarnation id': { ...JSON.parse(original), incarnationId: FOREIGN_INCARNATION },
    'same incarnation id but another project': { ...JSON.parse(original), projectId: 'proj-2' },
    'same id and generation reused in another project': { albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST, projectId: 'proj-2', incarnationId: FOREIGN_INCARNATION },
    'malformed identity': { ...JSON.parse(original), incarnationId: 'not-hex' },
  };
  for (const [name, notes] of Object.entries(variants)) {
    ps.vms.get('albera-pc-01').notes = JSON.stringify(notes);
    assert.deepEqual(await broker.purgeExpiredRetirements({ now: record.deadlineMs }), [{ computerId: 'pc-01', outcome: 'skipped' }], name);
    await rejects(broker.purgeVm(op('purge')), name.includes('malformed') ? 'invalid_provider_state' : 'environment_not_retired', 'not_applied');
    assert.equal(ps.count('remove'), 0, name);
    assert.equal(ps.vms.has('albera-pc-01'), true, name);
    assert.deepEqual(journal.get('pc-01'), record, `${name}: record kept`);
    if (!name.includes('malformed')) assert.notEqual((await broker.inspectVm(op('inspect'))).state, 'retired', name);
  }
  // The script is the last line of defence: it is told the full identity and refuses a VM whose Notes differ.
  ps.vms.get('albera-pc-01').notes = original;
  await broker.purgeExpiredRetirements({ now: record.deadlineMs });
  const request = ps.calls.find((c) => c.method === 'remove');
  assert.deepEqual(request.expect, { computerId: 'pc-01', generation: 1, vmId: record.vmId, projectId: 'proj-1', incarnationId: record.incarnationId, identity: 'full' });
  assert.equal(ps.vms.has('albera-pc-01'), false);
});

test('requested purge of a missing VM checks the record against the request first; a mismatch leaves the record alone (finding 2)', async () => {
  const { broker, ps, journal } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  const record = journal.get('pc-01');
  ps.vms.delete('albera-pc-01');
  await rejects(broker.purgeVm(op('purge', { projectId: 'proj-2' })), 'environment_not_retired', 'not_applied');
  await rejects(broker.purgeVm(op('purge', { expectedGeneration: 2 })), 'environment_not_retired', 'not_applied');
  assert.deepEqual(journal.get('pc-01'), record);
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'unknown');
  assert.equal((await broker.purgeVm(op('purge'))).state, 'missing');
  assert.equal(journal.get('pc-01'), null);
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'missing');
  assert.equal((await broker.purgeVm(op('purge', { projectId: 'proj-2' }))).state, 'missing', 'no record, nothing to protect');
});

test('two Brokers on the same store retire different VMs and both records are kept (finding 3)', async () => {
  const filePath = path.join(tmp, 'hv-two-writers.sqlite');
  const one = retiringBroker({ filePath });
  const two = makeBroker({ ps: one.ps, options: { retirements: makeJournal({ filePath, nowMs: () => T0 }) } }); // opened before either retired anything
  await one.broker.createVm(op('create', { computerId: 'pc-a' }));
  await one.broker.createVm(op('create', { computerId: 'pc-b' }));
  await one.broker.retireVm(op('retire', { computerId: 'pc-a' }));
  await two.broker.retireVm(op('retire', { computerId: 'pc-b' }));
  const reader = makeJournal({ filePath });
  assert.deepEqual(reader.list().map((r) => r.computerId), ['pc-a', 'pc-b']);
  assert.equal((await one.broker.inspectVm(op('inspect', { computerId: 'pc-b' }))).state, 'retired', 'each Broker sees the other retirement at once');
  await rejects(one.broker.startVm(op('start', { computerId: 'pc-b' })), 'environment_retired', 'not_applied');
});

test('destroy crash safety: a VM removed before its record was dropped is completed by the retry, and create works afterwards (finding 5)', async () => {
  const { broker, ps, journal } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  // The Broker died after the script removed the VM and before the record was dropped.
  ps.vms.delete('albera-pc-01');
  assert.notEqual(journal.get('pc-01'), null);
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'unknown', 'not a finished destroy yet');
  await rejects(broker.createVm(op('create')), 'operation_conflict', 'not_applied');
  assert.equal((await broker.removeVm(op('destroy'))).state, 'missing');
  assert.equal(journal.get('pc-01'), null, 'the retry dropped the matching record');
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'missing');
  assert.equal((await broker.createVm(op('create'))).state, 'off');
  assert.equal((await broker.startVm(op('start'))).state, 'running');
});

test('destroy: a record that cannot be dropped is an error with an unknown outcome, never success; the retry completes it (finding 5)', async () => {
  const { broker: first, ps, journal } = retiringBroker();
  await first.createVm(op('create'));
  await first.retireVm(op('retire'));
  let failDrop = true;
  const flaky = { ...journal, remove: (...args) => { if (failDrop) throw new Error('disk full'); return journal.remove(...args); } };
  const { broker } = makeBroker({ ps, options: { retirements: flaky } });
  await rejects(broker.removeVm(op('destroy')), 'provider_state_unknown', 'unknown');
  assert.equal(ps.vms.has('albera-pc-01'), false, 'the VM is gone');
  assert.notEqual(journal.get('pc-01'), null);
  await rejects(broker.removeVm(op('destroy')), 'provider_state_unknown', 'unknown');
  await rejects(broker.purgeVm(op('purge')), 'provider_state_unknown', 'unknown');
  failDrop = false;
  assert.equal((await broker.removeVm(op('destroy'))).state, 'missing');
  assert.equal(journal.get('pc-01'), null);
  assert.equal((await broker.createVm(op('create'))).state, 'off');
});

test('a journal that cannot be read stops start and create before anything changes', async () => {
  const { ps, journal } = retiringBroker();
  const broken = { ...journal, get: () => { throw new Error('unreadable'); } };
  const { broker } = makeBroker({ ps, options: { retirements: broken } });
  await rejects(broker.createVm(op('create')), 'provider_state_unknown', 'not_applied');
  assert.equal(ps.count('create'), 0);
});

// ---- round 2: the record is bound to the VM's own hypervisor id (Notes alone cannot tell a restored VM from the retired one) ----
const GUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const restoredCopy = (ps, notes) => { ps.vms.get('albera-pc-01').id = randomUUID(); ps.vms.get('albera-pc-01').notes = notes; };
const blankNotes = () => JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 1, imageDigest: DIGEST });

test('a restored VM with blank Notes and another VM id is never relabelled, stopped, purged or destroyed (round 2, findings 1 and 2)', async () => {
  const { broker, ps, journal } = retiringBroker({ retentionMs: 1000 });
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  const record = journal.get('pc-01');
  assert.match(record.vmId, GUID);
  // A backup of the VM is restored: same name, same generation, blank retirement identity, a new hypervisor id. It is running.
  restoredCopy(ps, blankNotes());
  ps.vms.get('albera-pc-01').state = 'Running';
  const notesBefore = ps.vms.get('albera-pc-01').notes;
  const callsBefore = ps.calls.length;

  await rejects(broker.retireVm(op('retire')), 'operation_conflict', 'not_applied');
  await rejects(broker.purgeVm(op('purge')), 'environment_not_retired', 'not_applied');
  await rejects(broker.removeVm(op('destroy')), 'operation_conflict', 'not_applied');
  await rejects(broker.startVm(op('start')), 'environment_retired', 'not_applied');
  assert.deepEqual(await broker.purgeExpiredRetirements({ now: record.deadlineMs }), [{ computerId: 'pc-01', outcome: 'skipped' }]);
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'running', 'not reported as retired');

  assert.deepEqual(ps.calls.slice(callsBefore).filter((c) => c.method !== 'inspect'), [], 'the script was asked to stop, annotate or remove nothing');
  assert.equal(ps.vms.get('albera-pc-01').notes, notesBefore, 'the Notes were not relabelled');
  assert.equal(ps.vms.get('albera-pc-01').state, 'Running');
  assert.deepEqual(journal.get('pc-01'), record, 'record kept');
});

test('Notes text copied onto another VM does not make it the retired one (same fields, other VM id)', async () => {
  const { broker, ps, journal } = retiringBroker({ retentionMs: 1000 });
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  const record = journal.get('pc-01');
  restoredCopy(ps, ps.vms.get('albera-pc-01').notes); // identical Notes, a different VM
  assert.deepEqual(await broker.purgeExpiredRetirements({ now: record.deadlineMs }), [{ computerId: 'pc-01', outcome: 'skipped' }]);
  await rejects(broker.purgeVm(op('purge')), 'environment_not_retired', 'not_applied');
  await rejects(broker.removeVm(op('destroy')), 'operation_conflict', 'not_applied');
  await rejects(broker.retireVm(op('retire')), 'operation_conflict', 'not_applied');
  assert.equal(ps.count('remove'), 0);
  assert.equal(ps.vms.has('albera-pc-01'), true);
});

test('destroy with a record that does not match the VM deletes nothing and keeps the record; with no record it is exactly the old destroy (round 2, finding 2)', async () => {
  const { broker, ps, journal } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  const record = journal.get('pc-01');
  const original = ps.vms.get('albera-pc-01').notes;
  const mismatches = {
    'another VM id': () => { ps.vms.get('albera-pc-01').id = randomUUID(); },
    'another incarnation in the Notes': () => { ps.vms.get('albera-pc-01').notes = JSON.stringify({ ...JSON.parse(original), incarnationId: FOREIGN_INCARNATION }); },
    'another project in the Notes': () => { ps.vms.get('albera-pc-01').notes = JSON.stringify({ ...JSON.parse(original), projectId: 'proj-2' }); },
  };
  const vmId = ps.vms.get('albera-pc-01').id;
  for (const [name, apply] of Object.entries(mismatches)) {
    ps.vms.get('albera-pc-01').id = vmId;
    ps.vms.get('albera-pc-01').notes = original;
    apply();
    await rejects(broker.removeVm(op('destroy')), 'operation_conflict', 'not_applied');
    assert.equal(ps.count('remove'), 0, name);
    assert.equal(ps.vms.has('albera-pc-01'), true, name);
    assert.deepEqual(journal.get('pc-01'), record, name);
  }
  ps.vms.get('albera-pc-01').id = vmId;
  ps.vms.get('albera-pc-01').notes = original;
  await rejects(broker.removeVm(op('destroy', { projectId: 'proj-2' })), 'operation_conflict', 'not_applied');
  assert.equal(ps.count('remove'), 0, 'a request from another project does not destroy the retired VM');
  assert.equal((await broker.removeVm(op('destroy'))).state, 'missing', 'the matching destroy works');
  assert.equal(journal.get('pc-01'), null);
  const sent = ps.calls.find((c) => c.method === 'remove');
  assert.deepEqual(sent.expect, { computerId: 'pc-01', generation: 1, vmId, projectId: 'proj-1', incarnationId: record.incarnationId, identity: 'full' });

  // No record: the old behaviour, byte for byte (the request names only the computer and the generation).
  const plain = retiringBroker();
  await plain.broker.createVm(op('create'));
  await plain.broker.removeVm(op('destroy'));
  assert.deepEqual(plain.ps.calls.find((c) => c.method === 'remove').expect, { computerId: 'pc-01', generation: 1 });
});

test('retire retry after a half-finished retire completes only for the same VM id; the same VM then destroys and purges normally (round 2)', async () => {
  const { broker, ps, journal } = retiringBroker({ retentionMs: 1000 });
  await broker.createVm(op('create'));
  const failing = makeBroker({
    ps, options: { retirements: journal, runPowerShell: async (request) => (request.method === 'annotate' ? { ok: false, code: 'provider_timeout' } : ps.run(request)) },
  });
  await rejects(failing.broker.retireVm(op('retire')), 'provider_timeout', 'unknown');
  const record = journal.get('pc-01');
  assert.equal(record.vmId, ps.vms.get('albera-pc-01').id);
  assert.equal(JSON.parse(ps.vms.get('albera-pc-01').notes).incarnationId, undefined);

  // The same VM, blank Notes: the retry completes and writes the recorded incarnation.
  assert.equal((await broker.retireVm(op('retire'))).state, 'retired');
  assert.deepEqual(journal.get('pc-01'), record, 'same record, same deadline');
  assert.equal(JSON.parse(ps.vms.get('albera-pc-01').notes).incarnationId, record.incarnationId);
  const annotate = ps.calls.filter((c) => c.method === 'annotate').at(-1);
  assert.deepEqual(annotate.expect, { computerId: 'pc-01', generation: 1, vmId: record.vmId, identity: 'vm' });
  assert.equal(annotate.incarnationId, record.incarnationId);
  assert.equal((await broker.inspectVm(op('inspect'))).state, 'retired');
});

test('a half-finished retire (blank Notes, same VM id) can be destroyed, and the record goes with it', async () => {
  const { broker, ps, journal } = retiringBroker();
  await broker.createVm(op('create'));
  const failing = makeBroker({
    ps, options: { retirements: journal, runPowerShell: async (request) => (request.method === 'annotate' ? { ok: false, code: 'provider_timeout' } : ps.run(request)) },
  });
  await rejects(failing.broker.retireVm(op('retire')), 'provider_timeout', 'unknown');
  const record = journal.get('pc-01');
  assert.equal((await broker.removeVm(op('destroy'))).state, 'missing');
  assert.deepEqual(ps.calls.find((c) => c.method === 'remove').expect, { computerId: 'pc-01', generation: 1, vmId: record.vmId, identity: 'vm' });
  assert.equal(journal.get('pc-01'), null);
  assert.equal((await broker.createVm(op('create'))).state, 'off');
});

test('the identity is mandatory on every path that has a record: the script gets the VM id (and, for purge, the full identity) every time', async () => {
  const { broker, ps, journal } = retiringBroker({ retentionMs: 1000 });
  await broker.createVm(op('create'));
  await broker.startVm(op('start'));
  await broker.retireVm(op('retire'));
  const { vmId } = journal.get('pc-01');
  for (const call of ps.calls.filter((c) => ['stop', 'annotate'].includes(c.method) && c.expect.vmId !== undefined)) assert.deepEqual([call.expect.vmId, call.expect.identity], [vmId, 'vm']);
  assert.equal(ps.calls.filter((c) => c.method === 'stop').length, 1);
  assert.equal(ps.calls.find((c) => c.method === 'stop').expect.identity, 'vm', 'the stop inside retire names the VM');
  await broker.purgeVm(op('purge'));
  const remove = ps.calls.find((c) => c.method === 'remove');
  assert.equal(remove.expect.identity, 'full');
  assert.deepEqual([remove.expect.vmId, typeof remove.expect.projectId, typeof remove.expect.incarnationId], [vmId, 'string', 'string']);
  // And the script (here its stand-in) refuses a request that names an identity level but leaves the VM id out.
  await broker.createVm(op('create', { computerId: 'pc-02' }));
  const refused = await ps.run({ method: 'remove', vmName: 'albera-pc-02', cloneRoot, vmDir: path.join(cloneRoot, 'albera-pc-02'), expect: { computerId: 'pc-02', generation: 1, identity: 'vm' } });
  assert.deepEqual([refused.ok, refused.code], [false, 'invalid_provider_state']);
  assert.equal(ps.vms.has('albera-pc-02'), true);
});

test('a retire needs the VM id: a script reply without one is refused before anything changes', async () => {
  const { ps, journal } = retiringBroker();
  const noId = makeBroker({
    ps, options: { retirements: journal, runPowerShell: async (request) => { const r = await ps.run(request); return request.method === 'inspect' && r.exists ? { ...r, vmId: undefined } : r; } },
  });
  await noId.broker.createVm(op('create'));
  await rejects(noId.broker.retireVm(op('retire')), 'invalid_provider_state', 'not_applied');
  assert.equal(ps.count('stop'), 0);
  assert.equal(journal.list().length, 0);
});

test('env-io.ps1 makes the identity mandatory and stays free of string-built commands', () => {
  const text = fs.readFileSync(new URL('../src/runtime/hyperv-env/env-io.ps1', import.meta.url), 'utf8');
  for (const needle of ["$Expect.identity", "$level -eq 'full'", '([string]$Vm.Id) -ine [string]$Expect.vmId', 'vmId = [string]$vm.Id', 'Invoke-Annotate']) assert.ok(text.includes(needle), needle);
  assert.equal(/Invoke-Expression|\biex\b|Start-Process|-Command/i.test(text), false, 'no command is built from a string');
});
