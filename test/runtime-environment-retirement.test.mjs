// Issue #115 step 1: environment.retire (undoable) and environment.purge (irreversible), the Broker-owned retirement record, and the scheduled purge.
// Nothing here adds a tier, a policy or a no-prompt path: every action is still authorized exactly as before (see the store tests for the approval path).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENVIRONMENT_ACTIONS, validateEnvironmentOperation } from '../src/runtime/environment-provider.mjs';
import { DEFAULT_RETENTION_MS, RetirementJournalError, createRetirementJournal, purgeExpired } from '../src/runtime/environment-retirement-journal.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';

const T0 = Date.parse('2026-10-31T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-retirement-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
  const journal = createRetirementJournal({ nowMs: c.now, ...options });
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

test('journal: the Broker stamps the time itself; deadline is retirement time + retention (default 7 days)', () => {
  const c = clock();
  const journal = createRetirementJournal({ nowMs: c.now });
  const record = journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1 });
  assert.deepEqual(record, { computerId: 'pc-01', projectId: 'project-a', generation: 1, retiredAtMs: T0, deadlineMs: T0 + 7 * DAY });
  assert.equal(DEFAULT_RETENTION_MS, 7 * DAY);
  assert.ok(Object.isFrozen(record));
  assert.equal(createRetirementJournal({ nowMs: c.now, retentionMs: 1000 }).retire({ computerId: 'pc-02', projectId: 'project-a', generation: 1 }).deadlineMs, T0 + 1000);
});

test('journal: caller-supplied times are ignored, and a second retire cannot move or extend the deadline', () => {
  const c = clock();
  const journal = createRetirementJournal({ nowMs: c.now });
  const forged = journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, retiredAtMs: 1, deadlineMs: 2, scheduled: true });
  assert.equal(forged.retiredAtMs, T0);
  assert.equal(forged.deadlineMs, T0 + 7 * DAY);
  c.advance(3 * DAY);
  const again = journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1, retiredAtMs: c.now() });
  assert.deepEqual(again, forged, 'the original record, deadline included');
  assert.throws(() => journal.retire({ computerId: 'pc-01', projectId: 'project-b', generation: 1 }), (e) => e instanceof RetirementJournalError && e.code === 'retirement_conflict');
  assert.throws(() => journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 2 }), (e) => e.code === 'retirement_conflict');
  assert.deepEqual(journal.get('pc-01'), forged);
});

test('journal: invalid identities and a broken clock are refused before anything is recorded', () => {
  const journal = createRetirementJournal({ nowMs: () => T0 });
  for (const bad of [{}, { computerId: 'pc 01', projectId: 'p', generation: 1 }, { computerId: 'pc', projectId: 'p', generation: 0 }, { computerId: 'pc', projectId: 'p', generation: 1.5 }]) {
    assert.throws(() => journal.retire(bad), (e) => e.code === 'retirement_invalid');
  }
  const broken = createRetirementJournal({ nowMs: () => -1 });
  assert.throws(() => broken.retire({ computerId: 'pc', projectId: 'p', generation: 1 }), (e) => e.code === 'retirement_clock_invalid');
  assert.deepEqual(broken.list(), []);
  assert.throws(() => createRetirementJournal({ retentionMs: 0 }), TypeError);
  assert.throws(() => createRetirementJournal({ filePath: '' }), TypeError);
});

test('journal: a record survives a restart (new journal over the same file) and removal is durable too', () => {
  const filePath = path.join(tmp, 'restart.json');
  const c = clock();
  const first = createRetirementJournal({ filePath, nowMs: c.now });
  const record = first.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1 });
  first.retire({ computerId: 'pc-02', projectId: 'project-a', generation: 3 });
  c.advance(DAY);
  const second = createRetirementJournal({ filePath, nowMs: c.now });
  assert.deepEqual(second.get('pc-01'), record, 'same retirement time and deadline after the restart');
  assert.deepEqual(second.list().map((r) => r.computerId), ['pc-01', 'pc-02']);
  assert.equal(second.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1 }).retiredAtMs, T0, 'the restart did not reset the clock on the record');
  assert.equal(second.remove('pc-01'), true);
  assert.equal(second.remove('pc-01'), false);
  assert.deepEqual(createRetirementJournal({ filePath, nowMs: c.now }).list().map((r) => r.computerId), ['pc-02']);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false, 'no temp file is left behind');
});

