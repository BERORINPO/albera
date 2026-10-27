// @ts-check
// 画面: 文言と時間の整形 (純粋関数。DOM・storage・時計は触らない。node:test からも読める)。
// 言葉を返す関数は全部 t を最初に受け取る (public/i18n.mjs の makeT)。Intl の出力は使わない。

import { COMPACT_SHOW_MS, DAY, DEEP_LINK_PREFIX, IDLE_SAFE_MS, QUIET_HINT_MS, QUIET_MS, RECENT_MS, SESSION_ID_RE } from '../src/shared/constants.mjs';
import { agoWords, doingText } from './doing.mjs';
import { durationText } from './times.mjs';

// 時間と日付の言葉は times.mjs、していることの言葉は doing.mjs にある (ここから今までどおり使える)
export { absoluteTime, agoText, cardTime, createdText, dateline, dayKey, durationText, hm, timeText } from './times.mjs';
export { agoWords, asOfText, doingMainSpec, doingOnePart, doingOneText, doingSpec, doingText, shortDoing } from './doing.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */

/**
 * 先頭の案内 (lede) の 2 行目。文なので長い単位。
 * @param {T} t
 * @param {string} pile needs_you | trouble | unread
 * @param {Card} card
 * @param {number} now
 */
export function ledeTimeLine(t, pile, card, now) {
  const d = now - (Number(card.since) || 0);
  const dur = durationText(t, d, 'long');
  const ago = t('time.agoPhrase', { dur });
  if (pile === 'needs_you') return dur ? t('lede.waiting', { dur }) : t('lede.waiting_now');
  if (pile === 'trouble') {
    if (!dur) return t('lede.stopped_now');
    return card.timeKind === 'stalled' ? t('lede.stalled', { dur }) : t('lede.stopped', { ago });
  }
  return dur ? t('lede.ended', { ago }) : t('lede.ended_now');
}

/** 欄の名前。 @param {T} t @param {string} key */
export const bucketTitle = (t, key) => t(`bucket.${key}.title`);

/** 片付けの理由グループの名前。 @param {T} t @param {string} reason */
export function cleanupGroupName(t, reason) {
  const days = reason === 'idle_30d' ? IDLE_SAFE_MS / DAY : RECENT_MS / DAY;
  return t(`cleanup.${reason}`, { days, from: RECENT_MS / DAY, to: IDLE_SAFE_MS / DAY });
}

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * 使用上限の「resets 1:50pm」から 24 時間制の HH:mm を取り出す。分か am/pm が無いものは読まない。
 * @param {unknown} reset
 * @returns {string|null}
 */
export function parseResetTime(reset) {
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(String(reset ?? ''));
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3] ? m[3][0].toLowerCase() : '';
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** @param {Array<{repo?: string}>|undefined} prs */
export const spansRepos = (prs) => new Set((prs ?? []).map((p) => p.repo)).size > 1;

/** PR の状態の言葉。知らない状態はそのまま。 @param {T} t @param {unknown} state */
export function prStateWord(t, state) {
  const key = `pr.state.${state}`;
  return t.has(key) ? t(key) : String(state ?? '');
}

/**
 * PR の短い表記。2 つ以上の repo にまたがるときだけ repo 名 (最後の / の後ろ) を付ける。
 * @param {T} t
 * @param {{num: number, repo?: string, state?: string}} pr
 * @param {boolean} multiRepo
 */
export function prLabel(t, pr, multiRepo) {
  const repo = String(pr.repo ?? '');
  const short = repo.slice(repo.lastIndexOf('/') + 1) || repo;
  const state = prStateWord(t, pr.state);
  if (multiRepo && short) return t('pr.labelRepo', { repo: short, num: pr.num, state }).trim();
  return t('pr.labelState', { num: pr.num, state }).trim();
}

/**
 * 理由の文 (reason + reasonParams から作る唯一の場所)。理由の文が無いものは ''。
 * @param {T} t
 * @param {Card} card
 */
export function reasonLine(t, card) {
  const p = card.reasonParams ?? {};
  switch (card.reason) {
    case 'stalled':
      return t(p.via === 'prompt' ? 'reason.stalled_prompt' : 'reason.stalled_tool');
    case 'git_startup':
    case 'not_started':
    case 'retried':
      return t(`reason.${card.reason}`);
    case 'limit': {
      const time = parseResetTime(p.reset);
      if (time) return t('reason.limit_resetAt', { time });
      return p.reset ? t('reason.limit_reset', { reset: p.reset }) : t('reason.limit');
    }
    case 'error':
      return t('reason.error', { error: p.error ?? '' });
    case 'routine_old': {
      const older = Number(p.older ?? card.routine?.runIds?.length ?? 1);
      const total = Number(p.total ?? older);
      let s = older === total ? t('reason.routine_all', { n: total }) : t('reason.routine_some', { n: older, total });
      if (p.latestBucket) s += t('sep.sentence') + t('reason.routine_elsewhere', { bucket: bucketTitle(t, p.latestBucket) });
      return s;
    }
    case 'pr_done': {
      const prs = Array.isArray(p.prs) ? p.prs : [];
      const multi = spansRepos(prs);
      const list = prs.map((pr) => prLabel(t, pr, multi)).join(t('sep.list'));
      return Number(p.more) > 0 ? t('reason.pr_done_more', { list, n: p.more }) : list;
    }
    case 'old_error':
      return p.error ? t('reason.old_error', { error: p.error }) : '';
    case 'old_question':
      return p.question ? t('reason.old_question', { question: p.question }) : '';
    default:
      return '';
  }
}

