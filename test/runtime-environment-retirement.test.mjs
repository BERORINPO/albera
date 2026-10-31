// Issue #115 step 1: environment.retire (undoable) and environment.purge (irreversible), the Broker-owned retirement record, and the scheduled purge.
// Nothing here adds a tier, a policy or a no-prompt path: every action is still authorized exactly as before (see the store tests for the approval path).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ENVIRONMENT_ACTIONS, validateEnvironmentOperation } from '../src/runtime/environment-provider.mjs';
import { DEFAULT_RETENTION_MS, RetirementJournalError, createRetirementJournal, purgeExpired } from '../src/runtime/environment-retirement-journal.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';

const T0 = Date.parse('2026-10-31T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const VM = '11111111-2222-4333-8444-555555555555';
const OTHER_VM = '99999999-8888-4777-8666-555555555555';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-retirement-'));
const journals = [];
/** Every journal a test opens is closed afterwards (an open SQLite file cannot be deleted on Windows). */
const makeJournal = (options) => { const journal = createRetirementJournal(options); journals.push(journal); return journal; };
test.after(() => {
  for (const journal of journals) journal.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function clock(start = T0) {
  const state = { ms: start };
  return { now: () => state.ms, iso: () => new Date(state.ms).toISOString(), advance: (ms) => { state.ms += ms; }, set: (ms) => { state.ms = ms; } };
}

const spec = {
  projectId: 'project-a', kind: 'ephemeral', os: 'linux', architecture: 'x64', imageDigest: `sha256:${'b'.repeat(64)}`,
  capabilities: ['terminal'], networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1', resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
};
const op = (action, overrides = {}) => ({
  operationId: `op-${action}`, idempotencyKey: `key-${action}`, subjectId: 'subject-1', projectId: 'project-a', taskId: 'task-1', runId: 'run-1',
  computerId: 'pc-01', providerId: 'mock', leaseId: 'lease-1', expectedGeneration: 1, policyVersion: 1, action,
  ...(action === 'create' ? { spec } : {}), ...overrides,
});
const rejectsWith = (promise, code, outcome = 'not_applied') => assert.rejects(promise, (error) => error.code === code && error.outcome === outcome);

function setup(options = {}) {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now, ...options });
  const provider = new MockEnvironmentProvider({ now: c.iso, retirements: journal });
  return { c, journal, provider };
}

test('retire and purge are new action names; destroy keeps its name and every provider base stub exists', async () => {
  assert.deepEqual(ENVIRONMENT_ACTIONS, ['create', 'inspect', 'start', 'stop', 'destroy', 'retire', 'purge']);
  for (const action of ['retire', 'purge']) assert.equal(validateEnvironmentOperation(op(action)).action, action);
  const { provider } = setup();
  assert.equal(typeof provider.retire, 'function');
  assert.equal(typeof provider.purge, 'function');
});

const INCARNATION = /^[a-f0-9]{32}$/;
/** A record with its random incarnation id checked for shape and removed, so the rest can be compared exactly. */
const withoutIncarnation = (record) => {
  assert.match(record.incarnationId, INCARNATION);
  assert.match(record.vmId, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const { incarnationId: _id, vmId: _vm, ...rest } = record;
  return rest;
};

test('journal: the Broker stamps the time itself; deadline is retirement time + retention (default 7 days); the incarnation id is random and 128 bits', () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now });
  const record = journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, vmId: VM });
  assert.deepEqual(withoutIncarnation(record), { computerId: 'pc-01', projectId: 'project-a', generation: 1, retiredAtMs: T0, deadlineMs: T0 + 7 * DAY });
  assert.equal(DEFAULT_RETENTION_MS, 7 * DAY);
  assert.ok(Object.isFrozen(record));
  const other = makeJournal({ nowMs: c.now, retentionMs: 1000 }).retire({ computerId: 'pc-02', projectId: 'project-a', generation: 1, vmId: VM });
  assert.equal(other.deadlineMs, T0 + 1000);
  assert.notEqual(other.incarnationId, record.incarnationId);
  const ids = new Set(Array.from({ length: 50 }, (_, n) => makeJournal({ nowMs: c.now }).retire({ computerId: `pc-${n}`, projectId: 'project-a', generation: 1, vmId: VM }).incarnationId));
  assert.equal(ids.size, 50, 'no two retirements share an incarnation id');
});

