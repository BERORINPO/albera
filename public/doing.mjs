// @ts-check
// 画面: していることの言葉 (spec/ui.md §8.4・§10.3、純粋関数。DOM・storage・時計は触らない)。種類のコードと短い安全な対象から、
// 辞書の doing.* / wait.* / short.* の言葉を作る。format.mjs が全部を再び export する (400 行の上限のため分けた)。

import { MIN } from '../src/shared/constants.mjs';
import { durationText } from './times.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */

/** target が無いときの言葉 (種類 → doing.<これ>)。web だけは target があると doing.webHost。 @type {Readonly<Record<string, string>>} */
const DOING_BARE = Object.freeze({ edit: 'edit_bare', write: 'edit_bare', read: 'read_bare', run: 'run_bare', test: 'test_bare', git: 'git_bare', connector: 'connector_bare', web: 'web' });
/** target を取らない種類。知らない種類はどれも doing.tool。 */
const DOING_PLAIN = new Set(['search', 'browser', 'plan', 'wrap_up', 'think']);
/** Claude の説明 (note) を言葉にする種類 (Bash / PowerShell の行)。 */
const NOTE_KINDS = new Set(['run', 'test', 'git']);

/**
 * していることの種類の言葉のキーと差し込み (純粋)。
 * @param {{kind?: string, target?: string, n?: number}|null|undefined} a
 * @returns {{key: string, params: {target?: string, n?: number}}}
 */
export function doingSpec(a) {
  const kind = String(a?.kind ?? '');
  const target = typeof a?.target === 'string' ? a.target : '';
  if (kind === 'agents') return Number(a?.n) >= 1 ? { key: 'doing.agents', params: { n: Number(a?.n) } } : { key: 'doing.agents_bare', params: {} };
  if (Object.hasOwn(DOING_BARE, kind)) {
    if (!target) return { key: `doing.${DOING_BARE[kind]}`, params: {} };
    return { key: kind === 'web' ? 'doing.webHost' : `doing.${kind}`, params: { target } };
  }
  return { key: DOING_PLAIN.has(kind) ? `doing.${kind}` : 'doing.tool', params: {} };
}

/**
 * していることの行の主の部分: 実行・テスト・Git で Claude の説明があればそれ (doing.note)、無ければ種類の言葉。
 * @param {{kind?: string, target?: string, n?: number, note?: string}|null|undefined} a
 * @returns {{key: string, params: {target?: string, n?: number, note?: string}}}
 */
export function doingMainSpec(a) {
  if (a && NOTE_KINDS.has(String(a.kind)) && typeof a.note === 'string' && a.note) return { key: 'doing.note', params: { note: a.note } };
  return doingSpec(a);
}

/** していることの行を 1 つの文字列で (手順、空白、主の部分)。title・aria-label・絞り込み・読み上げ用。 @param {T} t @param {any} a */
export function doingText(t, a) {
  if (!a) return '';
  const main = doingMainSpec(a);
  const text = t(main.key, main.params);
  return typeof a.step === 'string' && a.step ? `${t('doing.step', { step: a.step })} ${text}` : text;
}

/**
 * 1 行に出すとき (一覧の作業中の行・中くらいの付箋) はどちらか片方 (純粋)。主の部分が具体的 (Claude の説明・対象・サブエージェントの数) なら
 * 主の部分、そうでなく手順があれば手順。両方は詳しくと近くの付箋 (2 行) に出す。
 * @param {any} a
 * @returns {'main'|'step'}
 */
export function doingOnePart(a) {
  const main = doingMainSpec(a);
  const specific = main.key === 'doing.note' || main.key === 'doing.agents' || (typeof a?.target === 'string' && a.target !== '');
  return !specific && typeof a?.step === 'string' && a.step ? 'step' : 'main';
}

/** doingOnePart の片方を文字列で。 @param {T} t @param {any} a */
export function doingOneText(t, a) {
  if (!a) return '';
  if (doingOnePart(a) === 'step') return t('doing.step', { step: a.step });
  const main = doingMainSpec(a);
  return t(main.key, main.params);
}

/**
 * 毎分書き直す「N 前」つきの言葉。doing.asOf は長い単位、ctx.compacted と ctx.copied は行の短い単位。
 * 1 分未満は 1 分と言う (秒は数えない: 秒を見せるのは古い内容の知らせだけ)。
 * @param {T} t @param {string} key @param {number} at @param {number} now @param {string} [doing]
 */
export function agoWords(t, key, at, now, doing = '') {
  const dur = durationText(t, Math.max(MIN, now - at), key === 'doing.asOf' ? 'long' : 'short');
  return t(key, { ago: t('time.agoPhrase', { dur }), doing });
}

/** 止まったかもの「N 前の時点: …」。時刻が無ければ ''。 @param {T} t @param {any} a @param {number} now */
export function asOfText(t, a, now) {
  const at = Number(a?.at);
  if (!a || !Number.isFinite(at) || at <= 0) return '';
  const main = doingMainSpec(a);
  return agoWords(t, 'doing.asOf', at, now, t(main.key, main.params));
}

/**
 * キャンバスの中くらいの縮尺で 1 行に出す短い言葉 (純粋)。止まったかもと作業中だけ: 返事待ちと未読は印と時刻の言葉
 * (「2 時間待ち」「25 分前に終了」) が同じことを言うので ''。最近と片付けも ''。
 * @param {T} t @param {Card} card
 */
export function shortDoing(t, card) {
  const p = card.reasonParams ?? {};
  switch (card.bucket) {
    case 'trouble':
      if (card.reason === 'stalled') return t(p.via === 'prompt' ? 'short.stalled_prompt' : 'short.stalled_tool');
      return ['limit', 'git_startup', 'not_started', 'error'].includes(card.reason) ? t(`short.${card.reason}`) : '';
    case 'working':
      if (card.activity) return doingOneText(t, card.activity);
      return card.reason === 'background' || card.reason === 'starting' ? t(`reason.${card.reason}`) : '';
    default:
      return '';
  }
}
