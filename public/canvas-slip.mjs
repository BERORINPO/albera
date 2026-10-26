// @ts-check
// 画面: キャンバスの付箋 (spec/ui.md §10.3) 1 枚の DOM と、その署名 canvasSig (純粋)。
// 縮尺 (遠く・中くらい・近く) で見せる行は CSS が切り替える (縮尺を変えても作り直さない)。だから近くの行も中くらいの行も両方作る。
// 付箋は大きなクリックの的にしない (design.md §11): 題名 = カーソルと帯の詳しく、「開く ↗」= リンク、「引き継ぐ」= 帯の引き継ぎ。

import { compactedRecent, askText, bucketTitle, contextMeta, prLabel, reasonLine, shortDoing, titleOf, waitWordsKey } from './format.mjs';
import { handoffPlan, handoffRowEl } from './handoff.mjs';
import { asOfNode, contextNodes, doingNodes, langOf, openEl, timeEl } from './labels.mjs';
import { eventSummaryEl } from './events.mjs';
import { h, partsToNodes } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */
/** @typedef {{pile: string, faded: boolean, next: boolean, new: boolean, handoff: string, cs: boolean, demo: boolean}} SlipFlags */

/**
 * 付箋の署名 (純粋)。言語・カード・欄と印 (次の 1 件・新着・引き継ぎのコピー済みの状態・要約済みを出す間) だけ。
 * 時刻・カーソル・絞り込み・位置は入れない (それらは作り直さずに合わせる)。
 * @param {string} lang @param {Card} card @param {Partial<SlipFlags>} flags
 */
export function canvasSig(lang, card, flags) {
  const f = [flags.pile ?? '', flags.faded ? 'f' : '', flags.next ? 'n' : '', flags.new ? 'new' : '', flags.handoff ?? '', flags.cs ? 'cs' : '', flags.demo ? 'd' : ''];
  return `${lang}|${JSON.stringify(card)}|${f.join(',')}`;
}

/**
 * 付箋の印と見分けの元 (純粋)。
 * @param {Card} card @param {{pile: string, faded?: boolean}} slip
 * @param {{nextId: string|null, now: number, handoff?: Record<string, any>, demo: boolean, isNew: (pile: string, id: string) => boolean}} o
 * @returns {SlipFlags}
 */
export function slipFlags(card, slip, o) {
  return {
    pile: slip.pile,
    faded: !!slip.faded,
    next: o.nextId === card.id,
    new: !slip.faded && o.isNew(slip.pile, card.id),
    handoff: handoffPlan(card, o.handoff?.[card.id], o.now).row ?? '',
    cs: compactedRecent(card.context, o.now),
    demo: !!o.demo,
  };
}

/**
 * コンテキストの言葉のうち、毎分変わらないもの (読み上げの名前に入れる)。引き継げない欄の言葉 (終わってから・先に答えて) も。
 * @param {T} t @param {Card} card
 */
const ctxWords = (t, card) => {
  const words = contextMeta(t, card.context, Number.NaN)
    .filter((m) => !m.ago)
    .map((m) => m.text);
  const wait = waitWordsKey(card);
  return wait ? [...words, t(wait)] : words;
};

/**
 * 題名ボタンの中身。名前は中身から作る: 見えるのは題名 (中身の言語の lang 付き) だけで、欄の名前・区切り・コンテキストの言葉は
 * 画面の言語の見えない文字 (ボタンに lang を付けて画面の言葉まで題名の言語にしない、WCAG 3.1.2)。時刻は名前に入れず、
 * aria-describedby の時刻のセル (毎分書き直す) で伝える (フォーカスの上で名前が毎分変わらないように)。
 * @param {T} t @param {{pile: string, title: string, ctx: string}} d @param {string|null} lang
 */
