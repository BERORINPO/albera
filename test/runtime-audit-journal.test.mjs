import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fsyncSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';

const openTestJournal = (filePath, options = {}) => openRuntimeAuditJournal(filePath, { ...options, verifyWindowsAcl: async () => {} });

const SESSION_A = 'a'.repeat(32);
const SESSION_B = 'b'.repeat(32);
const REQUEST_A = '12345678-1234-4234-8234-123456789abc';
const RUN_A = '22345678-1234-4234-8234-123456789abc';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
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

test('journal preserves a legacy v1 prefix and anchors new v2 records to its exact bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-v1-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const legacyRecord = {
    version: 1, sequence: 1, sessionId: SESSION_A, requestId: REQUEST_A,
    action: 'run.start', phase: 'requested', at: 1, provider: 'claude',
  };
  const legacyPrefix = Buffer.from(`${JSON.stringify(legacyRecord)}\n`);
  await writeFile(file, legacyPrefix, { mode: 0o600 });

  const journal = await openTestJournal(file);
  const added = await journal.append(auditRecord({ phase: 'accepted', at: 2 }));
  assert.equal(added.version, 2);
  assert.equal(added.previousHash, sha256(legacyPrefix));
  await journal.close();

  const migratedBytes = await readFile(file);
  assert.deepEqual(migratedBytes.subarray(0, legacyPrefix.length), legacyPrefix, 'legacy bytes remain unchanged');
  const reopened = await openTestJournal(file);
  const next = await reopened.append(auditRecord({ phase: 'failed', at: 3, errorCode: 'provider_unavailable' }));
  assert.equal(next.previousHash, added.recordHash);
  await reopened.close();
  const final = await openTestJournal(file);
  assert.deepEqual(final.list().map(({ version }) => version), [1, 2, 2]);
  await final.close();
  const editedLegacyPrefix = migratedBytes.toString('utf8').replace('"at":1', '"at":9');
  await writeFile(file, editedLegacyPrefix, { encoding: 'utf8', mode: 0o600 });
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_corrupt');
  assert.equal(await readFile(file, 'utf8'), editedLegacyPrefix, 'legacy prefix tampering must not be repaired');
});

test('journal detects v2 record edits, removals, and reordering without modifying corrupt bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-chain-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const journal = await openTestJournal(file);
  for (const [index, phase] of ['requested', 'accepted', 'failed'].entries()) {
    await journal.append(auditRecord({
      requestId: `${String(index + 1).padStart(8, '0')}-1234-4234-8234-123456789abc`,
      phase, at: index + 1,
    }));
  }
  await journal.close();
  const original = (await readFile(file)).toString('utf8').trimEnd().split('\n');
  const cases = [
    { name: 'edit', lines: [original[0].replace('requested', 'accepted'), ...original.slice(1)] },
    { name: 'remove', lines: [original[0], original[2]] },
    { name: 'reorder', lines: [original[1], original[0], original[2]] },
  ];
  for (const { name, lines } of cases) {
    const corrupted = `${lines.join('\n')}\n`;
    await writeFile(file, corrupted, { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_corrupt', name);
    assert.equal(await readFile(file, 'utf8'), corrupted, `${name} journal must remain untouched`);
  }
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

test('journal persists only bounded stop reasons on stop lifecycle events', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-stop-reason-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const journal = await openTestJournal(file);
  const record = { kind: 'event', sessionId: SESSION_A, eventType: 'stop_requested', at: 2, provider: 'claude', runId: RUN_A, stopReason: 'timeout' };
  const appended = await journal.append(record);
  assert.equal(appended.stopReason, 'timeout');
  assert.throws(() => journal.append({ ...record, stopReason: 'secret-input' }), /invalid_journal_record/);
  assert.throws(() => journal.append({ ...record, eventType: 'started' }), /invalid_journal_record/);
  await journal.close();
  const reopened = await openTestJournal(file);
  assert.equal(reopened.list({ kind: 'event' })[0].stopReason, 'timeout');
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

test('journal append writes and syncs each accepted record before returning its promise', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const syncedDescriptors = [];
  const journal = await openTestJournal(file, {
    syncFile(fd) { syncedDescriptors.push(fd); fsyncSync(fd); },
  });
  const pending = journal.append(auditRecord());
  const content = readFileSync(file, 'utf8');
  assert.equal(content.endsWith('\n'), true, 'complete record is visible before append returns');
  assert.equal(JSON.parse(content).phase, 'requested');
  assert.equal(syncedDescriptors.length, 1, 'fsync has completed before append returns');
  assert.deepEqual(await pending, journal.list()[0]);
  await journal.close();
});

test('journal sync failure rejects the append, refuses later writes, and preserves current bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-sync-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  let syncCalls = 0;
  const journal = await openTestJournal(file, { syncFile() { syncCalls++; throw new Error('synthetic_sync_failure'); } });
  await assert.rejects(journal.append(auditRecord()), (error) => error.code === 'journal_write_failed');
  assert.equal(syncCalls, 1);
  const saved = readFileSync(file);
  assert.equal(saved.at(-1), 0x0a, 'the failed sync does not truncate the complete appended record');
  await assert.rejects(journal.append(auditRecord({ phase: 'accepted' })), (error) => error.code === 'journal_failed');
  await journal.close();
  assert.deepEqual(await readFile(file), saved, 'close preserves all bytes after the failed sync');
});

test('journal close preserves records accepted by synchronous appends', async (t) => {
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
  await writeFile(file, corrupt, { encoding: 'utf8', mode: 0o600 });
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_incomplete_tail');
  assert.equal(await readFile(file, 'utf8'), corrupt);
});

test('POSIX journal refuses a group-readable file without changing its bytes', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-permissions-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.audit.jsonl');
  const content = 'existing user data\n';
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o640);
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_permissions');
  assert.equal(await readFile(file, 'utf8'), content);
});

