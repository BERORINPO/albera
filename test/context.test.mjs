import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compactAtFor,
  contextFacts,
  contextLevel,
  contextMemo,
  contextUsable,
  finishContext,
  hasUsage,
  learnWindows,
  modelBase,
  usageTokens,
  windowFor,
} from '../src/core/context.mjs';
import { turnEntries } from '../src/core/turn.mjs';
import { CONTEXT, ONE_M_MODEL_RE } from '../src/shared/constants.mjs';
import { MIN, NOW, assistantLine, cid, rec, sid, synth, synth2 } from './helpers/fixtures.mjs';

const join = (/** @type {string[]} */ ...lines) => lines.join('\n') + '\n';
/** @param {string[]} lines */
const cf = (...lines) => contextFacts(turnEntries(join(...lines), false));
const NONE = new Map();
/** @param {number} n @param {Record<string, unknown>} [f] */
const withModel = (n, f = {}) => ({ ...rec(n), ...f });

test('context: 量は input + cache_creation + cache_read (output と iterations は足さない、数でないものは 0)', () => {
  assert.equal(usageTokens({ input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 99999 }), 3210);
  assert.equal(usageTokens({ input_tokens: 10, cache_read_input_tokens: '5', iterations: [{ input_tokens: 500 }] }), 10);
  assert.equal(usageTokens({ input_tokens: -5, cache_creation_input_tokens: Number.NaN }), 0);
  assert.equal(usageTokens(null), 0);
  const f = cf(synth.prompt('go'), assistantLine([{ type: 'text', text: 'x' }], { usage: { input_tokens: 3, cache_creation_input_tokens: 40, cache_read_input_tokens: 500, output_tokens: 7000 } }));
  assert.equal(f.lastUsage?.n, 543);
  assert.equal(f.maxUsed, 543);
  assert.equal(f.hasAssistant, true);
});

test('context: 同じ message.id の行は最後のものが勝つ (lastUsage も maxUsed も)', () => {
  const f = cf(synth2.usage(90_000, { id: 'msg_a' }), synth2.usage(60_000, { id: 'msg_b' }), synth2.usage(50_000, { id: 'msg_b' }));
  assert.equal(f.lastUsage?.n, 50_000);
  assert.equal(f.maxUsed, 90_000);
  const same = cf(synth2.usage(120_000, { id: 'msg_a' }), synth2.usage(110_000, { id: 'msg_a' }));
  assert.equal(same.maxUsed, 110_000);
});

test('context: 合成 (<synthetic>) と sidechain の行を飛ばす。量 0 の行は lastUsage にしない', () => {
  const f = cf(
    synth2.usage(80_000, { id: 'msg_1' }),
    synth2.usage(500_000, { id: 'msg_2', sidechain: true }),
    assistantLine([{ type: 'text', text: 'API Error' }], { id: 'msg_3', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }),
    synth2.usage(0, { id: 'msg_4' }),
  );
  assert.equal(f.lastUsage?.n, 80_000);
  assert.equal(f.maxUsed, 80_000);
  const onlySynthetic = cf(synth.prompt('go'), assistantLine([{ type: 'text', text: 'x' }], { model: '<synthetic>' }));
  assert.equal(onlySynthetic.hasAssistant, false);
  assert.equal(onlySynthetic.lastUsage, undefined);
  // usage の無い本筋の assistant 行でも hasAssistant (usage のキーが変わったことを contextSuspect で気づくため)
  assert.equal(cf(synth.prompt('go'), synth.text('hi')).hasAssistant, true);
});

test('context: hasUsage は量 > 0 の本筋の usage 行が 1 つでもあるか', () => {
  const e = (/** @type {string[]} */ ...l) => turnEntries(join(...l), false);
  assert.equal(hasUsage(e(synth.prompt('go'), synth2.usage(10))), true);
  assert.equal(hasUsage(e(synth.prompt('go'), synth.text('hi'))), false);
  assert.equal(hasUsage(e(synth2.usage(10, { sidechain: true }), synth2.usage(10, { model: '<synthetic>' }))), false);
  assert.equal(hasUsage([]), false);
});

