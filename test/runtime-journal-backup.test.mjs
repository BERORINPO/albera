import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';
import { backupRuntimeJournal, readBoundedBackupHandle, recoverRuntimeJournalTail, restoreRuntimeJournal, verifyRuntimeJournalBackup } from '../src/runtime/journal-backup.mjs';
import { loadOrCreateRuntimeSessionId, readRuntimeSessionId } from '../src/runtime/session-identity.mjs';
import { parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';

const verifyWindowsAcl = async () => {};
const PASSPHRASE = 'synthetic test phrase 2026';

test('backup restore reads only the validated size and rejects a file that grows while being read', async () => {
  const data = Buffer.from('backup');
  const makeHandle = (contents) => ({
    requests: [],
    async read(buffer, offset, length, at) {
      this.requests.push(length);
      const count = Math.max(0, Math.min(length, contents.byteLength - at));
      if (count) contents.copy(buffer, offset, at, at + count);
      return { bytesRead: count };
    },
    async stat() { return { size: contents.byteLength }; },
  });
  const handle = makeHandle(data);
  assert.deepEqual(await readBoundedBackupHandle(handle, data.byteLength), data);
  assert.deepEqual(handle.requests, [data.byteLength, 1]);

  const grownHandle = makeHandle(Buffer.concat([data, Buffer.from('x')]));
  await assert.rejects(readBoundedBackupHandle(grownHandle, data.byteLength), /backup_file_invalid/);
  assert.deepEqual(grownHandle.requests, [data.byteLength, 1], 'growth detection reads no more than one extra byte');
  const oversizedHandle = { async read() { assert.fail('oversized input must be rejected before reading'); } };
  await assert.rejects(readBoundedBackupHandle(oversizedHandle, Number.MAX_SAFE_INTEGER), /backup_file_invalid/);
});

async function sourceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-journal-backup-'));
  const journalPath = path.join(root, 'runtime.audit.jsonl');
  const journal = await openRuntimeAuditJournal(journalPath, { verifyWindowsAcl });
  const sessionId = await loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl });
  await journal.append({
    sessionId,
    requestId: '12345678-1234-4234-8234-123456789abc',
    action: 'run.start', phase: 'requested', at: 1, provider: 'claude',
  });
  await journal.close();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, journalPath, sessionId };
}

test('encrypted backup restores exact journal bytes and stable session identity without exposing the payload', async (t) => {
  const source = await sourceFixture(t);
  const backupPath = path.join(source.root, 'journal.backup.albera');
  const destinationDirectory = path.join(source.root, 'restored');
  const originalBytes = await readFile(source.journalPath);
  await backupRuntimeJournal({ ...source, outputPath: backupPath, passphrase: PASSPHRASE, verifyWindowsAcl });
  assert.deepEqual(await readFile(source.journalPath), originalBytes);
  const encrypted = await readFile(backupPath);
  assert.equal(encrypted.includes(originalBytes), false);
  assert.equal(encrypted.includes(Buffer.from(source.sessionId)), false);
  assert.equal(encrypted.includes(Buffer.from('run.start')), false);
  const restored = await restoreRuntimeJournal({ backupPath, destinationDirectory, passphrase: PASSPHRASE, verifyWindowsAcl });
  assert.deepEqual(await readFile(restored.journalPath), originalBytes);
  assert.equal(await readFile(`${restored.journalPath}.session-id`, 'utf8'), `${source.sessionId}\n`);
  assert.equal(restored.sessionId, source.sessionId);
  assert.equal(await readRuntimeSessionId(restored.journalPath, { verifyWindowsAcl }), source.sessionId);
  if (process.platform !== 'win32') {
    assert.equal((await stat(destinationDirectory)).mode & 0o077, 0);
  }
});