function titleNodes(t, d, lang) {
  const titleEl = h('span', { class: 'slip__t', lang, text: d.title });
  /** @type {Node[]} */
  const out = [];
  let hidden = '';
  const flush = () => {
    if (hidden) out.push(h('span', { class: 'vh', text: hidden }));
    hidden = '';
  };
  for (const p of t.parts('canvas.slipName', { pile: d.pile, title: titleEl })) {
    if (p !== titleEl) hidden += String(p);
    else {
      flush();
      out.push(titleEl);
    }
  }
  if (d.ctx) hidden += `${t('sep.list')}${d.ctx}`;
  flush();
  return out;
}

/**
 * 付箋の足のコンテキストの言葉: 言葉・目盛り・割合 (と due / soon の言葉)。中くらいでは CSS が目盛りと割合だけにする
 * (付箋の幅に収める。凡例が目盛りの意味を言い、題名の名前には言葉ごと入っている)。段階なしの割合は近くだけ (is-low)。
 * 割合の前の言葉は辞書の ctx.meta / ctx.metaEst の {pct} より前 (最後の空白より前が言葉、後ろの「~」「約」は割合の側)。
 * @param {T} t @param {any} ctx @param {number} now
 */
function ctxNodes(t, ctx, now) {
  const nodes = contextNodes(t, ctx, now, { always: true });
  const first = nodes[0];
  if (!first || first.dataset.agoKey) return nodes;
  if (!ctx.level) first.classList.add('is-low');
  const mark = {};
  const parts = t.parts(ctx.inferred ? 'ctx.metaEst' : 'ctx.meta', { pct: mark });
  const i = parts.indexOf(mark);
  const before = parts.slice(0, Math.max(0, i)).join('');
  const cut = before.trimEnd().lastIndexOf(' ');
  const word = cut < 0 ? before.trim() : before.slice(0, cut);
  const num = `${before.slice(word.length).trimStart()}${ctx.pct}${parts.slice(i + 1).join('')}`;
  const tick = h('span', { class: 'cvtick', 'aria-hidden': 'true' });
  tick.style.setProperty('--p', String(Math.max(0, Math.min(100, Number(ctx.pct) || 0))));
  const lv = ctx.level === 'due' || ctx.level === 'soon' ? t(`ctx.${ctx.level}`) : '';
  first.replaceChildren(
    ...(word ? [h('span', { class: 'ctx__w', text: word }), ' '] : []),
    h('span', { class: 'ctx__m' }, tick, num),
    ...(lv ? [' ', h('span', { class: 'ctx__lv', text: lv })] : []),
  );
  return nodes;
}

/**
 * 付箋の中の「開く ↗」と「引き継ぐ」は tab で止めない (用紙の付箋の群れは tab 1 回。開くのは Enter、引き継ぐのは h)。
 * @param {HTMLElement|null} el
 */
const offTab = (el) => {
  if (el?.matches('a, button')) el.tabIndex = -1;
  return el;
};

/** @param {string} cls @param {...any} kids */
const line = (cls, ...kids) => h('p', { class: `slip__line ${cls}` }, ...kids);

/**
 * 近くの「どこで」: ブランチ・worktree・最初の開いている PR (repo がプロジェクトと同じなら repo を付けない)、それと親の題名
 * (親子の関係は言葉で言う。付箋の間に線は引かない: 罫線の上の線は切れ端に見えた)。
 * @param {T} t @param {Card} card
 */
function whereLine(t, card) {
  const d = card.detail ?? {};
  const pr = (card.prs ?? []).find((/** @type {any} */ p) => p.state === 'OPEN');
  const repo = String(pr?.repo ?? '');
  const short = repo.slice(repo.lastIndexOf('/') + 1);
  const f = card.family;
  const pname = f?.parentTitle == null ? t('family.parentMissing') : f.parentTitle || t('untitled');
  const parent = f?.parentId ? partsToNodes(t.parts('family.parent', { name: h('bdi', { lang: langOf(t, pname), text: pname }) })) : null;
  const kids = [
    card.source ? h('span', { class: 'is-ink', text: t(`source.${card.source}`) }) : null,
    eventSummaryEl(t, card),
    d.branch ? h('code', { text: d.branch }) : null,
    d.worktreeName ? h('span', { text: d.worktreeName }) : null,
    pr ? h('span', { text: prLabel(t, pr, !!short && short !== card.project?.label) }) : null,
    parent ? h('span', { class: 'slip__parent' }, ...parent) : null,
  ].filter(Boolean);
  return kids.length ? line('slip__where', ...kids) : null;
}

