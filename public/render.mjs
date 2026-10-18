// @ts-check
// 画面: 描画のまとめ役。見出し・帯・lede・台帳・全体・各欄・帯・足元・タブ題名・favicon を順に合わせ、フォーカスを保つ。
// 5 秒ごとの描画はフォーカスを動かさない。フォーカスしていた部品が消えたときだけ、カーソルの行へ移す。

import { DAY, PAGE_SIZE, PREVIEW, RECENT_MS, STALE_AFTER_MS } from '../src/shared/constants.mjs';
import { renderCleanup, renderSelbar } from './cleanup.mjs';
import { faviconKind, setFavicon } from './favicon.mjs';
import { agoText, bucketTitle, dateline, deepLink, quietHint, sentences, tabTitle, timeText } from './format.mjs';
import { renderBanners, renderFront, renderIntro, renderLede } from './front.mjs';
import { otherLang } from './i18n.mjs';
import { notifyState } from './notify.mjs';
import { focusMark, overviewModel, renderOverview } from './overview.mjs';
import { renderLoadingPile, renderPile, renderRecent } from './rows.mjs';
import { archivedToday, isNew, now, pruneNew, savePrefs, state, takeArrival, zeroSinceToday } from './state.mjs';
import { batchProgress, cardIndex, cursorAfter, focusSignature, listsFromRows, nextUp, presentIds, visibleModel } from './ui-state.mjs';
import { announce, fill, h, leaveAndRemove } from './view.mjs';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const LIVE_PILES = /** @type {const} */ (['needs_you', 'trouble', 'unread', 'working']);

/** 今の見え方 (render のたびに作り直す)。 */
export const view = { /** @type {any} */ visible: null, /** @type {Map<string, any>} */ index: new Map(), /** @type {Set<string>} */ present: new Set() };

/** 片付いた (batch にあって盤面から消えた) 行だけ、フェードしてから外す。 @param {HTMLElement} el */
function leave(el) {
  const row = /** @type {HTMLElement|null} */ (el.firstElementChild);
  const id = row?.dataset.id;
  if (!id || !state.batch?.ids.includes(id) || view.present.has(id)) return false;
  leaveAndRemove(el);
  return true;
}

/** 部品の居場所: 欄 + 一番近い data-key (欄を移った行は「同じ部品」とみなさない)。 @param {Element} el */
const scopeOf = (el) => `${el.closest('section.pile, #overview, #selbar, #front')?.id ?? ''}/${el.parentElement?.closest('[data-key]')?.getAttribute('data-key') ?? ''}`;

function captureFocus() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body || el.id === 'filter') return null;
  // home: フォーカスの戻し先が無いときに見出しへ戻すための、部品のいた欄 (選択の帯なら片付けの欄)
  return { el, tag: el.tagName, sig: focusSignature(el.tagName, (n) => el.getAttribute(n), scopeOf(el)), home: el.closest('#selbar, section.pile')?.id ?? '' };
}

/** 消えたか、隠れた (hidden・inert の中に入った) 部品か。 @param {HTMLElement} el */
const gone = (el) => !el.isConnected || !!el.closest('[inert], [hidden]');

/** 欄の見出しへフォーカスする (開閉のボタンがあればそれ、無ければ見出しそのもの)。 @param {HTMLElement|null} section */
function focusPileHead(section) {
  if (!section || section.hidden) return;
  const btn = /** @type {HTMLElement|null} */ (section.querySelector('.pile__toggle'));
  if (btn) return btn.focus({ preventScroll: true });
  const head = /** @type {HTMLElement|null} */ (section.querySelector('.pile__head'));
  if (!head) return;
  head.tabIndex = -1;
  head.focus({ preventScroll: true });
}

