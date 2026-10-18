// @ts-check
// entry: adapter と core をつなぐ 1 点 (wiring)。盤面は最大 BOARD_CACHE_MS に 1 回だけ計算し、
// 同時に来たリクエストは計算中の Promise を共有する。ETag は時刻と計測値を除いた本文の sha1。
// セッションを読んだ後に folder hints を付け (attachFolders)、core がプロジェクト判定に使う。folders は JSON に出ない。

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BOARD_CACHE_MS } from '../shared/constants.mjs';
import { buildBoard, selectTranscriptTargets } from '../core/board.mjs';
import { attachFolders } from '../adapters/session-record.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */
/** @typedef {import('../shared/types.mjs').FolderHint} FolderHint */
/** @typedef {{load: () => Promise<{sessions: SessionRecord[], archivedIds: Set<string>, stats: any}>}} SessionsSource */
/** @typedef {{read: (ids: string[]) => Promise<Map<string, TranscriptInput>>, stats: () => {dirMissing: boolean}}} TranscriptsSource */
/** @typedef {{hintFor: (path: string) => Promise<FolderHint|undefined>}} FolderHints */

/**
 * 盤面の本文と ETag を作る。
 * @param {ReturnType<typeof buildBoard>} board
 */
export function serialize(board) {
  const stable = JSON.stringify({ ...board, generatedAt: 0, serverNow: 0, stats: { ...board.stats, scanMs: 0 } });
  const etag = `"${crypto.createHash('sha1').update(stable).digest('hex')}"`;
  return { body: JSON.stringify(board), etag };
}

/**
 * アーカイブしていないセッションにだけ folder hints を付ける (アーカイブ済みは盤面に出ないので、そのフォルダは見に行かない)。
 * @param {{sessions: SessionRecord[], archivedIds: Set<string>}} loaded
 * @param {FolderHints} folderHints
 * @returns {Promise<SessionRecord[]>}
 */
export async function withFolders(loaded, folderHints) {
  const archived = (/** @type {SessionRecord} */ s) => s.isArchived === true || loaded.archivedIds.has(s.sessionId);
  const hinted = await attachFolders(loaded.sessions.filter((s) => !archived(s)), (p) => folderHints.hintFor(p));
  const byId = new Map(hinted.map((s) => [s.sessionId, s]));
  return loaded.sessions.map((s) => byId.get(s.sessionId) ?? s);
}

/**
 * @param {{sessionsSource: SessionsSource, transcriptsSource: TranscriptsSource, folderHints?: FolderHints, roots: string[],
 *   demo?: boolean, clock?: () => number, cacheMs?: number}} deps
 *   folderHints が無ければ手掛かりなし (core は roots の規則だけで決める)。demo は stats.demo になる
 */
export function createBoardService({ sessionsSource, transcriptsSource, folderHints, roots, demo = false, clock = () => Date.now(), cacheMs = BOARD_CACHE_MS }) {
  /** @type {{body: string, etag: string, at: number}|null} */
  let cached = null;
  /** @type {Promise<{body: string, etag: string, at: number}>|null} */
  let inflight = null;

  async function compute() {
    const t0 = performance.now();
    const loaded = await sessionsSource.load();
    const sessions = folderHints ? await withFolders(loaded, folderHints) : loaded.sessions;
    const now = clock();
    const targets = selectTranscriptTargets(sessions, loaded.archivedIds, now);
    const byCli = await transcriptsSource.read(targets.map((t) => t.cliSessionId));
    /** @type {Map<string, TranscriptInput>} */
    const turns = new Map();
    for (const t of targets) {
      const ti = byCli.get(t.cliSessionId);
      if (ti) turns.set(t.sessionId, ti);
    }
    const board = buildBoard({
      sessions,
      archivedIds: loaded.archivedIds,
      turns,
      now,
      roots,
      sourceStats: loaded.stats,
      transcriptStats: transcriptsSource.stats(),
      scanMs: Math.round(performance.now() - t0),
      demo,
    });
    return { ...serialize(board), at: clock() };
  }

  return {
    /** @returns {Promise<{body: string, etag: string}>} */
    async get() {
      if (cached && clock() - cached.at < cacheMs) return cached;
      if (!inflight) {
        inflight = compute()
          .then((r) => {
            cached = r;
            return r;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}
