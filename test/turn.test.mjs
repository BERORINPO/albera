import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTurn, pendingAsk, turnEntries, turnStartedAt } from '../src/core/turn.mjs';
import { MIN, NOW, synth } from './helpers/fixtures.mjs';

const join = (/** @type {string[]} */ ...lines) => lines.join('\n') + '\n';

test('end_turn のあと stop_hook_summary で終わっていれば ended', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.toolUse(), synth.toolResult(), synth.text('done'), synth.stopHook()), false);
  assert.equal(r.turn, 'ended');
});

test('最後が assistant の end_turn / stop_sequence なら ended', () => {
  assert.equal(parseTurn(join(synth.prompt('go'), synth.text('done')), false).turn, 'ended');
  assert.equal(parseTurn(join(synth.prompt('go'), synth.text('done', 'stop_sequence')), false).turn, 'ended');
});

test('ターン終了後に届いた task-notification / system-reminder は読み飛ばす', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.text('done'), synth.stopHook(), synth.notification(), synth.reminder()), false);
  assert.equal(r.turn, 'ended');
});

test('中断 ([Request interrupted) は ended (how: interrupted)', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.toolUse(), synth.interrupted()), false);
  assert.deepEqual([r.turn, r.how], ['ended', 'interrupted']);
});

test('最後が tool_use なら inprogress (tool)', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.toolUse()), false);
  assert.deepEqual([r.turn, r.lastKind], ['inprogress', 'tool']);
});

test('最後が tool_result なら inprogress (tool)', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.toolUse(), synth.toolResult()), false);
  assert.deepEqual([r.turn, r.lastKind], ['inprogress', 'tool']);
});

test('最後が user の指示なら inprogress (prompt)', () => {
  const r = parseTurn(join(synth.text('ok'), synth.stopHook(), synth.prompt('次をお願いします')), false);
  assert.deepEqual([r.turn, r.lastKind], ['inprogress', 'prompt']);
});

test('ターン終了後のローカルコマンド (/model など) の行は読み飛ばす', () => {
  const r = parseTurn(join(synth.text('ok'), synth.stopHook(), synth.commandName(), synth.commandStdout()), false);
  assert.equal(r.turn, 'ended');
});

test('isMeta の user 行・その他の system 行・関係ない type は読み飛ばす', () => {
  const r = parseTurn(join(synth.text('ok'), synth.otherSystem(), synth.meta(), synth.noise()), false);
  assert.equal(r.turn, 'ended');
});

test('先頭が欠けた行 (truncatedHead) は捨てる', () => {
  const partial = synth.prompt('この行は途中から').slice(10);
  const text = partial + '\n' + join(synth.text('done'));
  assert.equal(turnEntries(text, true).length, 1);
  // 欠けていないなら先頭行も読む (ただし JSON として壊れているので結局は捨てられる)
  assert.equal(turnEntries(text, false).length, 1);
  // 完全な JSON 行が先頭にあっても truncatedHead なら捨てる
  assert.equal(turnEntries(join(synth.prompt('a'), synth.text('b')), true).length, 1);
});

test('200KB を超える 1 行が途中で切れていると該当行は 0 件 (adapter が 2MB で読み直す)', () => {
  const big = synth.text('x'.repeat(250 * 1024));
  const tail = big.slice(big.length - 200 * 1024) + '\n';
  const r = parseTurn(tail, true);
  assert.deepEqual([r.turn, r.relevant], ['unknown', 0]);
  assert.equal(parseTurn(big + '\n', false).turn, 'ended');
});

test('AskUserQuestion の tool_use に tool_result がまだ無ければ asking (質問文と askKind: question)', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.ask('q1', 'A と B のどちら?')), false);
  assert.deepEqual([r.turn, r.question, r.askKind], ['asking', 'A と B のどちら?', 'question']);
  assert.deepEqual(pendingAsk(turnEntries(join(synth.prompt('go'), synth.ask('q1', '?')), false)), { question: '?', kind: 'question' });
});

test('質問に答え済み (tool_result がある) なら inprogress のまま', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.ask('q1', '?'), synth.resultFor('q1')), false);
  assert.deepEqual([r.turn, r.lastKind, r.askKind], ['inprogress', 'tool', undefined]);
});

test('質問と並行して呼んだ別のツールの結果だけ返っていても asking', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.ask('q1', 'どれにしますか?'), synth.toolUseId('b1'), synth.resultFor('b1')), false);
  assert.deepEqual([r.turn, r.question], ['asking', 'どれにしますか?']);
});

test('ExitPlanMode の承認待ちも asking (askKind: plan、質問文が無ければ "" で決まり文句は入れない)', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.ask('p1', '1. やること', 'ExitPlanMode')), false);
  assert.deepEqual([r.turn, r.question, r.askKind], ['asking', '', 'plan']);
});

test('AskUserQuestion で質問文が空でも asking (askKind: question、質問文は "")', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.ask('q1', '   ')), false);
  assert.deepEqual([r.turn, r.question, r.askKind], ['asking', '', 'question']);
});

test('前のターンの答えていない質問は、そのあとに指示や中断があれば数えない', () => {
  const afterPrompt = parseTurn(join(synth.ask('q1', '?'), synth.prompt('別のことをして'), synth.toolUse()), false);
  assert.deepEqual([afterPrompt.turn, afterPrompt.question], ['inprogress', undefined]);
  const interrupted = parseTurn(join(synth.prompt('go'), synth.ask('q1', '?'), synth.interrupted()), false);
  assert.deepEqual([interrupted.turn, interrupted.how], ['ended', 'interrupted']);
  const afterHook = parseTurn(join(synth.ask('q1', '?'), synth.text('ok'), synth.stopHook(), synth.toolUse()), false);
  assert.equal(afterHook.turn, 'inprogress');
});