test('encrypted backup checks destination directory and empty file permissions before writing ciphertext', async (t) => {
  const source = await sourceFixture(t);
  const outputPath = path.join(source.root, 'checked.backup.albera');
  const aclTargets = [];
  await backupRuntimeJournal({
    ...source,
    outputPath,
    passphrase: PASSPHRASE,
    verifyWindowsAcl: async (target, { kind }) => {
      aclTargets.push(`${target}:${kind}`);
      if (target === outputPath) assert.equal((await stat(target)).size, 0, 'ACL check runs before ciphertext is written');
    },
  });
  assert.deepEqual(aclTargets, [
    `${source.root}:directory`, `${source.root}:directory`,
    `${source.journalPath}:file`, `${source.journalPath}.session-id:file`, `${outputPath}:file`,
  ]);

  const deniedDirectory = path.join(source.root, 'denied-backups');
  await mkdir(deniedDirectory);
  const deniedDirectoryOutput = path.join(deniedDirectory, 'backup.albera');
  await assert.rejects(backupRuntimeJournal({
    ...source,
    outputPath: deniedDirectoryOutput,
    passphrase: PASSPHRASE,
    verifyWindowsAcl: async (target, { kind }) => {
      if (target === deniedDirectory && kind === 'directory') throw new Error('backup_directory_permissions');
    },
  }), /backup_directory_permissions/);
  await assert.rejects(lstat(deniedDirectoryOutput), { code: 'ENOENT' });

  const deniedFileOutput = path.join(source.root, 'denied-file.backup.albera');
  await assert.rejects(backupRuntimeJournal({
    ...source,
    outputPath: deniedFileOutput,
    passphrase: PASSPHRASE,
    verifyWindowsAcl: async (target, { kind }) => {
      if (target === deniedFileOutput && kind === 'file') {
        assert.equal((await stat(target)).size, 0, 'refused output is still empty');
        throw new Error('backup_file_permissions');
      }
    },
  }), /backup_file_permissions/);
  assert.deepEqual(await readFile(deniedFileOutput), Buffer.alloc(0), 'permission failure writes no ciphertext');
});

test('encrypted backup refuses a POSIX output directory readable by other users', { skip: process.platform === 'win32' }, async (t) => {
  const source = await sourceFixture(t);
  const outputDirectory = path.join(source.root, 'broad-backup-directory');
  await mkdir(outputDirectory, { mode: 0o700 });
  await chmod(outputDirectory, 0o755);
  const outputPath = path.join(outputDirectory, 'backup.albera');

  await assert.rejects(backupRuntimeJournal({ ...source, outputPath, passphrase: PASSPHRASE, verifyWindowsAcl }), /backup_directory_permissions/);
  await assert.rejects(lstat(outputPath), { code: 'ENOENT' });
});

test('encrypted backup refuses an output path replaced during ACL verification', async (t) => {
  const source = await sourceFixture(t);
  const outputPath = path.join(source.root, 'raced.backup.albera');
  const originalCreatedFile = `${outputPath}.created`;
  await assert.rejects(backupRuntimeJournal({
    ...source,
    outputPath,
    passphrase: PASSPHRASE,
    verifyWindowsAcl: async (target, { kind }) => {
      if (target !== outputPath || kind !== 'file') return;
      await rename(outputPath, originalCreatedFile);
      await writeFile(outputPath, 'preserve replacement', { flag: 'wx' });
    },
  }), /backup_file_changed_during_permission_check/);
  assert.equal(await readFile(outputPath, 'utf8'), 'preserve replacement');
  assert.deepEqual(await readFile(originalCreatedFile), Buffer.alloc(0), 'the original opened file remains empty');
});

