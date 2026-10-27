// Host-configured, append-only audit journal. It stores only allowlisted control metadata.
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const JOURNAL_VERSION = 1;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const HARD_MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 2048;
const MAX_RECORDS = 20_000;
const LOCK_MAGIC = 'ALBERA_RUNTIME_AUDIT_LOCK_V1';
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(['claude', 'codex', 'opencode']);
const ACTIONS = new Set(['run.start', 'run.stop']);
const PHASES = new Set(['requested', 'accepted', 'denied', 'failed']);
const EVENT_TYPES = new Set(['started', 'stop_requested', 'stopped', 'exited', 'failed', 'stop_failed']);
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGABRT']);

export class JournalError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * Open an explicitly located, single-writer append-only Runtime audit journal.
 * The journal never stores tokens, prompts, paths, argv, environment or process output.
 */
export async function openRuntimeAuditJournal(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) throw new TypeError('journal_path_must_be_absolute');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > HARD_MAX_BYTES) throw new TypeError('invalid_journal_capacity');
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const lockPath = `${filePath}.lock`;
  const nonce = randomBytes(16).toString('hex');
  const lockText = JSON.stringify({ magic: LOCK_MAGIC, pid: process.pid, nonce });
  const lock = await acquireLock(lockPath, lockText);
  let dataHandle;
  try {
    const existing = await readExisting(filePath, maxBytes);
    if (existing.byteLength > maxBytes) throw new JournalError('journal_capacity_exceeded');
    const records = parseRecords(existing);
    if (records.length > MAX_RECORDS) throw new JournalError('journal_capacity_exceeded');
    const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
    dataHandle = await open(filePath, flags, 0o600);
    const fileInfo = await dataHandle.stat();
    if (!fileInfo.isFile() || fileInfo.size !== existing.byteLength) throw new JournalError('journal_changed_during_open');
    return new RuntimeAuditJournal(filePath, lockPath, lock, lockText, dataHandle, records, existing.byteLength, maxBytes);
  } catch (error) {
    await dataHandle?.close().catch(() => {});
    await releaseLock(lockPath, lock, lockText);
    throw error;
  }
}

class RuntimeAuditJournal {
  #filePath;
  #lockPath;
  #lockHandle;
  #lockText;
  #dataHandle;
  #records;
  #eventSequences = new Map();
  #bytes;
  #maxBytes;
  #queue = Promise.resolve();
  #closing = false;
  #closed = false;
  #failed = false;
  #closePromise;

  constructor(filePath, lockPath, lockHandle, lockText, dataHandle, records, bytes, maxBytes) {
    this.#filePath = filePath;
    this.#lockPath = lockPath;
    this.#lockHandle = lockHandle;
    this.#lockText = lockText;
    this.#dataHandle = dataHandle;
    this.#records = records;
    for (const record of records) {
      if ((record.kind ?? 'audit') === 'event' && Number.isSafeInteger(record.eventId)) {
        this.#eventSequences.set(record.sessionId, Math.max(this.#eventSequences.get(record.sessionId) ?? 0, record.eventId));
      }
    }
    this.#bytes = bytes;
    this.#maxBytes = maxBytes;
  }