test('context: usage の後の要約の区切り → 要約の直後で used = post、段階なし、compacted を付ける', () => {
  const at = NOW - 5 * MIN;
  const f = cf(synth2.usage(190_000), synth2.compact({ trigger: 'auto', pre: 167_500, post: 21_000, at }));
  assert.equal(f.lastBoundary?.post, 21_000);
  assert.equal(f.autoPre, 167_500);
  assert.equal(contextUsable(f), true);
  const ctx = finishContext(f, withModel(1), NONE, { cli: cid(1), level: 'soon', used: 190_000 });
  assert.deepEqual(ctx, { used: 21_000, window: 200_000, inferred: false, pct: 10, compactAt: 167_500, compacted: { at, trigger: 'auto' } });
  // post が数でなければ context 無し (数の無い区切りで 0% と言わない)
  const noPost = cf(synth2.usage(190_000), synth.otherSystem());
  assert.equal(finishContext(noPost, withModel(1), NONE), undefined);
  assert.equal(contextUsable(noPost), true); // usage 行はあるので「形式が読めない」には数えない
  // 区切りの後に usage があれば普通に数える (compacted は一番新しい要約)
  const after = cf(synth2.compact({ trigger: 'manual', pre: 300_000, post: 30_000, at }), synth2.usage(60_000));
  const c2 = finishContext(after, withModel(1), NONE);
  assert.equal(c2?.used, 60_000);
  assert.deepEqual(c2?.compacted, { at, trigger: 'manual' });
  assert.equal(after.autoPre, undefined); // 手動の要約は自動要約点の学習に使わない
});

test('context: usage も区切りも無い → context 無し。区切りだけで post が数なら要約の直後', () => {
  assert.equal(finishContext(cf(synth.prompt('go'), synth.text('hi')), withModel(1), NONE), undefined);
  assert.equal(finishContext(undefined, withModel(1), NONE), undefined);
  const only = cf(synth2.compact({ post: 12_000 }));
  assert.equal(finishContext(only, withModel(1), NONE)?.used, 12_000);
  assert.equal(finishContext(only, withModel(1), NONE)?.compacted, undefined); // 時刻が無ければ compacted は付けない
});

test('context: pct は floor(used / window × 100)、100 で止める', () => {
  assert.equal(finishContext(cf(synth2.usage(1_999)), withModel(1), NONE)?.pct, 0);
  assert.equal(finishContext(cf(synth2.usage(163_999)), withModel(1), NONE)?.pct, 81);
  // 浮動小数点の誤差で 1 つ小さくならない (58,000 / 200,000 は 29%)
  assert.equal(finishContext(cf(synth2.usage(58_000)), withModel(1), NONE)?.pct, 29);
  const over = cf(synth2.usage(150_000), synth2.compact({ trigger: 'auto', pre: 160_000, post: 250_000 }));
  assert.equal(finishContext(over, withModel(1), NONE)?.pct, 100);
});

test('窓の規則 1〜6 を順に (最初に当たったもの)', () => {
  const plain = cf(synth2.usage(50_000));
  const learnedBig = new Map([['claude-test-1', 400_000]]);
  // 1. [1m] 付き → 1M、推定でない (tail の証拠より先)
  assert.deepEqual(windowFor('claude-test-1[1m]', cf(synth2.compact({ trigger: 'auto', pre: 160_000, post: 1 })), NONE), { window: 1_000_000, inferred: false });
  // 2. maxUsed > PROOF_USED か autoPre > PROOF_PRE → 1M、推定でない
  assert.deepEqual(windowFor('claude-test-1', cf(synth2.usage(250_000)), NONE), { window: 1_000_000, inferred: false });
  assert.deepEqual(windowFor('claude-test-1', cf(synth2.compact({ trigger: 'auto', pre: 960_000, post: 1 })), NONE), { window: 1_000_000, inferred: false });
  // 3. autoPre ≤ PROOF_PRE → 200K、推定でない (学習した表や系列より先)
  assert.deepEqual(windowFor('claude-opus-4-7', cf(synth2.compact({ trigger: 'auto', pre: 167_000, post: 1 })), learnedBig), { window: 200_000, inferred: false });
  // 4. 同じ model の別のセッションが PROOF_USED を超えた → 1M、推定
  assert.deepEqual(windowFor('Claude-Test-1', plain, learnedBig), { window: 1_000_000, inferred: true });
  assert.deepEqual(windowFor('claude-test-1', plain, new Map([['claude-test-1', 200_000]])), { window: 200_000, inferred: true }); // ちょうどは超えていない
  // 5. 1M が標準の系列 → 1M、推定
  assert.deepEqual(windowFor('claude-sonnet-5', plain, NONE), { window: 1_000_000, inferred: true });
  // 6. それ以外 → 200K、推定
  assert.deepEqual(windowFor('claude-sonnet-4-5', plain, NONE), { window: 200_000, inferred: true });
  assert.deepEqual(windowFor(undefined, plain, NONE), { window: 200_000, inferred: true });
});

