// @ts-check
// 画面: 選択・コピー・片付けの進み具合・カーソル・絞り込みの計算 (純粋関数。DOM・storage・時計は触らない)。
// 元の Set や配列は書き換えず、新しいものを返す。

import { FAMILY_MAX_DEPTH, SKIP_EXPLAIN_MS } from '../src/shared/constants.mjs';
import { matches } from './format.mjs';

/** @typedef {Record<string, any>} Card */
/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {{id: string, pile: string, index: number}} Cursor */

/** 欄の固定順 (台帳・キー 1〜6・カーソルの移動先)。 */
export const PILES = Object.freeze(['needs_you', 'trouble', 'unread', 'working', 'recent', 'cleanup']);
/** 返事・確認・未読の 3 つ (先頭の案内とお知らせの対象)。 */
export const ACTION_PILES = Object.freeze(['needs_you', 'trouble', 'unread']);
const LIST_PILES = Object.freeze(['needs_you', 'trouble', 'unread', 'working']);

/** 片付けの行が表すセッション ID (定期実行の行は全部の回)。 @param {Card} card @returns {string[]} */
export const rowIds = (card) => (Array.isArray(card.routine?.runIds) && card.routine.runIds.length ? [...card.routine.runIds] : [card.id]);

/** 片付けのグループの全行 (サブグループも平らにする)。 @param {any} group @returns {Card[]} */
export const groupCards = (group) => (group.projects ? group.projects.flatMap((/** @type {any} */ p) => p.items ?? []) : (group.items ?? []));

/** @param {any} board @returns {Card[]} */
export const cleanupCards = (board) => (board?.cleanupGroups ?? []).flatMap(groupCards);

/**
 * 盤面の全カードと、それがいる欄。
 * @param {any} board
 * @returns {Array<{card: Card, pile: string}>}
 */
export function allCards(board) {
  if (!board) return [];
  const out = [];
  for (const pile of LIST_PILES) for (const card of board.buckets?.[pile] ?? []) out.push({ card, pile });
  for (const g of board.recentGroups ?? []) for (const card of g.items ?? []) out.push({ card, pile: 'recent' });
  for (const card of cleanupCards(board)) out.push({ card, pile: 'cleanup' });
  return out;
}

/**
 * ID → カードの表。定期実行の行は runIds の全部の ID を受け持つ。
 * @param {any} board
 * @returns {Map<string, {card: Card, pile: string}>}
 */
export function cardIndex(board) {
  const map = new Map();
  for (const e of allCards(board)) {
    map.set(e.card.id, e);
    for (const id of e.card.routine?.runIds ?? []) if (!map.has(id)) map.set(id, e);
  }
  return map;
}

/** 盤面にある全 ID (カードの ID と定期実行の runIds)。 @param {any} board @returns {Set<string>} */
export const presentIds = (board) => new Set(cardIndex(board).keys());

/** 片付けの欄にある全 ID。 @param {any} board @returns {Set<string>} */
export const cleanupIds = (board) => new Set(cleanupCards(board).flatMap(rowIds));

/** おすすめの全 ID (行の順)。 @param {any} board @returns {string[]} */
export const suggestedIds = (board) => cleanupCards(board).filter((c) => c.cleanup?.recommended).flatMap(rowIds);

/**
 * 次にコピーする分。まだコピーしていない ID の先頭 chunkSize 件。全部コピー済みなら最初から (restart)。
 * @param {string[]} selected 選んだ順
 * @param {Set<string>} copied
 * @param {number} chunkSize
 */
export function planCopy(selected, copied, chunkSize) {
  let pending = selected.filter((id) => !copied.has(id));
  const restart = pending.length === 0;
  if (restart) pending = selected;
  const done = selected.length - pending.length;
  const chunk = pending.slice(0, chunkSize);
  return { chunk, from: done + 1, to: done + chunk.length, restart, total: selected.length };
}

/**
 * コピーが確かにできたときだけ呼ぶ。コピー済みの印を付けた新しい Set。
 * @param {string[]} selected
 * @param {Set<string>} copied
 * @param {{chunk: string[], restart: boolean}} plan
 */
export function commitCopy(selected, copied, plan) {
  const next = new Set(copied);
  if (plan.restart) for (const id of selected) next.delete(id);
  for (const id of plan.chunk) next.add(id);
  return next;
}