/** @param {ReturnType<typeof captureFocus>} f */
function restoreFocus(f) {
  if (!f || !gone(f.el)) return;
  // 隠れただけの部品には、ブラウザが body へ移すまでフォーカスが残っている。それ以外の場所にあれば触らない
  const active = document.activeElement;
  if (active && active !== document.body && active !== f.el) return;
  for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll(f.tag)])) {
    if (focusSignature(el.tagName, (n) => el.getAttribute(n), scopeOf(el)) === f.sig && !gone(el)) {
      el.focus({ preventScroll: true });
      return;
    }
  }
  const row = state.cursor ? rowEl(state.cursor.id) : null;
  const title = /** @type {HTMLElement|null} */ (row?.querySelector('[data-action="toggle"]') ?? null);
  if (title && !gone(title)) return title.focus({ preventScroll: true });
  focusPileHead(f.home === 'selbar' ? $('p-cleanup') : f.home ? $(f.home) : null);
}

/**
 * 新しい盤面のあとのカーソルを、見えている行で決め直す。setCursorRow が覚える index は「その欄で見えていた行」の中の位置なので、
 * 隠れた行 (絞り込み・「残りを表示」の後ろ・閉じたグループ) へは移さない。見えている行が 1 つも無ければ盤面全体の結果のまま。
 */
