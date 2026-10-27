// @ts-check
// adapter: OpenCode SQLite session index, opened strictly read-only. Only safe event codes/times and a private directory hint escape.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_SESSIONS = 20;
const EVENT_LIMIT = 30;
const validTime = (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Stable opaque session key; the upstream OpenCode ID never crosses the adapter boundary. @param {string} id */
export function opaqueOpenCodeId(id) {
  const hex = createHash('sha256').update(id).digest('hex').slice(0, 32);
  return `opencode_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {string} version */
function supportsReadonlySqlite(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 4) || (major === 22 && minor >= 18);
}

/** @param {{root:string,maxSessions?:number,version?:string}} options */
export function createOpenCodeSessionsSource({ root, maxSessions = MAX_SESSIONS, version = process.versions.node }) {
  async function load() {
    const stats = { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0, unsupportedRuntime: false, legacySchema: false };
    let stat;
    try { stat = await fs.stat(root); } catch { return { sessions: [], archivedIds: new Set(), stats }; }
    if (!stat.isFile()) return { sessions: [], archivedIds: new Set(), stats };
    stats.files = 1;
    if (!supportsReadonlySqlite(version)) {
      stats.unsupportedRuntime = true;
      return { sessions: [], archivedIds: new Set(), stats };
    }
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(root, { readOnly: true, timeout: 250 });
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('session_v2');
      if (!exists) {
        const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get('session');
        const columns = legacy ? new Set(db.prepare('PRAGMA table_info(session)').all().map((column) => column.name)) : new Set();
        const required = ['id', 'directory', 'parent_id', 'time_created', 'time_updated', 'time_archived'];
        if (!legacy || required.some((column) => !columns.has(column))) {
          stats.bad = 1;
          return { sessions: [], archivedIds: new Set(), stats };
        }
        // V1 transcript/message and part tables carry prompts, tool I/O, and other arbitrary data.
        // We deliberately do not query them. List safe session metadata only; lifecycle stays unknown.
        stats.legacySchema = true;
        const rows = db.prepare(`
          SELECT id, directory, parent_id, time_created, time_updated
          FROM session
          WHERE time_archived IS NULL
          ORDER BY time_updated DESC
          LIMIT ?
        `).all(Math.max(1, Math.min(MAX_SESSIONS, maxSessions)));
        const sessions = [];
        for (const row of rows) {
          if (typeof row.id !== 'string' || !row.id || typeof row.directory !== 'string' || !path.isAbsolute(row.directory)) {
            stats.bad++;
            continue;
          }
          const createdAt = validTime(row.time_created);
          const updatedAt = validTime(row.time_updated);
          if (!createdAt || !updatedAt) { stats.bad++; continue; }
          sessions.push({
            source: 'opencode', sessionId: opaqueOpenCodeId(row.id), title: 'OpenCode', cwd: row.directory,
            ...(typeof row.parent_id === 'string' && row.parent_id ? { spawnedFromId: opaqueOpenCodeId(row.parent_id) } : {}),
            createdAt, lastActivityAt: updatedAt, isArchived: false, isStarred: false,
            autoArchiveExempt: true, prs: [], pendingFirstStart: null,
            lifecycle: { status: /** @type {const} */ ('unknown') }, events: [],
          });
        }
        stats.parsed = sessions.length;
        return { sessions, archivedIds: new Set(), stats };
      }
      const rows = db.prepare(`
        SELECT id, directory, parent_id, time_created, time_updated
        FROM session_v2
        WHERE time_archived IS NULL
        ORDER BY time_updated DESC
        LIMIT ?
      `).all(Math.max(1, Math.min(MAX_SESSIONS, maxSessions)));
      const eventsFor = db.prepare(`
        SELECT type, time_created, CASE WHEN type='idle' AND json_valid(data) THEN json_extract(data, '$.outcome') ELSE NULL END AS outcome
        FROM session_message
        WHERE session_id=? AND type IN ('user', 'idle')
        ORDER BY seq DESC
        LIMIT ?
      `);
      const sessions = [];
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id || typeof row.directory !== 'string' || !path.isAbsolute(row.directory)) {
          stats.bad++;
          continue;
        }
        const createdAt = validTime(row.time_created);
        const updatedAt = validTime(row.time_updated);
        if (!createdAt || !updatedAt) { stats.bad++; continue; }
        const eventRows = eventsFor.all(row.id, EVENT_LIMIT).reverse();
        const events = [];
        let finalState = 'unknown';
        for (const item of eventRows) {
          const at = validTime(item.time_created);
          if (!at) continue;
          if (item.type === 'user') { events.push({ type: 'turn_started', at }); finalState = 'active'; }
          else if (item.type === 'idle' && item.outcome === 'succeeded') { events.push({ type: 'turn_completed', at }); finalState = 'complete'; }
          else if (item.type === 'idle' && item.outcome === 'interrupted') { events.push({ type: 'turn_aborted', at }); finalState = 'interrupted'; }
          else if (item.type === 'idle' && item.outcome === 'failed') { events.push({ type: 'turn_failed', at }); finalState = 'failed'; }
          else if (item.type === 'idle') finalState = 'unknown';
        }
        const last = events.at(-1);
        const lifecycle = finalState === 'active' && last?.type === 'turn_started'
          ? { status: /** @type {const} */ ('active'), startedAt: last.at }
          : finalState === 'complete'
            ? { status: /** @type {const} */ ('complete') }
            : finalState === 'interrupted'
              ? { status: /** @type {const} */ ('interrupted') }
            : finalState === 'failed'
              ? { status: /** @type {const} */ ('failed') }
            : { status: /** @type {const} */ ('unknown') };
        sessions.push({
          source: 'opencode', sessionId: opaqueOpenCodeId(row.id), title: 'OpenCode', cwd: row.directory,
          ...(typeof row.parent_id === 'string' && row.parent_id ? { spawnedFromId: opaqueOpenCodeId(row.parent_id) } : {}),
          createdAt, lastActivityAt: updatedAt, isArchived: false, isStarred: false,
          autoArchiveExempt: true, prs: [], pendingFirstStart: null, lifecycle, events,
        });
      }
      stats.parsed = sessions.length;
      return { sessions, archivedIds: new Set(), stats };
    } catch {
      stats.bad = 1;
      return { sessions: [], archivedIds: new Set(), stats };
    } finally {
      try { db?.close(); } catch { /* close errors do not expose database diagnostics */ }
    }
  }
  return { load };
}
