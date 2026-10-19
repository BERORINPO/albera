// @ts-check
// core: コンテキストの量・窓・段階 (spec/board.md §5.2、純粋関数)。
// 量 = 最後の実際の API 呼び出しの input + cache_creation + cache_read。窓は tail の証拠 → 同じ model の観測 → 系列の表 の順に決め、
// 段階は自動要約点に対する割合 (帯つき)。前回の段階 (prev) は entry が持ち、ここは引数で受けるだけ (状態を持たない)。

import { CONTEXT, ONE_M_MODEL_RE } from '../shared/constants.mjs';

/** @typedef {import('../shared/types.mjs').ContextFacts} ContextFacts */
/** @typedef {import('../shared/types.mjs').Context} Context */
/** @typedef {import('../shared/types.mjs').ContextLevel} ContextLevel */
/** @typedef {import('../shared/types.mjs').PrevContext} PrevContext */
/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */
/** @typedef {import('../shared/types.mjs').Board} Board */
/** @typedef {import('../shared/types.mjs').Card} Card */

const SYNTHETIC_MODEL = '<synthetic>';
const ONE_M_SUFFIX_RE = /\[1m\]\s*$/i;

/** 0 以上の有限の数か。 @param {unknown} v @returns {v is number} */
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** 数でないもの・負の数は 0。 @param {unknown} v */
const count = (v) => (isCount(v) ? v : 0);

/** 行の timestamp (ms)。有限の数でなければ undefined。 @param {any} entry */
function timeOf(entry) {
  const at = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/**
 * usage の量: input + cache_creation + cache_read (output_tokens と iterations は足さない)。
 * @param {unknown} usage
 */
export function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const u = /** @type {Record<string, unknown>} */ (usage);
  return count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens);
}

/** 本筋の (sidechain でも合成でもない) assistant 行か。 @param {any} e */
const isMainAssistant = (e) => e?.type === 'assistant' && e.isSidechain !== true && !!e.message && e.message.model !== SYNTHETIC_MODEL;

/**
 * コンテキストの材料 (前から順に見る。now を使わない)。i は entries の中の位置 (「要約の直後」は位置で比べる)。
 * @param {any[]} entries turnEntries の結果
 * @returns {ContextFacts}
 */
export function contextFacts(entries) {
  /** @type {ContextFacts['lastUsage']} */
  let lastUsage;
  /** @type {ContextFacts['lastBoundary']} */
  let lastBoundary;
  /** @type {number|undefined} */
  let autoPre;
  let hasAssistant = false;
  /** @type {number[]} */
  const values = [];
  /** @type {Map<string, number>} message.id → values の位置 (同じ id の行は最後のものが勝つ) */
  const slotOf = new Map();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e?.isSidechain === true) continue;
    if (e?.type === 'system') {
      if (e.subtype !== 'compact_boundary') continue;
      const meta = e.compactMetadata && typeof e.compactMetadata === 'object' ? e.compactMetadata : {};
      const at = timeOf(e);
      lastBoundary = {
        i,
        ...(at !== undefined ? { at } : {}),
        trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
        ...(isCount(meta.preTokens) ? { pre: meta.preTokens } : {}),
        ...(isCount(meta.postTokens) ? { post: meta.postTokens } : {}),
      };
      if (meta.trigger === 'auto' && isCount(meta.preTokens)) autoPre = meta.preTokens;
      continue;
    }
    if (!isMainAssistant(e)) continue;
    hasAssistant = true;
    const n = usageTokens(e.message.usage);
    if (n <= 0) continue;
    const id = typeof e.message.id === 'string' && e.message.id !== '' ? e.message.id : null;
    const slot = id ? slotOf.get(id) : undefined;
    if (slot !== undefined) values[slot] = n;
    else {
      if (id) slotOf.set(id, values.length);
      values.push(n);
    }
    const at = timeOf(e);
    lastUsage = { i, n, ...(at !== undefined ? { at } : {}) };
  }
  const maxUsed = values.reduce((m, v) => (v > m ? v : m), 0);
  return {
    ...(lastUsage ? { lastUsage } : {}),
    maxUsed,
    ...(autoPre !== undefined ? { autoPre } : {}),
    ...(lastBoundary ? { lastBoundary } : {}),
    hasAssistant,
  };
}