test('ONE_M_MODEL_RE: 1M が標準の系列だけに当たる', () => {
  for (const m of ['claude-opus-4-7', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-fable-5', 'us.anthropic.claude-opus-4-7-v1', 'claude-opus-5', 'claude-sonnet-6-1']) {
    assert.ok(ONE_M_MODEL_RE.test(modelBase(m)), m);
  }
  for (const m of ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-haiku-5', 'claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'not-claude-opus-4-7x']) {
    assert.ok(!ONE_M_MODEL_RE.test(modelBase(m)), m);
  }
  assert.equal(modelBase(' Claude-Opus-4-7[1M] '), 'claude-opus-4-7');
  assert.equal(modelBase(42), '');
});

test('compactAt: 範囲内 (LEARN_MIN 以上・窓以下) の自動要約から学び、範囲外は窓ごとの既定', () => {
  assert.equal(compactAtFor(200_000, cf(synth2.compact({ trigger: 'auto', pre: 150_000, post: 1 }))), 150_000);
  assert.equal(compactAtFor(200_000, cf(synth2.compact({ trigger: 'auto', pre: 50_000, post: 1 }))), CONTEXT.COMPACT_AT_BASE);
  assert.equal(compactAtFor(200_000, cf(synth2.compact({ trigger: 'auto', pre: 205_000, post: 1 }))), CONTEXT.COMPACT_AT_BASE);
  assert.equal(compactAtFor(1_000_000, cf(synth2.compact({ trigger: 'auto', pre: 960_000, post: 1 }))), 960_000);
  assert.equal(compactAtFor(1_000_000, cf(synth2.usage(10))), CONTEXT.COMPACT_AT_LARGE);
  assert.equal(compactAtFor(200_000, cf(synth2.usage(10))), CONTEXT.COMPACT_AT_BASE);
});

test('learnWindows: セッションをまたいで model ごとの最大の量。[1m] 付きの回は入れない', () => {
  const big = cf(synth2.usage(450_000));
  const small = cf(synth2.usage(90_000));
  const learned = learnWindows([
    { model: 'claude-test-1', facts: small },
    { model: 'Claude-Test-1', facts: big },
    { model: 'claude-test-2[1m]', facts: big },
    { model: undefined, facts: big },
  ]);
  assert.equal(learned.get('claude-test-1'), 450_000);
  assert.equal(learned.has('claude-test-2'), false);
  assert.equal(learned.size, 1);
  // 別のセッションの観測で、証拠の無いセッションの窓が 1M (推定) になる
  assert.deepEqual(windowFor('claude-test-1', small, learned), { window: 1_000_000, inferred: true });
});

