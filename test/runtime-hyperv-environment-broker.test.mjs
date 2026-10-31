import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { HyperVEnvironmentProvider } from '../src/runtime/hyperv-environment-provider.mjs';
import { createRetirementJournal } from '../src/runtime/environment-retirement-journal.mjs';

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

test('the broker is a plain object with exactly the fixed methods as own data properties (five lifecycle, retire / purge, scheduled purge)', () => {
  const { broker } = makeBroker();
  assert.equal(Object.getPrototypeOf(broker), Object.prototype);
  assert.deepEqual(Object.keys(broker).sort(), ['createVm', 'inspectVm', 'purgeExpiredRetirements', 'purgeVm', 'removeVm', 'retireVm', 'startVm', 'stopVm']);
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

// ---- #115 step 1: retire / purge / scheduled purge (the retirement record is the Broker's own) ----
const T0 = Date.parse('2026-10-31T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function retiringBroker({ filePath, retentionMs } = {}) {
  const state = { ms: T0 };
  const journal = createRetirementJournal({ filePath, nowMs: () => state.ms, retentionMs });
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
  assert.deepEqual(journal.get('pc-01'), { computerId: 'pc-01', projectId: 'proj-1', generation: 1, retiredAtMs: T0, deadlineMs: T0 + 7 * DAY });
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

test('purge sends the script the same request shape as destroy: only the fixed folder under cloneRoot, never the golden image', async () => {
  const { broker, ps } = retiringBroker();
  await broker.createVm(op('create'));
  await broker.retireVm(op('retire'));
  await broker.purgeVm(op('purge'));
  const request = ps.calls.find((c) => c.method === 'remove');
  assert.equal(path.dirname(request.vmDir), cloneRoot);
  assert.equal(path.basename(request.vmDir), 'albera-pc-01');
  assert.deepEqual(request.expect, { computerId: 'pc-01', generation: 1 });
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
  const filePath = path.join(tmp, 'hv-retirements.json');
  const first = retiringBroker({ filePath });
  await first.broker.createVm(op('create'));
  await first.broker.retireVm(op('retire'));
  const recorded = first.journal.get('pc-01');

  // Restart: new journal object over the same file, the same (fake) hypervisor, a clock one millisecond short of the stored deadline.
  const later = { ms: recorded.deadlineMs - 1 };
  const journal2 = createRetirementJournal({ filePath, nowMs: () => later.ms });
  assert.deepEqual(journal2.get('pc-01'), recorded);
  const second = makeBroker({ ps: first.ps, options: { retirements: journal2 } });
  assert.equal((await second.broker.inspectVm(op('inspect'))).state, 'retired');
  await rejects(second.broker.startVm(op('start')), 'environment_retired', 'not_applied');
  assert.deepEqual(await second.broker.purgeExpiredRetirements(), []);
  later.ms += 1;
  assert.deepEqual(await second.broker.purgeExpiredRetirements(), [{ computerId: 'pc-01', outcome: 'purged' }]);
  assert.equal(first.ps.vms.size, 0);
  assert.deepEqual(createRetirementJournal({ filePath }).list(), []);
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
