// @ts-check
// entry: adapter と core をつなぐ 1 点 (wiring)。盤面は最大 BOARD_CACHE_MS に 1 回だけ計算し、
// 同時に来たリクエストは計算中の Promise を共有する。ETag は時刻と計測値を除いた本文の sha1。
// セッションを読んだ後に folder hints を付け (attachFolders)、core がプロジェクト判定に使う。folders は JSON に出ない。
// (v0.2) tail の解析結果 (TailFacts) をセッションごとに memo し、変わった tail だけ parse し直す。前回の盤面の
// コンテキストの段階 (prev) もここが持つ (メモリだけ)。core は両方を引数で受けるだけで、状態を持たない。

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BOARD_CACHE_MS, FACTS_CACHE_MAX } from '../shared/constants.mjs';
import { buildBoard, selectTranscriptTargets } from '../core/board.mjs';
import { tailFacts } from '../core/classify.mjs';
import { contextMemo } from '../core/context.mjs';
import { attachFolders } from '../adapters/session-record.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */
/** @typedef {import('../shared/types.mjs').FolderHint} FolderHint */
/** @typedef {{load: () => Promise<{sessions: SessionRecord[], archivedIds: Set<string>, stats: any}>}} SessionsSource */
/** @typedef {{read: (ids: string[]) => Promise<Map<string, TranscriptInput>>, stats: () => {dirMissing: boolean}}} TranscriptsSource */
/** @typedef {{hintFor: (path: string) => Promise<FolderHint|undefined>}} FolderHints */
/** @typedef {import('../shared/types.mjs').TailFacts} TailFacts */
/** @typedef {import('../shared/types.mjs').PrevContext} PrevContext */
/** @typedef {(tail: string, truncatedHead: boolean) => TailFacts} ParseTail */

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
 * tail の解析結果の memo。キーは cliSessionId、印は {size, mainMtime, truncatedHead} (パスは adapter の外に出さない)。
 * 印が同じなら parse しない。cliSessionId ごとに 1 件だけ持ち (変わった tail は前の結果を置き換える)、
 * 件数が max を超えたら古いものから捨てる。今回の盤面で読まなかったセッションの分は prune で捨てる。
 * @param {ParseTail} parse
 * @param {number} [max]
 */
export function createFactsMemo(parse, max = FACTS_CACHE_MAX) {
  /** @type {Map<string, {key: string, facts: TailFacts}>} */
  const memo = new Map();
  return {
    /** @param {string} cli @param {TranscriptInput} ti @returns {TailFacts} */
    get(cli, ti) {
      const key = `${cli}|${ti.size}|${ti.mainMtime}|${ti.truncatedHead ? 1 : 0}`;
      const hit = memo.get(cli);
      memo.delete(cli); // 入れ直して「新しい」側へ (捨てるのは長く使われていないもの)
      const facts = hit && hit.key === key ? hit.facts : parse(ti.tail, ti.truncatedHead);
      memo.set(cli, { key, facts });
      for (const old of memo.keys()) {
        if (memo.size <= max) break;
        memo.delete(old);
      }
      return facts;
    },
    /** @param {Set<string>} keep 今回読んだ cliSessionId */
    prune(keep) {
      for (const cli of memo.keys()) if (!keep.has(cli)) memo.delete(cli);
    },
    size: () => memo.size,
  };
}

/**
 * @param {{sessionsSource: SessionsSource, transcriptsSource: TranscriptsSource, folderHints?: FolderHints, worktreeSource?: {enrich:(sessions:SessionRecord[])=>Promise<SessionRecord[]>,stats:()=>{scanned:number,matched:number,unavailable:number,skipped:number}}, roots: string[],
 *   demo?: boolean, clock?: () => number, cacheMs?: number, parseTail?: ParseTail}} deps
 *   folderHints が無ければ手掛かりなし (core は roots の規則だけで決める)。demo は stats.demo になる。
 *   parseTail は core の tailFacts (テストで呼ばれた回数を数えるために差し替えられる)
 */
export function createBoardService({ sessionsSource, transcriptsSource, folderHints, worktreeSource, roots, demo = false, clock = () => Date.now(), cacheMs = BOARD_CACHE_MS, parseTail = tailFacts }) {
  /** @type {{body: string, etag: string, at: number}|null} */
  let cached = null;
  /** @type {Promise<{body: string, etag: string, at: number}>|null} */
  let inflight = null;
  const facts = createFactsMemo(parseTail);
  /** 前回の盤面のコンテキストの段階 (帯を持ち越すため)。メモリだけ、件数は盤面のセッション数まで @type {Map<string, PrevContext>} */
  let prevContext = new Map();

  async function compute() {
    const t0 = performance.now();
    const loaded = await sessionsSource.load();
    const folderSessions = folderHints ? await withFolders(loaded, folderHints) : loaded.sessions;
    const sessions = worktreeSource ? await worktreeSource.enrich(folderSessions) : folderSessions;
    const now = clock();
    const targets = selectTranscriptTargets(sessions, loaded.archivedIds, now);
    const byCli = await transcriptsSource.read(targets.map((t) => t.cliSessionId));
    /** @type {Map<string, TranscriptInput>} */
    const turns = new Map();
    /** @type {Map<string, TailFacts>} */
    const tailFactsById = new Map();
    for (const t of targets) {
      const ti = byCli.get(t.cliSessionId);
      if (!ti) continue;
      turns.set(t.sessionId, ti);
      tailFactsById.set(t.sessionId, facts.get(t.cliSessionId, ti));
    }
    facts.prune(new Set(byCli.keys()));
    const board = buildBoard({
      sessions,
      archivedIds: loaded.archivedIds,
      turns,
      now,
      roots,
      sourceStats: loaded.stats,
      worktreeStats: worktreeSource?.stats(),
      transcriptStats: transcriptsSource.stats(),
      scanMs: Math.round(performance.now() - t0),
      demo,
      tailFacts: tailFactsById,
      prevContext,
    });
    prevContext = contextMemo(board, sessions);
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