test('contextLevel: 上がるときは enter ですぐ、下がるときは enter − BAND まで同じ段階 (帯)', () => {
  assert.equal(contextLevel(0.59), undefined);
  assert.equal(contextLevel(0.6), 'notice');
  assert.equal(contextLevel(0.83), 'due');
  assert.equal(contextLevel(0.95), 'soon');
  assert.equal(contextLevel(0.95, 'notice'), 'soon'); // 一段飛ばしでもすぐ上がる
  assert.equal(contextLevel(0.8, 'due'), 'due'); // 帯の中
  assert.equal(contextLevel(0.78, 'due'), 'due');
  assert.equal(contextLevel(0.77, 'due'), 'notice');
  assert.equal(contextLevel(0.9, 'soon'), 'soon');
  assert.equal(contextLevel(0.87, 'soon'), 'due');
  assert.equal(contextLevel(0.56, 'notice'), 'notice');
  assert.equal(contextLevel(0.54, 'notice'), undefined);
  assert.equal(contextLevel(0.56, 'soon'), 'notice'); // 大きく下がっても、帯を満たす一番高い段階
  assert.equal(contextLevel(0.7, 'notice'), 'notice');
  assert.equal(contextLevel(Number.NaN, 'due'), undefined);
});

test('finishContext: 前回の段階 (prev) が帯に効き、3 つのリセット (要約・cliSessionId の変化・30% の減少) で持ち越さない', () => {
  const s = withModel(1);
  const at = (/** @type {number} */ f) => cf(synth2.usage(Math.round(f * CONTEXT.COMPACT_AT_BASE)));
  const prevDue = { cli: cid(1), level: /** @type {const} */ ('due'), used: Math.round(0.84 * CONTEXT.COMPACT_AT_BASE) };
  assert.equal(finishContext(at(0.8), s, NONE)?.level, 'notice');
  assert.equal(finishContext(at(0.8), s, NONE, prevDue)?.level, 'due');
  assert.equal(finishContext(at(0.8), s, NONE, { ...prevDue, cli: cid(2) })?.level, 'notice'); // 別の会話ログ
  // 30% を超える減少 (要約の区切りが tail の外にあった) は持ち越さない
  const dropped = { cli: cid(1), level: /** @type {const} */ ('soon'), used: 300_000 };
  assert.equal(finishContext(at(0.9), s, NONE, dropped)?.level, 'due');
  assert.equal(finishContext(at(0.9), s, NONE, { ...dropped, used: Math.round(0.95 * CONTEXT.COMPACT_AT_BASE) })?.level, 'soon');
  // 要約の直後は段階なし
  const compacted = cf(synth2.usage(160_000), synth2.compact({ trigger: 'auto', pre: 160_000, post: 150_000 }));
  assert.equal(finishContext(compacted, s, NONE, prevDue)?.level, undefined);
});

test('finishContext: 1M の窓では 80% で due、90% で soon (段階は自動要約点に対する割合)', () => {
  const s = withModel(1, { model: 'claude-test-1[1m]' });
  const lvl = (/** @type {number} */ used) => finishContext(cf(synth2.usage(used)), s, NONE);
  assert.deepEqual({ ...lvl(803_000), used: 0 }, { used: 0, window: 1_000_000, inferred: false, pct: 80, compactAt: 967_000, level: 'due' });
  assert.equal(lvl(900_000)?.level, 'soon');
  assert.equal(lvl(580_300)?.level, 'notice');
  assert.equal(lvl(500_000)?.level, undefined);
});

test('contextMemo: context を持つカードだけ、{cli, level, used} を前回の段階として返す', () => {
  const card = (/** @type {number} */ n, /** @type {any} */ context) => ({ id: sid(n), ...(context ? { context } : {}) });
  const board = /** @type {any} */ ({
    buckets: { needs_you: [card(1, { used: 10, level: 'due' })], trouble: [], unread: [card(2, { used: 20 })], working: [card(3)] },
    recentGroups: [{ key: 'a', label: 'a', items: [card(4, { used: 40, level: 'soon' })] }],
    cleanupGroups: [],
  });
  const memo = contextMemo(board, [rec(1), rec(2), rec(3), rec(4)]);
  assert.deepEqual([...memo.entries()], [
    [sid(1), { cli: cid(1), used: 10, level: 'due' }],
    [sid(2), { cli: cid(2), used: 20 }],
    [sid(4), { cli: cid(4), used: 40, level: 'soon' }],
  ]);
  assert.equal(contextMemo(board, []).size, 0); // cliSessionId が分からなければ持たない
});
