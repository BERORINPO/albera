import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAll, tailFacts } from '../src/core/classify.mjs';
import { activityFacts } from '../src/core/activity.mjs';
import { contextFacts } from '../src/core/context.mjs';
import { parseTurn, turnEntries } from '../src/core/turn.mjs';
import { DAY, HOUR, MIN, NOW, SEC, rec, sid, synth, synth2, tails, ti, usageOf } from './helpers/fixtures.mjs';

/**
 * @param {ReturnType<typeof rec>[]} active
 * @param {Record<string, ReturnType<typeof ti>>} [turnsById] sessionId がキー
 */
function run(active, turnsById = {}) {
  return classifyAll({ active, turns: new Map(Object.entries(turnsById)), now: NOW });
}
const one = (/** @type {ReturnType<typeof rec>} */ s, /** @type {any} */ t) => /** @type {any} */ (run([s], t ? { [s.sessionId]: t } : {}).get(s.sessionId));

test('R1: ターン途中で 15 分以内に書き込みがあれば作業中 (古い needs_action より優先)', () => {
  const s = rec(1, { postTurnSummary: { status_category: 'blocked', needs_action: '答えてください' } });
  const c = one(s, ti(tails.tool(), 2 * MIN));
  assert.deepEqual([c.bucket, c.reason, c.reasonParams], ['working', 'turn', undefined]);
});

test('R1: 作業中のターンは、始めた指示の時刻 (startedAt) を持つ。分からなければ無い', () => {
  const s = rec(1, { lastActivityAt: NOW - 2 * MIN });
  const c = one(s, ti(tails.tool(NOW - 23 * MIN), 2 * MIN));
  assert.deepEqual([c.bucket, c.reason, c.startedAt], ['working', 'turn', NOW - 23 * MIN]);
  assert.equal('startedAt' in one(s, ti(tails.tool(), 2 * MIN)), false);
  // 止まっているかも (15 分以上無音) には付けない
  assert.equal(one(s, ti(tails.tool(NOW - 3 * HOUR), 2 * HOUR)).startedAt, undefined);
});

test('R1: subagents の書き込みが本体より 5 秒以上後で 15 分以内ならバックグラウンド作業中', () => {
  const s = rec(1, { lastActivityAt: NOW - 30 * MIN });
  const c = one(s, ti(tails.ended(), 30 * MIN, 1 * MIN));
  assert.deepEqual([c.bucket, c.reason, c.reasonParams], ['working', 'background', undefined]);
});

test('R1: subagents が本体と 5 秒以内 (BG_LEAD 未満) ならバックグラウンド扱いしない', () => {
  // 両方とも 15 分以内 (QUIET の条件は満たす) なので、BG_LEAD の条件だけで決まる
  const s = rec(1, { lastActivityAt: NOW - 2 * MIN, lastFocusedAt: NOW - 2 * MIN + 10 * SEC });
  const c = one(s, ti(tails.ended(), 2 * MIN, 2 * MIN - 3 * SEC));
  assert.equal(c.facts.bg, false);
  assert.equal(c.bucket, 'recent');
  // 6 秒後なら BG_LEAD を超えるのでバックグラウンド
  assert.equal(one(s, ti(tails.ended(), 2 * MIN, 2 * MIN - 6 * SEC)).reason, 'background');
});

test('R0: 質問ツールの返事待ちは、15 分以内でも作業中ではなく返事待ち (古い needs_action より優先)', () => {
  const s = rec(1, { lastActivityAt: NOW - 2 * MIN, postTurnSummary: { status_category: 'completed', needs_action: '' } });
  const c = one(s, ti(tails.asking('A と B のどちら?'), 2 * MIN));
  assert.deepEqual([c.bucket, c.reason, c.timeKind, c.facts.T.question], ['needs_you', 'asking', 'waiting', 'A と B のどちら?']);
  assert.deepEqual(c.reasonParams, { ask: 'question' });
  // ExitPlanMode の承認待ちは ask: plan
  assert.deepEqual(one(s, ti(tails.asking('', 'ExitPlanMode'), 2 * MIN)).reasonParams, { ask: 'plan' });
  // 15 分を超えても「止まっているかも」には落ちない
  assert.equal(one(s, ti(tails.asking(), 3 * HOUR)).bucket, 'needs_you');
});

test('R0: 質問のあとにエラーが最新なら R3 (止まっているかも) に回す', () => {
  const s = rec(1, { lastActivityAt: NOW - 5 * MIN, error: 'API Error: overloaded', errorAt: NOW - 5 * MIN });
  assert.equal(one(s, ti(tails.asking(), 5 * MIN)).bucket, 'trouble');
});

