// @ts-check
// core: 1 セッションを 6 つのバケットのどれかに分ける (純粋関数)。spec/board.md §6
// 規則 R0〜R9 を順に試し、最初に当たったものに決める。now は呼び出し側から渡す。
// 出すのは理由のコード (reason) と変数 (reasonParams) だけ。文は画面が作る。

import {
  BG_LEAD_MS,
  CAP,
  ERROR_CURRENT_MS,
  IDLE_SAFE_MS,
  PR_DONE_IDLE_MS,
  QUIET_MS,
  RECENT_MS,
  RETRY_WINDOW_MS,
  START_GRACE_MS,
  UNREAD_SKEW_MS,
} from '../shared/constants.mjs';
import { activityFacts } from './activity.mjs';
import { contextFacts } from './context.mjs';
import { activityOf, parentOf, prListOf } from './session.mjs';
import { cap, isNonEmpty, resetPart } from './text.mjs';
import { parseTurnEntries, turnEntries } from './turn.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */
/** @typedef {import('../shared/types.mjs').TurnResult} TurnResult */
/** @typedef {import('../shared/types.mjs').BucketKey} BucketKey */
/** @typedef {import('../shared/types.mjs').TimeKind} TimeKind */
/** @typedef {import('../shared/types.mjs').ReasonCode} ReasonCode */
/** @typedef {import('../shared/types.mjs').ReasonParams} ReasonParams */
/** @typedef {import('../shared/types.mjs').TailFacts} TailFacts */

/**
 * @typedef {Object} Facts
 * @property {number} act
 * @property {number} age
 * @property {boolean} recent
 * @property {boolean} hasTranscript
 * @property {TurnResult} T
 * @property {number} quietSince
 * @property {number} silent
 * @property {boolean} bg
 * @property {boolean} fresh
 * @property {boolean} asks
 * @property {boolean} unreadExplicit
 * @property {boolean} unread
 * @property {boolean} errorNow
 * @property {boolean} failedStart
 * @property {boolean} hasOpenPr
 * @property {boolean} prDone
 * @property {string|null} parent
 */

/**
 * @typedef {Object} Classified
 * @property {BucketKey} bucket
 * @property {ReasonCode} reason
 * @property {ReasonParams=} reasonParams  変数のある reason だけ
 * @property {number} since
 * @property {TimeKind} timeKind
 * @property {number=} startedAt          working / turn で、ターンの始まりが分かるときだけ
 * @property {Facts} facts
 */

/** 会話ログを読む必要があるか (最近のものだけ読む)。 @param {SessionRecord} s @param {number} now */
export function needsTranscript(s, now) {
  return Math.max(0, now - activityOf(s)) < RECENT_MS;
}

/**
 * tail の解析を 1 回だけ (spec/board.md §5.3)。turnEntries を 1 回だけ呼び、parseTurn・activityFacts・contextFacts に
 * 同じ entries を渡す。now を使わないので、entry が {cliSessionId, size, mainMtime} をキーに memo できる。
 * @param {string} tail
 * @param {boolean} truncatedHead
 * @returns {TailFacts}
 */
export function tailFacts(tail, truncatedHead) {
  const entries = turnEntries(tail, truncatedHead);
  return { turn: parseTurnEntries(entries), activity: activityFacts(entries), context: contextFacts(entries) };
}

/**
 * @param {SessionRecord} s
 * @param {TranscriptInput|undefined} ti
 * @param {number} now
 * @param {TailFacts=} tf 解析済みの tail (無ければここで parse する)
 * @returns {Facts}
 */
