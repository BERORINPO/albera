// @ts-check
// 画面: 全体 (Overview)。見えているセッションを、プロジェクトの棚に 1 つずつ小さな印で並べる。
// overviewModel と markMove は純粋関数。印は形で状態を分け、色は返事待ちだけ。

import { OVERVIEW_SHELF_MAX } from '../src/shared/constants.mjs';
import { bucketTitle, cardTime, isOtherProject, projectLabel, timeText, titleOf } from './format.mjs';
import { groupCards, rowIds } from './ui-state.mjs';
import { fill, h, setDisclosed } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */

const LIVE = Object.freeze(['needs_you', 'trouble', 'unread', 'working']);
const MARK_PILES = Object.freeze([...LIVE, 'recent']);

/**
 * 棚の並び (純粋)。絞り込みは行と同じ (visible)。visible を省けば盤面そのまま。
 * @param {any} board
 * @param {any} visible ui-state の visibleModel の結果 (絞り込み済み)。盤面と同じ形
 * @param {{overviewQuiet?: boolean}} prefs
 */
export function overviewModel(board, visible, prefs) {
  const v = visible ?? board ?? {};
  /** @type {Map<string, any>} */
  const shelves = new Map();
  /** @param {Card} card */
  const shelfOf = (card) => {
    const key = String(card.project?.key ?? '(other)');
    let s = shelves.get(key);
    if (!s) {
      s = { key, project: card.project ?? { key, label: null }, marks: [], cleanup: 0, latest: 0, rank: 9 };
      shelves.set(key, s);
    }
    s.latest = Math.max(s.latest, Number(card.lastActivityAt) || Number(card.since) || 0);
    return s;
  };
  for (const pile of LIVE) for (const card of v.buckets?.[pile] ?? []) shelfOf(card).marks.push({ id: card.id, pile, card });
  for (const g of v.recentGroups ?? []) for (const card of g.items ?? []) shelfOf(card).marks.push({ id: card.id, pile: 'recent', card });
  for (const g of v.cleanupGroups ?? []) for (const card of groupCards(g)) shelfOf(card).cleanup += rowIds(card).length;
  for (const s of shelves.values()) {
    const first = s.marks.find((/** @type {any} */ m) => LIVE.includes(m.pile));
    s.rank = first ? LIVE.indexOf(first.pile) : 9;
    s.more = Math.max(0, s.marks.length - OVERVIEW_SHELF_MAX);
    s.marks = s.marks.slice(0, OVERVIEW_SHELF_MAX);
    s.counts = Object.fromEntries(MARK_PILES.map((p) => [p, s.marks.filter((/** @type {any} */ m) => m.pile === p).length]));
  }
  const all = [...shelves.values()];
  const other = (/** @type {any} */ s) => (isOtherProject(s.project) ? 1 : 0);
  const live = all.filter((s) => s.rank < 9).sort((a, b) => a.rank - b.rank || other(a) - other(b) || b.latest - a.latest);
  const quiet = all.filter((s) => s.rank === 9).sort((a, b) => b.latest - a.latest);
  const quietCounts = {
    recent: quiet.reduce((n, s) => n + s.marks.length + s.more, 0),
    cleanup: quiet.reduce((n, s) => n + s.cleanup, 0),
  };
  return { live, quiet, quietCounts, showQuiet: !!prefs.overviewQuiet, empty: all.length === 0 };
}

/**
 * 印の間の移動 (純粋)。←/→ と j/k は読む順、↑/↓ は前後の棚の同じ位置 (はみ出したら端)。
 * @param {string} key
 * @param {{shelf: number, index: number}} pos
 * @param {number[]} lengths 棚ごとの印の数
 * @returns {{shelf: number, index: number}|'activate'|'close'|null}
 */
