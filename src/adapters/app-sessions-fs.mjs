// @ts-check
// adapter: Claude デスクトップアプリのセッションメタデータを読む (読み取り専用)。
//   <root>/<accountUuid>/<orgUuid>/local_<uuid>.json と archived-sessions.idx
// root (セッションフォルダ) は entry が OS ごとの候補から決める (config.mjs)。
// アプリが常に書き換えるファイルなので、書き込み・rename・ロック・watch は一切しない。
// 壊れた JSON (書き込み途中) は前回の正常な射影を使い、無ければ飛ばして数える。例外は投げない。

import fs from 'node:fs/promises';
import path from 'node:path';
import { READ_CONCURRENCY } from '../shared/constants.mjs';
import { mapLimit } from './map-limit.mjs';
import { toSessionRecord } from './session-record.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {{files: number, parsed: number, bad: number, stale: number, dirs: number}} SourceStats */

const SESSION_FILE_RE = /^local_[0-9a-f-]{36}\.json$/;
const IDX_FILE = 'archived-sessions.idx';

/** @param {string} dir */
async function subdirs(dir) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * @param {{root: string, concurrency?: number}} opts
 */
export function createAppSessionsSource({ root, concurrency = READ_CONCURRENCY }) {
  /** @type {Map<string, {mtimeMs: number, size: number, record: SessionRecord|null}>} */
  const cache = new Map();
  /** @type {Map<string, string[]>} idx ファイルごとの前回の正常値 */
  const idxCache = new Map();

  /** @param {string} dir @param {Set<string>} into */
  async function readIdx(dir, into) {
    const p = path.join(dir, IDX_FILE);
    let ids = idxCache.get(p) ?? [];
    try {
      const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
      if (parsed && Array.isArray(parsed.archived)) {
        ids = parsed.archived.filter((/** @type {unknown} */ x) => typeof x === 'string');
        idxCache.set(p, ids);
      }
    } catch {
      // 無い・書き込み途中: 前回の値をそのまま使う
    }
    for (const id of ids) into.add(id);
  }

  /** @param {string} file @param {SourceStats} stats @returns {Promise<SessionRecord|null>} */
  async function readOne(file, stats) {
    const prev = cache.get(file);
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      return null; // 読む間に消えた
    }
    stats.files++;
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      if (prev.record) stats.parsed++;
      else stats.bad++;
      return prev.record;
    }
    try {
      const record = toSessionRecord(JSON.parse(await fs.readFile(file, 'utf8')));
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, record });
      if (record) stats.parsed++;
      else stats.bad++;
      return record;
    } catch {
      if (prev?.record) {
        stats.stale++;
        return prev.record;
      }
      stats.bad++;
      return null;
    }
  }

  return {
    /** @returns {Promise<{sessions: SessionRecord[], archivedIds: Set<string>, stats: SourceStats}>} */
    async load() {
      /** @type {SourceStats} */
      const stats = { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0 };
      const archivedIds = new Set();
      const files = [];
      for (const acct of await subdirs(root)) {
        for (const org of await subdirs(acct)) {
          stats.dirs++;
          await readIdx(org, archivedIds);
          let names = [];
          try {
            names = await fs.readdir(org);
          } catch {
            continue;
          }
          for (const n of names) if (SESSION_FILE_RE.test(n)) files.push(path.join(org, n));
        }
      }
      const records = await mapLimit(files, concurrency, (f) => readOne(f, stats));
      const seen = new Set(files);
      for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
      const sessions = /** @type {SessionRecord[]} */ (records.filter(Boolean));
      return { sessions, archivedIds, stats };
    },
  };
}