/**
 * 新しい盤面に合わせて選択を整える。片付けの欄から居なくなった ID は黙って外す。
 * @param {Set<string>} selected
 * @param {Set<string>} copied
 * @param {Set<string>} present 盤面にある全 ID
 * @param {Set<string>} cleanup 片付けの欄にある ID
 */
export function pruneSelection(selected, copied, present, cleanup) {
  let archived = 0;
  const nextSel = new Set();
  const nextCopied = new Set();
  for (const id of selected) {
    if (!present.has(id)) archived++;
    if (!cleanup.has(id)) continue;
    nextSel.add(id);
  }
  for (const id of copied) if (cleanup.has(id)) nextCopied.add(id);
  return { selected: nextSel, copied: nextCopied, archived };
}

/**
 * 「残りを選び直す」で選び直す ID: batch のうち、今も片付けの欄にあるものだけ (batch の順)。
 * @param {string[]} batchIds
 * @param {Set<string>} cleanup 片付けの欄にある ID
 */
export const reselectIds = (batchIds, cleanup) => batchIds.filter((id) => cleanup.has(id));

/** v0.2 で使わなくなった好みのキー (全体 Overview はキャンバスの遠くの縮尺に置き換わった)。読み込むときに落とす。 */
export const RETIRED_PREFS = Object.freeze(['overview', 'overviewQuiet']);

/**
 * 消す好みの記録: 盤面に無くなったプロジェクトの開閉 (prefs.open の sub:<reason>:<key> と prefs.more の recent:<key>) と、
 * 使わなくなったキー (prefs: 盤面が無くても返す)。
 * @param {{open?: Record<string, boolean>, more?: Record<string, boolean>}} prefs
 * @param {any} board
 * @returns {{open: string[], more: string[], prefs: string[]}}
 */
export function stalePrefKeys(prefs, board) {
  const retired = RETIRED_PREFS.filter((k) => Object.prototype.hasOwnProperty.call(prefs ?? {}, k));
  if (!board) return { open: [], more: [], prefs: retired };
  const subs = new Set((board.cleanupGroups ?? []).flatMap((/** @type {any} */ g) => (g.projects ?? []).map((/** @type {any} */ p) => `sub:${g.reason}:${p.key}`)));
  const recent = new Set((board.recentGroups ?? []).map((/** @type {any} */ g) => `recent:${g.key}`));
  return {
    open: Object.keys(prefs.open ?? {}).filter((k) => k.startsWith('sub:') && !subs.has(k)),
    more: Object.keys(prefs.more ?? {}).filter((k) => k.startsWith('recent:') && !recent.has(k)),
    prefs: retired,
  };
}

/**
 * 見えている行 (読む順) を欄ごとの ID の並びにする。カーソルの index はこの並びの中の位置。
 * @param {Array<{id: string, pile: string}>} rows
 * @returns {Array<{pile: string, ids: string[]}>} PILES の順
 */
export const listsFromRows = (rows) => PILES.map((pile) => ({ pile, ids: rows.filter((r) => r.pile === pile).map((r) => r.id) }));

/**
 * 片付けの進み具合。盤面から消えた (= アーカイブされた) 数を数えるだけで、推測はしない。
 * @param {string[]} batchIds
 * @param {Set<string>} present
 * @param {number} msSinceLastCopy
 */
export function batchProgress(batchIds, present, msSinceLastCopy) {
  const total = batchIds.length;
  const done = batchIds.filter((id) => !present.has(id)).length;
  return { total, done, left: total - done, stale: msSinceLastCopy >= SKIP_EXPLAIN_MS };
}

/**
 * 選択の帯の状態。
 * @param {number} selectedCount
 * @param {{total: number, done: number, stale: boolean}|null} progress 開いている batch の進み具合 (無ければ null)
 * @returns {'none'|'picked'|'copied'|'progress'|'done'|'left'}
 */
export function selbarMode(selectedCount, progress) {
  if (!progress || progress.total === 0) return selectedCount > 0 ? 'picked' : 'none';
  if (progress.done >= progress.total) return 'done';
  if (progress.stale) return 'left';
  return progress.done === 0 ? 'copied' : 'progress';
}

/**
 * 手順の今の段。1 = 何も選んでいない、2 = 選んだがまだコピーしていない、3 = 最初のコピーから batch を閉じるまで。
 * @param {number} selectedCount
 * @param {boolean} batchOpen
 * @returns {1|2|3}
 */
export const stepOf = (selectedCount, batchOpen) => (batchOpen ? 3 : selectedCount > 0 ? 2 : 1);

