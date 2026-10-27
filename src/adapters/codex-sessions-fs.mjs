// @ts-check
// adapter: Codex CLI の rollout JSONL を read-only で走査し、許可リストのイベントだけを SessionRecord に射影する。
// CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl の session_meta.source=cli を対象にする。

import fs from 'node:fs/promises';
import path from 'node:path';
import { READ_CONCURRENCY } from '../shared/constants.mjs';
import { mapLimit } from './map-limit.mjs';
import { opaqueProviderSessionId } from './opaque-session-id.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FILE_RE = new RegExp(`^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})\\.jsonl$`, 'i');
const MAX_HEADER_BYTES = 32 * 1024;
const TAIL_BYTES = 128 * 1024;
const EVENT_LIMIT = 30;
const ORIGINATORS = new Set(['codex', 'codex_cli_rs']);
const START_TYPES = new Set(['task_started', 'turn_started']);
const COMPLETE_TYPES = new Set(['task_complete', 'turn_complete']);
const ABORT_TYPES = new Set(['turn_aborted']);
const NON_TERMINAL_ERROR_INFO = new Set(['active_turn_not_steerable', 'thread_rollback_failed']);
const TERMINAL_ERROR_INFO = new Set([
  'context_window_exceeded', 'session_budget_exceeded', 'usage_limit_exceeded', 'rate_limit_exceeded',
  'flex_unavailable', 'server_overloaded', 'model_not_found', 'cyber_policy', 'bio_policy',
  'misalignment_policy_violation', 'too_many_denials', 'http_connection_failed',
  'response_stream_connection_failed', 'internal_server_error', 'unauthorized', 'bad_request',
  'invalid_prompt', 'sandbox_error', 'response_stream_disconnected', 'response_too_many_failed_attempts', 'other',
]);
const WSL_SHARE_STATUSES = new Set(['configured', 'not_configured', 'not_applicable']);

/** @param {unknown} v @returns {v is Record<string, any>} */
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} v @returns {number|undefined} */
function timestamp(v) {
  if (typeof v !== 'string' || v.length > 64) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * 先頭の session_meta だけを read-only で読む。巨大行・破損行・想定外の封筒は無視する。
 * @param {import('node:fs/promises').FileHandle} handle @param {(cwd:unknown)=>string|null} [cwdMapper]
 */
async function readHeader(handle, cwdMapper) {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
  if (end < 0 || end > MAX_HEADER_BYTES) return null;
  try {
    const line = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    if (!obj(line) || line.type !== 'session_meta' || !obj(line.payload)) return null;
    const meta = obj(line.payload.meta) ? line.payload.meta : line.payload;
    if (meta.source !== 'cli') return { rejected: 'not_cli', reason: Object.hasOwn(meta, 'source') ? 'other_source' : 'missing_source' };
    if (!ORIGINATORS.has(meta.originator)) return { rejected: 'unsupported_originator' };
    const id = typeof meta.id === 'string' && new RegExp(`^${UUID}$`, 'i').test(meta.id) ? meta.id.toLowerCase() : null;
    const cwd = cwdMapper
      ? cwdMapper(meta.cwd)
      : typeof meta.cwd === 'string' && path.isAbsolute(meta.cwd) ? meta.cwd : null;
    const createdAt = timestamp(meta.timestamp) ?? timestamp(line.timestamp);
    if (!id || !cwd || !createdAt) return null;
    return { id, cwd, createdAt };
  } catch {
    return null;
  }
}

/**
 * 末尾だけを read-only で読む。先頭の部分行を捨て、JSONL の各行は独立に検証する。
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} size
 */
async function readTail(handle, size) {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, size - length));
  let text = buffer.subarray(0, bytesRead).toString('utf8');
  if (size > length) {
    const newline = text.indexOf('\n');
    if (newline < 0) return [];
    text = text.slice(newline + 1);
  }
  const out = [];
  for (const raw of text.split(/\r?\n/).slice(-500)) {
    if (!raw || Buffer.byteLength(raw) > 64 * 1024) continue;
    try {
      const line = JSON.parse(raw);
      if (!obj(line) || line.type !== 'event_msg' || !obj(line.payload)) continue;
      const type = line.payload.type;
      const at = timestamp(line.timestamp);
      if (!at) continue;
      const turnId = typeof line.payload.turn_id === 'string' && line.payload.turn_id.length <= 128 ? line.payload.turn_id : undefined;
      if (typeof type === 'string' && START_TYPES.has(type)) out.push({ type: 'turn_started', at, turnId });
      else if (typeof type === 'string' && COMPLETE_TYPES.has(type)) {
        out.push({ type: terminalType(line.payload), at, turnId });
      }
      else if (typeof type === 'string' && ABORT_TYPES.has(type)) out.push({ type: 'turn_aborted', at, turnId });
    } catch {
      // JSONL の末尾は Codex が書き込み中のことがある。壊れた行だけを捨てる。
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-EVENT_LIMIT);
}

/** @param {Record<string, any>} payload */
function terminalType(payload) {
  const error = payload.error;
  if (error == null) return 'turn_completed';
  if (!obj(error) || typeof error.message !== 'string') return 'turn_unknown';
  const info = error.codex_error_info;
  if (info == null) return 'turn_failed';
  if (typeof info !== 'string') return 'turn_unknown';
  if (NON_TERMINAL_ERROR_INFO.has(info)) return 'turn_completed';
  return TERMINAL_ERROR_INFO.has(info) ? 'turn_failed' : 'turn_unknown';
}

