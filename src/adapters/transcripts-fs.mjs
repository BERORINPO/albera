// @ts-check
// adapter: CLI の会話ログ (<projectsDir>/<dir>/<cliSessionId>.jsonl) の末尾を読む (読み取り専用)。
// projectsDir は entry が決める (config.mjs: --projects-dir > 環境変数 > CLAUDE_CONFIG_DIR > ~/.claude/projects)。
// 場所はファイル名から引く表で探す (cwd からパスを組み立て直さない)。表は TTL ごとに作り直す。
// 返すのは生の末尾テキストと mtime だけ。ターン状態の解釈は core。

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BG_LEAD_MS,
  CLI_SESSION_ID_RE,
  MISSING_REBUILD_MS,
  QUIET_MS,
  READ_CONCURRENCY,
  SUBAGENT_SCAN_DEPTH,
  SUBAGENT_SCAN_MAX,
  TAIL_BYTES,
  TAIL_RETRY_BYTES,
  TRANSCRIPT_MAP_TTL_MS,
} from '../shared/constants.mjs';
import { turnEntries } from '../core/turn.mjs';
import { mapLimit } from './map-limit.mjs';

/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */

/**
 * ファイルの末尾 bytes バイトを読む (読み取り専用で開き、すぐ閉じる)。
 * @param {string} file
 * @param {number} size
 * @param {number} bytes
 */
export async function readTail(file, size, bytes) {
  const len = Math.min(bytes, size);
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    return { tail: buf.subarray(0, bytesRead).toString('utf8'), truncatedHead: len < size };
  } finally {
    await fh.close();
  }
}

/** @param {string} p */
const mtimeOf = async (p) => {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return 0; // 読む間に消えた
  }
};

/**
 * dir 配下で一番新しいファイルの mtime (stat だけ。深さと件数に上限)。無ければ 0。
 * 各階層でフォルダを mtime の新しい順に降りる (ファイルを作ったフォルダほど mtime が新しい)。
 * 件数の上限に達しても、切り捨てられるのは古いワークフローの方になる。
 * stopAbove より新しいファイルを見つけたら、そのフォルダを見終えたところで打ち切る
 * (呼び出し側は「作業中」の判定が変わらない値を渡す)。
 * @param {string} dir
 * @param {number} [stopAbove]
 */