test('journal: caller-supplied times and ids are ignored, and a second retire cannot move or extend the deadline or change the id', () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now });
  const forged = journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, vmId: VM, retiredAtMs: 1, deadlineMs: 2, scheduled: true, incarnationId: 'a'.repeat(32) });
  assert.equal(forged.retiredAtMs, T0);
  assert.equal(forged.deadlineMs, T0 + 7 * DAY);
  assert.notEqual(forged.incarnationId, 'a'.repeat(32));
  c.advance(3 * DAY);
  const again = journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, vmId: VM, retiredAtMs: c.now() });
  assert.deepEqual(again, forged, 'the original record, deadline and incarnation included');
  assert.throws(() => journal.retire({ computerId: 'pc-01', projectId: 'project-b', generation: 1, vmId: VM }), (e) => e instanceof RetirementJournalError && e.code === 'retirement_conflict');
  assert.throws(() => journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 2, vmId: VM }), (e) => e.code === 'retirement_conflict');
  assert.throws(() => journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, vmId: OTHER_VM }), (e) => e.code === 'retirement_conflict', 'another VM under the same id is not this record');
  assert.deepEqual(journal.get('pc-01'), forged);
});

test('journal: invalid identities and a broken clock are refused before anything is recorded', () => {
  const journal = makeJournal({ nowMs: () => T0 });
  for (const bad of [{}, { computerId: 'pc', projectId: 'p', generation: 1 }, { computerId: 'pc', projectId: 'p', generation: 1, vmId: 'not-a-guid' }, { computerId: 'pc 01', projectId: 'p', generation: 1, vmId: VM }, { computerId: 'pc', projectId: 'p', generation: 0, vmId: VM }, { computerId: 'pc', projectId: 'p', generation: 1.5, vmId: VM }]) {
    assert.throws(() => journal.retire(bad), (e) => e.code === 'retirement_invalid');
  }
  const broken = makeJournal({ nowMs: () => -1 });
  assert.throws(() => broken.retire({ computerId: 'pc', projectId: 'p', generation: 1, vmId: VM }), (e) => e.code === 'retirement_clock_invalid');
  assert.deepEqual(broken.list(), []);
  assert.throws(() => createRetirementJournal({ retentionMs: 0 }), TypeError);
  assert.throws(() => createRetirementJournal({ filePath: '' }), TypeError);
});

test('journal: remove deletes only the record of the named incarnation', () => {
  const journal = makeJournal({ nowMs: () => T0 });
  const record = journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, vmId: VM });
  assert.equal(journal.remove('pc-01', 'b'.repeat(32)), false, 'another incarnation under the same id is not touched');
  assert.deepEqual(journal.get('pc-01'), record);
  assert.throws(() => journal.remove('pc-01', 'short'), (e) => e.code === 'retirement_invalid');
  assert.equal(journal.remove('pc-01', record.incarnationId), true);
  assert.equal(journal.remove('pc-01', record.incarnationId), false);
  assert.equal(journal.get('pc-01'), null);
});

test('journal: a record survives a restart (new journal over the same file) and removal is durable too', () => {
  const filePath = path.join(tmp, 'restart.sqlite');
  const c = clock();
  const first = makeJournal({ filePath, nowMs: c.now });
  const record = first.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, vmId: VM });
  first.retire({ computerId: 'pc-02', projectId: 'project-a', generation: 3, vmId: VM });
  first.close();
  c.advance(DAY);
  const second = makeJournal({ filePath, nowMs: c.now });
  assert.deepEqual(second.get('pc-01'), record, 'same retirement time, deadline and incarnation after the restart');
  assert.deepEqual(second.list().map((r) => r.computerId), ['pc-01', 'pc-02']);
  assert.equal(second.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, vmId: VM }).retiredAtMs, T0, 'the restart did not reset the clock on the record');
  assert.equal(second.remove('pc-01', record.incarnationId), true);
  second.close();
  assert.deepEqual(makeJournal({ filePath, nowMs: c.now }).list().map((r) => r.computerId), ['pc-02']);
});

