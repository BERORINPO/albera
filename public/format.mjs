// @ts-check
// 画面: 文言と時間の整形 (純粋関数。DOM・storage・時計は触らない。node:test からも読める)。
// 言葉を返す関数は全部 t を最初に受け取る (public/i18n.mjs の makeT)。Intl の出力は使わない。

import { DAY, DEEP_LINK_PREFIX, HOUR, IDLE_SAFE_MS, MIN, QUIET_HINT_MS, QUIET_MS, RECENT_MS, SEC, SESSION_ID_RE } from '../src/shared/constants.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * 経過時間を分・時間・日に切り捨てて言葉にする。1 分未満は '' (呼び出し側が _now の形を使う)。
 * @param {T} t
 * @param {number} ms
 * @param {'short'|'long'} [style] 行のセルは short、文は long
 */
export function durationText(t, ms, style = 'short') {
  const d = Math.max(0, Number(ms) || 0);
  if (d < MIN) return '';
  const set = style === 'long' ? 'unit' : 'short';
  if (d < HOUR) return t(`time.${set}.minute`, { n: Math.floor(d / MIN) });
  if (d < DAY) return t(`time.${set}.hour`, { n: Math.floor(d / HOUR) });
  return t(`time.${set}.day`, { n: Math.floor(d / DAY) });
}

/**
 * 「N 前」。1 分未満は秒で数える (古い内容の知らせだけが秒を見せる)。
 * @param {T} t
 * @param {number} ms
 */
export function agoText(t, ms) {
  const d = Math.max(0, Number(ms) || 0);
  const dur = d < MIN ? t('time.short.second', { n: Math.floor(d / SEC) }) : durationText(t, d, 'short');
  return t('time.agoPhrase', { dur });
}

/**
 * 時刻のセルの文言 (状態の言葉つき)。知らない kind は time.ago。
 * @param {T} t
 * @param {string} kind waiting | stopped | stalled | ended | updated | running | latest | moved | ago
 * @param {number} since
 * @param {number} now
 * @param {'short'|'long'} [style]
 */
export function timeText(t, kind, since, now, style = 'short') {
  const k = t.has(`time.${kind}`) ? kind : 'ago';
  const d = now - since;
  if (!(d >= MIN)) return t(`time.${k}_now`);
  const dur = durationText(t, d, style);
  return t(`time.${k}`, { dur, ago: t('time.agoPhrase', { dur }) });
}

/**
 * 行の時刻セルに使う種類と起点。作業中で startedAt があれば「N 分経過」。
 * @param {Card} card
 * @returns {{kind: string, since: number}}
 */
export function cardTime(card) {
  if (card.bucket === 'working' && Number.isFinite(card.startedAt)) return { kind: 'running', since: card.startedAt };
  return { kind: String(card.timeKind ?? 'ago'), since: Number(card.since) || 0 };
}

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
 * 絞り込みの一致判定 (大文字小文字を区別しない部分一致)。今の言語の言葉で探す。
 * @param {Card} card
 * @param {string} q 小文字にした検索語 (空なら常に一致)
 * @param {T} t
 */
export function matches(card, q, t) {
  if (!q) return true;
  const hay = [card.title, projectLabel(t, card.project), card.body, reasonLine(t, card)];
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

/** ローカル時刻の HH:mm。 @param {number} ms */
export function hm(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ローカルの日付のキー YYYY-MM-DD (今日の件数などに使う)。 @param {number} ms */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 見出しの日付「Sun 18 Oct, as of 14:52」。 @param {T} t @param {number} ms */
export function dateline(t, ms) {
  const d = new Date(ms);
  return t('date.asOf', { wd: t(`date.wd.${d.getDay()}`), d: d.getDate(), mon: t(`date.mon.${d.getMonth()}`), hm: hm(ms) });
}

/** 絶対時刻 (ローカル) YYYY-MM-DD HH:mm。 @param {number|null|undefined} ms */
export function absoluteTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return `${dayKey(ms)} ${hm(ms)}`;
}

/** 作成日時: 今日なら「今日 HH:mm」、それ以外は絶対時刻。 @param {T} t @param {number|null|undefined} ms @param {number} now */
export function createdText(t, ms, now) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return dayKey(ms) === dayKey(now) ? t('date.today', { hm: hm(ms) }) : absoluteTime(ms);
}

/** Claude アプリで開くリンク。ID の形が違えば null。 @param {string} id */
export function deepLink(id) {
  return SESSION_ID_RE.test(String(id)) ? DEEP_LINK_PREFIX + id : null;
}

/** 無題なら (無題)。 @param {T} t @param {unknown} title */
export const titleOf = (t, title) => (String(title ?? '').trim() === '' ? t('untitled') : String(title));

/** 文をつなぐ (英語は空白、日本語は「。」の後に空白を入れない)。空の文は省く。 @param {T} t @param {...string} parts */
export const sentences = (t, ...parts) => parts.filter(Boolean).join(t.lang === 'ja' ? '' : ' ');