export function markMove(key, pos, lengths) {
  const n = lengths.length;
  if (!n) return key === 'z' || key === 'Escape' ? 'close' : null;
  const { shelf: s, index: i } = pos;
  const clamp = (/** @type {number} */ sh, /** @type {number} */ ix) => ({ shelf: sh, index: Math.max(0, Math.min(ix, lengths[sh] - 1)) });
  switch (key) {
    case 'ArrowRight':
    case 'j':
      if (i + 1 < lengths[s]) return { shelf: s, index: i + 1 };
      return s + 1 < n ? { shelf: s + 1, index: 0 } : pos;
    case 'ArrowLeft':
    case 'k':
      if (i > 0) return { shelf: s, index: i - 1 };
      return s > 0 ? { shelf: s - 1, index: lengths[s - 1] - 1 } : pos;
    case 'ArrowDown':
      return s + 1 < n ? clamp(s + 1, i) : pos;
    case 'ArrowUp':
      return s > 0 ? clamp(s - 1, i) : pos;
    case 'Home':
      return { shelf: 0, index: 0 };
    case 'End':
      return { shelf: n - 1, index: lengths[n - 1] - 1 };
    case 'Enter':
    case ' ':
      return 'activate';
    case 'z':
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}

/** 凡例の 1 つ。 @param {string} pile */
const glyph = (pile) => h('i', { class: `mark mark--${pile}`, 'aria-hidden': 'true' });

/**
 * 棚 1 つ。
 * @param {T} t @param {any} s @param {{now: number, cursorId: string|null, focusId: string|null}} o
 */
function shelfEl(t, s, o) {
  const name = projectLabel(t, s.project);
  const parts = MARK_PILES.filter((p) => s.counts[p] > 0).map((p) => t('overview.part', { pile: bucketTitle(t, p), n: s.counts[p] }));
  if (s.cleanup > 0) parts.push(t('overview.cleanup', { n: s.cleanup }));
  const marks = s.marks.map((/** @type {any} */ m) => {
    const { kind, since } = cardTime(m.card);
    const label = t('overview.mark', { pile: bucketTitle(t, m.pile), title: titleOf(t, m.card.title), time: timeText(t, kind, since, o.now) });
    return h(
      'button',
      { class: `mark-btn${m.id === o.cursorId ? ' is-cursor' : ''}`, type: 'button', 'data-action': 'jump-to', 'data-id': m.id, 'aria-label': label, title: label, tabindex: m.id === o.focusId ? '0' : '-1' },
      glyph(m.pile),
    );
  });
  if (s.more > 0) marks.push(h('span', { class: 'shelf__more', text: t('overview.more', { n: s.more }) }));
  return h(
    'div',
    { class: 'shelf', role: 'group', 'aria-label': t('overview.shelfAria', { project: name, list: parts.join(t('sep.list')) }), 'data-key': s.key },
    h('span', { class: `shelf__name${isOtherProject(s.project) ? ' is-other' : ''}`, text: name, title: isOtherProject(s.project) ? t('project.otherGloss') : null }),
    h('span', { class: 'shelf__marks' }, ...marks),
    s.cleanup > 0 ? h('span', { class: 'shelf__n', text: t('overview.cleanup', { n: s.cleanup }) }) : h('span', { class: 'shelf__n' }),
  );
}

/**
 * 全体の形の署名 (純粋)。時刻・カーソル・フォーカスは入れない (それらは作り直さずに合わせる)。
 * @param {string} lang @param {ReturnType<typeof overviewModel>} model
 */
export function overviewSig(lang, model) {
  const shelf = (/** @type {any} */ s) => [s.key, s.project?.label ?? '', s.cleanup, s.more, s.marks.map((/** @type {any} */ m) => `${m.id}:${m.pile}:${m.card.title ?? ''}`).join(',')].join(';');
  const shown = model.showQuiet ? model.quiet : [];
  return [lang, model.showQuiet, model.empty, model.quiet.length, JSON.stringify(model.quietCounts), model.live.map(shelf).join('/'), shown.map(shelf).join('/')].join('|');
}

/**
 * 全体を描く。印は 1 つだけ tab で止まる (roving tabindex)。
 * 形が変わらなければ作り直さない (5 秒ごとの取得で、フォーカスのある印を作り直して読み上げ直させない・画面を引き戻さない)。
 * 印の名前 (時刻入り)・カーソルの印・tab の止まる印だけを、その場で合わせる。
 * @param {HTMLElement} section #overview
 * @param {T} t
 * @param {ReturnType<typeof overviewModel>|null} model null なら閉じる
 * @param {{now: number, cursorId: string|null}} o
 */
export function renderOverview(section, t, model, o) {
  setDisclosed(section, !!model);
  if (!model) {
    section.dataset.sig = '';
    return;
  }
  const inner = /** @type {HTMLElement} */ (section.firstElementChild ?? section.appendChild(h('div', { class: 'disclose__in' })));
  const focused = document.activeElement instanceof HTMLElement && section.contains(document.activeElement) ? document.activeElement.dataset.id ?? null : null;
  const shelves = model.showQuiet ? [...model.live, ...model.quiet] : model.live;
  const ids = shelves.flatMap((s) => s.marks.map((/** @type {any} */ m) => m.id));
  const focusId = (focused && ids.includes(focused) && focused) || (o.cursorId && ids.includes(o.cursorId) ? o.cursorId : ids[0] ?? null);
  const sig = overviewSig(t.lang, model);
  if (section.dataset.sig === sig) {
    syncMarks(section, t, shelves, { ...o, focusId });
    return;
  }
  section.dataset.sig = sig;
  const so = { ...o, focusId };
  const quietLine = model.quiet.length
    ? h(
        'p',
        { class: 'ov__quiet' },
        h('span', { text: `${t('overview.quiet', { n: model.quiet.length })} ` }),
        h('span', { class: 'ov__quietCounts', text: t('overview.quietCounts', model.quietCounts) }),
        ' ',
        h('button', { class: 'textbtn', type: 'button', 'data-action': 'overview-quiet', 'aria-expanded': model.showQuiet ? 'true' : 'false', text: t(model.showQuiet ? 'overview.quietHide' : 'overview.quietShow') }),
      )
    : null;
  fill(
    inner,
    h('h2', { class: 'ov__title', id: 'ov-h', text: t('overview.title') }),
    h('p', { class: 'ov-legend', 'aria-hidden': 'true' }, ...MARK_PILES.map((p) => h('span', {}, glyph(p), bucketTitle(t, p))), h('span', { text: t('overview.key.cleanup') })),
    h('p', { class: 'ov__hint', text: t('overview.hint') }),
    model.empty ? h('p', { class: 'ov__empty', text: t('overview.empty') }) : h('div', { class: 'ov__shelves' }, ...model.live.map((s) => shelfEl(t, s, so))),
    quietLine,
    model.showQuiet && model.quiet.length ? h('div', { class: 'ov__shelves ov__shelves--quiet' }, ...model.quiet.map((s) => shelfEl(t, s, so))) : null,
  );
  // 作り直しでフォーカスのあった印が消えたときだけ、同じ印へ戻す (画面は動かさない)
  if (focused) focusMark(section, focused, false);
}

/** 作り直さずに、印の名前・カーソル・tab の止まる印を合わせる。 @param {HTMLElement} section @param {T} t @param {any[]} shelves @param {{now: number, cursorId: string|null, focusId: string|null}} o */
function syncMarks(section, t, shelves, o) {
  /** @type {Map<string, any>} */
  const byId = new Map(shelves.flatMap((s) => s.marks.map((/** @type {any} */ m) => [m.id, m])));
  for (const b of /** @type {HTMLElement[]} */ ([...section.querySelectorAll('.mark-btn')])) {
    const m = byId.get(b.dataset.id ?? '');
    if (!m) continue;
    const { kind, since } = cardTime(m.card);
    const label = t('overview.mark', { pile: bucketTitle(t, m.pile), title: titleOf(t, m.card.title), time: timeText(t, kind, since, o.now) });
    if (b.getAttribute('aria-label') !== label) {
      b.setAttribute('aria-label', label);
      b.title = label;
    }
    b.classList.toggle('is-cursor', m.id === o.cursorId);
    b.tabIndex = m.id === o.focusId ? 0 : -1;
  }
}

/**
 * 印にフォーカスする (無ければ最初の印)。scroll はキーで開いたときだけ true (作り直しのときは画面を動かさない)。
 * @param {HTMLElement} section @param {string|null} id @param {boolean} [scroll]
 */
export function focusMark(section, id, scroll = true) {
  const all = /** @type {HTMLElement[]} */ ([...section.querySelectorAll('.mark-btn')]);
  const target = all.find((b) => b.dataset.id === id) ?? all[0];
  if (!target) return false;
  for (const b of all) b.tabIndex = b === target ? 0 : -1;
  target.focus({ preventScroll: !scroll });
  return true;
}

/** 1 文字キーを止めているときに全体の中でも効かないキー。 */
const SINGLE_KEYS = new Set(['j', 'k', 'z']);

/**
 * 全体の中で受け持つキーの名前 (純粋)。日本語入力中・修飾キー・止めた 1 文字キー・z の押しっぱなしは null。
 * @param {{key: string, keyCode?: number, isComposing?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, repeat?: boolean}} ev
 * @param {boolean} keysOn
 * @returns {string|null}
 */
export function overviewKey(ev, keysOn) {
  if (ev.isComposing || ev.keyCode === 229 || ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  if (SINGLE_KEYS.has(ev.key) && !keysOn) return null;
  if (ev.key === 'z' && ev.repeat) return null;
  return ev.key;
}

/**
 * 全体の中のキー。動いたら true。
 * @param {HTMLElement} section
 * @param {KeyboardEvent} ev
 * @param {{onActivate: (id: string) => void, onClose: () => void, keysOn?: boolean}} o
 */
export function overviewKeydown(section, ev, o) {
  const key = overviewKey(ev, o.keysOn !== false);
  if (key === null) return false;
  const shelves = /** @type {HTMLElement[]} */ ([...section.querySelectorAll('.shelf')]);
  const lists = shelves.map((s) => /** @type {HTMLElement[]} */ ([...s.querySelectorAll('.mark-btn')])).filter((l) => l.length);
  const active = document.activeElement;
  let pos = { shelf: 0, index: 0 };
  lists.forEach((l, si) => {
    const i = l.indexOf(/** @type {HTMLElement} */ (active));
    if (i >= 0) pos = { shelf: si, index: i };
  });
  const onMark = active instanceof HTMLElement && active.classList.contains('mark-btn');
  if (!onMark && key !== 'Escape' && key !== 'z') return false;
  const r = markMove(key, pos, lists.map((l) => l.length));
  if (r === null) return false;
  if (r === 'close') o.onClose();
  else if (r === 'activate') o.onActivate(String(/** @type {HTMLElement} */ (active).dataset.id));
  else focusMark(section, lists[r.shelf][r.index].dataset.id ?? null);
  return true;
}