/**
 * 実際の usage 行 (量 > 0) が 1 つでもあるか (adapter の 2 MB 読み直しの判定)。
 * @param {any[]} entries turnEntries の結果
 */
export function hasUsage(entries) {
  return entries.some((e) => isMainAssistant(e) && usageTokens(e.message.usage) > 0);
}

/** 自動要約の直後 (最後の usage より後に要約の区切りがある) か。 @param {ContextFacts} f */
const justCompacted = (f) => !!f.lastBoundary && (!f.lastUsage || f.lastBoundary.i > f.lastUsage.i);

/**
 * 使える量が出たか (stats.contextSeen): usage 行がある、または要約の直後で post が数。
 * @param {ContextFacts} f
 */
export const contextUsable = (f) => !!f.lastUsage || (justCompacted(f) && isCount(f.lastBoundary?.post));

/**
 * model から [1m] を除いて小文字にしたもの (系列の表と観測の表のキー)。
 * @param {unknown} model
 */
export function modelBase(model) {
  if (typeof model !== 'string') return '';
  return model.trim().replace(ONE_M_SUFFIX_RE, '').trim().toLowerCase();
}

/** @param {unknown} model */
const hasOneMSuffix = (model) => typeof model === 'string' && ONE_M_SUFFIX_RE.test(model.trim());

/**
 * 盤面ごとに 1 回: model (modelBase) ごとに、tail で見た一番大きい量。
 * [1m] 付きのセッションは入れない (1M を選んだ回の量で、同じ model の 200K の回を 1M と推定しないため)。
 * @param {Array<{model?: string, facts: ContextFacts}>} items
 * @returns {Map<string, number>}
 */
export function learnWindows(items) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const { model, facts } of items) {
    const base = modelBase(model);
    if (base === '' || hasOneMSuffix(model) || !facts) continue;
    out.set(base, Math.max(out.get(base) ?? 0, count(facts.maxUsed)));
  }
  return out;
}

/**
 * 窓の大きさ (spec/board.md §5.2、上から最初に当たったもの)。
 * 1. [1m] 付き → 1M / 2. tail で 200K では起きない量 (maxUsed > PROOF_USED か autoPre > PROOF_PRE) → 1M /
 * 3. 自動要約が PROOF_PRE 以下で起きた → 200K / 4. 同じ model の別のセッションが PROOF_USED を超えた → 1M (推定) /
 * 5. 1M が標準の系列 (ONE_M_MODEL_RE) → 1M (推定) / 6. それ以外 → 200K (推定)。
 * @param {unknown} model
 * @param {ContextFacts} facts
 * @param {Map<string, number>} learned
 * @returns {{window: 200000|1000000, inferred: boolean}}
 */
export function windowFor(model, facts, learned) {
  const LARGE = /** @type {1000000} */ (CONTEXT.WINDOW_LARGE);
  const BASE = /** @type {200000} */ (CONTEXT.WINDOW_BASE);
  if (hasOneMSuffix(model)) return { window: LARGE, inferred: false };
  const autoPre = isCount(facts.autoPre) ? facts.autoPre : undefined;
  if (count(facts.maxUsed) > CONTEXT.PROOF_USED || (autoPre !== undefined && autoPre > CONTEXT.PROOF_PRE)) return { window: LARGE, inferred: false };
  if (autoPre !== undefined) return { window: BASE, inferred: false };
  const base = modelBase(model);
  if (base !== '' && (learned.get(base) ?? 0) > CONTEXT.PROOF_USED) return { window: LARGE, inferred: true };
  if (base !== '' && ONE_M_MODEL_RE.test(base)) return { window: LARGE, inferred: true };
  return { window: BASE, inferred: true };
}

/**
 * 自動要約が起きると見込む量。tail の自動要約 (LEARN_MIN ≤ autoPre ≤ window) があればその量、無ければ窓ごとの既定。
 * @param {number} window
 * @param {ContextFacts} facts
 */
export function compactAtFor(window, facts) {
  const pre = facts.autoPre;
  if (isCount(pre) && pre >= CONTEXT.LEARN_MIN && pre <= window) return pre;
  return window === CONTEXT.WINDOW_LARGE ? CONTEXT.COMPACT_AT_LARGE : CONTEXT.COMPACT_AT_BASE;
}

