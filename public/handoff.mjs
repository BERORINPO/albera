// @ts-check
// 画面: 引き継ぎ (spec/ui.md §9.1–§9.4)。前半は純粋関数 (コピーする指示文・誰にどの案内を出すか・コピー済みの状態・引き継ぎどきの並び)、
// 後半は案内の DOM (一覧の「詳しく」とキャンバスの帯が同じものを使う)。ボードは送らない・押さない: 指示文をコピーしてセッションを開くだけ。

import { HANDOFF } from '../src/shared/constants.mjs';
import { copyButton, copyText, swapLabel } from './copy.mjs';
import { agoWords, contentLang, titleOf, waitWordsKey } from './format.mjs';
import { h, partsToNodes } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */
/** @typedef {{at: number, pct: number}} Stored コピーした時刻 (サーバー時計) とそのときの割合 */
/** @typedef {{guide: 'handoff'|'rescue'|null, row: 'button'|'copied'|null, why: string|null}} Plan */

const HANDOFF_LINES = 7;
const RESCUE_LINES = 3;
const DUE_LEVELS = new Set(['due', 'soon']);
const DUE_PILES = Object.freeze(['needs_you', 'trouble', 'unread', 'working']);

/** 引き継ぎの指示文 (handoff.l0 … l6 を改行でつなぐ。差し込みは {pct} だけ)。 @param {T} t @param {{pct: number}} o */
export const handoffText = (t, { pct }) => Array.from({ length: HANDOFF_LINES }, (_, i) => t(`handoff.l${i}`, { pct })).join('\n');

/** 答えられないほど埋まったセッションの救出の指示文 (差し込みは {id} だけ。ID を含む唯一の指示文)。 @param {T} t @param {{id: string}} o */
export const rescueText = (t, { id }) => Array.from({ length: RESCUE_LINES }, (_, i) => t(`handoff.rescue.l${i}`, { id })).join('\n');

/** @param {Card} card */
const isDue = (card) => DUE_LEVELS.has(card?.context?.level);

/**
 * 引き継ぎのボタンをもう一度出すか (純粋)。コピーしていない、24 時間たった、割合が 5 ポイント上がった、そのあと要約された → 出す。
 * @param {Card} card @param {Stored|undefined|null} stored @param {number} now
 */
export function handoffArmed(card, stored, now) {
  if (!stored) return true;
  if (now - stored.at >= HANDOFF.COPIED_MS) return true;
  const ctx = card?.context;
  if (Number(ctx?.pct) >= stored.pct + HANDOFF.REARM_PCT) return true;
  return Number(ctx?.compacted?.at) > stored.at;
}

/**
 * 誰にどの案内を出すか (純粋、spec/ui.md §9.1 の表)。why は案内が無いときの理由の辞書のキー (h キーとキャンバスの帯)。
 * @param {Card} card @param {Stored|undefined|null} stored @param {number} now
 * @returns {Plan}
 */
export function handoffPlan(card, stored, now) {
  /** @param {Plan['guide']} guide @param {Plan['row']} row @param {string|null} why @returns {Plan} */
  const plan = (guide, row, why) => ({ guide, row, why: guide ? null : why });
  switch (card?.bucket) {
    case 'needs_you':
      return plan(null, null, 'ctx.answerFirst');
    case 'working':
      return plan(null, null, 'ctx.afterWork');
    case 'trouble': {
      const rescue = card.context?.level === 'soon' || Number(card.detail?.contextExceeded) > 0;
      return plan(rescue ? 'rescue' : null, null, card.reason === 'limit' ? 'ctx.afterLimit' : 'handoff.whyStuck');
    }
    case 'unread':
    case 'recent': {
      if (!card.context) return plan(null, null, 'handoff.whyUnknown');
      const active = now - Number(card.lastActivityAt) < HANDOFF.ROW_MS;
      return plan('handoff', isDue(card) && active ? (handoffArmed(card, stored, now) ? 'button' : 'copied') : null, null);
    }
    default:
      return plan(null, null, 'handoff.whyUnknown');
  }
}

/** 引き継ぎどきを数える欄のカード (片付け以外)。 @param {any} board @returns {Card[]} */
const liveCards = (board) => [...DUE_PILES.flatMap((p) => board?.buckets?.[p] ?? []), ...(board?.recentGroups ?? []).flatMap((/** @type {any} */ g) => g.items ?? [])];