export function deriveFacts(s, ti, now, tf) {
  const act = activityOf(s);
  const age = Math.max(0, now - act);
  const recent = age < RECENT_MS;
  const T = recent && ti ? tf?.turn ?? parseTurnEntries(turnEntries(ti.tail, ti.truncatedHead)) : { turn: /** @type {const} */ ('unknown'), relevant: 0 };
  const mainMtime = ti?.mainMtime ?? 0;
  const subMtime = ti?.subMtime ?? 0;
  const quietSince = Math.max(mainMtime, subMtime);
  const pts = s.postTurnSummary;
  const fresh = !!pts && (!s.lastAssistantUuid || !s.postTurnSummaryFor || s.postTurnSummaryFor === s.lastAssistantUuid);
  const asks = (fresh && (isNonEmpty(pts?.needs_action) || pts?.status_category === 'blocked')) || s.interruptedAwaitingPerson;
  const unreadExplicit = s.lastFocusedAt != null && (s.lastActivityAt ?? act) - s.lastFocusedAt > UNREAD_SKEW_MS;
  const errorNow = isNonEmpty(s.error) && (s.errorAt == null || s.errorAt >= (s.lastActivityAt ?? act) - ERROR_CURRENT_MS);
  const created = s.createdAt ?? act;
  const failedStart =
    s.errorCategory === 'git_startup_failed' || (!!s.pendingFirstStart && !errorNow && now - created > START_GRACE_MS);
  const prs = prListOf(s);
  return {
    act,
    age,
    recent,
    hasTranscript: !!ti,
    T,
    quietSince,
    silent: now - quietSince,
    bg: !!ti && subMtime > mainMtime + BG_LEAD_MS && now - subMtime < QUIET_MS,
    fresh,
    asks: !!asks,
    unreadExplicit,
    unread: s.lastFocusedAt == null ? true : unreadExplicit,
    errorNow,
    failedStart,
    hasOpenPr: prs.some((p) => p.state === 'OPEN'),
    prDone: prs.length > 0 && prs.every((p) => p.state === 'MERGED' || p.state === 'CLOSED'),
    parent: parentOf(s),
  };
}

/**
 * 止まっているかもの理由 (コードと変数だけ。時間は含めない)。
 * @param {SessionRecord} s
 * @param {Facts} f
 * @returns {{reason: ReasonCode, reasonParams?: ReasonParams, since: number, timeKind: TimeKind}}
 */
export function troubleReason(s, f) {
  const created = s.createdAt ?? f.act;
  if (!f.errorNow && !f.failedStart && f.T.turn === 'inprogress') {
    const via = f.T.lastKind === 'prompt' ? 'prompt' : 'tool';
    return { reason: 'stalled', reasonParams: { via }, since: f.quietSince || f.act, timeKind: 'stalled' };
  }
  if (s.errorCategory === 'git_startup_failed') return { reason: 'git_startup', since: s.errorAt ?? created, timeKind: 'stopped' };
  if (s.pendingFirstStart && !f.errorNow) {
    return { reason: 'not_started', since: s.pendingFirstStart.since ?? created, timeKind: 'stopped' };
  }
  const err = (s.error ?? '').trim();
  if (/limit/i.test(err)) {
    const reset = cap(resetPart(err), CAP.RESET_SNIPPET);
    return { reason: 'limit', ...(reset ? { reasonParams: { reset } } : {}), since: s.errorAt ?? f.act, timeKind: 'stopped' };
  }
  return { reason: 'error', reasonParams: { error: cap(err, CAP.ERROR_SNIPPET) }, since: s.errorAt ?? f.act, timeKind: 'stopped' };
}

/**
 * 同じ定期実行の中で最新でない回か、を判定するための「最新回」表。
 * @param {SessionRecord[]} active
 * @returns {Map<string, SessionRecord>}
 */
export function latestRunByRoutine(active) {
  /** @type {Map<string, SessionRecord>} */
  const latest = new Map();
  for (const s of active) {
    if (!s.scheduledTaskId) continue;
    const cur = latest.get(s.scheduledTaskId);
    const a = s.createdAt ?? 0;
    const b = cur ? cur.createdAt ?? 0 : -Infinity;
    if (!cur || a > b || (a === b && s.sessionId > cur.sessionId)) latest.set(s.scheduledTaskId, s);
  }
  return latest;
}

/**
 * 後から同じ内容で起動し直したか (やり直し済み)。
 * @param {SessionRecord} s
 * @param {Map<string, SessionRecord[]>} byTitle
 * @param {Map<string, Facts>} facts
 */
function isRetried(s, byTitle, facts) {
  if (!isNonEmpty(s.title)) return false;
  const mine = facts.get(s.sessionId);
  for (const o of byTitle.get(/** @type {string} */ (s.title)) ?? []) {
    if (o === s) continue;
    const of = facts.get(o.sessionId);
    if (!of || !mine || of.parent !== mine.parent || of.errorNow) continue;
    const gap = (o.createdAt ?? 0) - (s.createdAt ?? 0);
    if (gap > 0 && gap < RETRY_WINDOW_MS) return true;
  }
  return false;
}

/**
 * @param {SessionRecord} s
 * @param {Facts} f
 * @param {{superseded: boolean, retried: () => boolean}} ctx
 * @param {number} now
 * @returns {Omit<Classified, 'facts'>}
 */