const LEVEL_KEYS = CONTEXT.LEVELS.map((l) => /** @type {ContextLevel} */ (l.key));

/**
 * 段階 (帯つき)。上がるとき: enter ≤ f の一番高い段階にすぐ上がる。下がるとき: prevLevel 以下の段階のうち
 * f ≥ enter − BAND を満たす一番高いものにとどまる。結果は 2 つの高い方。
 * @param {number} f 量 ÷ 自動要約点
 * @param {ContextLevel=} prevLevel
 * @returns {ContextLevel|undefined}
 */
export function contextLevel(f, prevLevel) {
  if (!Number.isFinite(f)) return undefined;
  let rise = -1;
  CONTEXT.LEVELS.forEach((l, i) => {
    if (f >= l.enter) rise = i;
  });
  let hold = -1;
  const prevIdx = prevLevel ? LEVEL_KEYS.indexOf(prevLevel) : -1;
  for (let i = prevIdx; i >= 0; i--) {
    if (f >= CONTEXT.LEVELS[i].enter - CONTEXT.BAND) {
      hold = i;
      break;
    }
  }
  const idx = Math.max(rise, hold);
  return idx >= 0 ? LEVEL_KEYS[idx] : undefined;
}

/**
 * カードに付ける Context (spec/board.md §5.2)。量が無ければ undefined。
 * 要約の直後は used = postTokens (数のときだけ)、段階なし。prev は次のどれかなら使わない (帯を持ち越さない):
 * 要約の直後、prev.cli !== rec.cliSessionId、used < prev.used × (1 − RESET_DROP)。
 * @param {ContextFacts|undefined} facts
 * @param {SessionRecord} rec
 * @param {Map<string, number>} learned
 * @param {PrevContext=} prev
 * @returns {Context|undefined}
 */
export function finishContext(facts, rec, learned, prev) {
  if (!facts) return undefined;
  const fresh = justCompacted(facts);
  const lb = facts.lastBoundary;
  /** @type {number|undefined} */
  let used;
  if (fresh) used = isCount(lb?.post) ? lb.post : undefined;
  else used = facts.lastUsage?.n;
  if (used === undefined) return undefined;
  const { window, inferred } = windowFor(rec.model, facts, learned);
  const compactAt = compactAtFor(window, facts);
  // used * 100 first: (58_000 / 200_000) * 100 is 28.999… in floating point and would floor to 28.
  const pct = Math.min(100, Math.floor((used * 100) / window));
  let level;
  if (!fresh) {
    const keep = !!prev && prev.cli === rec.cliSessionId && !(used < prev.used * (1 - CONTEXT.RESET_DROP));
    level = contextLevel(used / compactAt, keep ? prev?.level : undefined);
  }
  return {
    used,
    window,
    inferred,
    pct,
    compactAt,
    ...(level ? { level } : {}),
    ...(lb && lb.at !== undefined ? { compacted: { at: lb.at, trigger: lb.trigger } } : {}),
  };
}

/**
 * 盤面の中の、コンテキストを持ちうるカード (片付け以外)。
 * @param {Board} board
 * @returns {Card[]}
 */
function cardsWithContext(board) {
  const b = board.buckets;
  return [...b.needs_you, ...b.trouble, ...b.unread, ...b.working, ...board.recentGroups.flatMap((g) => g.items)];
}

/**
 * 次の盤面に渡す前回の段階 (entry がメモリに持つ)。context を持つカードだけ。
 * @param {Board} board
 * @param {SessionRecord[]} sessions
 * @returns {Map<string, PrevContext>}
 */
export function contextMemo(board, sessions) {
  const cliOf = new Map(sessions.map((s) => [s.sessionId, s.cliSessionId]));
  /** @type {Map<string, PrevContext>} */
  const out = new Map();
  for (const card of cardsWithContext(board)) {
    const ctx = card.context;
    const cli = cliOf.get(card.id);
    if (!ctx || !cli) continue;
    out.set(card.id, { cli, used: ctx.used, ...(ctx.level ? { level: ctx.level } : {}) });
  }
  return out;
}