/**
 * チェックボックスの 3 状態。
 * @param {string[]} ids
 * @param {Set<string>} selected
 * @returns {'on'|'mixed'|'off'}
 */
export function checkState(ids, selected) {
  const n = ids.filter((id) => selected.has(id)).length;
  if (n === 0) return 'off';
  return n === ids.length ? 'on' : 'mixed';
}

/**
 * グループ (とサブグループ) のチェックボックス。おすすめを全部選んでいれば on、何か選んでいれば mixed。
 * @param {string[]} suggested
 * @param {string[]} all
 * @param {Set<string>} selected
 * @returns {'on'|'mixed'|'off'}
 */
export function groupState(suggested, all, selected) {
  if (!all.some((id) => selected.has(id))) return 'off';
  return suggested.length > 0 && suggested.every((id) => selected.has(id)) ? 'on' : 'mixed';
}

/**
 * 先頭の案内に出す 1 件: 返事待ち > 止まったかも > 未読 の先頭 (一番長く待っているもの)。絞り込みは無視する。
 * @param {any} board
 * @returns {{pile: string, card: Card}|null}
 */
export function nextUp(board) {
  for (const pile of ACTION_PILES) {
    const card = board?.buckets?.[pile]?.[0];
    if (card) return { pile, card };
  }
  return null;
}

/**
 * 新しい盤面でのカーソル。同じ欄に同じ ID → そのまま。別の欄へ移った → 同じ欄の同じ位置 (次の行) と moved。
 * 欄が空になった → 次の空でない欄の先頭。何も無い → null。
 * @param {Cursor|null} cursor
 * @param {Array<{pile: string, ids: string[]}>} lists PILES の順
 * @returns {{cursor: Cursor|null, moved: {id: string, to: string}|null}}
 */
export function cursorAfter(cursor, lists) {
  if (!cursor) return { cursor: null, moved: null };
  const at = lists.find((l) => l.pile === cursor.pile);
  const i = at ? at.ids.indexOf(cursor.id) : -1;
  if (at && i >= 0) return { cursor: { id: cursor.id, pile: cursor.pile, index: i }, moved: null };
  const where = lists.find((l) => l.ids.includes(cursor.id));
  const moved = where ? { id: cursor.id, to: where.pile } : null;
  if (at && at.ids.length) {
    const j = Math.max(0, Math.min(cursor.index, at.ids.length - 1));
    return { cursor: { id: at.ids[j], pile: at.pile, index: j }, moved };
  }
  const from = Math.max(0, lists.findIndex((l) => l.pile === cursor.pile));
  const order = [...lists.slice(from + 1), ...lists.slice(0, from + 1)];
  const next = order.find((l) => l.ids.length);
  if (!next) return { cursor: null, moved };
  return { cursor: { id: next.ids[0], pile: next.pile, index: 0 }, moved };
}

/** フォーカスの持ち主を見分けるのに使う属性 (選択で変わる値は使わない)。 */
export const FOCUS_ATTRS = Object.freeze(['data-action', 'data-key', 'data-id', 'data-pile', 'data-reason', 'data-list', 'data-root', 'href', 'id', 'type']);

/**
 * 作り直された同じ部品を探し直すための署名。
 * @param {string} tag
 * @param {(name: string) => string|null} attr
 * @param {string|null} scopeKey 一番近い祖先の data-key
 */
export function focusSignature(tag, attr, scopeKey) {
  const parts = [tag.toUpperCase()];
  for (const a of FOCUS_ATTRS) {
    const v = attr(a);
    if (v != null) parts.push(`${a}=${v}`);
  }
  parts.push(`in=${scopeKey ?? ''}`);
  return parts.join('|');
}

/** 片付けの行が何セッションか。 @param {Card} c */
const rowSize = (c) => rowIds(c).length;

/**
 * 絞り込み (文字と親子) を当てた見え方。piles の並びと一致数。
 * @param {any} board
 * @param {{q?: string, family?: string|null, source?: 'all'|'claude'|'codex'|'copilot'|'opencode', project?: string, t: T, now?: number}} opts now: 「要約済み」の言葉でも探すときの今
 */