test('journal: two journal objects over the same store keep both records (no lost update from a stale snapshot)', () => {
  const filePath = path.join(tmp, 'two-writers.sqlite');
  const c = clock();
  const a = makeJournal({ filePath, nowMs: c.now });
  const b = makeJournal({ filePath, nowMs: c.now }); // opened before either retired anything
  const recordA = a.retire({ computerId: 'pc-a', projectId: 'project-a', generation: 1, vmId: VM });
  const recordB = b.retire({ computerId: 'pc-b', projectId: 'project-a', generation: 1, vmId: VM });
  assert.deepEqual(a.list().map((r) => r.computerId), ['pc-a', 'pc-b'], 'A sees what B wrote');
  assert.deepEqual(b.list().map((r) => r.computerId), ['pc-a', 'pc-b'], 'B did not overwrite what A wrote');
  assert.deepEqual(makeJournal({ filePath }).list(), [recordA, recordB]);
  // The same environment retired through both gets one record, one deadline and one incarnation.
  c.advance(DAY);
  assert.deepEqual(b.retire({ computerId: 'pc-a', projectId: 'project-a', generation: 1, vmId: VM }), recordA);
  // And a removal by one is seen by the other at once.
  assert.equal(a.remove('pc-b', recordB.incarnationId), true);
  assert.equal(b.get('pc-b'), null);
});

test('journal: a file that is not this schema makes the journal refuse to open (fail closed)', () => {
  const garbage = path.join(tmp, 'garbage.sqlite');
  fs.writeFileSync(garbage, 'this is not a database, not even close to one');
  assert.throws(() => createRetirementJournal({ filePath: garbage }), (e) => e.code === 'retirement_journal_corrupt');

  const newer = path.join(tmp, 'newer.sqlite');
  const newerDb = new DatabaseSync(newer);
  newerDb.prepare('CREATE TABLE retirements (x TEXT)').run();
  newerDb.prepare('PRAGMA user_version = 2').run();
  newerDb.close();
  assert.throws(() => createRetirementJournal({ filePath: newer }), (e) => e.code === 'retirement_journal_corrupt');

  const foreign = path.join(tmp, 'foreign.sqlite');
  const foreignDb = new DatabaseSync(foreign);
  foreignDb.prepare('CREATE TABLE something_else (x TEXT)').run();
  foreignDb.close();
  assert.throws(() => createRetirementJournal({ filePath: foreign }), (e) => e.code === 'retirement_journal_corrupt', 'a database that is not ours is not adopted');

  const tampered = path.join(tmp, 'tampered.sqlite');
  const tamperedDb = new DatabaseSync(tampered);
  tamperedDb.prepare('CREATE TABLE retirements (computer_id TEXT, project_id TEXT, generation INTEGER, vm_id TEXT, incarnation_id TEXT, retired_at_ms INTEGER, deadline_ms INTEGER)').run();
  tamperedDb.prepare('INSERT INTO retirements VALUES (?, ?, ?, ?, ?, ?, ?)').run('pc-01', 'project-a', 1, VM, 'not-an-incarnation-id', T0, T0 + DAY);
  tamperedDb.prepare('PRAGMA user_version = 1').run();
  tamperedDb.close();
  const journal = makeJournal({ filePath: tampered });
  assert.throws(() => journal.get('pc-01'), (e) => e.code === 'retirement_journal_corrupt', 'a row that does not match the record shape is never used');
  assert.throws(() => journal.list(), (e) => e.code === 'retirement_journal_corrupt');
  assert.deepEqual(makeJournal({ filePath: path.join(tmp, 'absent.sqlite') }).list(), [], 'no file yet is an empty journal, not an error');
});

test('journal: a store that cannot be opened is reported, and nothing is recorded', () => {
  assert.throws(() => createRetirementJournal({ filePath: path.join(tmp, 'no-such-dir', 'r.sqlite') }), (e) => e instanceof RetirementJournalError && e.code === 'retirement_journal_unavailable');
});