export async function newestMtimeUnder(dir, stopAbove = Infinity) {
  let newest = 0;
  let seen = 0;
  /** @param {string} d @param {number} depth */
  async function walk(d, depth) {
    let ents;
    try {
      ents = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    /** @type {string[]} */
    const dirs = [];
    /** @type {string[]} */
    const files = [];
    for (const e of ents) {
      if (++seen > SUBAGENT_SCAN_MAX) break;
      const p = path.join(d, e.name);
      if (!e.isDirectory()) files.push(p);
      else if (depth < SUBAGENT_SCAN_DEPTH) dirs.push(p);
    }
    for (const m of await Promise.all(files.map(mtimeOf))) newest = Math.max(newest, m);
    if (newest > stopAbove || seen > SUBAGENT_SCAN_MAX) return;
    const ordered = await Promise.all(dirs.map(async (p) => ({ p, m: await mtimeOf(p) })));
    ordered.sort((a, b) => b.m - a.m);
    for (const { p } of ordered) {
      if (seen >= SUBAGENT_SCAN_MAX || newest > stopAbove) return;
      await walk(p, depth + 1);
    }
  }
  await walk(dir, 0);
  return newest;
}

/**
 * @param {{projectsDir: string, ttlMs?: number, clock?: () => number}} opts
 */
export function createTranscriptsSource({ projectsDir, ttlMs = TRANSCRIPT_MAP_TTL_MS, clock = () => Date.now() }) {
  /** @type {Map<string, {path: string, mtimeMs: number}>} */
  let index = new Map();
  let builtAt = -Infinity;
  let dirMissing = false;
  /** @type {Map<string, {size: number, mtimeMs: number, tail: string, truncatedHead: boolean}>} */
  const tailCache = new Map();

  async function rebuildIndex() {
    /** @type {Map<string, {path: string, mtimeMs: number}>} */
    const next = new Map();
    let dirs;
    try {
      dirs = (await fs.readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
      dirMissing = false;
    } catch {
      dirMissing = true;
      dirs = [];
    }
    for (const d of dirs) {
      let names = [];
      try {
        names = await fs.readdir(path.join(projectsDir, d.name));
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const id = n.slice(0, -'.jsonl'.length);
        if (!CLI_SESSION_ID_RE.test(id)) continue;
        const p = path.join(projectsDir, d.name, n);
        const prev = next.get(id);
        if (!prev) {
          next.set(id, { path: p, mtimeMs: 0 });
          continue;
        }
        // 同じ ID が 2 か所にあるときは新しい方
        const [a, b] = await Promise.all([fs.stat(prev.path).catch(() => null), fs.stat(p).catch(() => null)]);
        if ((b?.mtimeMs ?? 0) > (a?.mtimeMs ?? 0)) next.set(id, { path: p, mtimeMs: b?.mtimeMs ?? 0 });
      }
    }
    index = next;
    builtAt = clock();
  }

  /** @param {string} file @param {number} size @param {number} mtimeMs */
  async function tailOf(file, size, mtimeMs) {
    const hit = tailCache.get(file);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit;
    let r = await readTail(file, size, TAIL_BYTES);
    // 1 行が 200KB を超えるなどで該当行が 0 件なら、大きく 1 回だけ読み直す
    if (r.truncatedHead && turnEntries(r.tail, true).length === 0) r = await readTail(file, size, TAIL_RETRY_BYTES);
    const entry = { size, mtimeMs, ...r };
    tailCache.set(file, entry);
    return entry;
  }

  /** @param {string} cli @returns {Promise<TranscriptInput|null>} */
  async function readOne(cli) {
    const hit = index.get(cli);
    if (!hit) return null;
    let st;
    try {
      st = await fs.stat(hit.path);
    } catch {
      builtAt = -Infinity; // 消えた: 次回は表を作り直す
      return null;
    }
    try {
      const t = await tailOf(hit.path, st.size, st.mtimeMs);
      // これより新しい subagent のファイルが 1 つ見つかれば「バックグラウンドで作業中」は決まる (core の bg 判定と同じ式)
      const stopAbove = Math.max(clock() - QUIET_MS, st.mtimeMs + BG_LEAD_MS);
      const subMtime = await newestMtimeUnder(path.join(path.dirname(hit.path), cli, 'subagents'), stopAbove);
      return { tail: t.tail, truncatedHead: t.truncatedHead, mainMtime: st.mtimeMs, subMtime, size: st.size };
    } catch {
      return null;
    }
  }

  return {
    /**
     * @param {string[]} cliSessionIds
     * @returns {Promise<Map<string, TranscriptInput>>} 見つかったものだけ入る
     */
    async read(cliSessionIds) {
      const ids = [...new Set(cliSessionIds)];
      const age = clock() - builtAt;
      // 表を作ったあとに始まったセッションは表に無い。TTL を待たず、間隔を空けて作り直す
      if (age >= ttlMs || (age >= MISSING_REBUILD_MS && ids.some((id) => !index.has(id)))) await rebuildIndex();
      const results = await mapLimit(ids, READ_CONCURRENCY, readOne);
      /** @type {Map<string, TranscriptInput>} */
      const out = new Map();
      ids.forEach((id, i) => {
        const r = results[i];
        if (r) out.set(id, r);
      });
      const keep = new Set([...out.keys()].map((id) => index.get(id)?.path));
      for (const k of tailCache.keys()) if (!keep.has(k)) tailCache.delete(k);
      return out;
    },
    stats() {
      return { dirMissing, indexed: index.size };
    },
  };
}
