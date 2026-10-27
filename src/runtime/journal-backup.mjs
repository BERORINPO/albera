// Explicit offline backup for the Runtime journal. The payload is always authenticated ciphertext.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import process from 'node:process';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertPrivatePosixStorage, openRuntimeAuditJournal, recoverRuntimeAuditJournalPrefix, validateRuntimeAuditJournalSnapshot } from './audit-journal.mjs';
import { readRuntimeSessionId } from './session-identity.mjs';
import { assertPrivateWindowsAcl } from './windows-acl.mjs';

const scryptAsync = promisify(scrypt);
const MAGIC = Buffer.from('ALBERA-RTBK\0v1\0', 'ascii');
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_BYTES = MAGIC.length + SALT_BYTES + NONCE_BYTES + TAG_BYTES + MAX_JOURNAL_BYTES + 128;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const RECOVERY_LOCK_MAGIC = 'ALBERA_RUNTIME_AUDIT_LOCK_V1';

/** Create a new, authenticated encrypted backup without changing the source journal. */
export async function backupRuntimeJournal({ journalPath, outputPath, passphrase, verifyWindowsAcl = assertPrivateWindowsAcl }) {
  assertAbsolutePath(journalPath, 'journal_path_must_be_absolute');
  assertAbsolutePath(outputPath, 'backup_path_must_be_absolute');
  assertPassphrase(passphrase);
  const resolvedOutputPath = path.resolve(outputPath);
  if ([journalPath, `${journalPath}.session-id`, `${journalPath}.lock`].some((source) => resolvedOutputPath === path.resolve(source))) throw new Error('backup_path_conflicts_with_source');
  const outputDirectory = path.dirname(resolvedOutputPath);
  const outputDirectoryInfo = await lstat(outputDirectory, { bigint: true });
  if (!outputDirectoryInfo.isDirectory() || outputDirectoryInfo.isSymbolicLink()) throw new Error('backup_directory_invalid');
  assertPrivatePosixStorage({ mode: Number(outputDirectoryInfo.mode), uid: Number(outputDirectoryInfo.uid) }, 'backup_directory_permissions', 'directory');
  await verifyWindowsAcl(outputDirectory, { kind: 'directory' });
  const info = await lstat(journalPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('journal_file_invalid');

  const journal = await openRuntimeAuditJournal(journalPath, { verifyWindowsAcl });
  let payload;
  try {
    const [snapshot, sessionId] = await Promise.all([
      journal.snapshot(),
      readRuntimeSessionId(journalPath, { verifyWindowsAcl }),
    ]);
    payload = encodePayload(snapshot, sessionId);
  } finally {
    await journal.close();
  }

  const encrypted = await encryptPayload(payload, passphrase);
  const handle = await open(resolvedOutputPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try {
    const currentDirectoryInfo = await lstat(outputDirectory, { bigint: true });
    if (!currentDirectoryInfo.isDirectory() || currentDirectoryInfo.isSymbolicLink()
      || !sameFileIdentity(outputDirectoryInfo, currentDirectoryInfo)) throw new Error('backup_directory_changed_during_create');
    const outputInfo = await handle.stat();
    const outputHandleIdentity = await handle.stat({ bigint: true });
    if (!outputInfo.isFile() || outputInfo.nlink !== 1) throw new Error('backup_file_invalid');
    assertPrivatePosixStorage(outputInfo, 'backup_file_permissions', 'file');
    const pathInfoBeforeAcl = await lstat(resolvedOutputPath, { bigint: true });
    if (!pathInfoBeforeAcl.isFile() || pathInfoBeforeAcl.isSymbolicLink()
      || !sameFileIdentity(outputHandleIdentity, pathInfoBeforeAcl)) throw new Error('backup_file_changed_during_permission_check');
    await verifyWindowsAcl(resolvedOutputPath, { kind: 'file' });
    const pathInfoAfterAcl = await lstat(resolvedOutputPath, { bigint: true });
    if (!pathInfoAfterAcl.isFile() || pathInfoAfterAcl.isSymbolicLink()
      || !sameFileIdentity(outputHandleIdentity, pathInfoAfterAcl)) throw new Error('backup_file_changed_during_permission_check');
    await handle.writeFile(encrypted);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes: encrypted.byteLength };
}

/** Restore into a newly created private directory; existing destinations are never modified. */
export async function restoreRuntimeJournal({ backupPath, destinationDirectory, passphrase, verifyWindowsAcl = assertPrivateWindowsAcl }) {
  assertAbsolutePath(destinationDirectory, 'destination_must_be_absolute');
  const { snapshot, sessionId } = await decodeBackup(backupPath, passphrase);

  await mkdir(destinationDirectory, { recursive: false, mode: 0o700 });
  try {
    const directoryInfo = await lstat(destinationDirectory);
    assertPrivatePosixStorage(directoryInfo, 'restore_directory_permissions', 'directory');
    await verifyWindowsAcl(destinationDirectory, { kind: 'directory' });
    const journalPath = path.join(destinationDirectory, 'runtime.audit.jsonl');
    const identityPath = `${journalPath}.session-id`;
    await writeNewPrivateFile(journalPath, snapshot, verifyWindowsAcl);
    await writeNewPrivateFile(identityPath, Buffer.from(`${sessionId}\n`, 'ascii'), verifyWindowsAcl);
    return { journalPath, sessionId };
  } catch (error) {
    // Preserve the newly created directory and any partial restore for explicit user inspection.
    throw error;
  }
}

/** Authenticate and validate an encrypted backup without creating or changing any files. */
export async function verifyRuntimeJournalBackup({ backupPath, passphrase }) {
  const { recordCount, snapshot } = await decodeBackup(backupPath, passphrase);
  try {
    return Object.freeze({ recordCount });
  } finally {
    snapshot.fill(0);
  }
}

async function decodeBackup(backupPath, passphrase) {
  assertAbsolutePath(backupPath, 'backup_path_must_be_absolute');
  assertPassphrase(passphrase);
  const backupInfo = await lstat(backupPath);
  if (!backupInfo.isFile() || backupInfo.isSymbolicLink() || backupInfo.size > MAX_BACKUP_BYTES) throw new Error('backup_file_invalid');
  const backupHandle = await open(backupPath, fsConstants.O_RDONLY | NOFOLLOW);
  let encrypted;
  try {
    const openedInfo = await backupHandle.stat();
    if (!openedInfo.isFile() || openedInfo.size > MAX_BACKUP_BYTES || openedInfo.dev !== backupInfo.dev || openedInfo.ino !== backupInfo.ino) throw new Error('backup_file_invalid');
    encrypted = await readBoundedBackupHandle(backupHandle, openedInfo.size);
  } finally {
    await backupHandle.close();
  }
  const { snapshot, sessionId } = await decryptPayload(encrypted, passphrase);
  const recordCount = validateRuntimeAuditJournalSnapshot(snapshot, { maxBytes: MAX_JOURNAL_BYTES });
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('backup_payload_invalid');
  return { snapshot, sessionId, recordCount };
}

/** Read only the opened file's previously validated size, with one bounded growth probe. */
export async function readBoundedBackupHandle(handle, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_BACKUP_BYTES) throw new Error('backup_file_invalid');
  const contents = Buffer.allocUnsafe(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(contents, offset, expectedSize - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expectedSize) throw new Error('backup_file_invalid');

  const extraByte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(extraByte, 0, 1, offset);
  if (bytesRead !== 0 || (await handle.stat()).size !== expectedSize) throw new Error('backup_file_invalid');
  return contents;
}

/** Copy a validated complete-record prefix to a new journal beside the source, preserving the original bytes. */
export async function recoverRuntimeJournalTail({ journalPath, outputPath, verifyWindowsAcl = assertPrivateWindowsAcl }) {
  assertAbsolutePath(journalPath, 'journal_path_must_be_absolute');
  assertAbsolutePath(outputPath, 'recovery_path_must_be_absolute');
  const source = path.resolve(journalPath);
  const output = path.resolve(outputPath);
  const sourceIdentity = `${source}.session-id`;
  const lockPath = `${source}.lock`;
  if ([source, sourceIdentity, lockPath].some((candidate) => output === candidate)
    || path.dirname(output) !== path.dirname(source) || `${output}.session-id` === source || `${output}.session-id` === sourceIdentity) {
    throw new Error('journal_recovery_path_conflict');
  }

  const directoryPath = path.dirname(source);
  const directoryInfo = await lstat(directoryPath);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('journal_directory_invalid');
  assertPrivatePosixStorage(directoryInfo, 'journal_directory_permissions', 'directory');
  await verifyWindowsAcl(directoryPath, { kind: 'directory' });
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1 || sourceInfo.size > MAX_JOURNAL_BYTES) {
    throw new Error('journal_file_invalid');
  }
  assertPrivatePosixStorage(sourceInfo, 'journal_permissions', 'file');
  await verifyWindowsAcl(source, { kind: 'file' });

  const lockHandle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  const nonce = randomBytes(16).toString('hex');
  const lockText = JSON.stringify({ magic: RECOVERY_LOCK_MAGIC, pid: process.pid, nonce });
  let lockInfo;
  let lockTextWritten = false;
  try {
    lockInfo = await lockHandle.stat();
    if (!lockInfo.isFile() || lockInfo.nlink !== 1) throw new Error('journal_lock_invalid');
    assertPrivatePosixStorage(lockInfo, 'journal_lock_permissions', 'file');
    await verifyWindowsAcl(lockPath, { kind: 'file' });
    await lockHandle.writeFile(lockText, 'utf8');
    lockTextWritten = true;
    await lockHandle.sync();
    const sourceHandle = await open(source, fsConstants.O_RDONLY | NOFOLLOW);
    let snapshot;
    try {
      const openedInfo = await sourceHandle.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== sourceInfo.dev || openedInfo.ino !== sourceInfo.ino
        || openedInfo.size !== sourceInfo.size) throw new Error('journal_changed_during_recovery');
      snapshot = await sourceHandle.readFile();
      const afterInfo = await sourceHandle.stat();
      if (afterInfo.size !== openedInfo.size || snapshot.byteLength !== openedInfo.size) throw new Error('journal_changed_during_recovery');
    } finally {
      await sourceHandle.close();
    }
    const recovered = recoverRuntimeAuditJournalPrefix(snapshot, { maxBytes: MAX_JOURNAL_BYTES });
    const sessionId = await readRuntimeSessionId(source, { verifyWindowsAcl });
    const identityPath = `${output}.session-id`;
    await assertPathMissing(output, 'journal_recovery_output_exists');
    await assertPathMissing(identityPath, 'journal_recovery_identity_exists');
    const outputHandle = await open(output, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    try {
      const info = await outputHandle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('journal_recovery_output_invalid');
      assertPrivatePosixStorage(info, 'journal_permissions', 'file');
      await verifyWindowsAcl(output, { kind: 'file' });
      await outputHandle.writeFile(recovered.snapshot);
      await outputHandle.sync();
    } finally {
      await outputHandle.close();
    }
    await writeNewPrivateFile(identityPath, Buffer.from(`${sessionId}\n`, 'ascii'), verifyWindowsAcl);
    return { journalPath: output, identityPath, sessionId, ...recovered };
  } finally {
    await lockHandle.close().catch(() => {});
    try {
      const current = await lstat(lockPath);
      const currentHandle = await open(lockPath, fsConstants.O_RDONLY | NOFOLLOW);
      let currentText;
      try { currentText = await currentHandle.readFile('utf8'); }
      finally { await currentHandle.close(); }
      if (current.dev === lockInfo.dev && current.ino === lockInfo.ino
        && ((lockTextWritten && currentText === lockText) || (!lockTextWritten && current.size === 0))) await unlink(lockPath);
    } catch { /* Preserve any lock not provably owned by this recovery operation. */ }
  }
}

async function assertPathMissing(filePath, code) {
  try {
    await lstat(filePath);
    throw new Error(code);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

function encodePayload(snapshot, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('runtime_session_identity_invalid');
  const id = Buffer.from(sessionId, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(snapshot.byteLength);
  return Buffer.concat([size, snapshot, id]);
}

async function encryptPayload(payload, passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, salt, nonce]);
  const key = await deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
  } finally {
    key.fill(0);
    payload.fill(0);
  }
}

async function decryptPayload(encrypted, passphrase) {
  const headerLength = MAGIC.length + SALT_BYTES + NONCE_BYTES;
  if (!Buffer.isBuffer(encrypted) || encrypted.byteLength < headerLength + TAG_BYTES + 4 + 32
    || encrypted.byteLength > MAX_BACKUP_BYTES || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('backup_file_invalid');
  }
  const saltStart = MAGIC.length;
  const nonceStart = saltStart + SALT_BYTES;
  const tagStart = headerLength;
  const ciphertextStart = tagStart + TAG_BYTES;
  const salt = encrypted.subarray(saltStart, nonceStart);
  const nonce = encrypted.subarray(nonceStart, tagStart);
  const header = encrypted.subarray(0, headerLength);
  const tag = encrypted.subarray(tagStart, ciphertextStart);
  const key = await deriveKey(passphrase, salt);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(ciphertextStart)), decipher.final()]);
  } catch {
    throw new Error('backup_authentication_failed');
  } finally {
    key.fill(0);
  }
  if (plaintext.byteLength < 36) throw new Error('backup_payload_invalid');
  const snapshotLength = plaintext.readUInt32BE(0);
  if (snapshotLength > MAX_JOURNAL_BYTES || plaintext.byteLength !== 4 + snapshotLength + 32) {
    plaintext.fill(0);
    throw new Error('backup_payload_invalid');
  }
  const snapshot = Buffer.from(plaintext.subarray(4, 4 + snapshotLength));
  const sessionId = plaintext.subarray(4 + snapshotLength).toString('ascii');
  plaintext.fill(0);
  return { snapshot, sessionId };
}

async function deriveKey(passphrase, salt) {
  return scryptAsync(passphrase, salt, KEY_BYTES, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function writeNewPrivateFile(filePath, contents, verifyWindowsAcl) {
  const handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('restore_file_invalid');
    assertPrivatePosixStorage(info, 'restore_file_permissions', 'file');
    await verifyWindowsAcl(filePath, { kind: 'file' });
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  return typeof left.dev === 'bigint' && typeof left.ino === 'bigint' && left.ino !== 0n
    && left.dev === right.dev && left.ino === right.ino;
}

function assertAbsolutePath(value, code) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) throw new TypeError(code);
}

function assertPassphrase(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 12 || Buffer.byteLength(value, 'utf8') > 1024) {
    throw new TypeError('backup_passphrase_length_invalid');
  }
}