test('R1: subagents の書き込みが 15 分より前なら作業中ではない', () => {
  const s = rec(1, { lastActivityAt: NOW - 2 * HOUR });
  assert.notEqual(one(s, ti(tails.ended(), 2 * HOUR, 20 * MIN)).bucket, 'working');
});

test('R1: pendingFirstStart で 10 分以内なら起動中', () => {
  const s = rec(1, { createdAt: NOW - 3 * MIN, lastActivityAt: NOW - 3 * MIN, pendingFirstStart: { since: NOW - 3 * MIN, task: '秘密の指示' } });
  const c = one(s);
  assert.deepEqual([c.bucket, c.reason], ['working', 'starting']);
});

test('R2: 同じ定期実行の最新でない回は片付け候補 (idle より優先)', () => {
  const old = rec(1, { scheduledTaskId: 'r', createdAt: NOW - 40 * DAY, lastActivityAt: NOW - 40 * DAY });
  const latest = rec(2, { scheduledTaskId: 'r', createdAt: NOW - 1 * DAY, lastActivityAt: NOW - 1 * DAY });
  const m = run([old, latest]);
  assert.deepEqual([m.get(old.sessionId)?.bucket, m.get(old.sessionId)?.reason], ['cleanup', 'routine_old']);
  assert.equal(m.get(latest.sessionId)?.bucket, 'recent');
});

test('R3: Git の起動失敗は止まっているかも (最近)', () => {
  const s = rec(1, { error: 'Git is broken', errorAt: NOW - HOUR, errorCategory: 'git_startup_failed' });
  const c = one(s);
  assert.deepEqual([c.bucket, c.reason, c.reasonParams], ['trouble', 'git_startup', undefined]);
});

test('R3: 使用上限のエラーは解除時刻の部分を reasonParams.reset に入れる (無ければ省く)', () => {
  const s = rec(1, { error: "You've hit your session limit · resets 1:50pm", errorAt: NOW - HOUR });
  const c = one(s);
  assert.deepEqual([c.bucket, c.reason, c.reasonParams], ['trouble', 'limit', { reset: 'resets 1:50pm' }]);
  assert.equal(c.timeKind, 'stopped');
  const noReset = one(rec(1, { error: 'Usage limit reached', errorAt: NOW - HOUR }));
  assert.deepEqual([noReset.reason, noReset.reasonParams], ['limit', undefined]);
  // 解除時刻の部分は 40 字まで
  const long = one(rec(1, { error: 'limit · resets ' + 'x'.repeat(100), errorAt: NOW - HOUR }));
  assert.equal(Array.from(long.reasonParams.reset).length, 40);
});

test('R3: その他のエラーは reasonParams.error に先頭 80 字 (文は付けない)', () => {
  const s = rec(1, { error: 'API Error: ' + 'e'.repeat(200), errorAt: NOW - HOUR });
  const c = one(s);
  assert.equal(c.reason, 'error');
  assert.deepEqual(Object.keys(c.reasonParams), ['error']);
  assert.ok(c.reasonParams.error.startsWith('API Error: '));
  assert.equal(Array.from(c.reasonParams.error).length, 80);
  assert.equal('reasonText' in c, false);
});

test('R3: errorAt が最後の動きより 60 秒以上前なら、エラーは最新の出来事ではない', () => {
  const s = rec(1, { error: 'old failure', errorAt: NOW - 3 * HOUR, lastActivityAt: NOW - HOUR });
  assert.equal(one(s, ti(tails.ended(), HOUR)).bucket, 'recent');
});

test('R3: errorAt が最後の動きの 60 秒以内前 (ERROR_CURRENT_MS の幅) なら、エラーが最新の出来事', () => {
  const s = rec(1, { error: 'API Error: x', errorAt: NOW - HOUR - 30 * SEC, lastActivityAt: NOW - HOUR });
  const c = one(s, ti(tails.ended(), HOUR));
  assert.deepEqual([c.facts.errorNow, c.bucket], [true, 'trouble']);
  const late = rec(1, { error: 'API Error: x', errorAt: NOW - HOUR - 90 * SEC, lastActivityAt: NOW - HOUR });
  assert.equal(one(late, ti(tails.ended(), HOUR)).facts.errorNow, false);
});

