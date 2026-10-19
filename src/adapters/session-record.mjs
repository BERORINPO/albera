// @ts-check
// adapter 共通: アプリのセッション JSON を、許可した項目だけの SessionRecord に射影する。
// 元のオブジェクト (remoteMcpServersConfig など巨大な項目を含む) はここで捨てる。
// fs 版と Fake 版の両方がこの関数を通すので、両者の出力は必ず一致する。
// 射影の後に attachFolders でフォルダの手掛かり (folders) を付ける (folder-hints-fs / fake-folder-hints の共通部分)。
// (v0.2) model はコンテキストの窓を決めるためだけで、盤面の JSON には出ない。contextExceededCount は 0 以上の整数だけ
// (core が detail.contextExceeded として数だけ出す)。

import { CAP, CLI_SESSION_ID_RE, READ_CONCURRENCY, SESSION_ID_RE } from '../shared/constants.mjs';
import { mapLimit } from './map-limit.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {import('../shared/types.mjs').FolderHint} FolderHint */
/** @typedef {(path: string) => Promise<FolderHint|undefined>} HintFor */

const MAX_PR_ENTRIES = 50;

/** @param {unknown} v @returns {string|undefined} */
const str = (v) => (typeof v === 'string' ? (v.length > CAP.RAW ? v.slice(0, CAP.RAW) : v) : undefined);
/** @param {unknown} v @returns {number|undefined} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** 0 以上の整数だけ。 @param {unknown} v @returns {number|undefined} */
const count = (v) => (Number.isInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : undefined);

/**
 * model は窓 (200K / 1M) を決めるためだけに持つ (JSON には出さない)。CAP.MODEL の code point まで。
 * 画面には出ないので、切っても「…」は付けない。
 * @param {unknown} v @returns {string|undefined}
 */
function modelOf(v) {
  if (typeof v !== 'string' || v === '') return undefined;
  const cps = Array.from(v);
  return cps.length > CAP.MODEL ? cps.slice(0, CAP.MODEL).join('') : v;
}

/** @param {unknown} raw */
function prsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObj)
    .slice(0, MAX_PR_ENTRIES)
    .map((p) => ({ prNumber: num(p.prNumber), repo: str(p.repo), url: str(p.url), state: str(p.state) }));
}

/** @param {unknown} raw */
function summaryOf(raw) {
  if (!isObj(raw)) return undefined;
  return {
    status_category: str(raw.status_category),
    status_detail: str(raw.status_detail),
    needs_action: str(raw.needs_action),
  };
}

/**
 * @param {unknown} raw JSON.parse 直後の値
 * @returns {SessionRecord|null} ID が不正なら null (呼び出し側で bad に数える)
 */
export function toSessionRecord(raw) {
  if (!isObj(raw)) return null;
  const sessionId = raw.sessionId;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const cli = typeof raw.cliSessionId === 'string' && CLI_SESSION_ID_RE.test(raw.cliSessionId) ? raw.cliSessionId : undefined;
  const pfs = isObj(raw.pendingFirstStart) ? { since: num(raw.pendingFirstStart.since) ?? null } : null;
  return {
    sessionId,
    cliSessionId: cli,
    title: str(raw.title),
    cwd: str(raw.cwd),
    originCwd: str(raw.originCwd),
    worktreeName: str(raw.worktreeName),
    branch: str(raw.branch),
    createdAt: num(raw.createdAt),
    lastActivityAt: num(raw.lastActivityAt),
    lastFocusedAt: num(raw.lastFocusedAt),
    isArchived: raw.isArchived === true,
    isStarred: raw.isStarred === true,
    autoArchiveExempt: raw.autoArchiveExempt === true,
    completedTurns: num(raw.completedTurns),
    scheduledTaskId: str(raw.scheduledTaskId),
    postTurnSummary: summaryOf(raw.postTurnSummary),
    postTurnSummaryFor: str(raw.postTurnSummaryFor),
    lastAssistantUuid: str(raw.lastAssistantUuid),
    turnWrapUpDescription: isObj(raw.turnWrapUp) ? str(raw.turnWrapUp.description) : undefined,
    lastTurnReport: str(raw.lastTurnReport),
    interruptedAwaitingPerson: raw.interruptedAwaitingPerson != null,
    prs: prsOf(raw.prs),
    prNumber: num(raw.prNumber),
    prRepository: str(raw.prRepository),
    prState: str(raw.prState),
    prUrl: str(raw.prUrl),
    spawnedFromId: isObj(raw.spawnedFrom) ? str(raw.spawnedFrom.sessionId) : undefined,
    forkedFromSessionId: str(raw.forkedFromSessionId),
    dispatchParentId: str(raw.dispatchParentId),
    error: str(raw.error),
    errorAt: num(raw.errorAt),
    errorCategory: str(raw.errorCategory),
    pendingFirstStart: pfs,
    model: modelOf(raw.model),
    contextExceededCount: count(raw.contextExceededCount),
  };
}

// 区切りは '/' でも '\' でもよい。core の folderSegment と同じく大文字小文字を区別しない
const WORKTREE_TAIL_RE = /[\\/]\.claude[\\/]worktrees[\\/].*$/i;

/**
 * 末尾の `.claude/worktrees/<x>` から後ろを切る (worktree の中の .git は repo 本体ではないため)。
 * @param {string} p
 */
export function cutWorktreeTail(p) {
  return p.replace(WORKTREE_TAIL_RE, '');
}

/**
 * originCwd と cwd の手掛かりを引いて `folders` を付けた、新しい SessionRecord の配列を返す (元の配列とレコードは変えない)。
 * 同じパスは 1 回だけ引く。同時に引く数は concurrency まで。引けなかった (例外も含む) パスは手掛かりなし。
 * @param {SessionRecord[]} records
 * @param {HintFor} hintFor
 * @param {number} [concurrency]
 * @returns {Promise<SessionRecord[]>}
 */
export async function attachFolders(records, hintFor, concurrency = READ_CONCURRENCY) {
  const paths = [...new Set(records.flatMap((r) => [r.originCwd, r.cwd]).filter((p) => typeof p === 'string' && p.trim() !== ''))];
  const hints = await mapLimit(paths, concurrency, async (p) => {
    try {
      return await hintFor(/** @type {string} */ (p));
    } catch {
      return undefined;
    }
  });
  /** @type {Map<string, FolderHint|undefined>} */
  const byPath = new Map(paths.map((p, i) => [/** @type {string} */ (p), hints[i]]));
  return records.map((r) => {
    const origin = r.originCwd ? byPath.get(r.originCwd) : undefined;
    const cwd = r.cwd ? byPath.get(r.cwd) : undefined;
    if (!origin && !cwd) return r;
    return { ...r, folders: { ...(origin ? { origin } : {}), ...(cwd ? { cwd } : {}) } };
  });
}
