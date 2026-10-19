// @ts-check
// 画面: キャンバスの用紙の部品 (spec/ui.md §10.3、design.md §12)。柱 (見出し)・列の罫線・帯 (「最近 N」「片付け N」の 1 行)・
// 片付けだけのプロジェクトのまとめ。どれも DOM を作るだけで、合わせるのは canvas.mjs の syncSheet (400 行の上限のため分けた)。

import { CANVAS } from '../src/shared/constants.mjs';
import { bucketTitle, isOtherProject, projectLabel } from './format.mjs';
import { FOLD_KEY } from './canvas-layout.mjs';
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {import('./canvas-layout.mjs').SheetLayout} SheetLayout */

const { SLIP_W, FOLD_ROW, FOOT_H } = CANVAS;
const PILES = Object.freeze(['needs_you', 'trouble', 'unread', 'working', 'recent', 'cleanup']);
/** 柱に数を出す欄 (最近と片付けは用紙の下の帯が言う: 同じ数を 2 回出さない) */
const HEAD_PILES = Object.freeze(['needs_you', 'trouble', 'unread', 'working']);
const ACT = new Set(['needs_you', 'trouble', 'unread']);

/** world の単位の CSS 変数を合わせる (変わったときだけ書く)。 @param {HTMLElement|SVGElement} el @param {Record<string, number>} vars */
export function setVars(el, vars) {
  for (const [k, v] of Object.entries(vars)) {
    const s = String(Math.round(v * 100) / 100);
    if (el.style.getPropertyValue(k) !== s) el.style.setProperty(k, s);
  }
}

/**
 * 柱 (用紙の上の見出し): 名前と、返事待ち・止まったかも・未読・作業中の数 (0 は出さない)。遠くでは名前と「要対応 N」の 1 行
 * (N = 返事待ち・止まったかも・未読。0 なら数を出さない: 作業中・最近・片付けは見るものではない)。
 * 名前 (読み上げ) には全部の欄の数。ドラッグの取っ手と用紙の tab の止まる所を兼ねる。
 * @param {T} t @param {SheetLayout} s
 */
export function headEl(t, s) {
  const name = projectLabel(t, s.project);
  const n = (/** @type {string} */ p) => Number(/** @type {any} */ (s.counts)[p]) || 0;
  const part = (/** @type {string} */ p) => t('canvas.part', { pile: bucketTitle(t, p), n: n(p) });
  const due = [...ACT].reduce((k, p) => k + n(p), 0);
  return h(
    'h2',
    { class: 'sheet__h' },
    h(
      'button',
      { class: 'sheet__head', type: 'button', 'data-key': s.key, 'aria-label': t('canvas.headAria', { project: name, list: PILES.filter((p) => n(p) > 0).map(part).join(t('sep.list')) }), 'aria-describedby': 'head-keys' },
      h('span', { class: `sheet__name${isOtherProject(s.project) ? ' is-other' : ''}`, text: name }),
      h('span', { class: 'sheet__counts', 'aria-hidden': 'true' }, ...HEAD_PILES.filter((p) => n(p) > 0).map((p) => h('span', { class: ACT.has(p) ? 'is-act' : null, text: part(p) }))),
      due ? h('span', { class: 'sheet__far', 'aria-hidden': 'true', text: t('canvas.farCount', { n: due }) }) : null,
    ),
  );
}

/** 列の罫線 (付箋の部分の高さいっぱい)。 @param {SheetLayout} s */
export function colRules(s) {
  return Array.from({ length: Math.max(0, s.cols - 1) }, (_, i) => {
    const el = h('span', { class: 'sheet__col', 'aria-hidden': 'true' });
    setVars(el, { '--x': (i + 1) * SLIP_W, '--h': s.liveH });
    return el;
  });
}

/**
 * 帯: 「最近 N」と「片付け N」の 1 行 (押すと一覧のその欄へ。付箋にしていない最近と片付けは、ここの数に入っている)。
 * 数は柱の名前の数と同じセッションの数 (定期実行の回と、付箋にした最近・faded も数える: 同じ欄の名前の下に違う数を出さない)。
 * @param {T} t @param {SheetLayout} s
 */
export function backEl(t, s) {
  const { recent, cleanup } = s.counts;
  if (!(recent + cleanup)) return null;
  const btn = (/** @type {string} */ pile, /** @type {number} */ n) =>
    h('button', { class: 'textbtn sheet__backhead', type: 'button', 'data-action': 'canvas-back', 'data-pile': pile }, bucketTitle(t, pile), ' ', h('span', { class: 'num', text: String(n) }));
  const band = h('div', { class: `sheet__back${s.liveH ? '' : ' is-alone'}` }, recent ? btn('recent', recent) : null, cleanup ? btn('cleanup', cleanup) : null);
  setVars(band, { '--y': s.back.y, '--h': s.h - s.back.y - FOOT_H });
  return band;
}

/**
 * 片付けだけのプロジェクトのまとめ (最後の用紙の下)。見出しは 1 つのボタン (一覧の片付けを開く)、中身は 1 行ずつ「名前 件数」の文字。
 * 見出しの数は空白で離す (「·」でつながない、design.md §9 の 6)。
 * @param {T} t @param {import('./canvas-layout.mjs').Fold} f
 */
export function foldEl(t, f) {
  const total = f.items.reduce((n, it) => n + it.n, 0);
  const list = h(
    'ul',
    { class: 'fold__list' },
    ...f.items.map((it) => h('li', { class: 'fold__row' }, h('span', { class: 'fold__pname', text: projectLabel(t, it.project) }), h('span', { class: 'fold__n num', text: String(it.n) }))),
  );
  setVars(list, { '--rh': FOLD_ROW });
  const head = h(
    'h2',
    { class: 'fold__h' },
    h(
      'button',
      { class: 'fold__head', type: 'button', 'data-action': 'canvas-back', 'data-pile': 'cleanup' },
      h('span', { class: 'fold__title', text: t('canvas.fold') }),
      h('span', { class: 'vh', text: t('sep.list') }),
      h('span', { class: 'fold__sum' }, h('span', { text: t('canvas.foldCount', { n: f.items.length }) }), h('span', { class: 'vh', text: t('sep.list') }), h('span', { text: t('canvas.part', { pile: bucketTitle(t, 'cleanup'), n: total }) })),
      h('span', { class: 'vh', text: `${t('sep.list')}${t('canvas.foldOpen')}` }),
    ),
  );
  // 見出しの --x / --y はまとめの位置から継がない (貼り付けのずれの量に使う、用紙の見出しと同じ)
  setVars(head, { '--x': 0, '--y': 0 });
  return h('section', { class: 'fold', 'data-key': FOLD_KEY }, head, list);
}
