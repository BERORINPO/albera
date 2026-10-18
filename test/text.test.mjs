import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cap, reportSummary, resetPart } from '../src/core/text.mjs';

test('cap: code point 単位で切り、切ったら末尾を「…」にする', () => {
  assert.equal(cap('abc', 5), 'abc');
  assert.equal(cap('abcdef', 4), 'abc…');
  assert.equal(Array.from(cap('😀'.repeat(10), 5)).length, 5);
  assert.equal(cap('😀'.repeat(10), 5), '😀😀😀😀…');
  assert.equal(cap('😀😀', 2), '😀😀'); // UTF-16 では 4 単位でも 2 文字なので切らない
  assert.equal(cap(undefined, 5), '');
  assert.equal(cap(42, 5), '');
});

test('reportSummary: 前後の引用符を外し、⏎ の前を取り、リンクを文字だけにして空白を詰める', () => {
  assert.equal(reportSummary('"[PR #3](https://x/y) を出しました。\n  確認待ち ⏎ 本文"'), 'PR #3 を出しました。 確認待ち');
  assert.equal(reportSummary('\\"**太字** と [別の会話](#local_x)\\"'), '太字 と 別の会話');
  assert.equal(reportSummary('要約だけ'), '要約だけ');
  assert.equal(reportSummary(undefined), '');
});

test('resetPart: 使用上限の解除時刻の部分', () => {
  assert.equal(resetPart("You've hit your session limit · resets 1:50pm"), 'resets 1:50pm');
  assert.equal(resetPart('limit reached'), '');
});
