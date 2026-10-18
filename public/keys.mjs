// @ts-check
// 画面: キー操作 (spec/ui.md §14)。keyAction と escapeStep は純粋関数。help の dialog もここで作る。
// 日本語入力中・修飾キー・入力欄・dialog の中では何もしない。1 文字キーは help の切替で止められる (WCAG 2.1.4)。

import { QUIET_MS, MIN, RECENT_MS, DAY } from '../src/shared/constants.mjs';
import { bucketTitle } from './format.mjs';
import { PILES } from './ui-state.mjs';
import { fill, h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {'dialog'|'field'|'filter'|'overview'|'title'|'control'|'none'} KeyTarget */
/** @typedef {{key: string, keyCode?: number, isComposing?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, repeat?: boolean}} KeyLike */

const NO_REPEAT = new Set(['x', 'a', 'c', 'z']);
/** 全体 (Overview) の中では、全体の側が受け持つキー。 */
const OVERVIEW_KEYS = new Set(['j', 'k', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'z', 'Escape']);

/**
 * キーから動作の名前を決める (純粋)。null なら何もしない (ブラウザの普段の動きのまま)。
 * @param {KeyLike} ev
 * @param {{keysOn: boolean, target: KeyTarget}} ctx
 * @returns {string|null}
 */
export function keyAction(ev, ctx) {
  if (ev.isComposing || ev.keyCode === 229) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const key = ev.key;
  const { target, keysOn } = ctx;
  if (target === 'dialog' || target === 'field') return null;
  if (target === 'filter') return key === 'Escape' ? 'escape' : null;
  if (target === 'overview' && OVERVIEW_KEYS.has(key)) return null;
  if (key === 'Escape') return 'escape';
  // Shift で意味の変わる名前つきのキー (Enter・Space・矢印) だけ Shift を無視する。1 文字のキーは ev.key がもう配列どおりの文字なので、
  // '/' や数字に Shift が要る配列 (ドイツ語・フランス語など) でもそのまま効く。Shift+J は 'J' でどれにも当たらない
  if (ev.shiftKey && (key.length !== 1 || key === ' ')) return null;
  if (key === 'Enter') return target === 'title' || target === 'none' ? 'open' : null;
  if (key === ' ') return target === 'none' ? 'peek' : null;
  if (!keysOn) return null;
  if (key === 'ArrowDown') return target === 'none' || target === 'title' ? 'next' : null;
  if (key === 'ArrowUp') return target === 'none' || target === 'title' ? 'prev' : null;
  if (ev.repeat && NO_REPEAT.has(key)) return null;
  switch (key) {
    case 'j':
      return 'next';
    case 'k':
      return 'prev';
    case 'o':
      return 'open';
    case 'x':
      return 'pick';
    case 'a':
      return 'all';
    case 'c':
      return 'copy';
    case '/':
      return 'filter';
    case '?':
      return 'help';
    case 'z':
      return 'overview';
    default:
      if (/^[1-6]$/.test(key)) return `jump:${PILES[Number(key) - 1]}`;
      return null;
  }
}

/**
 * Esc で閉じるものを、上から最初に当てはまる 1 つだけ選ぶ (純粋)。選択と batch は決して消さない。
 * @param {{inFilter: boolean, filterValue: string, inOverview: boolean, detailOpen: boolean, family: string|null, q: string}} ctx
 * @returns {'filter-clear'|'filter-blur'|'overview-close'|'detail-close'|'family-clear'|'query-clear'|null}
 */
export function escapeStep(ctx) {
  if (ctx.inFilter) return ctx.filterValue ? 'filter-clear' : 'filter-blur';
  if (ctx.inOverview) return 'overview-close';
  if (ctx.detailOpen) return 'detail-close';
  if (ctx.family) return 'family-clear';
  if (ctx.q) return 'query-clear';
  return null;
}

/**
 * キーの受け手の種類 (DOM を見る)。
 * @param {EventTarget|null} el
 * @returns {KeyTarget}
 */
export function classifyTarget(el) {
  if (!(el instanceof Element)) return 'none';
  if (el.closest('dialog[open]')) return 'dialog';
  if (el.id === 'filter') return 'filter';
  if (el.closest('#overview')) return 'overview';
  // チェックボックスは文字を受けないので、ほかのボタンと同じに扱う (Space・Enter はブラウザのまま、j/k・x・c などは効く)
  if (el.matches('input[type="checkbox"], input[type="radio"]')) return 'control';
  if (el.matches('input, textarea, select, [contenteditable], [contenteditable] *')) return 'field';
  if (el.matches('.row__title, .trow__title')) return 'title';
  if (el.matches('button, a[href], summary, [tabindex]')) return 'control';
  return 'none';
}

/**
 * document に keydown を 1 つだけ付ける。
 * @param {() => boolean} keysOn
 * @param {(action: string, ev: KeyboardEvent) => boolean} run true を返したら preventDefault
 */
export function bindKeys(keysOn, run) {
  document.addEventListener('keydown', (ev) => {
    const action = keyAction(ev, { keysOn: keysOn(), target: classifyTarget(ev.target) });
    if (action && run(action, ev)) ev.preventDefault();
  });
}

/** @param {string} k */
const kbd = (k) => h('kbd', { text: k });

/**
 * help の dialog を (言語に合わせて) 作り直して開く。閉じたら opener にフォーカスを戻す。
 * @param {T} t
 * @param {{keysOn: boolean, onToggleKeys: (on: boolean) => void, opener: HTMLElement|null}} o
 */
export function openHelp(t, o) {
  const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('help'));
  if (!dlg) return;
  // keys の中の '–' は範囲の印 (1–6)。それ以外は 1 つずつ kbd にする
  const row = (/** @type {Array<string>} */ keys, /** @type {string} */ label) =>
    h('li', {}, h('span', { class: 'help__keys' }, ...keys.flatMap((k, i) => [i && k !== '–' && keys[i - 1] !== '–' ? ' ' : '', k === '–' ? '–' : kbd(k)])), h('span', { text: label }));
  const off = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'keys-off', checked: !o.keysOn }));
  off.addEventListener('change', () => o.onToggleKeys(!off.checked));
  const close = h('button', { class: 'btn btn--line', type: 'button', text: t('help.close') });
  close.addEventListener('click', () => dlg.close());
  const days = RECENT_MS / DAY;
  const title = h('h2', { class: 'help__title', id: 'help-title', tabindex: '-1', text: t('help.title') });
  fill(
    dlg,
    title,
    h(
      'ul',
      { class: 'help__list' },
      row(['j', 'k'], t('help.k.move')),
      row(['Enter', 'o'], t('help.k.open')),
      row(['Space'], t('help.k.peek')),
      row(['x'], t('help.k.pick')),
      row(['a'], t('help.k.all')),
      row(['c'], t('help.k.copy')),
      row(['/'], t('help.k.filter')),
      row(['1', '–', '6'], t('help.k.jump')),
      row(['z'], t('help.k.overview')),
      row(['?'], t('help.k.help')),
      row(['Esc'], t('help.k.esc')),
    ),
    h('h3', { class: 'help__sub', text: t('intro.title') }),
    h(
      'ol',
      { class: 'legend' },
      ...PILES.map((p) => h('li', {}, h('b', { text: bucketTitle(t, p) }), h('span', { text: t(`intro.${p}`, { min: QUIET_MS / MIN, days }) }))),
    ),
    h('h3', { class: 'help__sub', text: t('help.marks') }),
    h(
      'p',
      { class: 'ov-legend' },
      ...['needs_you', 'trouble', 'unread', 'working', 'recent'].map((p) => h('span', {}, h('i', { class: `mark mark--${p}`, 'aria-hidden': 'true' }), bucketTitle(t, p))),
      h('span', { text: t('overview.key.cleanup') }),
    ),
    h('p', { class: 'help__off' }, h('label', { class: 'check', for: 'keys-off' }, off, h('span', { text: t('help.off') })), h('span', { class: 'help__note', text: t('help.offNote') })),
    h('p', { class: 'help__acts' }, close),
  );
  dlg.setAttribute('aria-labelledby', 'help-title');
  dlg.onclose = () => o.opener?.focus();
  if (!dlg.open) dlg.showModal();
  // 一番上から見せる: 題名にフォーカスし (Tab で切替・閉じるへ進む)、showModal が最初の部品へ動かした分のスクロールを戻す
  title.focus({ preventScroll: true });
  dlg.scrollTop = 0;
}
