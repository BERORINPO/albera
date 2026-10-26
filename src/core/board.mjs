// @ts-check
// core: 分類結果から画面用の盤面 (JSON, v2) を組み立てる (純粋関数)。spec/board.md §7〜§10
// 元データのうち許可した項目だけを、上限で切ってから出す。言葉は出さない (コードと変数だけ)。

import {
  CAP,
  CLEANUP_REASONS,
  CLEANUP_SUBGROUP_THRESHOLD,
  FAMILY_MAX_DEPTH,
  FORMAT_SUSPECT_MIN,
  FORMAT_SUSPECT_RATIO,
  GITHUB_URL_RE,
  MAX_PRS,
  OTHER_PROJECT,
} from '../shared/constants.mjs';
import { finishActivity } from './activity.mjs';
import { classifyAll, latestRunByRoutine, needsTranscript, tailFacts } from './classify.mjs';
import { contextUsable, finishContext, learnWindows } from './context.mjs';
import { createProjectResolver } from './project.mjs';
import { activityOf, parentOf, prListOf, rootOf } from './session.mjs';
import { cap, isNonEmpty, reportSummary } from './text.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */
/** @typedef {import('../shared/types.mjs').Card} Card */
/** @typedef {import('../shared/types.mjs').Board} Board */
/** @typedef {import('../shared/types.mjs').NoteCode} NoteCode */
/** @typedef {import('../shared/types.mjs').ReasonParams} ReasonParams */
/** @typedef {import('../shared/types.mjs').FormatSuspect} FormatSuspect */
/** @typedef {import('../shared/types.mjs').TailFacts} TailFacts */
/** @typedef {import('../shared/types.mjs').PrevContext} PrevContext */
/** @typedef {import('./classify.mjs').Classified} Classified */

const MAX_URL = 500;
const MAX_STATE = 20; // PR の状態コードの上限 (OPEN / MERGED / CLOSED 以外は生のまま出すため)
const PR_DONE_SHOWN = 2; // pr_done の行に載せる PR の数

/** @param {SessionRecord} s @param {Set<string>} archivedIds */
const isArchived = (s, archivedIds) => s.isArchived === true || archivedIds.has(s.sessionId);

/**
 * 会話ログを読むべきセッション (非アーカイブかつ最近)。
 * @param {SessionRecord[]} sessions
 * @param {Set<string>} archivedIds
 * @param {number} now
 * @returns {Array<{sessionId: string, cliSessionId: string}>}
 */
export function selectTranscriptTargets(sessions, archivedIds, now) {
  const out = [];
  for (const s of sessions) {
    if (isArchived(s, archivedIds) || !s.cliSessionId || !needsTranscript(s, now)) continue;
    out.push({ sessionId: s.sessionId, cliSessionId: s.cliSessionId });
  }
  return out;
}

/** @param {SessionRecord} s @param {Classified} c */
function generalSummary(s, c) {
  if (isNonEmpty(s.turnWrapUpDescription)) return /** @type {string} */ (s.turnWrapUpDescription);
  if (c.facts.fresh && isNonEmpty(s.postTurnSummary?.status_detail)) return /** @type {string} */ (s.postTurnSummary?.status_detail);
  return reportSummary(s.lastTurnReport);
}

/**
 * カードの本文 (中身だけ)。trouble は '' (画面が reasonParams から理由の文を作る)。
 * @param {SessionRecord} s
 * @param {Classified} c
 */
function bodyFor(s, c) {
  const pts = s.postTurnSummary;
  if (c.bucket === 'needs_you') {
    // 質問ツールの返事待ちで質問文が無いときは ''。古い needs_action に落とさない (画面が ask.<kind> を出す)
    if (c.reason === 'asking') return isNonEmpty(c.facts.T.question) ? /** @type {string} */ (c.facts.T.question) : '';
    if (c.facts.fresh && isNonEmpty(pts?.needs_action)) return /** @type {string} */ (pts?.needs_action).trim();
    if (c.facts.fresh && isNonEmpty(pts?.status_detail)) return /** @type {string} */ (pts?.status_detail);
    return generalSummary(s, c);
  }
  if (c.bucket === 'trouble' || c.bucket === 'working') return '';
  return generalSummary(s, c);
}