test('encrypted backup refuses an output directory replaced after its ACL check', async (t) => {
  const source = await sourceFixture(t);
  const outputDirectory = path.join(source.root, 'backup-destination');
  const replacedDirectory = `${outputDirectory}.checked`;
  await mkdir(outputDirectory, { mode: 0o700 });
  const outputPath = path.join(outputDirectory, 'backup.albera');
  let replaced = false;

  await assert.rejects(backupRuntimeJournal({
    ...source,
    outputPath,
    passphrase: PASSPHRASE,
    verifyWindowsAcl: async (target, { kind }) => {
      if (target !== outputDirectory || kind !== 'directory' || replaced) return;
      replaced = true;
      await rename(outputDirectory, replacedDirectory);
      await mkdir(outputDirectory, { mode: 0o700 });
    },
  }), /backup_directory_changed_during_create/);
  assert.deepEqual(await readFile(outputPath), Buffer.alloc(0), 'the replacement destination remains empty');
  await assert.rejects(lstat(path.join(replacedDirectory, 'backup.albera')), { code: 'ENOENT' });
});

test('backup requires the exclusive journal lock and never overwrites an existing output', async (t) => {
  const source = await sourceFixture(t);
  const outputPath = path.join(source.root, 'backup.albera');
  const active = await openRuntimeAuditJournal(source.journalPath, { verifyWindowsAcl });
  await assert.rejects(backupRuntimeJournal({ ...source, outputPath, passphrase: PASSPHRASE, verifyWindowsAcl }));
  await active.close();
  await writeFile(outputPath, 'preserve me', { flag: 'wx' });
  await assert.rejects(backupRuntimeJournal({ ...source, outputPath, passphrase: PASSPHRASE, verifyWindowsAcl }));
  assert.equal(await readFile(outputPath, 'utf8'), 'preserve me');
});

test('wrong passphrase and authenticated tampering fail before creating a restore directory', async (t) => {
  const source = await sourceFixture(t);
  const backupPath = path.join(source.root, 'backup.albera');
  const wrongDestination = path.join(source.root, 'wrong-passphrase');
  await backupRuntimeJournal({ ...source, outputPath: backupPath, passphrase: PASSPHRASE, verifyWindowsAcl });
  await assert.rejects(restoreRuntimeJournal({ backupPath, destinationDirectory: wrongDestination, passphrase: 'another synthetic phrase', verifyWindowsAcl }), /backup_authentication_failed/);
  await assert.rejects(lstat(wrongDestination), { code: 'ENOENT' });

  const original = await readFile(backupPath);
  original[original.length - 1] ^= 0x01;
  await writeFile(backupPath, original);
  const tamperedDestination = path.join(source.root, 'tampered');
  await assert.rejects(restoreRuntimeJournal({ backupPath, destinationDirectory: tamperedDestination, passphrase: PASSPHRASE, verifyWindowsAcl }), /backup_authentication_failed/);
  await assert.rejects(lstat(tamperedDestination), { code: 'ENOENT' });
});

test('offline backup verification checks authentication and journal validity without writing files', async (t) => {
  const source = await sourceFixture(t);
  const backupPath = path.join(source.root, 'verify.albera');
  const destinationDirectory = path.join(source.root, 'must-not-exist');
  const sourceBefore = await readFile(source.journalPath);
  await backupRuntimeJournal({ ...source, outputPath: backupPath, passphrase: PASSPHRASE, verifyWindowsAcl });
  const backupBefore = await readFile(backupPath);

  assert.deepEqual(await verifyRuntimeJournalBackup({ backupPath, passphrase: PASSPHRASE }), { recordCount: 1 });
  assert.deepEqual(await readFile(source.journalPath), sourceBefore);
  assert.deepEqual(await readFile(backupPath), backupBefore);
  await assert.rejects(lstat(destinationDirectory), { code: 'ENOENT' });

  await assert.rejects(verifyRuntimeJournalBackup({ backupPath, passphrase: 'another synthetic phrase' }), /backup_authentication_failed/);
  const tampered = Buffer.from(backupBefore);
  tampered[tampered.length - 1] ^= 0x01;
  await writeFile(backupPath, tampered);
  const tamperedBefore = await readFile(backupPath);
  await assert.rejects(verifyRuntimeJournalBackup({ backupPath, passphrase: PASSPHRASE }), /backup_authentication_failed/);
  assert.deepEqual(await readFile(source.journalPath), sourceBefore);
  assert.deepEqual(await readFile(backupPath), tamperedBefore);
  await assert.rejects(lstat(destinationDirectory), { code: 'ENOENT' });
});