test('journal: a file that does not match the record shape makes the journal refuse to open (fail closed)', () => {
  const good = { computerId: 'pc-01', projectId: 'project-a', generation: 1, retiredAtMs: T0, deadlineMs: T0 + DAY };
  const cases = {
    'not json': '{nope',
    'wrong version': JSON.stringify({ v: 2, records: [] }),
    'records not an array': JSON.stringify({ v: 1, records: {} }),
    'extra field': JSON.stringify({ v: 1, records: [{ ...good, scheduled: true }] }),
    'missing field': JSON.stringify({ v: 1, records: [{ ...good, deadlineMs: undefined }] }),
    'deadline before retirement': JSON.stringify({ v: 1, records: [{ ...good, deadlineMs: T0 - 1 }] }),
    'negative time': JSON.stringify({ v: 1, records: [{ ...good, retiredAtMs: -5 }] }),
    'duplicate computer': JSON.stringify({ v: 1, records: [good, good] }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const filePath = path.join(tmp, `bad-${name.replaceAll(' ', '-')}.json`);
    fs.writeFileSync(filePath, text);
    assert.throws(() => createRetirementJournal({ filePath }), (e) => e.code === 'retirement_journal_corrupt', name);
  }
  assert.deepEqual(createRetirementJournal({ filePath: path.join(tmp, 'absent.json') }).list(), [], 'no file yet is an empty journal, not an error');
});

test('journal: a write that fails records nothing in memory, so the caller never reports a retirement that is not durable', () => {
  const journal = createRetirementJournal({ filePath: path.join(tmp, 'no-such-dir', 'r.json'), nowMs: () => T0 });
  assert.throws(() => journal.retire({ computerId: 'pc-01', projectId: 'project-a', generation: 1 }), (e) => e.code === 'retirement_journal_write_failed');
  assert.equal(journal.get('pc-01'), null);
  assert.deepEqual(journal.list(), []);
});

test('retire stops the environment, keeps it, reports retired, and writes the Broker record', async () => {
  const { provider, journal, c } = setup();
  await provider.create(op('create'));
  await provider.start(op('start'));
  assert.equal((await provider.inspect(op('inspect'))).state, 'running');
  const observed = await provider.retire(op('retire'));
  assert.equal(observed.state, 'retired');
  assert.equal(observed.generation, 1);
  assert.deepEqual(journal.get('pc-01'), { computerId: 'pc-01', projectId: 'project-a', generation: 1, retiredAtMs: c.now(), deadlineMs: c.now() + 7 * DAY });
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
  const journal = createRetirementJournal({ nowMs: c.now, retentionMs: 1000 });
  journal.retire({ computerId: 'a', projectId: 'project-a', generation: 1 });
  journal.retire({ computerId: 'b', projectId: 'project-a', generation: 1 });
  journal.retire({ computerId: 'c', projectId: 'project-a', generation: 1 });
  journal.retire({ computerId: 'd', projectId: 'project-a', generation: 1 });
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
  assert.equal((await provider.inspect(op('inspect', { expectedGeneration: 2 }))).state, 'retired');
});

test('scheduled purge survives a restart: a new Broker over the same file purges from the stored deadline', async () => {
  const filePath = path.join(tmp, 'scheduled.json');
  const c = clock();
  const journal1 = createRetirementJournal({ filePath, nowMs: c.now });
  const provider1 = new MockEnvironmentProvider({ now: c.iso, retirements: journal1 });
  await provider1.create(op('create'));
  await provider1.retire(op('retire'));
  const deadline = journal1.get('pc-01').deadlineMs;

  // Same file, new journal object and a clock far in the future: the stored deadline (not a new one) decides.
  const journal2 = createRetirementJournal({ filePath, nowMs: () => deadline + 1 });
  assert.equal(journal2.get('pc-01').deadlineMs, deadline);
  const provider2 = new MockEnvironmentProvider({ now: c.iso, retirements: journal2 });
  assert.deepEqual(await provider2.purgeExpiredRetirements(), [{ computerId: 'pc-01', outcome: 'already_missing' }], 'the new mock process has no such environment: the record is reaped');
  assert.deepEqual(createRetirementJournal({ filePath }).list(), []);
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