test('retire stops the environment, keeps it, reports retired, and writes the Broker record', async () => {
  const { provider, journal, c } = setup();
  await provider.create(op('create'));
  await provider.start(op('start'));
  assert.equal((await provider.inspect(op('inspect'))).state, 'running');
  const observed = await provider.retire(op('retire'));
  assert.equal(observed.state, 'retired');
  assert.equal(observed.generation, 1);
  assert.deepEqual(withoutIncarnation(journal.get('pc-01')), { computerId: 'pc-01', projectId: 'project-a', generation: 1, retiredAtMs: c.now(), deadlineMs: c.now() + 7 * DAY });
  assert.equal((await provider.inspect(op('inspect'))).state, 'retired', 'still there, now reported as retired');
  await rejectsWith(provider.start(op('start')), 'environment_retired');
  assert.equal((await provider.stop(op('stop'))).state, 'retired', 'stop of a retired environment is harmless and keeps it retired');
});

test('retire is idempotent: a repeat keeps the original deadline; a stale generation or another project is refused', async () => {
  const { provider, journal, c } = setup();
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  const first = journal.get('pc-01');
  c.advance(2 * DAY);
  assert.equal((await provider.retire(op('retire', { operationId: 'op-retire-2', idempotencyKey: 'key-retire-2' }))).state, 'retired');
  assert.deepEqual(journal.get('pc-01'), first);
  await rejectsWith(provider.retire(op('retire', { expectedGeneration: 2 })), 'stale_generation');
  await rejectsWith(provider.retire(op('retire', { projectId: 'project-b' })), 'project_mismatch');
  await rejectsWith(provider.retire(op('retire', { computerId: 'pc-99' })), 'computer_missing');
});

test('destroy is unchanged: it deletes a never-retired environment at once, and a retired one leaves no record behind', async () => {
  const { provider, journal } = setup();
  await provider.create(op('create'));
  await provider.start(op('start'));
  assert.equal((await provider.destroy(op('destroy'))).state, 'missing');
  assert.equal((await provider.inspect(op('inspect'))).state, 'missing');
  assert.deepEqual(journal.list(), []);

  await provider.create(op('create', { operationId: 'op-create-2', idempotencyKey: 'key-create-2' }));
  await provider.retire(op('retire'));
  assert.equal((await provider.destroy(op('destroy', { operationId: 'op-destroy-2', idempotencyKey: 'key-destroy-2' }))).state, 'missing');
  assert.deepEqual(journal.list(), [], 'no stale record that could later mark a new environment as retired');
  await provider.create(op('create', { operationId: 'op-create-3', idempotencyKey: 'key-create-3' }));
  assert.equal((await provider.start(op('start'))).state, 'running', 'a new environment under the same id is not retired');
});

test('purge refuses an environment that is not retired, and changes nothing', async () => {
  const { provider } = setup();
  await provider.create(op('create'));
  await provider.start(op('start'));
  await rejectsWith(provider.purge(op('purge')), 'environment_not_retired');
  const after = await provider.inspect(op('inspect'));
  assert.equal(after.state, 'running');
});

test('purge deletes a retired environment (the requested, approved path does not wait for the deadline) and drops its record', async () => {
  const { provider, journal } = setup();
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  await rejectsWith(provider.purge(op('purge', { projectId: 'project-b' })), 'project_mismatch');
  await rejectsWith(provider.purge(op('purge', { expectedGeneration: 2 })), 'stale_generation');
  assert.equal(journal.list().length, 1);
  const observed = await provider.purge(op('purge'));
  assert.equal(observed.state, 'missing');
  assert.equal((await provider.inspect(op('inspect'))).state, 'missing');
  assert.deepEqual(journal.list(), []);
  assert.equal((await provider.purge(op('purge', { operationId: 'op-purge-2', idempotencyKey: 'key-purge-2' }))).state, 'missing', 'repeat is already gone');
});

test('a Control Plane operation cannot carry a time, a deadline or a scheduled flag: the operation shape refuses extra keys', async () => {
  const { provider, journal } = setup();
  await provider.create(op('create'));
  for (const extra of [{ retiredAtMs: 1 }, { deadlineMs: 2 }, { scheduled: true }, { retentionMs: 0 }, { now: 5 }, { force: true }]) {
    assert.throws(() => validateEnvironmentOperation(op('retire', extra)), TypeError);
    await assert.rejects(provider.retire(op('retire', extra)), TypeError);
    await assert.rejects(provider.purge(op('purge', extra)), TypeError);
  }
  assert.deepEqual(journal.list(), [], 'nothing was recorded by the rejected requests');
});

