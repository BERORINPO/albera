// entry/service.mjs (v0.2): tail の解析結果の memo と、前回のコンテキストの段階 (prev) の持ち越し。データはすべて合成。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeAppSessionsSource } from '../src/adapters/fake-app-sessions.mjs';
import { createFakeTranscriptsSource } from '../src/adapters/fake-transcripts.mjs';
import { tailFacts } from '../src/core/classify.mjs';
import { createBoardService, createFactsMemo } from '../src/entry/service.mjs';
import { cid, HOUR, MIN, NOW, sid } from './helpers/fixtures.mjs';

/** @typedef {import('../src/shared/types.mjs').TranscriptInput} TranscriptInput */

const iso = (/** @type {number} */ at) => new Date(at).toISOString();

/**
 * 本物と同じ形の、終わったターンの末尾。最後の API 呼び出しの量 (input + cache_creation + cache_read) が used。
 * @param {number} used
 * @param {number} at 最後の行の時刻
 */
function endedTail(used, at) {
  const usage = { input_tokens: 4, cache_creation_input_tokens: 1000, cache_read_input_tokens: used - 1004, output_tokens: 200 };
  return [
    JSON.stringify({ type: 'user', timestamp: iso(at - 5 * MIN), message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: iso(at - MIN),
      message: { id: 'msg_s1', role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] } }),
    JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(at) }),
    '',
  ].join('\n');
}

/** 未読のセッション (最後に見たのは 2 時間前)。 @param {number} n @param {number} ago */
const rawOf = (n, ago) => ({
  sessionId: sid(n),
  cliSessionId: cid(n),
  title: `synthetic ${n}`,
  cwd: '/home/tester/app',
  originCwd: '/home/tester/app',
  model: 'claude-opus-4-7[1m]',
  createdAt: NOW - 3 * HOUR,
  lastActivityAt: NOW - ago,
  lastFocusedAt: NOW - 2 * HOUR,
  isArchived: false,
});

/** @param {string} tail @param {number} mainAgo @returns {TranscriptInput} */
const ti = (tail, mainAgo) => ({ tail, truncatedHead: false, mainMtime: NOW - mainAgo, subMtime: 0, subLive: 0, size: tail.length });

/** @param {any} b @param {number} n */
const cardOf = (b, n) => [...Object.values(b.buckets).flat(), ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items)].find((c) => c.id === sid(n));

/** @param {any[]} raws @param {Map<string, TranscriptInput>} transcripts @param {import('../src/entry/service.mjs').ParseTail} [parseTail] */
const serviceOf = (raws, transcripts, parseTail) =>
  createBoardService({
    sessionsSource: createFakeAppSessionsSource({ raws }),
    transcriptsSource: createFakeTranscriptsSource(transcripts),
    roots: ['/home/tester'],
    clock: () => NOW,
    cacheMs: 0, // 毎回計算し直す (2 秒のキャッシュを通さない)
    ...(parseTail ? { parseTail } : {}),
  });

test('service: 変わっていない tail は parse し直さない (memo)。変わった tail だけ parse し、結果は parse し直したものと同じ', async () => {
  let parsed = 0;
  /** @type {import('../src/entry/service.mjs').ParseTail} */
  const counting = (tail, truncatedHead) => (parsed++, tailFacts(tail, truncatedHead));
  const raws = [rawOf(1, 30 * MIN), rawOf(2, 20 * MIN), rawOf(3, 10 * MIN)];
  const transcripts = new Map([
    [cid(1), ti(endedTail(300_000, NOW - 30 * MIN), 30 * MIN)],
    [cid(2), ti(endedTail(400_000, NOW - 20 * MIN), 20 * MIN)],
    [cid(3), ti(endedTail(500_000, NOW - 10 * MIN), 10 * MIN)],
  ]);
  const service = serviceOf(raws, transcripts, counting);
  await service.get();
  assert.equal(parsed, 3);
  await service.get();
  assert.equal(parsed, 3, '同じ {cliSessionId, size, mainMtime} なら parse しない');

  // 1 件だけ書き込みが進んだ (size と mtime が変わる)
  transcripts.set(cid(2), ti(endedTail(410_000, NOW - 5 * MIN), 5 * MIN));
  const r = await service.get();
  assert.equal(parsed, 4, '変わった 1 件だけ parse し直す');
  const b = JSON.parse(r.body);
  assert.equal(cardOf(b, 2).context.used, 410_000);
  assert.equal(cardOf(b, 1).context.used, 300_000);
  const fresh = await serviceOf(raws, transcripts).get();
  assert.equal(r.etag, fresh.etag, 'memo を使った盤面と、全部を parse し直した盤面は同じ');
});

test('createFactsMemo: cliSessionId ごとに 1 件。上限を超えたら長く使われていないものから捨て、今回読まなかったものは prune で捨てる', () => {
  let n = 0;
  const memo = createFactsMemo(() => /** @type {any} */ ({ n: ++n }), 2);
  const a = ti('a', MIN);
  const b = ti('b', MIN);
  assert.equal(/** @type {any} */ (memo.get('A', a)).n, 1);
  assert.equal(/** @type {any} */ (memo.get('B', b)).n, 2);
  assert.equal(/** @type {any} */ (memo.get('A', a)).n, 1, '当たり (A は新しい側へ)');
  memo.get('C', ti('c', MIN));
  assert.equal(memo.size(), 2);
  assert.equal(/** @type {any} */ (memo.get('A', a)).n, 1, 'A は残っている');
  assert.equal(/** @type {any} */ (memo.get('B', b)).n, 4, 'B は捨てられていたので parse し直す');
  assert.equal(/** @type {any} */ (memo.get('A', { ...a, size: a.size + 1 })).n, 5, 'size が変われば parse し直す');
  assert.equal(/** @type {any} */ (memo.get('A', { ...a, size: a.size + 1, mainMtime: a.mainMtime + 1 })).n, 6, 'mtime が変われば parse し直す');
  assert.equal(/** @type {any} */ (memo.get('A', { ...a, size: a.size + 1, mainMtime: a.mainMtime + 1, truncatedHead: true })).n, 7, '先頭の欠けが変われば parse し直す');
  memo.prune(new Set(['A']));
  assert.equal(memo.size(), 1);
});

test('service: 前回の段階 (prev) が帯に効く。前回の盤面が無ければ同じ量でも 1 つ下の段階、帯の下まで減れば下がる', async () => {
  const raws = [rawOf(1, 30 * MIN)];
  const transcripts = new Map([[cid(1), ti(endedTail(820_000, NOW - 30 * MIN), 30 * MIN)]]);
  const service = serviceOf(raws, transcripts);
  const levelOf = async (/** @type {ReturnType<typeof serviceOf>} */ svc) => {
    const card = cardOf(JSON.parse((await svc.get()).body), 1);
    assert.equal(card.bucket, 'unread');
    return card.context.level;
  };
  assert.equal(await levelOf(service), 'due', '820K / 967K = 0.85');
  transcripts.set(cid(1), ti(endedTail(780_000, NOW - 20 * MIN), 20 * MIN)); // 0.81: due に入る点 (0.83) の下、帯 (0.78) の上
  assert.equal(await levelOf(service), 'due', '前回が due なので帯の中は due のまま');
  assert.equal(await levelOf(serviceOf(raws, transcripts)), 'notice', '前回の盤面が無いサービスでは notice');
  transcripts.set(cid(1), ti(endedTail(740_000, NOW - 10 * MIN), 10 * MIN)); // 0.77: 帯の下
  assert.equal(await levelOf(service), 'notice');
});
