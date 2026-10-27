// @ts-check
// 画面: ただ 1 つの状態のかたまりと、その setter。好み (prefs) は localStorage に保存する (読み書きは全部 try/catch)。
// 選択とコピー済みと batch はメモリだけ (再読み込みで消える)。

import { LEGACY_UI_STORAGE_KEY, NEW_BADGE_MS, UI_STORAGE_KEY } from '../src/shared/constants.mjs';
import { dayKey, hm } from './format.mjs';
import { latchHandoffs, pruneHandoffs } from './handoff.mjs';
import { makeT } from './i18n.mjs';
import { ACTION_PILES, commitCopy, cursorAfter, PILES, presentIds, pruneSelection, cleanupIds, reselectIds, stalePrefKeys } from './ui-state.mjs';

/** @typedef {import('./ui-state.mjs').Cursor} Cursor */

/**
 * @typedef {Object} Prefs
 * @property {'en'|'ja'=} lang
 * @property {Record<string, boolean>} open      recent / cleanup / sub:<reason>:<key>
 * @property {Record<string, boolean>} more      欄ごとの「残りを表示」
 * @property {boolean} notify
 * @property {boolean} keys                      1 文字キーを使うか (既定 true)
 * @property {boolean} seenIntro
 * @property {{day: string, hm: string}|null} zeroSince
 * @property {{day: string, n: number}|null} archivedToday
 * @property {'list'|'canvas'} view                   開く表示 (既定 list)
 * @property {Record<string, {at: number, pct: number}>} handoff  引き継ぎの指示文をコピーした記録 (24 時間で消す)
 */

/** @returns {Prefs} */
const defaults = () => ({
  open: {}, more: {}, notify: false, keys: true, seenIntro: false, zeroSince: null, archivedToday: null,
  view: /** @type {'list'|'canvas'} */ ('list'), handoff: {},
});

export const state = {
  t: makeT('en'),
  /** @type {any} */ board: null,
  /** @type {any} */ prevBoard: null,
  /** @type {string|null} */ etag: null,
  lastOk: 0, // 最後に取得できた時刻 (サーバー時計)
  offset: 0, // サーバー時計 - 手元の時計
  /** @type {null|'offline'|'server'|'version'|'render'} */ fail: null,
  /** @type {'list'|'canvas'} */ view: 'list', // 今の表示 (?view= で開いたときは保存しない。prefs.view が覚えた表示)
  loading: true,
  filter: '',
  /** @type {string|null} */ family: null,
  /** @type {Cursor|null} */ cursor: null,
  // 新しい盤面を受け取る前のカーソル。index は「その欄で見えていた行」の中の位置なので、描き終えてから見えている行で合わせ直す
  /** @type {Cursor|null} */ cursorWas: null,
  /** @type {Set<string>} */ open: new Set(), // 詳しくを開いている ID
  /** @type {Set<string>} */ selected: new Set(), // 選んだ順
  /** @type {Set<string>} */ copied: new Set(),
  /** @type {{ids: string[], lastCopyAt: number, activeAtStart: number, text: string}|null} */ batch: null,
  /** @type {Set<string>} */ counted: new Set(), // 今日の件数に数えた ID
  copiedUntil: 0, // 「コピーした ✓」を出しておく時刻
  /** @type {Map<string, number>} */ newUntil: new Map(), // bucket:id → 新着の印を消す時刻
  /** @type {Set<string>} */ arrived: new Set(), // 到着の一度きりの印を付け終えた bucket:id
  /** @type {Record<string, number>} */ pages: {}, // 片付けの一覧ごとの表示ページ数
  storageOk: true,
  /** @type {Prefs} */ prefs: defaults(),
};

/** サーバー時計での今。 */
export const now = () => Date.now() + state.offset;

export function loadPrefs() {
  try {
    const current = localStorage.getItem(UI_STORAGE_KEY);
    const raw = current ?? localStorage.getItem(LEGACY_UI_STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    state.prefs = v && typeof v === 'object' ? { ...defaults(), ...v, open: { ...(v.open ?? {}) }, more: { ...(v.more ?? {}) } } : defaults();
    state.prefs.view = state.prefs.view === 'canvas' ? 'canvas' : 'list';
    for (const k of stalePrefKeys(state.prefs, null).prefs) delete /** @type {any} */ (state.prefs)[k];
    state.prefs.handoff = pruneHandoffs(state.prefs.handoff, now());
    state.storageOk = true;
  } catch {
    state.prefs = defaults();
    state.storageOk = false;
  }
  return state.prefs;
}

export function savePrefs() {
  state.prefs.handoff = pruneHandoffs(state.prefs.handoff, now());
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state.prefs));
    state.storageOk = true;
  } catch {
    state.storageOk = false;
  }
}