function settleCursor() {
  const was = state.cursorWas;
  state.cursorWas = null;
  if (!was) return;
  const rows = visibleRows().map((r) => ({ id: r.dataset.id ?? '', pile: r.dataset.pile ?? '' }));
  const { cursor } = cursorAfter(was, listsFromRows(rows));
  if (!cursor) return;
  state.cursor = cursor;
  for (const r of /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#pages .row[data-id], #pages .trow[data-id]')])) r.classList.toggle('is-cursor', r.dataset.id === cursor.id);
  for (const b of /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#overview .mark-btn')])) b.classList.toggle('is-cursor', b.dataset.id === cursor.id);
}

/** @param {string} id */
export const rowEl = (id) => /** @type {HTMLElement|null} */ (document.querySelector(`.row[data-id="${CSS.escape(id)}"], .trow[data-id="${CSS.escape(id)}"]`));

function renderMast() {
  const t = state.t;
  const at = now();
  const date = $('dateline');
  if (!state.lastOk) date.textContent = '';
  else if (at - state.lastOk > STALE_AFTER_MS) date.textContent = t('date.stale', { ago: agoText(t, at - state.lastOk) });
  else date.textContent = dateline(t, state.lastOk);
  $('demo').hidden = !state.board?.stats?.demo;
  // 言語ボタンの名前は見えている言葉 (「日本語」/「English」) から始める (WCAG 2.5.3)。lang は見えている言葉にだけ付ける
  const lang = $('lang');
  if (lang.dataset.lang !== t.lang) {
    lang.dataset.lang = t.lang;
    fill(lang, h('span', { lang: otherLang(t.lang), text: t('lang.switchTo') }), h('span', { class: 'vh', text: ` (${t('lang.toggleAria')})` }));
  }
  const needs = (Number(state.board?.counts?.needs_you) || 0) > 0;
  document.querySelector('.glyph rect')?.classList.toggle('is-on', needs);
}

function renderFoot() {
  const t = state.t;
  const s = state.board?.stats ?? {};
  const keysOn = state.prefs.keys !== false;
  const notify = notifyState();
  const archived = Number(state.board?.counts?.archived ?? s.archived) || 0;
  const badFormat = Number(s.recentWithTranscript) > 0 && Number(s.unknownTurnRecent) / Number(s.recentWithTranscript) > 0.5;
  // 署名は足元に出す値だけ (scanMs などで毎回作り直して、開いた「読み込みの状態」を閉じないように)
  const sig = [t.lang, keysOn, notify, state.prefs.notify, !!state.board, s.bad, s.transcriptsMissingRecent, s.transcriptsDirMissing, badFormat, s.demo, archived].join('|');
  const foot = $('foot');
  if (foot.dataset.sig === sig) return;
  foot.dataset.sig = sig;
  const diagOpen = /** @type {HTMLDetailsElement|null} */ (foot.querySelector('details.foot__diag'))?.open ?? false;
  const key = (/** @type {string[]} */ keys, /** @type {string} */ label) => h('span', {}, ...keys.flatMap((k) => [h('kbd', { text: k }), ' ']), label);
  const diag = [];
  if (Number(s.bad) > 0) diag.push(h('p', { text: t('foot.bad', { n: s.bad }) }));
  if (Number(s.transcriptsMissingRecent) > 0) diag.push(h('p', { text: sentences(t, t('foot.missing', { n: s.transcriptsMissingRecent, days: RECENT_MS / DAY }), t('foot.missingWhy')) }));
  if (!diag.length) diag.push(h('p', { text: t('foot.allGood') }));
  fill(
    foot,
    h(
      'div',
      { class: 'foot__l' },
      h('p', { class: 'foot__trust', text: t('foot.trust') }),
      keysOn
        ? h('p', { class: 'foot__keys', 'aria-label': t('help.title') }, key(['j', 'k'], t('foot.keys.move')), key(['Enter'], t('foot.keys.open')), key(['Space'], t('foot.keys.peek')), key(['x'], t('foot.keys.pick')), key(['/'], t('foot.keys.filter')), key(['z'], t('foot.keys.overview')), key(['?'], t('foot.keys.more')))
        : null,
      notify === 'ok' && state.board
        ? h('p', { class: 'foot__notify' }, h('button', { class: 'textbtn', type: 'button', 'data-action': 'notify', text: t(state.prefs.notify ? 'foot.notifyOff' : 'foot.notifyOn') }), ' ', h('span', { class: 'foot__note', text: t('foot.notifyNote') }))
        : null,
      notify === 'blocked' && state.board ? h('p', { class: 'foot__note', text: t('foot.notifyBlocked') }) : null,
    ),
    h(
      'div',
      { class: 'foot__r' },
      archived > 0 ? h('p', { class: 'foot__facts', text: t('foot.archived', { n: archived }) }) : null,
      s.demo ? h('p', { class: 'foot__ink', text: t('foot.demo') }) : null,
      s.transcriptsDirMissing ? h('p', { class: 'foot__ink', text: t('foot.noDir') }) : null,
      badFormat ? h('p', { class: 'foot__ink', text: t('foot.badFormat') }) : null,
      state.board ? h('details', { class: 'foot__diag', open: diagOpen }, h('summary', { text: t('foot.diag') }), ...diag) : null,
      h('p', { class: 'foot__disc', text: t('foot.disclaimer') }),
    ),
  );
}

/** 全体を描き直す。 */
export function render() {
  const t = state.t;
  const at = now();
  const board = state.board;
  const focus = captureFocus();
  view.visible = board ? visibleModel(board, { q: state.filter, family: state.family, t }) : null;
  view.index = cardIndex(board);
  view.present = presentIds(board);
  renderMast();
  renderBanners($('banners'), { t, now: at, board, fail: state.fail, lastOk: state.lastOk, visible: view.visible, q: state.filter.trim(), family: state.family });
  renderFront(
    { lede: $('lede'), ledger: $('ledger'), toggle: $('ov-toggle') },
    { t, now: at, board, loading: state.loading, fail: state.fail, calmSince: zeroSinceToday(at), visible: view.visible, overviewOpen: !!state.prefs.overview && !!board, keysOn: state.prefs.keys !== false },
  );
  renderIntro($('intro'), { t, show: !!board && !state.prefs.seenIntro && state.storageOk });
  const ov = $('overview');
  renderOverview(ov, t, board && state.prefs.overview ? overviewModel(board, view.visible, state.prefs) : null, { now: at, cursorId: state.cursor?.id ?? null });
  const empty = !board || (Number(board.counts?.active) || 0) === 0;
  $('pages').hidden = !!board && empty;
  document.documentElement.classList.toggle('keys-off', state.prefs.keys === false);
  if (!board) {
    for (const p of LIVE_PILES) $(`p-${p}`).hidden = true;
    $('p-recent').hidden = true;
    $('p-cleanup').hidden = true;
    $('selbar').hidden = true;
    $('pages').hidden = !state.loading || !!state.fail;
    if (state.loading && !state.fail) renderLoadingPile($('p-needs_you'), t);
  } else if (!empty) {
    const next = nextUp(board);
    const ctx = {
      t, now: at, board, index: view.index, nextId: next?.card.id ?? null, cursorId: state.cursor?.id ?? null,
      open: state.open, selected: state.selected, copied: state.copied, filtering: view.visible.filtering, prefs: state.prefs,
      isNew: (/** @type {string} */ p, /** @type {string} */ id) => isNew(p, id, at), takeArrival, leave, pages: state.pages, batchOpen: !!state.batch,
    };
    for (const p of LIVE_PILES) renderPile($(`p-${p}`), p, view.visible.buckets[p], ctx);
    renderRecent($('p-recent'), view.visible.recentGroups, view.visible.counts.recent, ctx);
    renderCleanup($('p-cleanup'), view.visible, ctx);
    renderSelbar($('selbar'), {
      t, now: at, board, visible: view.visible, selected: state.selected, copied: state.copied, batch: state.batch,
      progress: state.batch ? batchProgress(state.batch.ids, view.present, Date.now() - state.batch.lastCopyAt) : null,
      copiedUntil: state.copiedUntil, local: Date.now(), prefs: state.prefs, today: archivedToday(at), wide: matchMedia('(min-width: 40rem)').matches,
    });
  }
  settleCursor();
  // 止まったかもと未読が両方空なら、真ん中の列を詰める (広い画面の 3 列で空の帯を残さない)
  const solo = $('p-trouble').hidden && $('p-unread').hidden;
  /** @type {HTMLElement} */ (document.querySelector('.page--now > .side')).hidden = solo;
  document.querySelector('.page--now')?.classList.toggle('is-solo', solo);
  renderFoot();
  document.title = tabTitle(t, board?.counts, !!board && state.fail === 'offline');
  setFavicon(board ? faviconKind(board.counts) : 'none');
  restoreFocus(focus);
}

/** 304 のとき: 盤面は同じなので、見出しの日付だけ合わせる (行も全体も作り直さない)。 */
export function renderPulse() {
  renderMast();
}

/**
 * 毎分: 時刻の文言・lede・見出しの日付・静かな作業中の一言。新着の印が切れていれば、その印を消して全体を描き直してから、
 * いつもどおり時刻も書き直す (署名の変わらない行は作り直されないので、ここで書き直さないと時刻が止まる)。
 */
export function renderTimes() {
  const at = now();
  if (pruneNew(at)) render();
  const t = state.t;
  for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll('time[data-kind][data-since]')])) {
    const text = timeText(t, el.dataset.kind ?? 'ago', Number(el.dataset.since), at);
    if (el.textContent !== text) el.textContent = text;
  }
  for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-hint-since]')])) {
    const text = quietHint(t, Number(el.dataset.hintSince), at);
    el.hidden = !text;
    if (el.textContent !== text) el.textContent = text;
  }
  renderMast();
  renderLede($('lede'), { t, now: at, board: state.board, loading: state.loading, fail: state.fail, calmSince: zeroSinceToday(at) });
}

