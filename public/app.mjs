// @ts-check
// 画面: 起動と操作。言語と好みを読み、静的な文言を入れ、クリックとキーを 1 か所で受け、5 秒ごとの取得 (poll.mjs) を始める。
// 読み取り専用 (サーバーへは GET しかしない)。片付けと引き継ぎは Claude への指示文をコピーするだけ (actions.mjs)。

import { FILTER_ANNOUNCE_MS, MIN } from '../src/shared/constants.mjs';
import { normalizeLang } from '../src/shared/i18n.mjs';
import { copyChunk, copySmall, dueNext, handoffKey, openHandoff, runGuide } from './actions.mjs';
import { CANVAS_CLICK, initCanvas, runCanvasKey } from './canvas-act.mjs';
import { isCanvas, openBar, switchView } from './canvas-ctl.mjs';
import { applyPick, cleanupBodyParts, pickAllSuggested, togglePickRow } from './cleanup.mjs';
import { titleOf } from './format.mjs';
import { detectLang } from './i18n.mjs';
import { bindKeys, escapeStep, openHelp } from './keys.mjs';
import { poll, schedule } from './poll.mjs';
import { clearFilters, jumpPile, jumpTo, moveCursor, openSession, render, renderTimes, rowEl, setCursorRow, view } from './render.mjs';
import { closeBatch, loadPrefs, reselectLeft, savePrefs, setLang, state } from './state.mjs';
import { announce, fill } from './view.mjs';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const filterInput = /** @type {HTMLInputElement} */ ($('filter'));

/** index.html の data-i18n / data-i18n-attr を今の言語で埋める。 */
function applyStaticText() {
  const t = state.t;
  for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-i18n]')])) el.textContent = t(el.dataset.i18n ?? '');
  for (const el of /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-i18n-attr]')])) {
    for (const pair of (el.dataset.i18nAttr ?? '').split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  }
}

/** @param {'en'|'ja'|'zh'} lang */
function setLanguage(lang) {
  setLang(lang);
  document.documentElement.lang = lang;
  applyStaticText();
  render();
}

/** 見出しの言語の選び箱: 選んだ言語を保存して、URL の ?lang= を外して切り替える (盤面は取り直さない)。 @param {unknown} value */
function switchLanguage(value) {
  const next = normalizeLang(value);
  if (!next || next === state.t.lang) return;
  state.prefs.lang = next;
  savePrefs();
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.delete('lang');
      history.replaceState(null, '', url);
    }
  } catch {
    // URL を書き換えられなくても切り替えはできる
  }
  setLanguage(next);
}

// ---------- クリック・変更 ----------

/** @param {string} id */
function toggleDetail(id) {
  if (state.open.has(id)) state.open.delete(id);
  else state.open.add(id);
  render();
}

/**
 * 開閉を切り替えて覚える。既定と同じに戻ったら記録を消す (開閉の表にプロジェクト名を残し続けない)。
 * @param {Record<string, boolean>} rec @param {string} key @param {boolean} dflt
 */
function flip(rec, key, dflt) {
  const next = !(rec[key] ?? dflt);
  if (next === dflt && rec !== /** @type {any} */ (state.prefs)) delete rec[key];
  else rec[key] = next;
  savePrefs();
  render();
}

/** @param {HTMLElement|null} opener */
function showHelp(opener) {
  openHelp(state.t, {
    keysOn: state.prefs.keys !== false,
    opener: opener ?? $('help-btn'),
    onToggleKeys: (on) => {
      state.prefs.keys = on;
      savePrefs();
      render();
    },
  });
}

function toggleNotify() {
  if (state.prefs.notify) {
    state.prefs.notify = false;
    savePrefs();
    return render();
  }
  if (typeof Notification === 'undefined') return;
  void Notification.requestPermission().then((p) => {
    state.prefs.notify = p === 'granted';
    savePrefs();
    render();
  });
}

