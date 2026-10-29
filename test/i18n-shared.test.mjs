import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUPPORTED_LANGS, fill, fillParts, normalizeLang, pickForm } from '../src/shared/i18n.mjs';

test('SUPPORTED_LANGS は en・ja・zh (変更できない)', () => {
  assert.deepEqual([...SUPPORTED_LANGS], ['en', 'ja', 'zh']);
  assert.ok(Object.isFrozen(SUPPORTED_LANGS));
});

test('normalizeLang: 先頭の英字で ja / en / zh に寄せる。それ以外は null', () => {
  for (const tag of ['ja', 'JA', 'ja-JP', 'ja_JP.UTF-8', 'Japanese_Japan.932', ' ja-jp ']) assert.equal(normalizeLang(tag), 'ja', tag);
  for (const tag of ['en', 'en-US', 'en_GB.UTF-8', 'English_United States.1252']) assert.equal(normalizeLang(tag), 'en', tag);
  for (const tag of ['zh', 'ZH', 'zh-CN', 'zh_CN.UTF-8', 'zh-Hans', 'Chinese (Simplified)_China.936', ' zh-cn ']) assert.equal(normalizeLang(tag), 'zh', tag);
  // 繁体字の辞書ができるまでは、繁体字の指定も簡体字 (zh) に寄せる
  for (const tag of ['zh-TW', 'zh_TW.UTF-8', 'zh-HK', 'zh-Hant', 'Chinese (Traditional)_Taiwan.950']) assert.equal(normalizeLang(tag), 'zh', tag);
  for (const tag of ['C.UTF-8', 'C', 'POSIX', 'fr_FR', 'de', '', '123', '-ja', '-zh', 'z', 'zhx'])
    assert.equal(normalizeLang(tag), null, tag);
  assert.equal(normalizeLang(undefined), null);
  assert.equal(normalizeLang(null), null);
  assert.equal(normalizeLang(42), null);
});

test('fill: {name} を params の値で置き換える (数・文字列)', () => {
  assert.equal(fill('{n} 件 · {who}', { n: 3, who: 'x' }), '3 件 · x');
  assert.equal(fill('{a}{a}', { a: 'y' }), 'yy');
  assert.equal(fill('plain'), 'plain');
  assert.equal(fill('{n}', { n: 0 }), '0');
});

test('fill: 1 回だけ通す (値の中の "{n}" は展開しない)', () => {
  assert.equal(fill('{q} ({n})', { q: 'contains {n} and {q}', n: 2 }), 'contains {n} and {q} (2)');
});

test('fill: params に無い placeholder はそのまま残す。prototype のキー (constructor など) は置き換えない', () => {
  assert.equal(fill('{missing} / {n}', { n: 1 }), '{missing} / 1');
  assert.equal(fill('{constructor} {toString}', {}), '{constructor} {toString}');
  assert.equal(fill('{n}', /** @type {any} */ (null)), '{n}');
});

test('fillParts: 文字列と値 (DOM ノードなど) を交互に並べる。空の文字列は入れない', () => {
  const node = { tag: 'code' };
  assert.deepEqual(fillParts('Run {cmd} in a terminal.', { cmd: node }), ['Run ', node, ' in a terminal.']);
  assert.deepEqual(fillParts('{cmd}', { cmd: node }), [node]);
  assert.deepEqual(fillParts('{a}{b}', { a: 1, b: 2 }), [1, 2]);
  assert.deepEqual(fillParts('no placeholders'), ['no placeholders']);
  assert.deepEqual(fillParts(''), []);
});

test('fillParts: params に無い placeholder は文字列のまま残し、前後の文字列とつなげる', () => {
  const node = { tag: 'kbd' };
  assert.deepEqual(fillParts('a {x} b {k} c', { k: node }), ['a {x} b ', node, ' c']);
  // 値の中の "{k}" は展開しない
  assert.deepEqual(fillParts('{q}!', { q: '{k}' }), ['{k}', '!']);
});

test('pickForm: 文字列の項目はそのまま (ja はいつも文字列)', () => {
  assert.equal(pickForm('ja', '{n} 件', 1), '{n} 件');
  assert.equal(pickForm('en', 'Close', 5), 'Close');
});

test('pickForm: {one, other} の項目は Intl.PluralRules で選ぶ (n = 0, 1, 2)', () => {
  const entry = { one: '{n} session', other: '{n} sessions' };
  assert.equal(pickForm('en', entry, 1), '{n} session');
  assert.equal(pickForm('en', entry, 2), '{n} sessions');
  assert.equal(pickForm('en', entry, 0), '{n} sessions');
  assert.equal(pickForm('en', entry, '1'), '{n} session');
  // n が無ければ 0 として扱う
  assert.equal(pickForm('en', entry, undefined), '{n} sessions');
  assert.equal(fill(pickForm('en', entry, 1), { n: 1 }), '1 session');
});

test('pickForm: 分類の形が無ければ other。言語が不正でも落ちない', () => {
  assert.equal(pickForm('ja', { other: '{n} 件' }, 1), '{n} 件');
  assert.equal(pickForm('en', { other: 'x' }, 1), 'x');
  assert.equal(pickForm('', { one: 'a', other: 'b' }, 1), 'a');
  assert.equal(pickForm('not a lang!!', { one: 'a', other: 'b' }, 2), 'b');
});