function decide(s, f, ctx, now) {
  const created = s.createdAt ?? f.act;
  const ago = { since: f.act, timeKind: /** @type {TimeKind} */ ('ago') };
  const working = (/** @type {ReasonCode} */ reason, /** @type {number} */ since) => ({
    bucket: /** @type {BucketKey} */ ('working'), reason, since, timeKind: /** @type {TimeKind} */ ('updated'),
  });
  // R0: 質問ツールの返事待ち。作業中に見えても、止まっているのは利用者の返事 (R1 より先に見る)。
  // 定期実行の古い回の質問は R2 で片付け候補へ、エラーが最新なら R3 へ回す
  if (f.T.turn === 'asking' && !ctx.superseded && !f.errorNow) {
    const ask = f.T.askKind ?? 'question';
    return { bucket: 'needs_you', reason: 'asking', reasonParams: { ask }, since: f.quietSince || f.act, timeKind: 'waiting' };
  }
  // R1: 動いているものは決して隠さない
  if (f.T.turn === 'inprogress' && f.silent < QUIET_MS) {
    const started = f.T.startedAt;
    return { ...working('turn', f.quietSince), ...(typeof started === 'number' && Number.isFinite(started) ? { startedAt: started } : {}) };
  }
  if (f.bg) return working('background', f.quietSince);
  if (s.pendingFirstStart && !f.errorNow && now - created <= START_GRACE_MS) {
    return working('starting', s.pendingFirstStart.since ?? created);
  }
  if (ctx.superseded) return { bucket: 'cleanup', reason: 'routine_old', ...ago }; // R2
  if (f.errorNow || f.failedStart) { // R3
    if (ctx.retried()) return { bucket: 'cleanup', reason: 'retried', ...ago };
    if (f.recent) return { bucket: 'trouble', ...troubleReason(s, f) };
    return { bucket: 'cleanup', reason: 'old_error', ...ago };
  }
  if (f.T.turn === 'inprogress') return { bucket: 'trouble', ...troubleReason(s, f) }; // R4
  if (f.asks) { // R5
    if (f.recent) return { bucket: 'needs_you', reason: 'asks', since: f.act, timeKind: 'waiting' };
    return { bucket: 'cleanup', reason: 'old_question', ...ago };
  }
  if (f.recent && f.unread) return { bucket: 'unread', reason: 'unread', since: f.act, timeKind: 'ended' }; // R6
  if (f.prDone && f.age >= PR_DONE_IDLE_MS && !f.unreadExplicit) return { bucket: 'cleanup', reason: 'pr_done', ...ago }; // R7
  if (f.recent) return { bucket: 'recent', reason: 'recent', ...ago }; // R8
  return { bucket: 'cleanup', reason: f.age >= IDLE_SAFE_MS ? 'idle_30d' : 'idle_7d', ...ago }; // R9
}

/**
 * 非アーカイブのセッション全部を分類する。
 * @param {{active: SessionRecord[], turns: Map<string, TranscriptInput>, now: number, tailFacts?: Map<string, TailFacts>}} input
 *   turns と tailFacts は sessionId がキー。tailFacts に無いセッションは tail をここで parse する
 * @returns {Map<string, Classified>}
 */
export function classifyAll({ active, turns, now, tailFacts: parsed }) {
  /** @type {Map<string, Facts>} */
  const facts = new Map();
  /** @type {Map<string, SessionRecord[]>} */
  const byTitle = new Map();
  for (const s of active) {
    facts.set(s.sessionId, deriveFacts(s, turns.get(s.sessionId), now, parsed?.get(s.sessionId)));
    if (isNonEmpty(s.title)) {
      const list = byTitle.get(/** @type {string} */ (s.title)) ?? [];
      list.push(s);
      byTitle.set(/** @type {string} */ (s.title), list);
    }
  }
  const latest = latestRunByRoutine(active);
  /** @type {Map<string, Classified>} */
  const out = new Map();
  for (const s of active) {
    const f = /** @type {Facts} */ (facts.get(s.sessionId));
    const superseded = !!s.scheduledTaskId && latest.get(s.scheduledTaskId) !== s;
    const c = decide(s, f, { superseded, retried: () => isRetried(s, byTitle, facts) }, now);
    out.set(s.sessionId, { ...c, facts: f });
  }
  return out;
}
