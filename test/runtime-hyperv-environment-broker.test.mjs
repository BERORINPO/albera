import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { HyperVEnvironmentProvider } from '../src/runtime/hyperv-environment-provider.mjs';

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
test.after(() => {
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
      return Boolean(n) && n.computerId === request.expect.computerId && n.generation === request.expect.generation;
    };
    switch (request.method) {
      case 'inspect': return vm ? { ok: true, exists: true, state: vm.state, notes: vm.notes } : { ok: true, exists: false };
      case 'create':
        vms.set(request.vmName, { state: 'Off', notes: request.notes });
        return { ok: true, state: 'Off' };
      case 'start':
        if (!owned()) return { ok: false, code: 'invalid_provider_state', notApplied: true };
        vm.state = 'Running';
        return { ok: true, state: vm.state };
      case 'stop':
        if (!owned()) return { ok: false, code: 'invalid_provider_state', notApplied: true };
        vm.state = 'Off';
        return { ok: true, state: vm.state };
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

test('the broker is a plain object with exactly the five fixed methods as own data properties', () => {
  const { broker } = makeBroker();
  assert.equal(Object.getPrototypeOf(broker), Object.prototype);
  assert.deepEqual(Object.keys(broker).sort(), ['createVm', 'inspectVm', 'removeVm', 'startVm', 'stopVm']);
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
  assert.deepEqual(JSON.parse(request.notes), { albera: 1, computerId: 'pc-01', generation: 3, imageDigest: DIGEST });
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
test('real Hyper-V: create, start, stop and destroy a clone without touching the golden image', {
  skip: realGolden && realRoot ? false : 'ALBERA_HYPERV_GOLDEN_VHDX and ALBERA_HYPERV_CLONE_ROOT are not set',
  timeout: 20 * 60 * 1000,
}, async () => {
  const { createHash } = await import('node:crypto');
  const digestOf = async () => {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(realGolden)) hash.update(chunk);
    return hash.digest('hex');
  };
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