/**
 * カードに載せる PR。open を先に、その中は新しい順 (紐づけた順の逆) に並べてから MAX_PRS 件で切る。
 * 切る前に並べるので、後から作った open の PR が落ちない。
 * @param {SessionRecord} s
 */
export function sortedPrs(s) {
  const list = prListOf(s).reverse();
  return [...list.filter((p) => p.state === 'OPEN'), ...list.filter((p) => p.state !== 'OPEN')];
}

/** @param {SessionRecord} s */
function prsForCard(s) {
  return sortedPrs(s)
    .slice(0, MAX_PRS)
    .map((p) => ({
      num: p.num,
      repo: cap(p.repo, CAP.TITLE),
      state: cap(p.state, MAX_STATE),
      url: p.url && p.url.length <= MAX_URL && GITHUB_URL_RE.test(p.url) ? p.url : null,
    }));
}

/** @param {SessionRecord} s @param {Classified} c @param {string} body */
function detailFor(s, c, body) {
  /** @type {Card['detail']} */
  const d = {};
  const sd = s.postTurnSummary?.status_detail;
  if (c.facts.fresh && isNonEmpty(sd) && cap(sd, CAP.BODY) !== body) d.statusDetail = cap(sd, CAP.BODY);
  if (isNonEmpty(s.branch)) d.branch = cap(s.branch, CAP.TITLE);
  if (isNonEmpty(s.worktreeName)) d.worktreeName = cap(s.worktreeName, CAP.TITLE);
  if (typeof s.completedTurns === 'number') d.completedTurns = s.completedTurns;
  if (isNonEmpty(s.error)) d.error = cap(/** @type {string} */ (s.error).trim(), CAP.BODY);
  const morePrs = prListOf(s).length - MAX_PRS;
  if (morePrs > 0) d.prsMore = morePrs;
  const exceeded = s.contextExceededCount;
  if (c.bucket !== 'cleanup' && typeof exceeded === 'number' && Number.isInteger(exceeded) && exceeded >= 1) d.contextExceeded = exceeded;
  return d;
}

/**
 * プロジェクト key ごとに最も多い表記を表示名にする。
 * @param {Iterable<{key: string, name: string}>} refs
 */
function labelTable(refs) {
  /** @type {Map<string, Map<string, number>>} */
  const counts = new Map();
  for (const r of refs) {
    const m = counts.get(r.key) ?? new Map();
    m.set(r.name, (m.get(r.name) ?? 0) + 1);
    counts.set(r.key, m);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [key, m] of counts) {
    let best = '';
    let n = -1;
    for (const [name, c] of m) if (c > n) [best, n] = [name, c];
    out.set(key, best);
  }
  return out;
}

/**
 * 家族 (親子) の表。2 人以上いる家族だけ作る。
 * @param {SessionRecord[]} active
 * @param {Map<string, SessionRecord>} byId
 */
function buildFamilies(active, byId) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const s of active) {
    const root = rootOf(s, byId, FAMILY_MAX_DEPTH);
    const list = groups.get(root.sessionId) ?? [];
    list.push(s.sessionId);
    groups.set(root.sessionId, list);
  }
  /** @type {Record<string, {title: string, memberIds: string[]}>} */
  const families = {};
  /** @type {Map<string, string>} */
  const rootOfId = new Map();
  for (const [rootId, memberIds] of groups) {
    if (memberIds.length < 2) continue;
    families[rootId] = { title: cap((byId.get(rootId)?.title ?? '').trim(), CAP.TITLE), memberIds };
    for (const id of memberIds) rootOfId.set(id, rootId);
  }
  return { families, rootOfId };
}