test('scheduled purge: only records past their own deadline are purged; everything else is left alone (clock injected)', async () => {
  const { provider, journal, c } = setup();
  const make = async (id) => {
    await provider.create(op('create', { computerId: id, operationId: `c-${id}`, idempotencyKey: `c-${id}` }));
    await provider.start(op('start', { computerId: id, operationId: `s-${id}`, idempotencyKey: `s-${id}` }));
  };
  const retire = (id) => provider.retire(op('retire', { computerId: id, operationId: `r-${id}`, idempotencyKey: `r-${id}` }));
  await make('old-retired');
  await make('young-retired');
  await make('never-retired');
  await retire('old-retired');
  c.advance(5 * DAY);
  await retire('young-retired');
  const oldDeadline = journal.get('old-retired').deadlineMs;
  const youngDeadline = journal.get('young-retired').deadlineMs;
  assert.ok(oldDeadline < youngDeadline);

  assert.deepEqual(await provider.purgeExpiredRetirements({ now: oldDeadline - 1 }), [], 'one millisecond before the deadline: nothing');
  const results = await provider.purgeExpiredRetirements({ now: oldDeadline });
  assert.deepEqual(results, [{ computerId: 'old-retired', outcome: 'purged' }], 'the deadline itself counts');
  const state = async (id) => (await provider.inspect(op('inspect', { computerId: id, operationId: `i-${id}`, idempotencyKey: `i-${id}` }))).state;
  assert.equal(await state('old-retired'), 'missing');
  assert.equal(await state('young-retired'), 'retired');
  assert.equal(await state('never-retired'), 'running', 'an environment with no retirement record is never purged, however late the clock is');
  assert.deepEqual(journal.list().map((r) => r.computerId), ['young-retired']);

  assert.deepEqual(await provider.purgeExpiredRetirements({ now: youngDeadline + 365 * DAY }), [{ computerId: 'young-retired', outcome: 'purged' }]);
  assert.equal(await state('never-retired'), 'running');
  assert.deepEqual(await provider.purgeExpiredRetirements({ now: youngDeadline + 366 * DAY }), []);
});

test('scheduled purge uses the Broker clock when no time is given, and accepts a Date', async () => {
  const { provider, journal, c } = setup();
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  assert.deepEqual(await provider.purgeExpiredRetirements(), []);
  c.advance(7 * DAY - 1);
  assert.deepEqual(await provider.purgeExpiredRetirements({}), []);
  assert.deepEqual(await provider.purgeExpiredRetirements({ now: new Date(c.now()) }), []);
  c.advance(1);
  assert.deepEqual(await provider.purgeExpiredRetirements(), [{ computerId: 'pc-01', outcome: 'purged' }]);
  assert.deepEqual(journal.list(), []);
});

test('scheduled purge skips a record that no longer matches its environment and keeps the record; one failure does not stop the others', async () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now, retentionMs: 1000 });
  journal.retire({ computerId: 'a', projectId: 'project-a', generation: 1, vmId: VM });
  journal.retire({ computerId: 'b', projectId: 'project-a', generation: 1, vmId: VM });
  journal.retire({ computerId: 'c', projectId: 'project-a', generation: 1, vmId: VM });
  journal.retire({ computerId: 'd', projectId: 'project-a', generation: 1, vmId: VM });
  const seen = [];
  const results = await purgeExpired({
    journal, atMs: T0 + 1000,
    purgeRecord: (record) => {
      seen.push(record.computerId);
      if (record.computerId === 'a') return 'skipped';
      if (record.computerId === 'b') throw Object.assign(new Error('C:\\secret'), { code: 'provider_timeout' });
      if (record.computerId === 'c') throw new Error('C:\\secret path');
      return 'already_missing';
    },
  });
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  assert.deepEqual(results, [
    { computerId: 'a', outcome: 'skipped' }, { computerId: 'b', outcome: 'failed', code: 'provider_timeout' },
    { computerId: 'c', outcome: 'failed', code: 'provider_outcome_unknown' }, { computerId: 'd', outcome: 'already_missing' },
  ]);
  assert.deepEqual(journal.list().map((r) => r.computerId), ['a', 'b', 'c'], 'only a finished purge drops its record');
});