/** 開く表示を覚える (一覧 / キャンバス)。 @param {'list'|'canvas'} view */
export function setView(view) {
  state.prefs.view = view === 'canvas' ? 'canvas' : 'list';
  savePrefs();
}

/** 引き継ぎの指示文をコピーしたことを覚える (確かにコピーできたときだけ呼ぶ)。 @param {string} id @param {{at: number, pct: number}} rec */
export function storeHandoff(id, rec) {
  state.prefs.handoff = { ...state.prefs.handoff, [id]: { at: rec.at, pct: rec.pct } };
  savePrefs();
}

/** 言語を変える (辞書を引き直すだけ。盤面は取り直さない)。 @param {'en'|'ja'} lang */
export function setLang(lang) {
  state.t = makeT(lang);
}

/** @param {string} pile @param {string} id */
const pairKey = (pile, id) => `${pile}:${id}`;

/** @param {any} board @returns {Set<string>} */
function actionPairs(board) {
  const out = new Set();
  for (const pile of ACTION_PILES) for (const c of board?.buckets?.[pile] ?? []) out.add(pairKey(pile, c.id));
  return out;
}

/**
 * 欄ごとの ID の並び (カーソルの計算用)。
 * @param {any} board
 * @returns {Array<{pile: string, ids: string[]}>}
 */
export function pileLists(board) {
  return PILES.map((pile) => {
    if (pile === 'recent') return { pile, ids: (board?.recentGroups ?? []).flatMap((/** @type {any} */ g) => g.items.map((/** @type {any} */ c) => c.id)) };
    if (pile === 'cleanup') return { pile, ids: (board?.cleanupGroups ?? []).flatMap((/** @type {any} */ g) => (g.projects ? g.projects.flatMap((/** @type {any} */ p) => p.items) : g.items).map((/** @type {any} */ c) => c.id)) };
    return { pile, ids: (board?.buckets?.[pile] ?? []).map((/** @type {any} */ c) => c.id) };
  });
}

/**
 * 新しい盤面を受け取る。選択を整え、カーソルを合わせ、新着の印を付ける。
 * @param {any} board
 * @param {number} at サーバー時計の今
 * @returns {{moved: {id: string, to: string}|null, verified: string[]}}
 */
export function setBoard(board, at) {
  const first = state.board == null;
  state.prevBoard = state.board;
  state.board = board;
  state.loading = false;
  // 新着: 前の盤面に無かった bucket:id (最初の 1 回は付けない)
  if (!first) {
    const before = actionPairs(state.prevBoard);
    for (const p of actionPairs(board)) if (!before.has(p)) state.newUntil.set(p, at + NEW_BADGE_MS);
  }
  pruneNew(at);
  const present = presentIds(board);
  const pruned = pruneSelection(state.selected, state.copied, present, cleanupIds(board));
  state.selected = pruned.selected;
  state.copied = pruned.copied;
  // batch のうち盤面から消えた ID は片付いたもの。今日の件数に 1 回だけ数える
  const verified = [];
  if (state.batch) {
    for (const id of state.batch.ids) {
      if (present.has(id) || state.counted.has(id)) continue;
      state.counted.add(id);
      verified.push(id);
    }
    if (verified.length) addArchivedToday(verified.length, at);
  }
  for (const id of [...state.open]) if (!present.has(id)) state.open.delete(id);
  // moved (読み上げ) は盤面全体で決める。行の位置は描き終えてから見えている行で決め直す (render の settleCursor)
  state.cursorWas = state.cursor;
  const { cursor, moved } = cursorAfter(state.cursor, pileLists(board));
  state.cursor = cursor;
  trackZero(board, at, first);
  dropStalePrefKeys(board);
  // 引き継ぎのコピーのあとに要約されたセッションは、記録を消して次の due でボタンを出し直す (要約の印はすぐ末尾の外へ流れる)
  const latched = latchHandoffs(state.prefs.handoff, board);
  if (latched !== state.prefs.handoff) {
    state.prefs.handoff = latched;
    savePrefs();
  }
  return { moved, verified };
}

/** 期限の切れた新着の印を消す。消したものがあれば true。 @param {number} at */
export function pruneNew(at) {
  let dropped = false;
  for (const [k, until] of state.newUntil) {
    if (until > at) continue;
    state.newUntil.delete(k);
    dropped = true;
  }
  return dropped;
}

/** 盤面から居なくなったプロジェクトの開閉の記録を消す (プロジェクト名をブラウザに残し続けない)。 @param {any} board */
function dropStalePrefKeys(board) {
  const stale = stalePrefKeys(state.prefs, board);
  if (!stale.open.length && !stale.more.length) return;
  for (const k of stale.open) delete state.prefs.open[k];
  for (const k of stale.more) delete state.prefs.more[k];
  savePrefs();
}