/** @type {Record<string, (el: HTMLElement, ev: MouseEvent) => void>} */
const CLICK = {
  toggle: (el) => {
    const row = /** @type {HTMLElement|null} */ (el.closest('[data-pile]'));
    if (row) setCursorRow(row);
    toggleDetail(el.dataset.id ?? '');
  },
  jump: (el, ev) => {
    ev.preventDefault();
    jumpPile(el.dataset.pile ?? '');
  },
  'jump-to': (el) => jumpTo(el.dataset.id ?? ''),
  family: (el) => {
    state.family = el.dataset.root ?? null;
    render();
  },
  'clear-family': () => {
    state.family = null;
    render();
  },
  'clear-filter': () => {
    state.filter = '';
    filterInput.value = '';
    render();
  },
  'clear-filters': () => {
    clearFilters();
    render();
  },
  more: (el) => flip(state.prefs.more, el.dataset.list ?? '', false),
  page: (el) => {
    const key = el.dataset.list ?? '';
    state.pages[key] = (state.pages[key] ?? 1) + 1;
    render();
  },
  pile: (el) => flip(state.prefs.open, el.dataset.pile ?? '', el.dataset.pile === 'cleanup'),
  sub: (el) => flip(state.prefs.open, el.dataset.list ?? '', false),
  copy: (el) => void copyChunk(el),
  'clear-selection': () => {
    state.selected = new Set();
    render();
  },
  'close-batch': () => {
    closeBatch();
    render();
  },
  reselect: () => {
    reselectLeft();
    render();
  },
  'copy-id': (el) => void copySmall(el),
  'copy-link': (el) => void copySmall(el),
  'handoff-open': (el) => (isCanvas() ? openBar('handoff', el.dataset.id ?? '') : openHandoff(el.dataset.id ?? '')),
  'handoff-copy-open': (el) => void runGuide(el),
  'handoff-copy': (el) => void runGuide(el),
  'handoff-rescue': (el) => void runGuide(el),
  'due-next': () => dueNext(),
  help: (el) => showHelp(el),
  reload: () => location.reload(),
  'intro-ok': () => {
    state.prefs.seenIntro = true;
    savePrefs();
    render();
  },
  notify: () => toggleNotify(),
};

/** @param {MouseEvent} ev */
function onClick(ev) {
  const el = /** @type {HTMLElement|null} */ (ev.target instanceof Element ? ev.target.closest('[data-action]') : null);
  if (!el || el instanceof HTMLInputElement) return;
  const action = el.dataset.action ?? '';
  (CLICK[action] ?? CANVAS_CLICK[action])?.(el, ev);
}

// ---------- キー ----------

/** @returns {boolean} preventDefault するか */
function escapeChain() {
  const active = document.activeElement;
  const step = escapeStep({
    inFilter: active === filterInput,
    filterValue: filterInput.value,
    detailOpen: !!state.cursor && state.open.has(state.cursor.id),
    family: state.family,
    q: state.filter,
  });
  if (!step) return false;
  if (step === 'filter-clear' || step === 'query-clear') {
    state.filter = '';
    filterInput.value = '';
  } else if (step === 'filter-blur') filterInput.blur();
  else if (step === 'detail-close' && state.cursor) state.open.delete(state.cursor.id);
  else if (step === 'family-clear') state.family = null;
  render();
  return true;
}

/** キーの動作。true を返すと preventDefault。 @param {string} action */
function runKey(action) {
  // キャンバスのキー (cv:)。絞り込みと help は一覧と同じ動き
  if (action === 'cv:filter' || action === 'cv:help') return runKey(action.slice(3));
  if (action.startsWith('cv:')) return runCanvasKey(action.slice(3));
  const cur = state.cursor;
  const b = state.board;
  switch (action) {
    case 'next':
      return moveCursor(1);
    case 'prev':
      return moveCursor(-1);
    case 'open': {
      const id = cur?.id ?? b?.buckets?.needs_you?.[0]?.id ?? b?.buckets?.trouble?.[0]?.id ?? b?.buckets?.unread?.[0]?.id;
      return id ? openSession(id) : false;
    }
    case 'peek':
      if (!cur) return false;
      toggleDetail(cur.id);
      return true;
    case 'pick': {
      const done = togglePickRow(cur ? rowEl(cur.id) : null);
      if (!done || !cur) return false;
      render();
      const title = titleOf(state.t, view.index.get(cur.id)?.card.title);
      announce(state.t(done === 'picked' ? 'live.picked' : 'live.unpicked', { title }));
      return true;
    }
    case 'all': {
      const n = pickAllSuggested();
      if (!n) return false;
      render();
      announce(state.t('live.selectAll', { n: Number(b?.counts?.recommended) || n }));
      return true;
    }
    case 'copy': {
      // 予備のコピー (textarea・手で写す dialog) のあとにフォーカスを戻す先: 今の部品、無ければカーソルの行の題名
      const active = document.activeElement;
      const title = cur ? /** @type {HTMLElement|null} */ (rowEl(cur.id)?.querySelector('[data-action="toggle"]') ?? null) : null;
      void copyChunk(active instanceof HTMLElement && active !== document.body ? active : title);
      return true;
    }
    case 'filter':
      filterInput.focus();
      filterInput.select();
      return true;
    case 'help':
      showHelp($('help-btn'));
      return true;
    case 'view':
      switchView('canvas');
      return true;
    case 'canvas-fit':
      switchView('canvas', { fit: true });
      return true;
    case 'handoff':
      return handoffKey();
    case 'escape':
      return escapeChain();
    default:
      if (!action.startsWith('jump:')) return false;
      jumpPile(action.slice(5));
      return true;
  }
}