test('質問文は本文の上限 (600 字) で切る', () => {
  const r = parseTurn(join(synth.prompt('go'), synth.ask('q1', '問'.repeat(2000))), false);
  assert.equal(Array.from(/** @type {string} */ (r.question)).length, 600);
});

test('該当行が 0 件なら unknown', () => {
  assert.equal(parseTurn('', false).turn, 'unknown');
  assert.equal(parseTurn(join(synth.noise(), '{"broken'), false).turn, 'unknown');
  assert.equal(parseTurn(join(synth.notification()), false).turn, 'unknown');
});

// --- startedAt: 今のターンを始めた指示の行の timestamp ---

test('startedAt: 作業中のターンは、始めた指示の行の timestamp (tool の途中でも prompt が最後でも)', () => {
  const at = NOW - 23 * MIN;
  const tool = parseTurn(join(synth.prompt('go', at), synth.toolUse(NOW - 20 * MIN), synth.toolResult(NOW - 19 * MIN), synth.toolUse(NOW - MIN)), false);
  assert.deepEqual([tool.turn, tool.startedAt], ['inprogress', at]);
  const prompt = parseTurn(join(synth.text('ok'), synth.stopHook(), synth.prompt('次', at)), false);
  assert.deepEqual([prompt.turn, prompt.lastKind, prompt.startedAt], ['inprogress', 'prompt', at]);
});

test('startedAt: 読み飛ばす行 (tool_result・isMeta・system・task-notification・system-reminder・ローカルコマンド) をまたいで指示の行を見つける', () => {
  const at = NOW - 40 * MIN;
  const tail = join(
    synth.text('前のターン'),
    synth.stopHook(),
    synth.prompt('今のターンの指示', at),
    synth.meta(NOW - 39 * MIN),
    synth.toolUse(NOW - 38 * MIN),
    synth.toolResult(NOW - 37 * MIN),
    synth.otherSystem(),
    synth.notification(NOW - 30 * MIN),
    synth.reminder(NOW - 29 * MIN),
    synth.commandName(NOW - 28 * MIN),
    synth.commandStdout(NOW - 27 * MIN),
    synth.toolUse(NOW - 2 * MIN),
  );
  const r = parseTurn(tail, false);
  assert.deepEqual([r.turn, r.startedAt], ['inprogress', at]);
});

test('startedAt: 中断のあとに送り直した指示があれば、その新しい指示の時刻 (前の指示ではない)', () => {
  const r = parseTurn(join(synth.prompt('最初', NOW - 60 * MIN), synth.toolUse(), synth.interrupted(NOW - 50 * MIN), synth.prompt('やり直し', NOW - 10 * MIN), synth.toolUse()), false);
  assert.deepEqual([r.turn, r.startedAt], ['inprogress', NOW - 10 * MIN]);
});

test('startedAt: 中断で終わったターン・終わったターンには付けない', () => {
  const interrupted = parseTurn(join(synth.prompt('go', NOW - 10 * MIN), synth.toolUse(), synth.interrupted(NOW - 5 * MIN)), false);
  assert.deepEqual([interrupted.turn, interrupted.startedAt], ['ended', undefined]);
  const ended = parseTurn(join(synth.prompt('go', NOW - 10 * MIN), synth.text('done')), false);
  assert.deepEqual([ended.turn, ended.startedAt], ['ended', undefined]);
  // 中断の行より前に指示が無い (中断が区切りになる) なら付けない
  assert.equal(turnStartedAt(turnEntries(join(synth.prompt('go', NOW - 10 * MIN), synth.interrupted(NOW - 5 * MIN), synth.toolResult(), synth.toolUse()), false)), undefined);
});

test('startedAt: 区切り (stop_hook_summary / end_turn) に先に当たれば付けない (通知で始まったターンなど)', () => {
  const afterHook = parseTurn(join(synth.prompt('go', NOW - 30 * MIN), synth.text('done'), synth.stopHook(), synth.notification(NOW - 3 * MIN), synth.toolUse()), false);
  assert.deepEqual([afterHook.turn, afterHook.startedAt], ['inprogress', undefined]);
  const afterEnd = turnStartedAt(turnEntries(join(synth.prompt('go', NOW - 30 * MIN), synth.text('done'), synth.toolUse()), false));
  assert.equal(afterEnd, undefined);
});

test('startedAt: 指示の行に timestamp が無い・読めない、または tail の中に指示が無いなら付けない', () => {
  const noTs = parseTurn(join(synth.prompt('go'), synth.toolUse(NOW - MIN)), false);
  assert.deepEqual([noTs.turn, noTs.startedAt], ['inprogress', undefined]);
  const bad = JSON.stringify({ type: 'user', timestamp: 'not-a-date', message: { role: 'user', content: 'go' } });
  assert.equal(parseTurn(join(bad, synth.toolUse()), false).startedAt, undefined);
  const headless = parseTurn(join(synth.toolResult(NOW - 5 * MIN), synth.toolUse(NOW - MIN)), false);
  assert.deepEqual([headless.turn, headless.startedAt], ['inprogress', undefined]);
});

test('startedAt: 返事待ち (asking) には付けない', () => {
  const r = parseTurn(join(synth.prompt('go', NOW - 10 * MIN), synth.ask('q1', 'どれ?')), false);
  assert.deepEqual([r.turn, r.startedAt], ['asking', undefined]);
});