export function visibleModel(board, { q = '', family = null, source = 'all', project = 'all', t, now }) {
  const qq = String(q ?? '').trim().toLowerCase();
  const fam = family ? new Set(board?.families?.[family]?.memberIds ?? [family]) : null;
  const filtering = qq !== '' || fam != null || source !== 'all' || project !== 'all';
  /** @param {Card} c */
  const ok = (c) => (!fam || fam.has(c.id) || rowIds(c).some((id) => fam.has(id))) && (source === 'all' || (c.source ?? (c.id.startsWith('codex_') ? 'codex' : c.id.startsWith('copilot_') ? 'copilot' : c.id.startsWith('opencode_') ? 'opencode' : 'claude')) === source) && (project === 'all' || c.project?.key === project) && matches(c, qq, t, now);
  /** @type {Record<string, Card[]>} */
  const buckets = {};
  for (const pile of LIST_PILES) buckets[pile] = (board?.buckets?.[pile] ?? []).filter(ok);
  const recentGroups = (board?.recentGroups ?? []).map((/** @type {any} */ g) => ({ ...g, items: (g.items ?? []).filter(ok) })).filter((/** @type {any} */ g) => g.items.length);
  const cleanupGroups = (board?.cleanupGroups ?? [])
    .map((/** @type {any} */ g) => {
      if (!g.projects) return { ...g, items: (g.items ?? []).filter(ok) };
      const projects = g.projects.map((/** @type {any} */ p) => ({ ...p, items: (p.items ?? []).filter(ok) })).filter((/** @type {any} */ p) => p.items.length);
      return { ...g, projects };
    })
    .filter((/** @type {any} */ g) => groupCards(g).length);
  const sum = (/** @type {Card[]} */ list, /** @type {(c: Card) => number} */ f) => list.reduce((n, c) => n + f(c), 0);
  const recentCards = recentGroups.flatMap((/** @type {any} */ g) => g.items);
  const counts = filtering
    ? {
        needs_you: buckets.needs_you.length,
        trouble: buckets.trouble.length,
        unread: buckets.unread.length,
        working: buckets.working.length,
        recent: recentCards.length,
        cleanup: sum(cleanupGroups.flatMap(groupCards), rowSize),
      }
    : Object.fromEntries(PILES.map((p) => [p, Number(board?.counts?.[p]) || 0]));
  const total = PILES.reduce((n, p) => n + /** @type {any} */ (counts)[p], 0);
  return { filtering, q: qq, family, buckets, recentGroups, cleanupGroups, counts, total };
}

/**
 * 詳しくの中の親子の木。根を先頭に、子は作成の古い順。最大 max 個、残りと見つからない人は more に数える。
 * @param {any} board
 * @param {Map<string, {card: Card, pile: string}>} index
 * @param {string} rootId
 * @param {string} selfId
 * @param {number} [max]
 * @returns {{roots: any[], more: number, title: string}|null}
 */
export function familyTree(board, index, rootId, selfId, max = 12) {
  const fam = board?.families?.[rootId];
  if (!fam) return null;
  /** @type {Map<string, any>} */
  const nodes = new Map();
  let missing = 0;
  for (const id of fam.memberIds ?? []) {
    const e = index.get(id);
    if (!e) {
      missing++;
      continue;
    }
    if (nodes.has(e.card.id)) continue;
    nodes.set(e.card.id, {
      id: e.card.id,
      title: e.card.title,
      pile: e.pile,
      createdAt: Number(e.card.createdAt) || 0,
      parentKey: e.card.family?.parentId ? index.get(e.card.family.parentId)?.card.id ?? null : null,
      self: e.card.id === selfId || rowIds(e.card).includes(selfId),
      children: [],
    });
  }
  const tops = [];
  for (const n of nodes.values()) {
    const parent = n.parentKey && n.parentKey !== n.id ? nodes.get(n.parentKey) : null;
    if (parent) parent.all = [...(parent.all ?? []), n];
    else tops.push(n);
  }
  const byCreated = (/** @type {any} */ a, /** @type {any} */ b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
  tops.sort((a, b) => (a.id === index.get(rootId)?.card.id ? -1 : b.id === index.get(rootId)?.card.id ? 1 : byCreated(a, b)));
  let shown = 0;
  /** @param {any} n @param {number} depth @returns {any|null} */
  const take = (n, depth) => {
    if (shown >= max || depth > FAMILY_MAX_DEPTH) return null;
    shown++;
    const out = { id: n.id, title: n.title, pile: n.pile, self: n.self, children: /** @type {any[]} */ ([]) };
    for (const c of [...(n.all ?? [])].sort(byCreated)) {
      const kid = take(c, depth + 1);
      if (kid) out.children.push(kid);
    }
    return out;
  };
  const roots = tops.map((n) => take(n, 0)).filter(Boolean);
  return { roots, more: nodes.size - shown + missing, title: String(fam.title ?? '') };
}