test('scheduled purge on the mock leaves an environment alone when its generation moved on since the retirement', async () => {
  const { provider, journal } = setup();
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  provider.restoreGeneration('pc-01', 2);
  const deadline = journal.get('pc-01').deadlineMs;
  assert.deepEqual(await provider.purgeExpiredRetirements({ now: deadline }), [{ computerId: 'pc-01', outcome: 'skipped' }]);
  assert.equal((await provider.inspect(op('inspect', { expectedGeneration: 2 }))).state, 'off', 'a record of generation 1 does not make generation 2 retired');
  assert.notEqual(journal.get('pc-01'), null, 'record kept');
});

test('scheduled purge survives a restart: a new Broker over the same file purges from the stored deadline', async () => {
  const filePath = path.join(tmp, 'scheduled.sqlite');
  const c = clock();
  const journal1 = makeJournal({ filePath, nowMs: c.now });
  const provider1 = new MockEnvironmentProvider({ now: c.iso, retirements: journal1 });
  await provider1.create(op('create'));
  await provider1.retire(op('retire'));
  const deadline = journal1.get('pc-01').deadlineMs;

  // Same file, new journal object and a clock far in the future: the stored deadline (not a new one) decides.
  const journal2 = makeJournal({ filePath, nowMs: () => deadline + 1 });
  assert.equal(journal2.get('pc-01').deadlineMs, deadline);
  const provider2 = new MockEnvironmentProvider({ now: c.iso, retirements: journal2 });
  assert.deepEqual(await provider2.purgeExpiredRetirements(), [{ computerId: 'pc-01', outcome: 'already_missing' }], 'the new mock process has no such environment: the record is reaped');
  assert.deepEqual(makeJournal({ filePath }).list(), []);
});

test('mock provider rejects a journal that is not one, and failNext accepts the new actions only', async () => {
  assert.throws(() => new MockEnvironmentProvider({ retirements: {} }), TypeError);
  const { provider } = setup();
  await provider.create(op('create'));
  provider.failNext('retire', { timing: 'after', code: 'reply_lost' });
  await assert.rejects(provider.retire(op('retire')), (e) => e.code === 'reply_lost' && e.outcome === 'unknown');
  provider.failNext('purge', { timing: 'before' });
  await rejectsWith(provider.purge(op('purge')), 'mock_provider_failure');
  assert.throws(() => provider.failNext('reboot'), TypeError);
});

test('requested purge of a missing environment checks the record against the request first: another project cannot erase the record (finding 2)', async () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now });
  const owner = new MockEnvironmentProvider({ now: c.iso, retirements: journal });
  await owner.create(op('create'));
  await owner.retire(op('retire'));
  const record = journal.get('pc-01');
  // The environment is gone from this Broker's hypervisor (for example removed by hand) but the record is still the retirement of project-a, generation 1.
  const gone = new MockEnvironmentProvider({ now: c.iso, retirements: journal });
  await rejectsWith(gone.purge(op('purge', { projectId: 'project-b' })), 'environment_not_retired');
  await rejectsWith(gone.purge(op('purge', { expectedGeneration: 2 })), 'environment_not_retired');
  assert.deepEqual(journal.get('pc-01'), record, 'the record of project-a is untouched');
  assert.equal((await gone.inspect(op('inspect'))).state, 'unknown', 'a record with no environment is an unfinished clean-up, not plain "missing"');
  assert.equal((await gone.purge(op('purge'))).state, 'missing', 'the owner of the record may finish it');
  assert.equal(journal.get('pc-01'), null);
  assert.equal((await gone.inspect(op('inspect'))).state, 'missing');
  assert.equal((await gone.purge(op('purge', { projectId: 'project-b' }))).state, 'missing', 'with no record there is nothing to protect');
});