test('restore refuses an existing destination and leaves its contents unchanged', async (t) => {
  const source = await sourceFixture(t);
  const backupPath = path.join(source.root, 'backup.albera');
  const destinationDirectory = path.join(source.root, 'existing');
  await backupRuntimeJournal({ ...source, outputPath: backupPath, passphrase: PASSPHRASE, verifyWindowsAcl });
  await mkdir(destinationDirectory);
  const markerPath = path.join(destinationDirectory, 'marker.txt');
  await writeFile(markerPath, 'preserve me');
  await assert.rejects(restoreRuntimeJournal({ backupPath, destinationDirectory, passphrase: PASSPHRASE, verifyWindowsAcl }));
  assert.equal(await readFile(markerPath, 'utf8'), 'preserve me');
});

test('incomplete journal tail recovery copies only validated complete records and preserves the source', async (t) => {
  const source = await sourceFixture(t);
  const original = await readFile(source.journalPath);
  const tail = Buffer.from('{"version":2,"sequence":2', 'utf8');
  await appendFile(source.journalPath, tail);
  const damaged = await readFile(source.journalPath);
  const outputPath = path.join(source.root, 'runtime.recovered.jsonl');
  const aclTargets = [];

  const recovered = await recoverRuntimeJournalTail({
    journalPath: source.journalPath,
    outputPath,
    verifyWindowsAcl: async (target, { kind }) => aclTargets.push(`${target}:${kind}`),
  });

  assert.equal(recovered.recordCount, 1);
  assert.equal(recovered.discardedTailBytes, tail.byteLength);
  assert.equal(recovered.sessionId, source.sessionId);
  assert.deepEqual(aclTargets, [
    `${source.root}:directory`, `${source.journalPath}:file`, `${source.journalPath}.lock:file`,
    `${source.journalPath}.session-id:file`, `${outputPath}:file`, `${outputPath}.session-id:file`,
  ]);
  assert.deepEqual(await readFile(source.journalPath), damaged, 'source journal and incomplete bytes stay unchanged');
  assert.deepEqual(await readFile(outputPath), original, 'recovery output contains only the verified prefix');
  assert.equal(await readFile(`${outputPath}.session-id`, 'utf8'), `${source.sessionId}\n`);
  const reopened = await openRuntimeAuditJournal(outputPath, { verifyWindowsAcl });
  assert.equal(reopened.list().length, 1);
  await reopened.close();
});

