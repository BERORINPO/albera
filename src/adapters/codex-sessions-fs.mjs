// @ts-check
// adapter: Codex CLI の rollout JSONL を read-only で走査し、許可リストのイベントだけを SessionRecord に射影する。
// CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl の session_meta.source=cli を対象にする。

import fs from 'node:fs/promises';
import path from 'node:path';
import { READ_CONCURRENCY } from '../shared/constants.mjs';
import { mapLimit } from './map-limit.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FILE_RE = new RegExp(`^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})\\.jsonl$`, 'i');
const MAX_HEADER_BYTES = 32 * 1024;
const TAIL_BYTES = 128 * 1024;
const EVENT_LIMIT = 30;
const ORIGINATORS = new Set(['codex', 'codex_cli_rs']);
const START_TYPES = new Set(['task_started', 'turn_started']);
const COMPLETE_TYPES = new Set(['task_complete', 'turn_complete']);
const ABORT_TYPES = new Set(['turn_aborted']);

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
 * @param {import('node:fs/promises').FileHandle} handle
 */
async function readHeader(handle) {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
  if (end < 0 || end > MAX_HEADER_BYTES) return null;
  try {
    const line = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    if (!obj(line) || line.type !== 'session_meta' || !obj(line.payload)) return null;
    const meta = obj(line.payload.meta) ? line.payload.meta : line.payload;
    if (meta.source !== 'cli' || !ORIGINATORS.has(meta.originator)) return null;
    const id = typeof meta.id === 'string' && new RegExp(`^${UUID}$`, 'i').test(meta.id) ? meta.id.toLowerCase() : null;
    const cwd = typeof meta.cwd === 'string' && path.isAbsolute(meta.cwd) ? meta.cwd : null;
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
      if (typeof type === 'string' && START_TYPES.has(type)) out.push({ type: 'turn_started', at });
      else if (typeof type === 'string' && COMPLETE_TYPES.has(type)) out.push({ type: 'turn_completed', at });
      else if (typeof type === 'string' && ABORT_TYPES.has(type)) out.push({ type: 'turn_aborted', at });
    } catch {
      // JSONL の末尾は Codex が書き込み中のことがある。壊れた行だけを捨てる。
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-EVENT_LIMIT);
}

/** @param {string} dir */
async function dirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** @param {string} root @param {number} concurrency */
export function createCodexSessionsSource({ root, concurrency = READ_CONCURRENCY }) {
  /** @type {Map<string, {mtimeMs:number,size:number,record: any|null}>} */
  const cache = new Map();

  /** @param {string} file @param {{files:number,parsed:number,bad:number,stale:number,dirs:number}} stats */
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
      else stats.bad++;
      return previous.record;
    }
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const meta = await readHeader(handle);
      if (!meta) {
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record: null });
        stats.bad++;
        return null;
      }
      const events = await readTail(handle, stat.size);
      const filename = FILE_RE.exec(path.basename(file));
      if (!filename || filename[2].toLowerCase() !== meta.id) {
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record: null });
        stats.bad++;
        return null;
      }
      const lifecycle = lifecycleOf(events);
      const lastActivityAt = lifecycle.status === 'active' ? Math.max(events.at(-1)?.at ?? meta.createdAt, stat.mtimeMs) : events.at(-1)?.at ?? meta.createdAt;
      const record = {
        source: 'codex',
        sessionId: `codex_${meta.id}`,
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
      const stats = { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0 };
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

/** @param {Array<{type:string,at:number}>} events */
function lifecycleOf(events) {
  let state = 'unknown';
  let startedAt;
  for (const event of events) {
    if (event.type === 'turn_started') {
      state = 'active';
      startedAt = event.at;
    } else if (event.type === 'turn_completed' || event.type === 'turn_aborted') state = 'complete';
  }
  return { status: state, ...(state === 'active' && startedAt ? { startedAt } : {}) };
}