test('R3: あとで同じ title・同じ親で起動し直していれば cleanup/retried', () => {
  const failed = rec(1, { title: '同じ作業', createdAt: NOW - 3 * HOUR, lastActivityAt: NOW - 3 * HOUR, error: 'Git is broken', errorAt: NOW - 3 * HOUR, errorCategory: 'git_startup_failed' });
  const retry = rec(2, { title: '同じ作業', createdAt: NOW - 2 * HOUR, lastActivityAt: NOW - HOUR });
  const m = run([failed, retry]);
  assert.deepEqual([m.get(failed.sessionId)?.bucket, m.get(failed.sessionId)?.reason], ['cleanup', 'retried']);
});

test('R3: 親が違う・やり直しもエラーなら retried にしない', () => {
  const base = { title: '同じ作業', createdAt: NOW - 3 * HOUR, lastActivityAt: NOW - 3 * HOUR, error: 'x', errorAt: NOW - 3 * HOUR };
  const failed = rec(1, base);
  const otherParent = rec(2, { title: '同じ作業', createdAt: NOW - 2 * HOUR, spawnedFrom: { sessionId: sid(99) } });
  const alsoFailed = rec(3, { ...base, createdAt: NOW - 2 * HOUR, lastActivityAt: NOW - 2 * HOUR, errorAt: NOW - 2 * HOUR });
  assert.equal(run([failed, otherParent, alsoFailed]).get(failed.sessionId)?.bucket, 'trouble');
});

test('R3: やり直しが 24 時間 (RETRY_WINDOW) より後なら retried にしない', () => {
  const failed = rec(1, { title: '同じ作業', createdAt: NOW - 30 * HOUR, lastActivityAt: NOW - 30 * HOUR, error: 'x', errorAt: NOW - 30 * HOUR });
  const late = rec(2, { title: '同じ作業', createdAt: NOW - 5 * HOUR, lastActivityAt: NOW - 4 * HOUR });
  assert.equal(run([failed, late]).get(failed.sessionId)?.bucket, 'trouble');
  const inTime = rec(3, { title: '同じ作業', createdAt: NOW - 8 * HOUR, lastActivityAt: NOW - 7 * HOUR });
  assert.equal(run([failed, late, inTime]).get(failed.sessionId)?.reason, 'retried');
});

test('R3: 同じ title の回が「前に」あるだけなら retried にしない (やり直しは後から起動したもの)', () => {
  const earlier = rec(1, { title: '同じ作業', createdAt: NOW - 5 * HOUR, lastActivityAt: NOW - 5 * HOUR });
  const failed = rec(2, { title: '同じ作業', createdAt: NOW - 3 * HOUR, lastActivityAt: NOW - 3 * HOUR, error: 'x', errorAt: NOW - 3 * HOUR });
  assert.equal(run([earlier, failed]).get(failed.sessionId)?.bucket, 'trouble');
});

test('R3: title が空どうしは retried にしない', () => {
  // byTitle は空の title を入れないので、isRetried の空 title の早期 return を消しても結果は同じ (等価な書き換え)。仕様の記録として残す
  const failed = rec(1, { title: '', createdAt: NOW - 3 * HOUR, lastActivityAt: NOW - 3 * HOUR, error: 'x', errorAt: NOW - 3 * HOUR });
  const other = rec(2, { title: '', createdAt: NOW - 2 * HOUR, lastActivityAt: NOW - 2 * HOUR });
  assert.equal(run([failed, other]).get(failed.sessionId)?.bucket, 'trouble');
});

test('R3: 7 日より前のエラーは cleanup/old_error', () => {
  const s = rec(1, { createdAt: NOW - 10 * DAY, lastActivityAt: NOW - 9 * DAY, error: 'x', errorAt: NOW - 9 * DAY });
  assert.deepEqual([one(s).bucket, one(s).reason], ['cleanup', 'old_error']);
});

test('R3: pendingFirstStart のまま 10 分を過ぎたら「起動しないまま止まっている」', () => {
  const s = rec(1, { createdAt: NOW - 30 * MIN, lastActivityAt: NOW - 30 * MIN, pendingFirstStart: { since: NOW - 30 * MIN } });
  const c = one(s);
  assert.deepEqual([c.bucket, c.reason, c.reasonParams], ['trouble', 'not_started', undefined]);
});