test('POSIX journal refuses a broadly accessible directory without changing existing data', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-permissions-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'shared');
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o755);
  const file = path.join(directory, 'runtime.audit.jsonl');
  const content = 'existing user data\n';
  await writeFile(file, content, { mode: 0o600 });
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_directory_permissions');
  assert.equal(await readFile(file, 'utf8'), content);
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
    await writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
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
  await writeFile(lockFile, existing, { encoding: 'utf8', mode: 0o600 });
  await assert.rejects(openTestJournal(file), (error) => error.code === 'journal_locked');
  assert.equal(await readFile(lockFile, 'utf8'), existing);
});

test('journal refuses a hard-linked data file without changing either path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-hardlink-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'user-data.txt');
  const journal = path.join(root, 'runtime.audit.jsonl');
  const content = 'existing user data must not be appended to\n';
  await writeFile(original, content, { encoding: 'utf8', mode: 0o600 });
  await link(original, journal);
  await assert.rejects(openTestJournal(journal), (error) => error.code === 'journal_hard_linked_file');
  assert.equal(await readFile(original, 'utf8'), content);
  assert.equal(await readFile(journal, 'utf8'), content);
});

test('journal refuses a hard-linked lock path without changing either path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-audit-hardlink-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'user-data.txt');
  const journal = path.join(root, 'runtime.audit.jsonl');
  const lockFile = `${journal}.lock`;
  const content = 'unrelated lock-path data\n';
  await writeFile(original, content, { encoding: 'utf8', mode: 0o600 });
  await link(original, lockFile);
  await assert.rejects(openTestJournal(journal), (error) => error.code === 'journal_lock_hard_linked');
  assert.equal(await readFile(original, 'utf8'), content);
  assert.equal(await readFile(lockFile, 'utf8'), content);
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
  const savedBytes = await readFile(file);
  await assert.rejects(
    journal.append(auditRecord({ requestId: '92345678-1234-4234-8234-123456789abc', at: sequence + 1 })),
    (error) => error.code === 'journal_capacity_exceeded',
  );
  await journal.close();

  assert.deepEqual(await readFile(file), savedBytes, 'capacity refusal must not truncate or rewrite earlier records');
  const reopened = await openTestJournal(file, { maxBytes: 2048 });
  assert.deepEqual(reopened.list({ limit: 100 }), previous, 'all earlier records remain available after reopening');
  await reopened.close();
  assert.deepEqual(await readFile(file), savedBytes, 'reopen and close must preserve the journal byte-for-byte');
});