/**
 * @typedef {Object} Ctx
 * @property {Map<string, SessionRecord>} byId
 * @property {Map<string, Classified>} cls
 * @property {Map<string, import('./project.mjs').ProjectRef>} projRefs
 * @property {Map<string, string>} labelOf
 * @property {Map<string, SessionRecord[]>} kids
 * @property {Map<string, string>} rootOfId
 * @property {Map<string, SessionRecord>} latestRun
 * @property {Map<string, SessionRecord[]>} runsByRoutine
 * @property {FormatSuspect} formatSuspect  null でなければおすすめを全部切る
 * @property {Map<string, TranscriptInput>} turns
 * @property {Map<string, TailFacts>} tfs    最近で transcript があるセッションの tail の解析結果 (v0.2)
 * @property {Map<string, number>} learned   model ごとの観測した最大の量 (窓の推定)
 * @property {Map<string, PrevContext>} prev 前回の盤面の段階 (entry が渡す)
 * @property {boolean} contextSuspect        true なら context を付けない
 */

/** @param {SessionRecord} s @param {Ctx} ctx */
function familyFor(s, ctx) {
  const pid = parentOf(s);
  const children = ctx.kids.get(s.sessionId) ?? [];
  if (!pid && !children.length) return undefined;
  /** @type {NonNullable<Card['family']>} */
  const fam = {};
  const rootId = ctx.rootOfId.get(s.sessionId);
  if (rootId) fam.rootId = rootId;
  if (pid) {
    const p = ctx.byId.get(pid);
    fam.parentId = pid; // parentOf は SESSION_ID_RE に合う ID しか返さない (長さは 42 字で固定)
    fam.parentTitle = p ? cap((p.title ?? '').trim(), CAP.PARENT_TITLE) : null;
  }
  if (children.length) {
    const ch = { total: children.length, working: 0, needs_you: 0, trouble: 0, unread: 0 };
    for (const k of children) {
      const b = ctx.cls.get(k.sessionId)?.bucket;
      if (b === 'working' || b === 'needs_you' || b === 'trouble' || b === 'unread') ch[b]++;
    }
    fam.children = ch;
  }
  return fam;
}

/** @param {SessionRecord} s @param {Ctx} ctx */
function routineFor(s, ctx) {
  const rid = s.scheduledTaskId;
  if (!rid) return undefined;
  const runs = ctx.runsByRoutine.get(rid) ?? [s];
  const latest = ctx.latestRun.get(rid) ?? s;
  let completed = 0;
  let stalled = 0;
  for (const r of runs) {
    if (r === latest) continue;
    const T = ctx.cls.get(r.sessionId)?.facts.T;
    // 中断で終わった回 (止まった末に利用者が止めた) と返事待ちのまま残った回は「完了」に数えない
    if (T?.turn === 'ended' && T.how !== 'interrupted') completed++;
    else if (T?.turn === 'ended' || T?.turn === 'inprogress' || T?.turn === 'asking') stalled++;
  }
  const latestBucket = ctx.cls.get(latest.sessionId)?.bucket ?? 'cleanup';
  return { id: cap(rid, CAP.TITLE), runs: runs.length, completed, stalled, latestBucket };
}

/**
 * @param {SessionRecord} s
 * @param {Ctx} ctx
 * @returns {Card}
 */