/**
 * 「引き継ぎどき N 件」が順に回る ID: due / soon で、いま引き継げる (案内のある) カード。未読・最近と、救出の案内のある止まったかも。
 * 作業中・返事待ち・上限で止まったものは、終わる・答える・戻るまで引き継げないので数えない (数えると押しても引き継げない件数を約束する)。
 * 割合の高い順、同じなら ID 順。
 * @param {any} board
 * @returns {string[]}
 */
export function dueIds(board) {
  /** @type {Map<string, number>} */
  const pct = new Map();
  for (const c of liveCards(board)) if (isDue(c) && !pct.has(c.id) && handoffPlan(c, null, 0).guide) pct.set(c.id, Number(c.context.pct) || 0);
  return [...pct.keys()].sort((a, b) => /** @type {number} */ (pct.get(b)) - /** @type {number} */ (pct.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * コピーの記録のうち、そのあと要約された (今の盤面で compacted.at が記録より後、または割合が REARM_PCT 以上下がった) ものを落とした表。
 * 要約の印は会話ログの末尾にある間しか見えず、もう一度 due になるころには末尾の外へ流れている。見えたときに記録を消して
 * 「出し直し」を覚えておく (spec/ui.md §9.2)。何も落とさなければ同じ表を返す (入力は書き換えない)。
 * @param {Record<string, Stored>} map prefs.handoff @param {any} board
 * @returns {Record<string, Stored>}
 */
export function latchHandoffs(map, board) {
  const ids = Object.keys(map ?? {});
  if (!ids.length || !board) return map;
  const ctxOf = new Map(liveCards(board).map((c) => [c.id, c.context]));
  const drop = ids.filter((id) => {
    const ctx = ctxOf.get(id);
    const s = map[id];
    return !!ctx && (Number(ctx.compacted?.at) > s.at || Number(ctx.pct) <= s.pct - HANDOFF.REARM_PCT);
  });
  if (!drop.length) return map;
  return Object.fromEntries(Object.entries(map).filter(([id]) => !drop.includes(id)));
}

/**
 * 古いコピーの記録 (24 時間より前) と形の壊れた記録を落とした新しい表。
 * @param {unknown} map prefs.handoff
 * @param {number} now
 * @returns {Record<string, Stored>}
 */
export function pruneHandoffs(map, now) {
  /** @type {Record<string, Stored>} */
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [id, v] of Object.entries(map)) {
    const at = Number(v?.at);
    const pct = Number(v?.pct);
    if (Number.isFinite(at) && Number.isFinite(pct) && now - at < HANDOFF.COPIED_MS) out[id] = { at, pct };
  }
  return out;
}

// ---------- DOM ----------

/**
 * 行と付箋の引き継ぎの部品: 「引き継ぐ」のボタン、コピー済みの言葉、または引き継げない欄の言葉 (words: false なら出さない)。
 * @param {T} t @param {Card} card @param {Stored|undefined|null} stored @param {number} now @param {{words?: boolean}} [o]
 * @returns {HTMLElement|null}
 */
export function handoffRowEl(t, card, stored, now, o = {}) {
  const row = handoffPlan(card, stored, now).row;
  if (row === 'button') {
    // 名前は見えている言葉から始め、どのセッションかを足す (行の「開く: 題名」と同じ形。並んだボタンを読み上げで見分けられるように)
    return h('button', { class: 'textbtn is-strong', type: 'button', 'data-action': 'handoff-open', 'data-id': card.id, 'aria-label': t('handoff.openAria', { title: titleOf(t, card.title) }), text: t('handoff.open') });
  }
  if (row === 'copied' && stored) {
    return h('span', { class: 'ctx', 'data-ago-key': 'ctx.copied', 'data-ago-at': stored.at, 'data-ago-until': stored.at + HANDOFF.COPIED_MS, text: agoWords(t, 'ctx.copied', stored.at, now) });
  }
  const wait = o.words === false ? null : waitWordsKey(card);
  return wait ? h('span', { class: 'ctx', text: t(wait) }) : null;
}

/** 「コピーする指示文」を開いているカード (案内を作り直しても、開いたまま。一覧の詳しくとキャンバスの帯で同じ)。 */
const openTexts = new Set();

/**
 * 止まったかもが、ツールの途中で (許可の確認待ちかもしれずに) 止まっていて、上限超えの記録が無いか。救出の案内の前に
 * 「確かめても止まったままなら」と書く (理由の行の「許可の確認待ちかもしれません」と食い違わないように)。
 * @param {Card} card
 */
const mayBeWaiting = (card) => card.reason === 'stalled' && card.reasonParams?.via !== 'prompt' && !(Number(card.detail?.contextExceeded) > 0);

/**
 * 引き継ぎの案内 (kind 'handoff') または救出の案内 (kind 'rescue')。一覧の「詳しく」とキャンバスの帯 (inBar) が使う。
 * 救出は、見出し → ボタン → 貼る先の文の順 (「そこに貼って」の前にコピーのボタンがある)。
 * @param {T} t @param {Card} card @param {{kind: 'handoff'|'rescue', inBar: boolean, demo: boolean}} o
 */
export function handoffGuideEl(t, card, o) {
  const rescue = o.kind === 'rescue';
  const title = titleOf(t, card.title);
  const lang = contentLang(title);
  const name = h('span', { lang: lang === t.lang ? null : lang, text: title });
  const pct = Number(card.context?.pct) || 0;
  const leadId = `${o.inBar ? 'hb' : 'hl'}-${card.id}`;
  const acts = rescue
    ? [copyButton(t, { action: 'handoff-rescue', id: card.id, key: 'handoff.rescueBtn', cls: 'btn btn--ink' })]
    : [copyButton(t, { action: 'handoff-copy-open', id: card.id, key: 'handoff.copyOpen', cls: 'btn btn--ink' }), copyButton(t, { action: 'handoff-copy', id: card.id, key: 'handoff.copyOnly', cls: 'btn btn--line' })];
  if (o.inBar) acts.push(h('button', { class: 'textbtn', type: 'button', 'data-action': 'handoff-close', 'data-id': card.id, text: t('handoff.close') }));
  const textKey = `${o.kind}:${card.id}`;
  const text = h('details', { class: 'handoff__text', open: openTexts.has(textKey) }, h('summary', { text: t('handoff.text') }), h('pre', { text: rescue ? rescueText(t, { id: card.id }) : handoffText(t, { pct }) }));
  text.addEventListener('toggle', () => (/** @type {HTMLDetailsElement} */ (text).open ? openTexts.add(textKey) : openTexts.delete(textKey)));
  const leadKey = rescue ? (mayBeWaiting(card) ? 'handoff.rescueLeadCheck' : 'handoff.rescueLead') : 'handoff.lead';
  return h(
    'section',
    { class: 'handoff', 'aria-labelledby': leadId },
    h('h3', { class: 'handoff__lead', id: leadId }, ...partsToNodes(t.parts(leadKey, { title: name, pct }))),
    rescue ? null : h('p', { class: 'handoff__why', text: t('handoff.why') }),
    rescue ? null : h('ol', { class: 'steps handoff__steps' }, ...[1, 2, 3].map((i) => h('li', {}, h('span', { class: 'steps__n', text: String(i) }), t(`handoff.step${i}`)))),
    h('p', { class: 'handoff__acts' }, ...acts),
    rescue ? h('p', { class: 'handoff__why', text: t('handoff.rescuePaste') }) : null,
    o.demo && !rescue ? h('p', { class: 'handoff__demo', text: t('open.demoTitle') }) : null,
    text,
  );
}

/**
 * 案内のボタンを押したとき: まずコピーし (ページにフォーカスがある間に)、確かにコピーできたときだけ、文字を「コピーした ✓」にし、
 * 読み上げ、コピーの記録を残し (救出は残さない)、copy-open ならセッションを開く (デモは ID が無いので開かない)。
 * @param {{t: T, card: Card, mode: 'copy-open'|'copy'|'rescue', button: HTMLElement|null, opener: HTMLElement|null,
 *   store: (id: string, rec: Stored) => void, open: (id: string) => unknown, announce: (text: string) => void, now: number, demo: boolean}} o
 * @returns {Promise<boolean>} コピーできたか
 */
export async function runHandoffCopy(o) {
  const { t, card } = o;
  const rescue = o.mode === 'rescue';
  const pct = Number(card.context?.pct) || 0;
  if (!(await copyText(t, rescue ? rescueText(t, { id: card.id }) : handoffText(t, { pct }), o.opener))) return false;
  const key = rescue ? 'handoff.rescueBtn' : o.mode === 'copy' ? 'handoff.copyOnly' : 'handoff.copyOpen';
  if (o.button) swapLabel(o.button, t('detail.copied'), t(key));
  o.announce(rescue ? t('handoff.rescuePaste') : t('handoff.copied', { title: titleOf(t, card.title) }));
  if (!rescue) o.store(card.id, { at: o.now, pct });
  if (o.mode === 'copy-open' && !o.demo) o.open(card.id);
  return true;
}