/** @param {string} dir */
async function dirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** @param {string} root @param {number} concurrency @param {(cwd:unknown)=>string|null} [cwdMapper] @param {string} [wslShareStatus] */
export function createCodexSessionsSource({ root, concurrency = READ_CONCURRENCY, cwdMapper, wslShareStatus = 'not_applicable' }) {
  /** @type {Map<string, {mtimeMs:number,size:number,record: any|null,rejection?:'not_cli'|'unsupported_originator'|'filename_mismatch',reason?:'missing_source'|'other_source'}>} */
  const cache = new Map();

  /** @param {string} file @param {{files:number,parsed:number,bad:number,stale:number,dirs:number,notCli:number,missingSource:number,otherSource:number,unsupportedOriginator:number,filenameMismatch:number}} stats */
  async function readOne(file, stats) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return null;
    }
    stats.files++;
    const previous = cache.get(file);
    if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
      if (previous.record) stats.parsed++;
      else {
        stats.bad++;
        if (previous.rejection === 'not_cli') {
          stats.notCli++;
          if (previous.reason === 'missing_source') stats.missingSource++;
          if (previous.reason === 'other_source') stats.otherSource++;
        }
        if (previous.rejection === 'unsupported_originator') stats.unsupportedOriginator++;
        if (previous.rejection === 'filename_mismatch') stats.filenameMismatch++;
      }
      return previous.record;
    }
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const meta = await readHeader(handle, cwdMapper);
      if (meta?.rejected === 'not_cli') {
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record: null, rejection: 'not_cli', reason: meta.reason });
        stats.bad++;
        stats.notCli++;
        if (meta.reason === 'missing_source') stats.missingSource++;
        if (meta.reason === 'other_source') stats.otherSource++;
        return null;
      }
      if (meta?.rejected === 'unsupported_originator') {
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record: null, rejection: 'unsupported_originator' });
        stats.bad++;
        stats.unsupportedOriginator++;
        return null;
      }
      if (!meta) {
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record: null });
        stats.bad++;
        return null;
      }
      const sourceEvents = await readTail(handle, stat.size);
      const { lifecycle, events } = projectLifecycle(sourceEvents);
      const filename = FILE_RE.exec(path.basename(file));
      if (!filename || filename[2].toLowerCase() !== meta.id) {
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record: null, rejection: 'filename_mismatch' });
        stats.bad++;
        stats.filenameMismatch++;
        return null;
      }
      const lastActivityAt = lifecycle.status === 'active' ? Math.max(events.at(-1)?.at ?? meta.createdAt, stat.mtimeMs) : events.at(-1)?.at ?? meta.createdAt;
      const record = {
        source: 'codex',
        cliSessionId: meta.id,
        ...(cwdMapper ? { executionLocation: 'wsl' } : {}),
        sessionId: opaqueProviderSessionId('codex', meta.id),
        title: 'Codex CLI',
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        lastActivityAt,
        lastFocusedAt: lastActivityAt,
        isArchived: false,
        isStarred: false,
        autoArchiveExempt: true,
        prs: [],
        pendingFirstStart: null,
        lifecycle,
        events,
      };
      cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record });
      stats.parsed++;
      return record;
    } catch {
      if (previous?.record) {
        stats.stale++;
        return previous.record;
      }
      stats.bad++;
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return {
    /** @returns {Promise<{sessions:any[],archivedIds:Set<string>,stats:{files:number,parsed:number,bad:number,stale:number,dirs:number}}>} */
    async load() {
      const stats = {
        files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0, notCli: 0,
        missingSource: 0, otherSource: 0, unsupportedOriginator: 0, filenameMismatch: 0,
        wslShareStatus: WSL_SHARE_STATUSES.has(wslShareStatus) ? wslShareStatus : 'not_applicable',
      };
      const sessionsRoot = path.join(root, 'sessions');
      const files = [];
      for (const year of await dirs(sessionsRoot)) {
        if (!/^\d{4}$/.test(path.basename(year))) continue;
        for (const month of await dirs(year)) {
          if (!/^\d{2}$/.test(path.basename(month))) continue;
          stats.dirs++;
          for (const day of await dirs(month)) {
            if (!/^\d{2}$/.test(path.basename(day))) continue;
            let names = [];
            try {
              names = await fs.readdir(day);
            } catch {
              continue;
            }
            for (const name of names) if (FILE_RE.test(name)) files.push(path.join(day, name));
          }
        }
      }
      const records = await mapLimit(files, concurrency, (file) => readOne(file, stats));
      const seen = new Set(files);
      for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
      return { sessions: records.filter(Boolean), archivedIds: new Set(), stats };
    },
  };
}

/** @param {Array<{type:string,at:number,turnId?:string}>} sourceEvents */
function projectLifecycle(sourceEvents) {
  let state = 'unknown';
  let startedAt;
  let currentTurnId;
  let hasStart = false;
  const events = [];
  for (const event of sourceEvents) {
    if (event.type === 'turn_started') {
      state = 'active';
      startedAt = event.at;
      currentTurnId = event.turnId;
      hasStart = true;
      events.push({ type: event.type, at: event.at });
      continue;
    }

    if (hasStart && currentTurnId && event.turnId && currentTurnId !== event.turnId) continue;
    if (hasStart && (currentTurnId === undefined) !== (event.turnId === undefined)) {
      state = 'unknown';
      events.push({ type: 'turn_unknown', at: event.at });
      continue;
    }

    if (event.type === 'turn_completed') state = 'complete';
    else if (event.type === 'turn_failed') state = 'failed';
    else if (event.type === 'turn_aborted') state = 'interrupted';
    else if (event.type === 'turn_unknown') state = 'unknown';
    events.push({ type: event.type, at: event.at });
  }
  return {
    lifecycle: { status: state, ...(state === 'active' && startedAt ? { startedAt } : {}) },
    events,
  };
}