/** 質問文の無い返事待ちに出す言葉 (ask.question / ask.plan)。 @param {T} t @param {Card} card */
export function askText(t, card) {
  const ask = card.reasonParams?.ask;
  return ask === 'plan' || ask === 'question' ? t(`ask.${ask}`) : '';
}

/** プロジェクトの表示名。label が null なら「フォルダなし」。 @param {T} t @param {{label?: string|null, extra?: number}|undefined} project */
export function projectLabel(t, project) {
  const base = project?.label ?? t('project.other');
  const extra = Number(project?.extra) || 0;
  return extra > 0 ? `${base} ${t('project.extra', { n: extra })}` : base;
}

/** @param {{label?: string|null}|undefined} project */
export const isOtherProject = (project) => project?.label == null;

/**
 * 中身の言語。仮名か漢字があれば ja、それ以外は en。
 * @param {unknown} text
 * @returns {'en'|'ja'}
 */
export function contentLang(text) {
  return /[぀-ヿ㐀-鿿]/.test(String(text ?? '')) ? 'ja' : 'en';
}

/**
 * 絞り込みの一致判定 (大文字小文字を区別しない部分一致)。今の言語の言葉で探す: 題名・プロジェクト・本文・理由の文・
 * していること (手順と Claude の説明を含む)・コンテキストの言葉 (「引き継ぎどき」と、引き継げない欄の言葉)。
 * @param {Card} card
 * @param {string} q 小文字にした検索語 (空なら常に一致)
 * @param {T} t
 * @param {number} [now] 渡せば「要約済み」の言葉でも探す
 */
export function matches(card, q, t, now = Number.NaN) {
  if (!q) return true;
  const wait = waitWordsKey(card);
  const words = contextMeta(t, card.context, now).map((m) => m.text);
  const hay = [card.title, projectLabel(t, card.project), card.body, reasonLine(t, card), doingText(t, card.activity), ...words, wait ? t(wait) : ''];
  return hay.some((s) => String(s ?? '').toLowerCase().includes(q));
}

/**
 * Claude に貼る片付けの指示文。3 行の頼み方 + 1 行に 1 つの ID (title は入れない)。
 * @param {T} t
 * @param {string[]} ids
 */
export function archiveInstruction(t, ids) {
  return [t('archive.line1', { n: ids.length }), t('archive.line2'), t('archive.line3'), ...ids].join('\n');
}

/**
 * 「子 N 件 (返事待ち a、…)」。0 件の項目は省く。
 * @param {T} t
 * @param {{total: number, working?: number, needs_you?: number, trouble?: number, unread?: number}} ch
 */
export function childrenText(t, ch) {
  const parts = ['needs_you', 'trouble', 'unread', 'working']
    .filter((k) => Number(/** @type {any} */ (ch)[k]) > 0)
    .map((k) => t(`family.part.${k}`, { n: /** @type {any} */ (ch)[k] }));
  if (!parts.length) return t('family.children', { n: ch.total });
  return t('family.childrenWith', { n: ch.total, list: parts.join(t('sep.list')) });
}

/**
 * 定期実行の履歴の一言。過去の回 (最新回を除く) の状態が分からなければ ''。
 * @param {T} t
 * @param {{runs: number, completed: number, stalled: number}} r
 */
export function routineHistory(t, r) {
  const past = Number(r.runs) - 1;
  if (past <= 0 || Number(r.completed) + Number(r.stalled) === 0) return '';
  return t('routine.history', { n: past, done: r.completed, stalled: r.stalled });
}

/** 途中で止まりやすい定期実行の一言 (2 回以上止まったとき)。 @param {T} t @param {{runs: number, stalled: number}} r */
export function routineFlaky(t, r) {
  return Number(r.stalled) >= 2 ? t('routine.flaky', { s: r.stalled, n: Number(r.runs) - 1 }) : '';
}

/**
 * 作業中の行で長く静かなときの一言。QUIET_HINT_MS 以下なら ''。
 * @param {T} t
 * @param {number} since
 * @param {number} now
 */
export function quietHint(t, since, now) {
  const d = now - since;
  if (!(d > QUIET_HINT_MS)) return '';
  return t('row.quietHint', { dur: durationText(t, d, 'short'), pile: bucketTitle(t, 'trouble'), limit: durationText(t, QUIET_MS, 'short') });
}

/**
 * タブの題名。返事待ち > 止まったかも の件数。オフラインなら印を足す。
 * @param {T} t
 * @param {{needs_you?: number, trouble?: number}|null|undefined} counts
 * @param {boolean} [offline]
 */