function makeCard(s, ctx) {
  const c = /** @type {Classified} */ (ctx.cls.get(s.sessionId));
  const ref = /** @type {import('./project.mjs').ProjectRef} */ (ctx.projRefs.get(s.sessionId));
  const body = cap(bodyFor(s, c), CAP.BODY);
  const isOther = ref.key === OTHER_PROJECT.key;
  /** @type {Card} */
  const card = {
    id: s.sessionId,
    ...(s.source === 'codex' ? { source: 'codex' } : {}),
    bucket: c.bucket,
    reason: c.reason,
    ...(c.reasonParams ? { reasonParams: c.reasonParams } : {}),
    title: cap((s.title ?? '').trim(), CAP.TITLE),
    body,
    since: c.since,
    timeKind: c.timeKind,
    ...(c.bucket === 'working' && c.reason === 'turn' && typeof c.startedAt === 'number' ? { startedAt: c.startedAt } : {}),
    lastActivityAt: c.facts.act,
    createdAt: s.createdAt ?? null,
    project: { key: ref.key, label: isOther ? null : ctx.labelOf.get(ref.key) ?? ref.name, extra: ref.extra },
    prs: prsForCard(s),
    detail: detailFor(s, c, body),
    ...(s.source === 'codex' && Array.isArray(s.events) ? { events: s.events.slice(-30).map((event) => ({ type: event.type, at: event.at })) } : {}),
  };
  const routine = routineFor(s, ctx);
  if (routine) card.routine = routine;
  const family = familyFor(s, ctx);
  if (family) card.family = family;
  const tf = c.bucket === 'cleanup' ? undefined : ctx.tfs.get(s.sessionId);
  if (tf) {
    const activity = finishActivity(tf.activity, c.bucket, ctx.turns.get(s.sessionId)?.subLive ?? 0);
    if (activity) card.activity = activity;
    const context = ctx.contextSuspect ? undefined : finishContext(tf.context, s, ctx.learned, ctx.prev.get(s.sessionId));
    if (context) card.context = context;
  }
  return card;
}

/**
 * 片付け候補の行の注記 (おすすめから外す理由のコード)。当たらなければ undefined。
 * @param {SessionRecord[]} members
 * @param {Ctx} ctx
 * @returns {NoteCode|undefined}
 */
function cleanupNote(members, ctx) {
  const facts = (/** @type {SessionRecord} */ m) => ctx.cls.get(m.sessionId)?.facts;
  if (members.some((m) => facts(m)?.hasOpenPr)) return 'open_pr';
  if (members.some((m) => m.autoArchiveExempt === true)) return 'exempt';
  if (members.some((m) => m.isStarred === true)) return 'starred';
  if (members.some((m) => !m.scheduledTaskId && facts(m)?.unreadExplicit)) return 'unread';
  const childInUse = members.some((m) =>
    (ctx.kids.get(m.sessionId) ?? []).some((k) => ctx.cls.get(k.sessionId)?.bucket !== 'cleanup'),
  );
  if (childInUse) return 'child';
  return undefined;
}

/**
 * 片付け候補の行ごとの理由の変数 (変数の無い理由は undefined)。
 * @param {SessionRecord} s
 * @param {string} reason
 * @returns {ReasonParams|undefined}
 */
function cleanupReasonParams(s, reason) {
  if (reason === 'pr_done') {
    const prs = prListOf(s);
    const shown = prs.slice(0, PR_DONE_SHOWN).map((p) => ({ num: p.num, repo: cap(p.repo, CAP.TITLE), state: cap(p.state, MAX_STATE) }));
    const more = prs.length - shown.length;
    return more > 0 ? { prs: shown, more } : { prs: shown };
  }
  if (reason === 'old_error') return { error: cap((s.error ?? '').trim(), CAP.ERROR_SNIPPET) };
  if (reason === 'old_question') {
    const pts = s.postTurnSummary;
    const q = [pts?.needs_action, pts?.status_detail].map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => v !== '');
    return q ? { question: cap(q, CAP.ERROR_SNIPPET) } : undefined;
  }
  return undefined;
}

/**
 * おすすめの印。formatSuspect のときはすべて false (日時が読めないと全部が古く見えるため)。
 * @param {boolean} reasonRecommended
 * @param {NoteCode|undefined} note
 * @param {Ctx} ctx
 * @returns {NonNullable<Card['cleanup']>}
 */