test('destroy: a crash between removing the environment and dropping its record is completed by the retry, and create works afterwards (finding 5)', async () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now });
  let failDrop = true;
  const flaky = { ...journal, remove: (...args) => { if (failDrop) throw new RetirementJournalError('retirement_journal_write_failed'); return journal.remove(...args); } };
  const provider = new MockEnvironmentProvider({ now: c.iso, retirements: flaky });
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  const destroy = op('destroy', { operationId: 'op-destroy-1', idempotencyKey: 'key-destroy-1' });

  // The environment is removed, the record cannot be dropped: that is an unfinished destroy, never success.
  await assert.rejects(provider.destroy(destroy), (e) => e.code === 'provider_state_unknown' && e.outcome === 'unknown');
  assert.notEqual(journal.get('pc-01'), null);
  assert.equal((await provider.inspect(op('inspect'))).state, 'unknown', 'reconciliation cannot call this a finished destroy');
  await rejectsWith(provider.create(op('create')), 'operation_conflict');

  // The retry finds the environment already gone and still drops the matching record.
  await assert.rejects(provider.destroy(destroy), (e) => e.outcome === 'unknown', 'a failing drop is still reported on the retry');
  failDrop = false;
  assert.equal((await provider.destroy(destroy)).state, 'missing');
  assert.equal(journal.get('pc-01'), null);
  assert.equal((await provider.inspect(op('inspect'))).state, 'missing');
  assert.equal((await provider.create(op('create'))).state, 'off', 'the id can be created again');
  assert.equal((await provider.start(op('start'))).state, 'running', 'and the new environment is not retired');
});

test('destroy of an environment whose record belongs to another project or generation leaves that record alone', async () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now });
  const a = new MockEnvironmentProvider({ now: c.iso, retirements: journal });
  await a.create(op('create'));
  await a.retire(op('retire'));
  const record = journal.get('pc-01');
  const other = new MockEnvironmentProvider({ now: c.iso, retirements: journal });
  assert.equal((await other.destroy(op('destroy', { projectId: 'project-b' }))).state, 'missing');
  assert.deepEqual(journal.get('pc-01'), record);
  assert.equal((await other.destroy(op('destroy', { expectedGeneration: 5 }))).state, 'missing');
  assert.deepEqual(journal.get('pc-01'), record);
});

test('scheduled purge never deletes a restored or re-created environment that is not the recorded incarnation (finding 1)', async () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now });
  const provider = new MockEnvironmentProvider({ now: c.iso, retirements: journal });
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  const record = journal.get('pc-01');
  // Another incarnation under the same id, project and generation (what a restored backup looks like): same fields, no retirement identity.
  provider.restoreComputer('pc-01', { projectId: 'project-a', generation: 1 });
  assert.deepEqual(await provider.purgeExpiredRetirements({ now: record.deadlineMs }), [{ computerId: 'pc-01', outcome: 'skipped' }]);
  assert.deepEqual(journal.get('pc-01'), record, 'record kept');
  assert.equal((await provider.inspect(op('inspect'))).state, 'off', 'the restored environment is alive and not reported as retired');
  await rejectsWith(provider.purge(op('purge')), 'environment_not_retired');
  assert.equal((await provider.inspect(op('inspect'))).state, 'off');
});

test('a restored environment (same id, project, generation, another VM id) is never relabelled, purged or destroyed by the record of the retired one (round 2)', async () => {
  const c = clock();
  const journal = makeJournal({ nowMs: c.now });
  const provider = new MockEnvironmentProvider({ now: c.iso, retirements: journal });
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  const record = journal.get('pc-01');
  provider.restoreComputer('pc-01', { projectId: 'project-a', generation: 1 });
  await provider.start(op('start')).then(() => assert.fail('start must be refused while a record exists'), (e) => assert.equal(e.code, 'environment_retired'));
  await rejectsWith(provider.retire(op('retire')), 'operation_conflict');
  await rejectsWith(provider.destroy(op('destroy')), 'operation_conflict');
  await rejectsWith(provider.purge(op('purge')), 'environment_not_retired');
  assert.deepEqual(await provider.purgeExpiredRetirements({ now: record.deadlineMs }), [{ computerId: 'pc-01', outcome: 'skipped' }]);
  assert.deepEqual(journal.get('pc-01'), record, 'record kept');
  assert.equal((await provider.inspect(op('inspect'))).state, 'off', 'the restored environment is alive and not reported as retired');
});

test('retire retry for the very environment that was retired is accepted and keeps its record', async () => {
  const { provider, journal } = setup();
  await provider.create(op('create'));
  await provider.retire(op('retire'));
  const record = journal.get('pc-01');
  assert.equal((await provider.retire(op('retire', { operationId: 'op-retire-again', idempotencyKey: 'key-retire-again' }))).state, 'retired');
  assert.deepEqual(journal.get('pc-01'), record);
});