export function tabTitle(t, counts, offline = false) {
  const name = t('app.name');
  let title = name;
  for (const pile of ['needs_you', 'trouble']) {
    const n = Number(/** @type {any} */ (counts ?? {})[pile]) || 0;
    if (n > 0) {
      title = t('app.tabTitle', { n, pile: bucketTitle(t, pile), name });
      break;
    }
  }
  return offline ? t('app.tabOffline', { title }) : title;
}

/** Claude アプリで開くリンク。ID の形が違えば null。 @param {string} id */
export function deepLink(id) {
  const value = String(id);
  // The deep-link scheme belongs to Claude Code app sessions only. Other
  // providers must not be routed to Claude or implicitly resumed from here.
  return /^local_[0-9a-f-]{36}$/i.test(value) && SESSION_ID_RE.test(value) ? DEEP_LINK_PREFIX + value : null;
}

/** 無題なら (無題)。 @param {T} t @param {unknown} title */
export const titleOf = (t, title) => (String(title ?? '').trim() === '' ? t('untitled') : String(title));

/** 文をつなぐ (英語は空白、日本語は「。」の後に空白を入れない)。空の文は省く。 @param {T} t @param {...string} parts */
export const sentences = (t, ...parts) => parts.filter(Boolean).join(t.lang === 'ja' ? '' : ' ');

// ---------- v0.2: していること・コンテキストの言葉 (spec/ui.md §8.4・§8.5・§10.3) ----------

/**
 * トークン数の短い表記 (自前のテンプレート、Intl なし): 999 → 999、150000 → 150K、999600 → 1M、1200000 → 1.2M。
 * @param {number} n
 */
export function tokensText(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  const k = Math.round(v / 1000);
  return k < 1000 ? `${k}K` : `${Math.round(v / 1e5) / 10}M`;
}

/** 要約が COMPACT_SHOW_MS 以内か (行に「要約済み」を出す間)。 @param {any} ctx @param {number} now */
export const compactedRecent = (ctx, now) => Number.isFinite(Number(ctx?.compacted?.at)) && now - Number(ctx.compacted.at) < COMPACT_SHOW_MS;

/**
 * 行のコンテキストの言葉 (純粋)。0〜2 項目 {text, strong}: notice は控えめ、due / soon は太字の 1 項目、
 * 段階なしは無し (always なら控えめ)、1 時間以内の要約は「要約済み」(ago: 毎分書き直す印)。
 * @param {T} t @param {any} ctx @param {number} now @param {{always?: boolean}} [o]
 * @returns {Array<{text: string, strong: boolean, ago?: {key: string, at: number, until: number}}>}
 */
export function contextMeta(t, ctx, now, { always = false } = {}) {
  if (!ctx || !Number.isFinite(Number(ctx.pct))) return [];
  const out = [];
  const meta = t(ctx.inferred ? 'ctx.metaEst' : 'ctx.meta', { pct: ctx.pct });
  if (ctx.level === 'due' || ctx.level === 'soon') out.push({ text: `${meta} ${t(`ctx.${ctx.level}`)}`, strong: true });
  else if (ctx.level === 'notice' || always) out.push({ text: meta, strong: false });
  if (compactedRecent(ctx, now)) {
    const at = Number(ctx.compacted.at);
    out.push({ text: agoWords(t, 'ctx.compacted', at, now), strong: false, ago: { key: 'ctx.compacted', at, until: at + COMPACT_SHOW_MS } });
  }
  return out;
}

/**
 * 詳しくのコンテキストの値: 割合・使用量・窓・自動要約の点、推定ならその一言、要約されていれば「要約済み」(いつでも)。
 * @param {T} t @param {any} ctx @param {number} now
 * @param {{compacted?: boolean}} [o] compacted: false なら要約の言葉を付けない (DOM が別の項目にして毎分書き直す)
 */
export function contextValueText(t, ctx, now, o = {}) {
  if (!ctx) return '';
  const value = t('detail.contextValue', { pct: ctx.pct, used: tokensText(ctx.used), window: tokensText(ctx.window), at: tokensText(ctx.compactAt) });
  const at = Number(ctx.compacted?.at);
  const done = o.compacted !== false && Number.isFinite(at) ? agoWords(t, 'ctx.compacted', at, now) : '';
  return sentences(t, value, ctx.inferred ? t('detail.contextEst') : '', done);
}

/**
 * 引き継ぎのボタンを出さない欄の言葉のキー (段階が due / soon のときだけ): 作業中 → 終わってから、返事待ち → 先に答える、
 * 使用上限で止まった → 上限が戻ってから。それ以外は null。
 * @param {Card|null|undefined} card
 */
export function waitWordsKey(card) {
  const lv = card?.context?.level;
  if (!card || (lv !== 'due' && lv !== 'soon')) return null;
  if (card.bucket === 'working') return 'ctx.afterWork';
  if (card.bucket === 'needs_you') return 'ctx.answerFirst';
  return card.bucket === 'trouble' && card.reason === 'limit' ? 'ctx.afterLimit' : null;
}