const cleanupMark = (reasonRecommended, note, ctx) => ({
  recommended: reasonRecommended && !note && !ctx.formatSuspect,
  ...(note ? { note } : {}),
});

/**
 * 1 つの定期実行の、片付け候補に入った回すべてを 1 行にまとめる。
 * @param {string} rid
 * @param {SessionRecord[]} inCleanup
 * @param {Ctx} ctx
 */
function routineRow(rid, inCleanup, ctx) {
  const sorted = [...inCleanup].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const rep = sorted[0];
  const latest = ctx.latestRun.get(rid) ?? rep;
  const { reasonParams: _unused, ...base } = makeCard(rep, ctx);
  const routine = /** @type {NonNullable<Card['routine']>} */ (base.routine);
  // 片付け候補に入った回の数 (older) と全部の回の数 (total) は意味が違うので両方送る。
  // latestBucket は最新回が片付け候補以外にいるときだけ
  /** @type {ReasonParams} */
  const reasonParams = {
    older: sorted.length,
    total: routine.runs,
    ...(routine.latestBucket !== 'cleanup' ? { latestBucket: routine.latestBucket } : {}),
  };
  return {
    ...base,
    reason: 'routine_old',
    reasonParams,
    title: cap((latest.title ?? '').trim(), CAP.TITLE),
    since: activityOf(latest),
    timeKind: 'latest',
    routine: { ...routine, runIds: sorted.map((r) => r.sessionId) },
    cleanup: cleanupMark(true, cleanupNote(sorted, ctx), ctx),
  };
}

/** @param {SessionRecord} s @param {Ctx} ctx @returns {Card} */
function cleanupRow(s, ctx) {
  const { reasonParams: _unused, ...card } = makeCard(s, ctx);
  const meta = CLEANUP_REASONS.find((r) => r.key === card.reason);
  const reasonParams = cleanupReasonParams(s, card.reason);
  return { ...card, ...(reasonParams ? { reasonParams } : {}), cleanup: cleanupMark(!!meta?.recommended, cleanupNote([s], ctx), ctx) };
}

/** 行が表すセッション数。 @param {Card} c */
const rowSize = (c) => c.routine?.runIds?.length ?? 1;

/** 新しい順 (同時刻は id 順で安定させる)。 @param {Card} a @param {Card} b */
const byNewest = (a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : 1);

/**
 * プロジェクト別のまとまりに分ける。フォルダなし ('(other)'、label は null) は最後。
 * @param {Card[]} cards 新しい順に並んでいること
 * @returns {Array<{key: string, label: string|null, lastActivityAt: number, items: Card[]}>}
 */
function groupByProject(cards) {
  /** @type {Map<string, Card[]>} */
  const m = new Map();
  for (const c of cards) {
    const list = m.get(c.project.key) ?? [];
    list.push(c);
    m.set(c.project.key, list);
  }
  const isOther = (/** @type {string} */ key) => key === OTHER_PROJECT.key;
  return [...m.entries()]
    .map(([key, items]) => ({ key, label: isOther(key) ? null : items[0].project.label, lastActivityAt: items[0].lastActivityAt, items }))
    .sort((a, b) => {
      if (isOther(a.key) !== isOther(b.key)) return isOther(a.key) ? 1 : -1;
      return b.lastActivityAt - a.lastActivityAt;
    });
}

/** @param {Card[]} rows */
const countOf = (rows) => rows.reduce((n, c) => n + rowSize(c), 0);
/** @param {Card[]} rows */
const recommendedOf = (rows) => rows.reduce((n, c) => n + (c.cleanup?.recommended ? rowSize(c) : 0), 0);

/**
 * @param {SessionRecord[]} active
 * @param {Ctx} ctx
 */