/** 近くの「何を」(長い形)。 @param {T} t @param {Card} card @param {string} pile @param {boolean} faded @param {number} now */
function longDoing(t, card, pile, faded, now) {
  const cls = 'slip__doing slip__doing--long';
  if (faded) return line(`${cls} is-quiet`, t('canvas.faded'));
  const quote = (/** @type {string} */ text) => h('q', { lang: langOf(t, text) ?? t.lang, text });
  switch (pile) {
    case 'needs_you':
      return card.body ? line(cls, quote(card.body)) : askText(t, card) ? line(cls, askText(t, card)) : null;
    case 'trouble': {
      const r = reasonLine(t, card);
      const asOf = card.activity ? asOfNode(t, card.activity, now) : null;
      return r || asOf ? line(cls, r ? h('span', { lang: langOf(t, r), text: r }) : null, r && asOf ? ' ' : null, asOf) : null;
    }
    case 'unread':
      return card.body ? line(cls, quote(card.body)) : null;
    case 'working': {
      if (card.activity) return line(`${cls} doing`, ...doingNodes(t, card.activity));
      const s = shortDoing(t, card);
      return s ? line(cls, s) : null;
    }
    default:
      return card.body ? line(`${cls} is-one is-quiet`, h('span', { lang: langOf(t, card.body), text: card.body })) : null;
  }
}

/**
 * 付箋 1 枚 (li.slip)。位置 (--x / --y)・カーソル・薄くするかは syncSlip が合わせる。
 * @param {T} t @param {Card} card @param {{pile: string, faded?: boolean}} slip
 * @param {{nextId: string|null, now: number, handoff?: Record<string, any>, demo: boolean, isNew: (pile: string, id: string) => boolean, takeArrival: (pile: string, id: string) => boolean}} o
 */
export function slipEl(t, card, slip, o) {
  const faded = !!slip.faded;
  const pile = faded ? 'cleanup' : slip.pile;
  const title = titleOf(t, card.title);
  const label = { pile: faded ? t('canvas.faded') : bucketTitle(t, pile), title, ctx: faded ? '' : ctxWords(t, card).join(t('sep.list')) };
  const next = o.nextId === card.id && !faded;
  const arrive = !faded && o.takeArrival(pile, card.id);
  const short = shortDoing(t, card);
  const ctx = !faded && card.context ? ctxNodes(t, card.context, o.now) : [];
  // 引き継げない欄 (作業中・返事待ち・止まったかもの上限) では、ボタンの代わりに理由の言葉 (終わってから・先に答えて) を出す
  const ho = faded ? null : handoffRowEl(t, card, o.handoff?.[card.id], o.now);
  const timeId = `st-${card.id}`;
  return h(
    'li',
    { class: `slip slip--${pile}${faded ? ' is-faded' : ''}${next ? ' is-next' : ''}${arrive ? ' is-new' : ''}`, 'data-id': card.id, 'data-pile': pile },
    h('span', { class: 'slip__mark', 'aria-hidden': 'true' }, h('i', { class: `mark mark--${faded ? 'faded' : pile}` })),
    h(
      'button',
      { class: 'slip__title', type: 'button', 'data-action': 'slip', 'data-id': card.id, tabindex: '-1', 'aria-describedby': `${timeId} slip-keys` },
      ...titleNodes(t, label, langOf(t, card.title)),
    ),
    whereLine(t, card),
    longDoing(t, card, pile, faded, o.now),
    short ? line('slip__doing slip__doing--short', h('span', { lang: langOf(t, short), text: short })) : null,
    line('slip__foot', h('span', { class: 'slip__time', id: timeId }, timeEl(t, card, o.now)), ...ctx),
    line('slip__acts', ...[openEl(t, card, 'slip__open', o.demo), ho].map(offTab)),
  );
}