test('R4: ターン途中のまま 15 分以上無音なら止まっているかも (reasonParams.via が tool / prompt)', () => {
  const s = rec(1, { lastActivityAt: NOW - 3 * HOUR });
  const tool = one(s, ti(tails.tool(), 3 * HOUR));
  assert.deepEqual([tool.bucket, tool.reason, tool.reasonParams], ['trouble', 'stalled', { via: 'tool' }]);
  assert.equal(tool.timeKind, 'stalled');
  const prompt = one(s, ti(tails.prompt(), 3 * HOUR));
  assert.deepEqual([prompt.reason, prompt.reasonParams], ['stalled', { via: 'prompt' }]);
});

test('R5: 新しい postTurnSummary の needs_action / blocked / interruptedAwaitingPerson は返事待ち', () => {
  assert.equal(one(rec(1, { postTurnSummary: { status_category: 'completed', needs_action: 'どちらにしますか?' } })).bucket, 'needs_you');
  assert.equal(one(rec(1, { postTurnSummary: { status_category: 'blocked', needs_action: '' } })).bucket, 'needs_you');
  assert.equal(one(rec(1, { interruptedAwaitingPerson: { kind: 'x' } })).bucket, 'needs_you');
  const c = one(rec(1, { postTurnSummary: { status_category: 'completed', needs_action: '  ' } }));
  assert.equal(c.bucket, 'recent');
});

test('R5: postTurnSummary が古い回のもの (postTurnSummaryFor ≠ lastAssistantUuid) なら返事待ちにしない', () => {
  const s = rec(1, { postTurnSummary: { status_category: 'blocked', needs_action: '答えて' }, postTurnSummaryFor: 'a', lastAssistantUuid: 'b' });
  assert.equal(one(s).bucket, 'recent');
});

test('R5: 7 日より前の質問は cleanup/old_question', () => {
  const s = rec(1, { lastActivityAt: NOW - 9 * DAY, postTurnSummary: { needs_action: '答えて' } });
  assert.deepEqual([one(s).bucket, one(s).reason], ['cleanup', 'old_question']);
});

test('理由の変数の無い reason (asks / unread / recent / cleanup の各理由) は reasonParams を持たない', () => {
  const cases = [
    rec(1, { postTurnSummary: { status_category: 'blocked', needs_action: '答えて' } }),
    rec(2, { lastActivityAt: NOW - HOUR, lastFocusedAt: NOW - 2 * HOUR }),
    rec(3),
    rec(4, { lastActivityAt: NOW - 40 * DAY }),
  ];
  const m = run(cases);
  assert.deepEqual(cases.map((s) => m.get(s.sessionId)?.reason), ['asks', 'unread', 'recent', 'idle_30d']);
  for (const s of cases) assert.equal(m.get(s.sessionId)?.reasonParams, undefined);
});

test('R6: 最後の動きのあと見ていない (2 秒の余裕) か、一度も見ていなければ未読', () => {
  assert.equal(one(rec(1, { lastActivityAt: NOW - HOUR, lastFocusedAt: NOW - 2 * HOUR })).bucket, 'unread');
  assert.equal(one(rec(1, { lastActivityAt: NOW - HOUR, lastFocusedAt: undefined })).bucket, 'unread');
  assert.equal(one(rec(1, { lastActivityAt: NOW - HOUR, lastFocusedAt: NOW - HOUR - 1500 })).bucket, 'recent');
});

test('R7: PR が全部 merge / close 済みで 24 時間以上動きなし、未読でなければ cleanup/pr_done', () => {
  const prs = [{ prNumber: 1, repo: 'o/r', state: 'MERGED' }, { prNumber: 2, repo: 'o/r', state: 'CLOSED' }];
  const s = rec(1, { lastActivityAt: NOW - 2 * DAY, lastFocusedAt: NOW - 2 * DAY + MIN, prs });
  assert.deepEqual([one(s).bucket, one(s).reason], ['cleanup', 'pr_done']);
  const open = rec(1, { lastActivityAt: NOW - 2 * DAY, lastFocusedAt: NOW - 2 * DAY + MIN, prs: [...prs, { prNumber: 3, repo: 'o/r', state: 'OPEN' }] });
  assert.equal(one(open).bucket, 'recent');
  const fresh = rec(1, { lastActivityAt: NOW - 2 * HOUR, lastFocusedAt: NOW - HOUR, prs });
  assert.equal(one(fresh).bucket, 'recent');
  const legacy = rec(1, { lastActivityAt: NOW - 2 * DAY, lastFocusedAt: NOW - DAY, prNumber: 5, prRepository: 'o/r', prState: 'MERGED' });
  assert.equal(one(legacy).reason, 'pr_done');
});