function buildCleanupGroups(active, ctx) {
  /** @type {Map<string, Card[]>} */
  const rows = new Map(CLEANUP_REASONS.map((r) => [r.key, []]));
  const merged = new Set();
  for (const [rid, runs] of ctx.runsByRoutine) {
    if (runs.length < 2) continue;
    const inCleanup = runs.filter((r) => ctx.cls.get(r.sessionId)?.bucket === 'cleanup');
    if (!inCleanup.length) continue;
    for (const r of inCleanup) merged.add(r.sessionId);
    rows.get('routine_old')?.push(routineRow(rid, inCleanup, ctx));
  }
  for (const s of active) {
    const c = ctx.cls.get(s.sessionId);
    if (c?.bucket !== 'cleanup' || merged.has(s.sessionId)) continue;
    rows.get(c.reason)?.push(cleanupRow(s, ctx));
  }
  return CLEANUP_REASONS.map((meta) => {
    const list = (rows.get(meta.key) ?? []).sort(byNewest);
    const base = {
      reason: meta.key,
      recommendedReason: meta.recommended,
      count: countOf(list),
      recommendedCount: recommendedOf(list),
    };
    if (list.length <= CLEANUP_SUBGROUP_THRESHOLD) return { ...base, items: list };
    const projects = groupByProject(list).map((g) => ({ ...g, count: countOf(g.items), recommendedCount: recommendedOf(g.items) }));
    return { ...base, projects };
  });
}

/** 古い順 (一番長く待っているものが先頭。同時刻は id 順)。 @param {Card} a @param {Card} b */
const byOldestSince = (a, b) => a.since - b.since || (a.id < b.id ? -1 : 1);
/** 新しい順 (同時刻は id 順)。 @param {Card} a @param {Card} b */
const byNewestSince = (a, b) => b.since - a.since || (a.id < b.id ? -1 : 1);
// 返事待ち・止まったかも・未読は古い順 (「他 N 件」に一番長く待っているものを隠さない)。作業中は新しい順
const PILE_ORDER = /** @type {const} */ ({ needs_you: byOldestSince, trouble: byOldestSince, unread: byOldestSince, working: byNewestSince });

/** @param {unknown} v */
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * アプリのファイル形式が変わった疑い (spec/board.md §9)。上から最初に当たったもの。
 * - 組織フォルダはあるのに local_*.json が 0 件 → 'no_session_files'
 * - 非アーカイブが FORMAT_SUSPECT_MIN 件以上で、日時 (lastActivityAt も createdAt も) の無いものが FORMAT_SUSPECT_RATIO を超える → 'no_timestamps'
 * @param {SessionRecord[]} active
 * @param {{files: number, dirs: number}} src
 * @returns {FormatSuspect}
 */
export function detectFormatSuspect(active, src) {
  if (src.dirs > 0 && src.files === 0) return 'no_session_files';
  if (active.length >= FORMAT_SUSPECT_MIN) {
    const missing = active.filter((s) => !isTime(s.lastActivityAt) && !isTime(s.createdAt)).length;
    if (missing / active.length > FORMAT_SUSPECT_RATIO) return 'no_timestamps';
  }
  return null;
}

/**
 * v0.2: 最近で transcript があるセッションの tail の解析結果 (渡されていないものはここで作る) と、それを使う盤面全体の値。
 * contextSuspect (spec/board.md §9): 本筋の assistant 行がある最近の transcript を A 件、そのうち使える量が出たものを
 * contextSeen 件として、A ≥ FORMAT_SUSPECT_MIN かつ (A − contextSeen) / A > FORMAT_SUSPECT_RATIO なら true。
 * @param {SessionRecord[]} active
 * @param {Map<string, TranscriptInput>} turns
 * @param {number} now
 * @param {Map<string, TailFacts>|undefined} given
 */
