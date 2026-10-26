// @ts-check
// adapter: local GitHub Copilot session event logs. Only safe event codes/times and a private cwd hint escape.
// COPILOT_HOME/session-state/<sessionId>/events.jsonl is shared by CLI and the Copilot app; source is labeled GitHub Copilot.

import fs from 'node:fs/promises';
import path from 'node:path';
import { opaqueProviderSessionId } from './opaque-session-id.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSIONS = 20;
const HEADER_BYTES = 32 * 1024;
const TAIL_BYTES = 128 * 1024;
const EVENT_LIMIT = 30;
const START = new Set(['assistant.turn_start']);
const COMPLETE = new Set(['assistant.turn_end', 'session.task_complete']);
const INTERRUPT = new Set(['abort']);
const FAILURE = new Set(['session.error']);

/** @param {unknown} value @returns {value is Record<string, any>} */
const obj = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value */
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** @param {import('node:fs/promises').FileHandle} handle */
async function readHeader(handle) {
  const buffer = Buffer.alloc(HEADER_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
  if (newline < 0 || newline > HEADER_BYTES) return null;
  try {
    const event = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
    if (!obj(event) || event.type !== 'session.start' || !obj(event.data)) return null;
    const data = event.data;
    if (data.producer !== 'copilot-agent' || typeof data.sessionId !== 'string' || !UUID.test(data.sessionId)) return null;
    const cwd = obj(data.context) && typeof data.context.cwd === 'string' && path.isAbsolute(data.context.cwd) ? data.context.cwd : undefined;
    const createdAt = timestamp(data.startTime) ?? timestamp(event.timestamp);
    if (!createdAt) return null;
    return { id: data.sessionId.toLowerCase(), cwd, createdAt };
  } catch { return null; }
}

/** @param {import('node:fs/promises').FileHandle} handle @param {number} size */
async function readEvents(handle, size) {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, size - length));
  let content = buffer.subarray(0, bytesRead).toString('utf8');
  if (size > length) {
    const newline = content.indexOf('\n');
    if (newline < 0) return [];
    content = content.slice(newline + 1);
  }
  /** @type {Array<{type:'turn_started'|'turn_completed'|'turn_aborted'|'turn_failed',at:number}>} */
  const events = [];
  /** @type {'unknown'|'active'|'complete'|'interrupted'|'failed'} */
  let status = 'unknown';
  /** @type {number|undefined} */
  let startedAt;
  for (const raw of content.split(/\r?\n/).slice(-500)) {
    if (!raw || Buffer.byteLength(raw) > 64 * 1024) continue;
    try {
      const event = JSON.parse(raw);
      if (!obj(event) || typeof event.type !== 'string') continue;
      // The SDK also persists child-agent events on the parent stream. They are not the root session lifecycle.
      if (event.agentId !== undefined && event.agentId !== null) continue;
      const failedShutdown = event.type === 'session.shutdown' && obj(event.data) && event.data.shutdownType === 'error';
      const type = START.has(event.type) ? 'turn_started' : COMPLETE.has(event.type) ? 'turn_completed' : INTERRUPT.has(event.type) ? 'turn_aborted' : FAILURE.has(event.type) || failedShutdown ? 'turn_failed' : null;
      const at = timestamp(event.timestamp);
      if (type && at) {
        events.push({ type, at });
        if (type === 'turn_started') { status = 'active'; startedAt = at; }
        else if (type === 'turn_aborted') { status = 'interrupted'; startedAt = undefined; }
        else if (type === 'turn_failed') { status = 'failed'; startedAt = undefined; }
        else if (event.type === 'session.task_complete') { status = 'complete'; startedAt = undefined; }
        else { status = 'unknown'; startedAt = undefined; }
      }
    } catch { /* malformed or partial event is ignored */ }
  }
  return {
    events: events.slice(-EVENT_LIMIT),
    lifecycle: status === 'active' && startedAt ? { status, startedAt } : { status },
  };
}

/** @param {{root:string,maxSessions?:number,now?:()=>number}} options */
export function createCopilotSessionsSource({ root, maxSessions = MAX_SESSIONS }) {
  /** @type {Map<string,{mtimeMs:number,size:number,record:object|null}>} */
  const cache = new Map();

  async function load() {
    const stats = { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0 };
    /** @type {string[]} */
    let dirs;
    try {
      dirs = (await fs.readdir(path.join(root, 'session-state'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
        .map((entry) => path.join(root, 'session-state', entry.name));
    } catch { return { sessions: [], archivedIds: new Set(), stats }; }
    const ranked = await Promise.all(dirs.map(async (dir) => {
      try { return { dir, mtimeMs: (await fs.stat(path.join(dir, 'events.jsonl'))).mtimeMs }; }
      catch { return null; }
    }));
    const candidates = ranked.filter((entry) => entry !== null).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, Math.min(MAX_SESSIONS, maxSessions)));
    stats.dirs = dirs.length;
    /** @type {any[]} */
    const sessions = [];
    for (const candidate of candidates) {
      const file = path.join(candidate.dir, 'events.jsonl');
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      stats.files++;
      const previous = cache.get(file);
      if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        if (previous.record) { sessions.push(previous.record); stats.parsed++; } else stats.bad++;
        continue;
      }
      let handle;
      try {
        handle = await fs.open(file, 'r');
        const header = await readHeader(handle);
        if (!header || header.id !== path.basename(candidate.dir).toLowerCase()) {
          cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, record: null });
          stats.bad++;
          continue;
        }
        const { events, lifecycle } = await readEvents(handle, stat.size);
        const lastActivityAt = Math.max(events.at(-1)?.at ?? header.createdAt, stat.mtimeMs);
        const record = {
          source: 'copilot',
          sessionId: opaqueProviderSessionId('copilot', header.id),
          title: 'GitHub Copilot',
          cwd: header.cwd,
          createdAt: header.createdAt,
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
        sessions.push(record);
        stats.parsed++;
      } catch {
        if (previous?.record) { sessions.push(previous.record); stats.stale++; }
        else stats.bad++;
      } finally { await handle?.close().catch(() => {}); }
    }
    return { sessions, archivedIds: new Set(), stats };
  }

  return { load };
}