test('R7: PR が全部済みでも、最後の報告を読んでいなければ pr_done にしない (8 日前なら idle_7d)', () => {
  const prs = [{ prNumber: 1, repo: 'o/r', state: 'MERGED' }];
  const s = rec(1, { lastActivityAt: NOW - 8 * DAY, lastFocusedAt: NOW - 9 * DAY, prs });
  const c = one(s);
  assert.equal(c.facts.unreadExplicit, true);
  assert.deepEqual([c.bucket, c.reason], ['cleanup', 'idle_7d']);
});

test('R8 / R9: 最近 7 日は recent、それより古いものは 7〜30 日 / 30 日以上', () => {
  assert.equal(one(rec(1, { lastActivityAt: NOW - 6 * DAY })).bucket, 'recent');
  assert.deepEqual([one(rec(1, { lastActivityAt: NOW - 8 * DAY })).reason], ['idle_7d']);
  assert.deepEqual([one(rec(1, { lastActivityAt: NOW - 31 * DAY })).reason], ['idle_30d']);
});

test('未来の時刻は経過 0 として扱う', () => {
  const c = one(rec(1, { lastActivityAt: NOW + HOUR, lastFocusedAt: NOW + 2 * HOUR }));
  assert.equal(c.bucket, 'recent');
  assert.equal(c.facts.age, 0);
});

test('会話ログが無ければターン状態は unknown (メタデータだけで判定)', () => {
  const c = one(rec(1, { lastActivityAt: NOW - HOUR, lastFocusedAt: NOW - 2 * HOUR }));
  assert.deepEqual([c.facts.T.turn, c.bucket], ['unknown', 'unread']);
});

test('7 日より前のセッションは会話ログがあっても読まない (unknown)', () => {
  const s = rec(1, { lastActivityAt: NOW - 10 * DAY });
  const c = one(s, ti(tails.tool(), 10 * DAY));
  assert.deepEqual([c.facts.T.turn, c.bucket], ['unknown', 'cleanup']);
});

test('tailFacts: tail を 1 回だけ parse して、ターン・していること・コンテキストを同じ entries から出す', () => {
  const tail = [
    synth.prompt('go', NOW - 10 * MIN),
    synth2.tool('Read', { file_path: '/home/tester/alpha/spec.md' }, { usage: usageOf(70_000) }),
    synth.toolResult(),
    synth2.tool('Edit', { file_path: '/home/tester/alpha/board.mjs' }, { usage: usageOf(80_000), id: 'msg_2' }),
    synth.noise(),
    '',
  ].join('\n');
  const realParse = JSON.parse;
  let calls = 0;
  JSON.parse = (/** @type {any[]} */ ...args) => {
    calls++;
    return realParse.apply(JSON, /** @type {any} */ (args));
  };
  let tf;
  try {
    tf = tailFacts(tail, false);
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(calls, 5); // JSON の行ごとに 1 回 (3 つの解析で共有する)
  const entries = turnEntries(tail, false);
  assert.deepEqual(tf.turn, parseTurn(tail, false));
  assert.deepEqual(tf.activity, activityFacts(entries));
  assert.deepEqual(tf.context, contextFacts(entries));
  assert.equal(tf.turn.turn, 'inprogress');
  assert.deepEqual(tf.activity, { kind: 'edit', target: 'board.mjs' });
  assert.equal(tf.context.lastUsage?.n, 80_000);
  // 先頭の欠けた行は 3 つとも見ない
  const cut = tailFacts('{"type":"assistant","message":{"usage":{"input_tokens":900000}}}\n' + tail, true);
  assert.equal(cut.context.maxUsed, 80_000);
});

test('classifyAll: 渡された tailFacts のターン状態を使い、無いセッションは tail を parse する', () => {
  const s1 = rec(1);
  const s2 = rec(2);
  const parsed = new Map([[sid(1), { turn: { turn: /** @type {const} */ ('inprogress'), lastKind: /** @type {const} */ ('tool'), relevant: 1 }, activity: null, context: { maxUsed: 0, hasAssistant: false } }]]);
  const out = classifyAll({ active: [s1, s2], turns: new Map([[sid(1), ti('', MIN)], [sid(2), ti(tails.tool(), MIN)]]), now: NOW, tailFacts: parsed });
  assert.equal(out.get(sid(1))?.bucket, 'working'); // tail は空だが、memo のターン状態で作業中
  assert.equal(out.get(sid(2))?.bucket, 'working');
});