function liveInputs(active, turns, now, given) {
  /** @type {Map<string, TailFacts>} */
  const tfs = new Map();
  /** @type {Array<{model?: string, facts: TailFacts['context']}>} */
  const items = [];
  let withAssistant = 0;
  let contextSeen = 0;
  let activitySeen = 0;
  for (const s of active) {
    const ti = turns.get(s.sessionId);
    if (!ti || !needsTranscript(s, now)) continue;
    const tf = given?.get(s.sessionId) ?? tailFacts(ti.tail, ti.truncatedHead);
    tfs.set(s.sessionId, tf);
    items.push({ model: s.model, facts: tf.context });
    if (tf.context.hasAssistant) {
      withAssistant++;
      if (contextUsable(tf.context)) contextSeen++;
    }
    if (tf.activity && tf.activity.kind !== 'think') activitySeen++;
  }
  const contextSuspect = withAssistant >= FORMAT_SUSPECT_MIN && (withAssistant - contextSeen) / withAssistant > FORMAT_SUSPECT_RATIO;
  return { tfs, learned: learnWindows(items), stats: { contextSeen, activitySeen, contextSuspect } };
}

/**
 * @param {Object} input
 * @param {SessionRecord[]} input.sessions アーカイブ済みも含む全件
 * @param {Set<string>} input.archivedIds
 * @param {Map<string, TranscriptInput>} input.turns sessionId がキー
 * @param {number} input.now
 * @param {string[]} input.roots
 * @param {{files?: number, parsed?: number, bad?: number, stale?: number, dirs?: number, sources?: {codex?: {files?: number, bad?: number}}}=} input.sourceStats
 * @param {{dirMissing?: boolean}=} input.transcriptStats
 * @param {number=} input.scanMs
 * @param {boolean=} input.demo デモデータで動いているとき true (stats.demo)
 * @param {Map<string, TailFacts>=} input.tailFacts (v0.2) entry が memo した tail の解析結果。無いセッションはここで作る
 * @param {Map<string, PrevContext>=} input.prevContext (v0.2) 前回の盤面の段階 (contextMemo の結果)
 * @returns {Board}
 */