/** 見えている行 (読む順)。 */
export function visibleRows() {
  return /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#pages .row[data-id], #pages .trow[data-id]')]).filter((el) => !el.closest('[hidden], [inert], .is-leaving'));
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 行にカーソルを置いてフォーカスする。
 * @param {HTMLElement} row @param {ScrollLogicalPosition} [block]
 */
export function focusRow(row, block = 'nearest') {
  setCursorRow(row);
  const title = /** @type {HTMLElement|null} */ (row.querySelector('[data-action="toggle"]'));
  title?.focus({ preventScroll: true });
  row.scrollIntoView({ block, behavior: block === 'center' && !reduced() ? 'smooth' : 'auto' });
}

/** 行にカーソルを置く (描き直さずに印だけ付け替える)。 @param {HTMLElement} row */
export function setCursorRow(row) {
  const pile = row.dataset.pile ?? '';
  const list = visibleRows().filter((r) => r.dataset.pile === pile);
  state.cursor = { id: row.dataset.id ?? '', pile, index: Math.max(0, list.indexOf(row)) };
  for (const r of document.querySelectorAll('#pages .is-cursor')) if (r !== row) r.classList.remove('is-cursor');
  row.classList.add('is-cursor');
}

/** j / k。 @param {1|-1} dir */
export function moveCursor(dir) {
  const rows = visibleRows();
  if (!rows.length) return false;
  const i = state.cursor ? rows.findIndex((r) => r.dataset.id === state.cursor?.id) : -1;
  const next = i < 0 ? rows[0] : rows[Math.max(0, Math.min(rows.length - 1, i + dir))];
  focusRow(next);
  return true;
}


// ---------- 行・欄への移動 (全体・木・通知・台帳・キーから) ----------

/** Claude アプリでセッションを開く (行の「開く ↗」と同じリンクを押す)。 @param {string} id */
export function openSession(id) {
  const href = deepLink(id);
  if (!href) return false;
  const a = document.createElement('a');
  a.href = href;
  a.click();
  return true;
}

/** 文字と親子の絞り込みを消す。 */
export function clearFilters() {
  state.filter = '';
  /** @type {HTMLInputElement} */ ($('filter')).value = '';
  state.family = null;
}

/** その行が見えるように欄・グループ・「残りを表示」を開いて、カーソルとフォーカスを置く。 @param {string} id */
export function jumpTo(id) {
  const e = view.index.get(id);
  if (!e) return;
  const { card, pile } = e;
  const b = state.board;
  const at = (/** @type {any[]} */ list) => list.findIndex((c) => c.id === card.id);
  if (pile === 'unread' || pile === 'working') {
    if (at(b.buckets[pile]) >= PREVIEW[pile]) state.prefs.more[pile] = true;
  } else if (pile === 'recent') {
    state.prefs.open.recent = true;
    const g = b.recentGroups.find((/** @type {any} */ x) => at(x.items) >= 0);
    if (g && at(g.items) >= PREVIEW.recentGroup) state.prefs.more[`recent:${g.key}`] = true;
  } else if (pile === 'cleanup') {
    state.prefs.open.cleanup = true;
    for (const g of b.cleanupGroups) {
      for (const p of g.projects ?? []) {
        const i = at(p.items);
        if (i < 0) continue;
        const key = `sub:${g.reason}:${p.key}`;
        state.prefs.open[key] = true;
        state.pages[key] = Math.max(state.pages[key] ?? 1, Math.ceil((i + 1) / PAGE_SIZE));
      }
    }
  }
  savePrefs();
  render();
  let row = rowEl(card.id);
  if ((!row || row.closest('[hidden], [inert]')) && (state.filter || state.family)) {
    clearFilters();
    render();
    row = rowEl(card.id);
  }
  if (row) focusRow(row, 'center');
}

/** 台帳とキー 1〜6: 欄を開いて、その先頭の行へ。空なら読み上げるだけ。 @param {string} pile */
export function jumpPile(pile) {
  if ((pile === 'recent' || pile === 'cleanup') && !(state.prefs.open[pile] ?? pile === 'cleanup')) {
    state.prefs.open[pile] = true;
    savePrefs();
    render();
  }
  const first = visibleRows().find((r) => r.dataset.pile === pile);
  if (!first) return announce(state.t('bucket.none', { pile: bucketTitle(state.t, pile) }));
  focusRow(first, 'start');
}

/** カーソルの行の題名へ (無ければ全体を開くボタンへ) フォーカスを戻す。 */
export function backToRow() {
  const row = state.cursor ? rowEl(state.cursor.id) : null;
  const title = /** @type {HTMLElement|null} */ (row?.querySelector('[data-action="toggle"]') ?? null);
  (title ?? $('ov-toggle')).focus();
}

/** 全体を開く / 閉じる。キー z からなら中の印 (閉じたら行) へフォーカスを移す。 @param {boolean} [moveFocus] */
export function toggleOverview(moveFocus = false) {
  state.prefs.overview = !state.prefs.overview;
  savePrefs();
  render();
  if (!moveFocus) return;
  if (state.prefs.overview) focusMark($('overview'), state.cursor?.id ?? null);
  else backToRow();
}