  /** Append a stable audit phase. Only the enumerated, non-content metadata is accepted. */
  append(input) {
    if (this.#closing || this.#closed) return Promise.reject(new JournalError('journal_closed'));
    if (this.#failed) return Promise.reject(new JournalError('journal_failed'));
    const payload = validateInput(input);
    const task = this.#queue.then(async () => {
      if (this.#failed) throw new JournalError('journal_failed');
      try {
        const sequence = this.#records.length ? this.#records.at(-1).sequence + 1 : 1;
        const eventId = payload.kind === 'event' ? (this.#eventSequences.get(payload.sessionId) ?? 0) + 1 : undefined;
        const record = Object.freeze({ version: JOURNAL_VERSION, sequence, ...payload, ...(eventId === undefined ? {} : { eventId }) });
        const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
        const bytes = line.byteLength;
        if (bytes > MAX_RECORD_BYTES) throw new JournalError('journal_record_too_large');
        if (this.#records.length >= MAX_RECORDS || this.#bytes + bytes > this.#maxBytes) throw new JournalError('journal_capacity_exceeded');
        let offset = 0;
        while (offset < bytes) {
          const { bytesWritten } = await this.#dataHandle.write(line, offset, bytes - offset, null);
          if (bytesWritten <= 0) throw new Error('journal_short_write');
          offset += bytesWritten;
        }
        await this.#dataHandle.sync();
        this.#bytes += bytes;
        this.#records.push(record);
        if (eventId !== undefined) this.#eventSequences.set(payload.sessionId, eventId);
        return { ...record };
      } catch (error) {
        if (error instanceof JournalError) throw error;
        this.#failed = true;
        throw new JournalError('journal_write_failed');
      }
    });
    this.#queue = task.catch(() => {});
    return task;
  }

  /** Read a bounded immutable snapshot; audit records use the journal sequence, events use their session cursor. */
  list({ sessionId, kind, after = 0, limit = 100 } = {}) {
    if (sessionId !== undefined && !SESSION_ID_RE.test(sessionId)) throw new TypeError('invalid_session_id');
    if (kind !== undefined && !['audit', 'event'].includes(kind)) throw new TypeError('invalid_journal_kind');
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('invalid_journal_cursor');
    return this.#records
      .filter((record) => (kind === 'event' ? record.eventId > after : record.sequence > after) && (sessionId === undefined || record.sessionId === sessionId)
        && (kind === undefined || (record.kind ?? 'audit') === kind))
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  /** Wait for queued writes, close descriptors, and release only this process's lock. */
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      try {
        await this.#queue;
        await this.#dataHandle.close();
      } finally {
        this.#closed = true;
        await releaseLock(this.#lockPath, this.#lockHandle, this.#lockText);
      }
    })();
    return this.#closePromise;
  }

  get path() { return this.#filePath; }
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_journal_record');
  const allowed = new Set(['kind', 'sessionId', 'requestId', 'action', 'phase', 'at', 'provider', 'runId', 'errorCode', 'eventType', 'eventId', 'code', 'signal']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('invalid_journal_record');
  const kind = input.kind ?? 'audit';
  if (!['audit', 'event'].includes(kind) || !SESSION_ID_RE.test(input.sessionId)
    || !Number.isSafeInteger(input.at) || input.at < 0) throw new TypeError('invalid_journal_record');
  if (input.provider !== undefined && !PROVIDERS.has(input.provider)) throw new TypeError('invalid_journal_record');
  if (input.runId !== undefined && !UUID_RE.test(input.runId)) throw new TypeError('invalid_journal_record');
  if (kind === 'event') {
    if (input.requestId !== undefined || input.action !== undefined || input.phase !== undefined || input.errorCode !== undefined
      || !EVENT_TYPES.has(input.eventType) || !PROVIDERS.has(input.provider) || !UUID_RE.test(input.runId)
      || (input.eventId !== undefined && (!Number.isSafeInteger(input.eventId) || input.eventId < 1))
      || (input.code !== undefined && input.code !== null && !Number.isSafeInteger(input.code))
      || (input.signal !== undefined && input.signal !== null && !SIGNALS.has(input.signal))) throw new TypeError('invalid_journal_record');
    return {
      kind, sessionId: input.sessionId, eventType: input.eventType, at: input.at,
      provider: input.provider, runId: input.runId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.code === undefined ? {} : { code: input.code }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
  }
  if (input.eventType !== undefined || input.eventId !== undefined || input.code !== undefined || input.signal !== undefined
    || !UUID_RE.test(input.requestId) || !ACTIONS.has(input.action) || !PHASES.has(input.phase)) throw new TypeError('invalid_journal_record');
  return {
    ...(input.kind === undefined ? {} : { kind }),
    sessionId: input.sessionId, requestId: input.requestId, action: input.action, phase: input.phase, at: input.at,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  };
}

async function readExisting(filePath, maxBytes) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new JournalError('journal_not_regular_file');
    if (info.size > maxBytes) throw new JournalError('journal_capacity_exceeded');
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

function parseRecords(buffer) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0x0a) throw new JournalError('journal_incomplete_tail');
  const lines = buffer.toString('utf8').split('\n');
  lines.pop();
  const records = [];
  const eventIds = new Map();
  for (const line of lines) {
    if (!line || Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new JournalError('journal_corrupt');
    let record;
    try { record = JSON.parse(line); }
    catch { throw new JournalError('journal_corrupt'); }
    const { version, sequence, ...payload } = record ?? {};
    if (version !== JOURNAL_VERSION || sequence !== records.length + 1) throw new JournalError('journal_corrupt');
    let normalized;
    try { normalized = validateInput(payload); }
    catch { throw new JournalError('journal_corrupt'); }
    if (normalized.kind === 'event') {
      const expectedEventId = (eventIds.get(normalized.sessionId) ?? 0) + 1;
      if (!Number.isSafeInteger(normalized.eventId) || normalized.eventId !== expectedEventId) throw new JournalError('journal_corrupt');
      eventIds.set(normalized.sessionId, expectedEventId);
    }
    records.push(Object.freeze({ version, sequence, ...payload }));
    if (records.length > MAX_RECORDS) throw new JournalError('journal_capacity_exceeded');
  }
  return records;
}

async function acquireLock(lockPath, lockText) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(lockText, 'utf8');
        await handle.sync();
        return handle;
      } catch (error) {
        await releaseLock(lockPath, handle, lockText);
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stale = await removeStaleLock(lockPath);
      if (!stale || attempt === 1) throw new JournalError('journal_locked');
    }
  }
  throw new JournalError('journal_locked');
}

async function removeStaleLock(lockPath) {
  try {
    const info = await lstat(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    const content = await readFile(lockPath, 'utf8');
    const owner = JSON.parse(content);
    if (owner?.magic !== LOCK_MAGIC || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[0-9a-f]{32}$/.test(owner.nonce ?? '')) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) {
      if (error?.code !== 'ESRCH') return false;
    }
    const latest = await readFile(lockPath, 'utf8');
    if (latest !== content) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

async function releaseLock(lockPath, handle, lockText) {
  await handle.close().catch(() => {});
  try {
    if (await readFile(lockPath, 'utf8') === lockText) await unlink(lockPath);
  } catch { /* preserve an unexpected or replaced lock */ }
}