test('tail recovery refuses complete corruption, active lock, and existing outputs without modifying source', async (t) => {
  const source = await sourceFixture(t);
  const original = await readFile(source.journalPath);
  const corrupt = Buffer.from(original);
  corrupt[2] ^= 0x01;
  await writeFile(source.journalPath, Buffer.concat([corrupt, Buffer.from('{"partial"', 'utf8')]));
  const damaged = await readFile(source.journalPath);
  const corruptOutput = path.join(source.root, 'corrupt.recovered.jsonl');
  await assert.rejects(recoverRuntimeJournalTail({ journalPath: source.journalPath, outputPath: corruptOutput, verifyWindowsAcl }), /journal_corrupt/);
  assert.deepEqual(await readFile(source.journalPath), damaged);
  await assert.rejects(lstat(corruptOutput), { code: 'ENOENT' });

  await writeFile(`${source.journalPath}.lock`, 'active writer', { flag: 'wx' });
  const lockedOutput = path.join(source.root, 'locked.recovered.jsonl');
  await assert.rejects(recoverRuntimeJournalTail({ journalPath: source.journalPath, outputPath: lockedOutput, verifyWindowsAcl }));
  assert.deepEqual(await readFile(source.journalPath), damaged);
  await rm(`${source.journalPath}.lock`);

  const existingOutput = path.join(source.root, 'existing.recovered.jsonl');
  await writeFile(existingOutput, 'keep this file', { flag: 'wx' });
  await assert.rejects(recoverRuntimeJournalTail({ journalPath: source.journalPath, outputPath: existingOutput, verifyWindowsAcl }));
  assert.equal(await readFile(existingOutput, 'utf8'), 'keep this file');
  assert.deepEqual(await readFile(source.journalPath), damaged);

  const identitySource = await sourceFixture(t);
  const identityCollisionOutput = path.join(identitySource.root, 'identity-collision.jsonl');
  await writeFile(`${identityCollisionOutput}.session-id`, 'preserve existing identity', { flag: 'wx' });
  await appendFile(identitySource.journalPath, '{"partial"');
  const identitySourceBefore = await readFile(identitySource.journalPath);
  await assert.rejects(recoverRuntimeJournalTail({ journalPath: identitySource.journalPath, outputPath: identityCollisionOutput, verifyWindowsAcl }), /journal_recovery_identity_exists/);
  await assert.rejects(lstat(identityCollisionOutput), { code: 'ENOENT' });
  assert.equal(await readFile(`${identityCollisionOutput}.session-id`, 'utf8'), 'preserve existing identity');
  assert.deepEqual(await readFile(identitySource.journalPath), identitySourceBefore);
});

test('runtime CLI exposes explicit backup and restore paths without passphrase arguments', () => {
  assert.deepEqual(parseRuntimeArgs(['backup', '--journal', '/tmp/runtime.audit.jsonl', '--output', '/tmp/archive.albera']), {
    command: 'backup', journalPath: '/tmp/runtime.audit.jsonl', outputPath: '/tmp/archive.albera', backupPath: undefined, destinationDirectory: undefined, help: false,
  });
  assert.deepEqual(parseRuntimeArgs(['restore', '--backup', '/tmp/archive.albera', '--destination', '/tmp/restored']), {
    command: 'restore', journalPath: undefined, outputPath: undefined, backupPath: '/tmp/archive.albera', destinationDirectory: '/tmp/restored', help: false,
  });
  assert.throws(() => parseRuntimeArgs(['backup', '--journal', '/tmp/journal']), /runtime_backup_options_required/);
  assert.throws(() => parseRuntimeArgs(['backup', '--journal', 'relative', '--output', '/tmp/archive']), /runtime_path_must_be_absolute/);
  assert.deepEqual(parseRuntimeArgs(['recover-tail', '--journal', '/tmp/runtime.audit.jsonl', '--output', '/tmp/runtime.recovered.jsonl']), {
    command: 'recover-tail', journalPath: '/tmp/runtime.audit.jsonl', outputPath: '/tmp/runtime.recovered.jsonl', backupPath: undefined, destinationDirectory: undefined, help: false,
  });
  assert.throws(() => parseRuntimeArgs(['recover-tail', '--journal', '/tmp/runtime.audit.jsonl']), /runtime_backup_options_required/);
  assert.deepEqual(parseRuntimeArgs(['verify-backup', '--backup', '/tmp/archive.albera']), {
    command: 'verify-backup', journalPath: undefined, outputPath: undefined, backupPath: '/tmp/archive.albera', destinationDirectory: undefined, help: false,
  });
  assert.throws(() => parseRuntimeArgs(['verify-backup']), /runtime_backup_options_required/);
  assert.throws(() => parseRuntimeArgs(['verify-backup', '--backup', '/tmp/archive.albera', '--destination', '/tmp/out']), /invalid_runtime_option/);
  assert.match(RUNTIME_HELP, /albera-runtime verify-backup --backup <absolute-backup-path>/);
});