// ---------- 起動 ----------

function observeSizes() {
  if (typeof ResizeObserver === 'undefined') return;
  const root = document.documentElement;
  const bar = $('selbar');
  new ResizeObserver(() => root.style.setProperty('--bar-h', `${bar.hidden ? 0 : Math.ceil(bar.getBoundingClientRect().height)}px`)).observe(bar);
  // 貼り付く見出しの高さ = 見えている見出しのうち一番高いもの。どれも見えていなければ CSS の既定 (3.25rem) に任せ、0 は書かない
  const heads = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.pile__head')]);
  const measure = () => {
    const tallest = Math.max(0, ...heads.map((el) => (el.getClientRects().length ? Math.ceil(el.getBoundingClientRect().height) : 0)));
    if (tallest > 0) root.style.setProperty('--head-h', `${tallest}px`);
    else root.style.removeProperty('--head-h');
  };
  const ro = new ResizeObserver(measure);
  for (const el of heads) ro.observe(el);
}

/** @type {ReturnType<typeof setTimeout>|null} */
let filterTimer = null;

/** 打ち終えたら一致数を読み上げる (打つたびには読まない)。 */
function announceFilter() {
  const v = view.visible;
  const q = state.filter.trim();
  if (!v?.filtering || !q) return;
  announce(v.total === 0 ? state.t('nomatch.query.lead', { q }) : state.t('banner.filter', { q, n: v.total }));
}

/** 毎分ちょうど (分が変わったところ) に時刻の文言を書き直す。 */
function tick() {
  renderTimes();
  setTimeout(tick, MIN - (Date.now() % MIN) + 50);
}

function init() {
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  loadPrefs();
  // 開く表示: ?view= (保存しない) > 覚えた表示 > 一覧
  const asked = new URLSearchParams(location.search).get('view');
  state.view = asked === 'canvas' || asked === 'list' ? asked : state.prefs.view;
  fill(/** @type {HTMLElement} */ ($('r-cleanup').firstElementChild), ...cleanupBodyParts());
  setLang(detectLang({ search: location.search, saved: state.prefs.lang, languages: navigator.languages ?? [navigator.language] }));
  document.documentElement.lang = state.t.lang;
  applyStaticText();
  document.addEventListener('click', onClick);
  document.addEventListener('change', (ev) => {
    if (ev.target instanceof HTMLSelectElement && ev.target.id === 'lang') switchLanguage(ev.target.value);
    else if (ev.target instanceof HTMLInputElement && applyPick(ev.target, view.visible)) render();
  });
  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value;
    render();
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(announceFilter, FILTER_ANNOUNCE_MS);
  });
  initCanvas();
  bindKeys(() => state.prefs.keys !== false, runKey, () => state.view);
  // Tab で行の題名 (片付けの行ならチェックボックスも) に来たら、そこをカーソルにする (Enter / Space / x がその行に効くように)
  document.addEventListener('focusin', (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest('.row__title, .trow__title, .trow .check input') : null;
    const row = /** @type {HTMLElement|null} */ (el?.closest('[data-id]') ?? null);
    if (row && state.cursor?.id !== row.dataset.id) setCursorRow(row);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) schedule();
    else void poll();
  });
  observeSizes();
  render();
  void poll();
  setTimeout(tick, MIN - (Date.now() % MIN) + 50);
}

init();
