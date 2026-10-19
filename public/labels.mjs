// @ts-check
// 画面: 行・詳しく・キャンバスの付箋と帯が共有する小さな部品 (DOM)。時刻のセル・「開く ↗」・していることの行・
// コンテキストの言葉・詳しくの「していること / 手順 / コンテキスト」の行。言葉は format.mjs の純粋関数が作り、ここはノードにするだけ。
// 「N 前」を含む項目は data-ago-key / data-ago-at (/ data-ago-until) を持ち、毎分の renderTimes が書き直す。

import {
  agoWords, asOfText, cardTime, contentLang, contextMeta, contextValueText, deepLink, doingMainSpec, doingOnePart, doingSpec, timeText, titleOf, waitWordsKey,
} from './format.mjs';
import { h, partsToNodes } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */

/** 中身の言語が画面と違うときだけ lang を付ける。 @param {T} t @param {unknown} text */
export const langOf = (t, text) => {
  const l = contentLang(text);
  return l === t.lang ? null : l;
};

/** 時刻のセル。renderTimes が data-kind と data-since から書き直す。 @param {T} t @param {Card} card @param {number} now */
export function timeEl(t, card, now) {
  const { kind, since } = cardTime(card);
  const iso = Number.isFinite(since) && since > 0 ? new Date(since).toISOString() : null;
  return h('time', { datetime: iso, 'data-kind': kind, 'data-since': since, text: timeText(t, kind, since, now) });
}

/**
 * 「開く ↗」。ID の形が違えば開けないことを伝える (tab では止まる)。デモでは、開いてもアプリに本物が無いことを title で伝える。
 * @param {T} t @param {Card} card @param {string} [cls] @param {boolean} [demo]
 */
export function openEl(t, card, cls = 'row__open', demo = false) {
  const href = deepLink(card.id);
  const title = titleOf(t, card.title);
  if (!href) return h('a', { class: cls, role: 'link', tabindex: '0', 'aria-disabled': 'true', title: t('open.disabled'), text: t('open.row') });
  return h('a', { class: cls, href, 'data-action': 'open', 'data-id': card.id, 'aria-label': t('open.aria', { title }), title: t(demo ? 'open.demoTitle' : 'open.title'), text: t('open.row') });
}

/** Claude 自身の言葉 (手順・コマンドの説明)。訳さず、言語だけ付ける。双方向の文字の向きを外へ漏らさないよう bdi。 @param {T} t @param {string} text */
const content = (t, text) => h('bdi', { lang: langOf(t, text), text });

/** 種類の言葉。target (ファイル名・コマンドの頭・ホスト・コネクタ名) は code。 @param {T} t @param {{key: string, params: Record<string, any>}} spec */
function specNodes(t, spec) {
  const p = { ...spec.params };
  if (p.target) p.target = h('code', { dir: 'auto', text: p.target });
  return partsToNodes(t.parts(spec.key, p));
}

/** 「“説明”」。 @param {T} t @param {string} note */
const noteNodes = (t, note) => partsToNodes(t.parts('doing.note', { note: content(t, note) }));

/**
 * していることの行 (作業中の行の本文・キャンバスの付箋)。手順があれば先に、間は column-gap (「·」はつなぎに使わない)。
 * 間の空白は読み上げ用 (flex の中の空白だけの文字は描かれない)。one: 1 行に出す (一覧の行) ときは doingOnePart の片方だけ
 * (2 つを別々に切ると、どちらも半分の言葉になる)。
 * @param {T} t @param {any} a Card.activity @param {{one?: boolean}} [o]
 * @returns {Node[]}
 */
export function doingNodes(t, a, o = {}) {
  if (!a) return [];
  const main = doingMainSpec(a);
  const mainEl = h('span', { class: 'doing__main' }, ...(main.key === 'doing.note' ? noteNodes(t, a.note) : specNodes(t, main)));
  if (!(typeof a.step === 'string' && a.step)) return [mainEl];
  const stepEl = h('span', { class: 'doing__step' }, ...partsToNodes(t.parts('doing.step', { step: content(t, a.step) })));
  if (o.one) return [doingOnePart(a) === 'step' ? stepEl : mainEl];
  return [stepEl, document.createTextNode(' '), mainEl];
}

