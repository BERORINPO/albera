// Stable non-secret API session identity paired with one explicit Runtime audit journal.
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { assertPrivateWindowsAcl } from './windows-acl.mjs';

const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Read or create a mode-restricted sidecar that lets the trusted host reissue a journal's session boundary.
 * Existing symlinks, non-files, malformed identifiers, and permissive POSIX modes fail closed without modification.
 */
export async function loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl = assertPrivateWindowsAcl } = {}) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) throw new TypeError('journal_path_must_be_absolute');
  const identityPath = `${journalPath}.session-id`;
  await verifyWindowsAcl(path.dirname(identityPath), { kind: 'directory' });
  try { return await readRuntimeSessionId(journalPath, { verifyWindowsAcl }); }
  catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }

  const sessionId = randomBytes(16).toString('hex');
  let handle;
  try {
    handle = await open(identityPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    await handle.writeFile(`${sessionId}\n`, 'utf8');
    await handle.sync();
    return sessionId;
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
    return readRuntimeSessionId(journalPath, { verifyWindowsAcl });
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Read the existing journal identity without creating or repairing a sidecar. */
export async function readRuntimeSessionId(journalPath, { verifyWindowsAcl = assertPrivateWindowsAcl } = {}) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) throw new TypeError('journal_path_must_be_absolute');
  return readIdentity(`${journalPath}.session-id`, verifyWindowsAcl);
}

async function readIdentity(filePath, verifyWindowsAcl) {
  if (process.platform === 'win32') {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('runtime_session_identity_invalid');
  }
  await verifyWindowsAcl(filePath, { kind: 'file' });
  const handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64) throw new Error('runtime_session_identity_invalid');
    if (process.platform !== 'win32') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if ((info.mode & 0o077) !== 0 || uid === undefined || info.uid !== uid) throw new Error('runtime_session_identity_permissions');
    }
    let value = await handle.readFile('utf8');
    if (value.endsWith('\n')) value = value.slice(0, -1);
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!SESSION_ID_RE.test(value)) throw new Error('runtime_session_identity_invalid');
    return value;
  } finally {
    await handle.close();
  }
}