export function buildBoard({
  sessions, archivedIds, turns, now, roots, sourceStats = {}, transcriptStats = {}, scanMs = 0, demo = false, tailFacts: givenFacts, prevContext,
}) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const active = sessions.filter((s) => !isArchived(s, archivedIds));
  const files = sourceStats.files ?? sessions.length;
  const formatSuspect = detectFormatSuspect(active, { files, dirs: sourceStats.dirs ?? 0 });
  const live = liveInputs(active, turns, now, givenFacts);
  const cls = classifyAll({ active, turns, now, tailFacts: live.tfs });
  const resolveProject = createProjectResolver({ roots, byId });
  const projRefs = new Map(active.map((s) => [s.sessionId, resolveProject(s)]));
  /** @type {Map<string, SessionRecord[]>} */
  const kids = new Map();
  /** @type {Map<string, SessionRecord[]>} */
  const runsByRoutine = new Map();
  for (const s of active) {
    const pid = parentOf(s);
    if (pid) kids.set(pid, [...(kids.get(pid) ?? []), s]);
    if (s.scheduledTaskId) runsByRoutine.set(s.scheduledTaskId, [...(runsByRoutine.get(s.scheduledTaskId) ?? []), s]);
  }
  const { families, rootOfId } = buildFamilies(active, byId);
  /** @type {Ctx} */
  const ctx = {
    byId, cls, projRefs, labelOf: labelTable(projRefs.values()), kids, rootOfId,
    latestRun: latestRunByRoutine(active), runsByRoutine, formatSuspect,
    turns, tfs: live.tfs, learned: live.learned, prev: prevContext ?? new Map(), contextSuspect: live.stats.contextSuspect,
  };

  /** @type {Record<'needs_you'|'trouble'|'unread'|'working'|'recent', Card[]>} */
  const lists = { needs_you: [], trouble: [], unread: [], working: [], recent: [] };
  for (const s of active) {
    const b = cls.get(s.sessionId)?.bucket;
    if (b && b !== 'cleanup') lists[b].push(makeCard(s, ctx));
  }
  for (const k of /** @type {const} */ (['needs_you', 'trouble', 'unread', 'working'])) lists[k].sort(PILE_ORDER[k]);
  const recentGroups = groupByProject(lists.recent.sort(byNewest)).map(({ key, label, items }) => ({ key, label, items }));
  const cleanupGroups = buildCleanupGroups(active, ctx);
  const codexInput = sourceStats.sources?.codex;
  const codexSessions = active.filter((s) => s.source === 'codex');
  const count = (/** @type {unknown} */ v) => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : 0;
  const lastEvent = (/** @type {SessionRecord} */ s) => s.events?.at(-1)?.type;
  const codexDiagnostics = codexInput ? {
    files: count(codexInput.files),
    detected: codexSessions.length,
    working: lists.working.filter((c) => c.source === 'codex').length,
    trouble: lists.trouble.filter((c) => c.source === 'codex').length,
    recent: lists.recent.filter((c) => c.source === 'codex').length,
    active: codexSessions.filter((s) => s.lifecycle?.status === 'active').length,
    completed: codexSessions.filter((s) => lastEvent(s) === 'turn_completed').length,
    interrupted: codexSessions.filter((s) => lastEvent(s) === 'turn_aborted').length,
    unknown: codexSessions.filter((s) => s.lifecycle?.status !== 'active' && !['turn_completed', 'turn_aborted'].includes(lastEvent(s))).length,
    rejected: count(codexInput.bad),
  } : undefined;

  const cleanupCount = [...cls.values()].filter((c) => c.bucket === 'cleanup').length;
  return {
    v: 2,
    generatedAt: now,
    serverNow: now,
    counts: {
      needs_you: lists.needs_you.length,
      trouble: lists.trouble.length,
      unread: lists.unread.length,
      working: lists.working.length,
      recent: lists.recent.length,
      cleanup: cleanupCount,
      recommended: cleanupGroups.reduce((n, g) => n + g.recommendedCount, 0),
      active: active.length,
      archived: sessions.length - active.length,
    },
    buckets: { needs_you: lists.needs_you, trouble: lists.trouble, unread: lists.unread, working: lists.working },
    recentGroups,
    cleanupGroups,
    families,
    stats: {
      files,
      parsed: sourceStats.parsed ?? sessions.length,
      bad: sourceStats.bad ?? 0,
      stale: sourceStats.stale ?? 0,
      archived: sessions.length - active.length,
      active: active.length,
      ...transcriptCounts(active, cls),
      transcriptsDirMissing: !!transcriptStats.dirMissing,
      scanMs,
      formatSuspect,
      demo: !!demo,
      ...(codexDiagnostics ? { sources: { codex: codexDiagnostics } } : {}),
      ...live.stats,
    },
  };
}

/**
 * 最近のセッションについての会話ログの統計。
 * @param {SessionRecord[]} active
 * @param {Map<string, Classified>} cls
 */
function transcriptCounts(active, cls) {
  const recentActive = active.filter((s) => cls.get(s.sessionId)?.facts.recent);
  const recentFacts = recentActive.map((s) => /** @type {Classified} */ (cls.get(s.sessionId)).facts);
  return {
    recentTotal: recentFacts.length,
    // cliSessionId が無い (CLI が一度も始まっていない起動失敗など) ものは、会話ログが無くて当然なので数えない
    transcriptsMissingRecent: recentActive.filter((s) => s.cliSessionId && !cls.get(s.sessionId)?.facts.hasTranscript).length,
    unknownTurnRecent: recentFacts.filter((f) => f.hasTranscript && f.T.turn === 'unknown').length,
    recentWithTranscript: recentFacts.filter((f) => f.hasTranscript).length,
  };
}
