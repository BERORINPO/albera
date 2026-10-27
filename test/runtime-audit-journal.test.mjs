import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';

const openTestJournal = (filePath, options = {}) => openRuntimeAuditJournal(filePath, { ...options, verifyWindowsAcl: async () => {} });

const SESSION_A = 'a'.repeat(32);
const SESSION_B = 'b'.repeat(32);
const REQUEST_A = '12345678-1234-4234-8234-123456789abc';
const RUN_A = '22345678-1234-4234-8234-123456789abc';
function auditRecord(overrides = {}) {
  return { sessionId: SESSION_A, requestId: REQUEST_A, action: 'run.start', phase: 'requested', at: 1, provider: 'claude', ...overrides };
}

test('audit journal persists serialized allowlisted records and reopens without secrets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const journal = await openTestJournal(file);
  const records = await Promise.all([
    journal.append(auditRecord()),
    journal.append(auditRecord({ requestId: '32345678-1234-4234-8234-123456789abc', phase: 'accepted', runId: RUN_A })),
    journal.append(auditRecord({ sessionId: SESSION_B, requestId: '42345678-1234-4234-8234-123456789abc', phase: 'denied', errorCode: 'confirmation_required' })),
    journal.append(auditRecord({ requestId: '52345678-1234-4234-8234-123456789abc', action: 'run.input', phase: 'accepted', runId: RUN_A })),
  ]);
  assert.deepEqual(records.map(({ sequence }) => sequence), [1, 2, 3, 4]);
  assert.equal(journal.list().length, 4);
  assert.equal(journal.list({ sessionId: SESSION_A }).length, 3);
  assert.equal(journal.list({ sessionId: SESSION_B }).length, 1);
  assert.throws(() => journal.append(auditRecord({ prompt: 'synthetic-secret' })), /invalid_journal_record/);
  await journal.close();

  const content = await readFile(file, 'utf8');
  assert.equal(content.includes('synthetic-secret'), false);
  assert.equal(content.includes('prompt'), false);
  const reopened = await openTestJournal(file);
  assert.deepEqual(reopened.list({ sessionId: SESSION_A }).map(({ sequence, phase }) => [sequence, phase]), [[1, 'requested'], [2, 'accepted'], [4, 'accepted']]);
  await reopened.close();
});

test('journal persists allowlisted lifecycle events in the same monotonic sequence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-event-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const journal = await openTestJournal(file);
  const audit = await journal.append(auditRecord({ phase: 'accepted', runId: RUN_A }));
  const event = await journal.append({ kind: 'event', sessionId: SESSION_A, eventType: 'started', at: 2, provider: 'claude', runId: RUN_A });
  assert.equal(event.sequence, audit.sequence + 1);
  assert.equal(event.eventId, 1);
  const otherSessionEvent = await journal.append({ kind: 'event', sessionId: SESSION_B, eventType: 'started', at: 2, provider: 'claude', runId: RUN_A });
  assert.equal(otherSessionEvent.eventId, 1);
  const secondSessionAEvent = await journal.append({ kind: 'event', sessionId: SESSION_A, eventType: 'exited', at: 3, provider: 'claude', runId: RUN_A, code: 0 });
  assert.equal(secondSessionAEvent.eventId, 2);
  assert.equal(journal.list({ sessionId: SESSION_A, kind: 'event' }).length, 2);
  assert.equal(journal.list({ sessionId: SESSION_A, kind: 'event', after: 1 }).length, 1);
  assert.equal(journal.list({ sessionId: SESSION_A, kind: 'event', after: 0 })[0].eventId, 1);
  assert.equal(journal.list({ sessionId: SESSION_A, kind: 'audit' }).length, 1);
  assert.throws(() => journal.append({ kind: 'event', sessionId: SESSION_A, eventType: 'started', at: 3, provider: 'claude', runId: RUN_A, prompt: 'secret' }), /invalid_journal_record/);
  await journal.close();
  const reopened = await openTestJournal(file);
  assert.deepEqual(reopened.list({ sessionId: SESSION_A, kind: 'event' }).map(({ eventId }) => eventId), [1, 2]);
  assert.deepEqual(reopened.list({ sessionId: SESSION_B, kind: 'event' }).map(({ eventId }) => eventId), [1]);
  await reopened.close();
});

test('audit journal enforces one live writer and releases its lock on close', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const journal = await openTestJournal(file);
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_locked');
  await journal.close();
  const reopened = await openTestJournal(file);
  await reopened.close();
});

test('journal close drains writes already accepted into its queue', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const journal = await openTestJournal(file);
  const writes = Array.from({ length: 20 }, (_, index) => journal.append(auditRecord({
    requestId: `${String(index + 1).padStart(8, '0')}-1234-4234-8234-123456789abc`, at: index + 1,
  })));
  const closed = journal.close();
  await Promise.all(writes);
  await closed;
  const reopened = await openTestJournal(file);
  assert.equal(reopened.list({ limit: 100 }).length, 20);
  await reopened.close();
});

test('audit journal refuses incomplete or corrupt existing data without modifying it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const corrupt = '{"version":1';
  await writeFile(file, corrupt, 'utf8');
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_incomplete_tail');
  assert.equal(await readFile(file, 'utf8'), corrupt);
});

test('journal rejects duplicate, skipped, or non-initial per-session event cursors without modifying data', async (t) => {
  const cases = [
    { name: 'duplicate', ids: [1, 1] },
    { name: 'skipped', ids: [1, 3] },
    { name: 'non-initial', ids: [2] },
  ];
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-event-cursor-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const { name, ids } of cases) {
    const file = path.join(root, `${name}.jsonl`);
    const content = ids.map((eventId, index) => JSON.stringify({
      version: 1, sequence: index + 1, kind: 'event', eventId, sessionId: SESSION_A,
      eventType: 'started', at: index + 1, provider: 'claude', runId: RUN_A,
    })).join('\n') + '\n';
    await writeFile(file, content, 'utf8');
    await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_corrupt', name);
    assert.equal(await readFile(file, 'utf8'), content, `${name} journal must remain untouched`);
  }
});

test('journal startup preserves an unrelated lock-path file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-lock-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const lockFile = `${file}.lock`;
  const existing = 'user-owned lock metadata';
  await writeFile(lockFile, existing, 'utf8');
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_locked');
  assert.equal(await readFile(lockFile, 'utf8'), existing);
});

test('audit journal fails closed at its configured capacity and keeps earlier records', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-full-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const journal = await openTestJournal(file, { maxBytes: 2048 });
  let sequence = 0;
  while (true) {
    try {
      sequence++;
      await journal.append(auditRecord({ requestId: `${String(sequence).padStart(8, '0')}-1234-4234-8234-123456789abc`, at: sequence }));
    } catch (error) {
      assert.equal(error.code, 'journal_capacity_exceeded');
      break;
    }
  }
  assert.ok(sequence > 1);
  const previous = journal.list({ limit: 100 });
  assert.equal(previous.length, sequence - 1);
  await journal.close();
});