/** setBoard が変える状態の控え (新しい盤面を描けなかったときに戻す)。 */
export function snapshot() {
  return {
    board: state.board, prevBoard: state.prevBoard, loading: state.loading, selected: state.selected, copied: state.copied,
    counted: new Set(state.counted), open: new Set(state.open), cursor: state.cursor, cursorWas: state.cursorWas,
    newUntil: new Map(state.newUntil), archivedToday: state.prefs.archivedToday, zeroSince: state.prefs.zeroSince,
  };
}

/** @param {ReturnType<typeof snapshot>} s */
export function restore(s) {
  Object.assign(state, { board: s.board, prevBoard: s.prevBoard, loading: s.loading, selected: s.selected, copied: s.copied, counted: s.counted, open: s.open, cursor: s.cursor, cursorWas: s.cursorWas, newUntil: s.newUntil });
  state.prefs.archivedToday = s.archivedToday;
  state.prefs.zeroSince = s.zeroSince;
  savePrefs();
}

/** @param {number} n @param {number} at */
function addArchivedToday(n, at) {
  const day = dayKey(at);
  const cur = state.prefs.archivedToday?.day === day ? state.prefs.archivedToday.n : 0;
  state.prefs.archivedToday = { day, n: cur + n };
  savePrefs();
}

/** 今日片付けた数。 @param {number} at */
export const archivedToday = (at) => (state.prefs.archivedToday?.day === dayKey(at) ? state.prefs.archivedToday.n : 0);

/**
 * 返事待ち + 止まったかも + 未読 が 0 になった時刻を覚える (その日のうちだけ)。
 * @param {any} board @param {number} at @param {boolean} first
 */
function trackZero(board, at, first) {
  const c = board?.counts ?? {};
  const busy = (Number(c.needs_you) || 0) + (Number(c.trouble) || 0) + (Number(c.unread) || 0);
  const prev = state.prefs.zeroSince;
  if (busy > 0) {
    if (prev !== null) {
      state.prefs.zeroSince = null;
      savePrefs();
    }
    return;
  }
  const prevBusy = !first && state.prevBoard ? ACTION_PILES.some((p) => (Number(state.prevBoard.counts?.[p]) || 0) > 0) : false;
  if (prevBusy) {
    state.prefs.zeroSince = { day: dayKey(at), hm: hm(at) };
    savePrefs();
  }
}

/** 0 件になった時刻 (今日のものだけ、分からなければ null)。 @param {number} at */
export const zeroSinceToday = (at) => (state.prefs.zeroSince?.day === dayKey(at) ? state.prefs.zeroSince.hm : null);

/** @param {Cursor|null} cursor */
export function setCursor(cursor) {
  state.cursor = cursor;
}

/** 選ぶ (選んだ順を保つ)。 @param {string[]} ids */
export function pick(ids) {
  const next = new Set(state.selected);
  for (const id of ids) next.add(id);
  state.selected = next;
}

/** 外す。 @param {string[]} ids */
export function unpick(ids) {
  const drop = new Set(ids);
  state.selected = new Set([...state.selected].filter((id) => !drop.has(id)));
}

/**
 * コピーができたことを記録して batch に足す。
 * @param {{chunk: string[], restart: boolean}} plan
 * @param {string} text
 * @param {number} at 手元の時計
 */
export function startBatch(plan, text, at) {
  const selected = [...state.selected];
  state.copied = commitCopy(selected, state.copied, plan);
  const ids = state.batch ? [...state.batch.ids] : [];
  for (const id of plan.chunk) if (!ids.includes(id)) ids.push(id);
  state.batch = { ids, lastCopyAt: at, activeAtStart: state.batch?.activeAtStart ?? (Number(state.board?.counts?.active) || 0), text };
}

/** batch を閉じる (選択が空なら帯も消える)。 */
export function closeBatch() {
  state.batch = null;
}

/**
 * 片付けの欄に残った ID を選び直し、それらのコピー済みの印を外す。次のコピーで新しい batch になる。
 * 片付けの欄から別の欄へ移った ID (開き直した・作業中・貼った会話自身) は選び直さない。
 */
export function reselectLeft() {
  if (!state.batch) return;
  const left = reselectIds(state.batch.ids, cleanupIds(state.board));
  state.selected = new Set(left);
  state.copied = new Set([...state.copied].filter((id) => !left.includes(id)));
  state.batch = null;
}

/** 新着の印を出す時刻か。 @param {string} pile @param {string} id @param {number} at */
export const isNew = (pile, id, at) => (state.newUntil.get(pairKey(pile, id)) ?? 0) > at;

/** 到着の一度きりの印をまだ付けていなければ true を返し、付けたことにする。 @param {string} pile @param {string} id */
export function takeArrival(pile, id) {
  const k = pairKey(pile, id);
  if (!state.newUntil.has(k) || state.arrived.has(k)) return false;
  state.arrived.add(k);
  return true;
}