/** キャンバスの目盛り (aria-hidden、--p = 割合)。見た目は canvas.css。 @param {any} ctx */
function tickEl(ctx) {
  const el = h('span', { class: 'cvtick', 'aria-hidden': 'true' });
  el.style.setProperty('--p', String(Math.max(0, Math.min(100, Number(ctx.pct) || 0))));
  return el;
}

/**
 * コンテキストの言葉 (行の小さな項目・付箋の足)。due / soon は太字の 1 項目、要約済みは毎分書き直す。
 * @param {T} t @param {any} ctx Card.context @param {number} now
 * @param {{always?: boolean, tick?: boolean}} [o] always: 段階なしでも割合を出す (キャンバスの近く)。tick: キャンバスの目盛りを前に付ける
 * @returns {HTMLElement[]}
 */
export function contextNodes(t, ctx, now, o = {}) {
  return contextMeta(t, ctx, now, { always: !!o.always }).map((it, i) =>
    h(
      'span',
      { class: it.strong ? 'ctx is-strong' : 'ctx', 'data-ago-key': it.ago?.key, 'data-ago-at': it.ago?.at, 'data-ago-until': it.ago?.until },
      o.tick && i === 0 && !it.ago ? tickEl(ctx) : null,
      it.text,
    ),
  );
}

/** 止まったかもの「N 前の時点: …」(行の小さな項目)。時刻が無ければ null。 @param {T} t @param {any} a @param {number} now */
export function asOfNode(t, a, now) {
  const text = asOfText(t, a, now);
  if (!text) return null;
  const main = doingMainSpec(a);
  return h('span', { class: 'row__asof', 'data-ago-key': 'doing.asOf', 'data-ago-at': a.at, 'data-ago-doing': t(main.key, main.params), text });
}

/** 「要約済み」(詳しくの中ではいつでも出す)。 @param {T} t @param {any} ctx @param {number} now */
function compactedEl(t, ctx, now) {
  const at = Number(ctx?.compacted?.at);
  if (!Number.isFinite(at)) return null;
  return h('span', { class: 'ctx', 'data-ago-key': 'ctx.compacted', 'data-ago-at': at, text: agoWords(t, 'ctx.compacted', at, now) });
}

/** @param {string} label @param {Node|null} value */
const dlRow = (label, value) => (value ? [h('dt', { text: label }), h('dd', {}, value)] : []);

/**
 * 詳しくの 2〜4 行目: していること・手順・コンテキスト (spec/ui.md §9)。
 * 作業中は種類の言葉と Claude の説明、ほかの欄は「N 前の時点: …」(説明があれば種類の言葉と両方)。
 * @param {T} t @param {Card} card @param {string} pile @param {number} now
 * @returns {HTMLElement[]}
 */
export function activityRows(t, card, pile, now) {
  const a = card.activity;
  const c = card.context;
  let doing = null;
  if (a && pile === 'working') {
    doing = h('span', { class: 'words' }, h('span', {}, ...specNodes(t, doingSpec(a))), a.note ? [' ', h('span', {}, ...noteNodes(t, a.note))] : null);
  } else if (a && Number.isFinite(Number(a.at)) && Number(a.at) > 0) {
    const spec = doingSpec(a);
    const both = [t(spec.key, spec.params), a.note ? t('doing.note', { note: a.note }) : ''].filter(Boolean).join(' ');
    doing = h('span', { 'data-ago-key': 'doing.asOf', 'data-ago-at': a.at, 'data-ago-doing': both, text: agoWords(t, 'doing.asOf', Number(a.at), now, both) });
  }
  const step = a && typeof a.step === 'string' && a.step ? content(t, a.step) : null;
  const wait = waitWordsKey(card);
  const ctxValue = c
    ? h('span', { class: 'words' }, h('span', { text: contextValueText(t, c, now, { compacted: false }) }), ' ', compactedEl(t, c, now), ' ', wait ? h('span', { class: 'ctx', text: t(wait) }) : null)
    : null;
  return [...dlRow(t('detail.activity'), doing), ...dlRow(t('detail.step'), step), ...dlRow(t('detail.context'), ctxValue)];
}
