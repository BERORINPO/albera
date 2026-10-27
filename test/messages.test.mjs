// 端末の言葉 (src/entry/messages.mjs): en と ja のキーと placeholder がそろっていること、使っているキーが全部あること。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { errorLines, msg, TERM } from '../src/entry/messages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[　-ヿ㐀-鿿！-｠]/;
const placeholders = (/** @type {string} */ s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

test('en と ja は同じキーで、キーごとの placeholder も同じ。空の文は無い', () => {
  assert.deepEqual(Object.keys(TERM.ja).sort(), Object.keys(TERM.en).sort());
  for (const k of Object.keys(TERM.en)) {
    assert.deepEqual(placeholders(TERM.ja[k]), placeholders(TERM.en[k]), k);
    assert.ok(TERM.en[k].trim() !== '' && TERM.ja[k].trim() !== '', k);
    assert.doesNotMatch(TERM.en[k], CJK, `en の ${k} に日本語`);
  }
});

test('ソースで使っている term.* のキーは全部辞書にある', () => {
  const dir = path.join(ROOT, 'src', 'entry');
  const used = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (f === 'messages.mjs') continue;
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/'(term\.[A-Za-z]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 10, `見つかったキー ${used.size} 件`);
  for (const k of used) assert.ok(k in TERM.en, k);
});

test('msg: 値を差し込む。知らない言語は en、知らないキーはキーそのもの', () => {
  assert.equal(msg('en', 'term.started', { port: 18950, mode: msg('en', 'term.modeDemo') }), 'ALBERA: http://127.0.0.1:18950 (demo data, read-only)');
  assert.equal(msg('ja', 'term.started', { port: 18950, mode: msg('ja', 'term.modeReadOnly') }), 'ALBERA: http://127.0.0.1:18950 (読み取り専用)');
  assert.equal(msg('fr', 'term.alreadyRunning', { port: 1 }), 'Already running: open http://127.0.0.1:1');
  assert.equal(msg('en', 'term.nope'), 'term.nope');
  assert.equal(msg('en', 'term.badFlag', { flag: '{port}', cmd: 'npx albera' }), 'Unknown option: {port}. See: npx albera --help', '値の中の {..} は展開しない');
});

test('起動の行には URL が入る (テストと smoke はこれで起動完了を判定する)', () => {
  for (const lang of ['en', 'ja']) assert.match(msg(lang, 'term.started', { port: 8797, mode: 'x' }), /http:\/\/127\.0\.0\.1:\d+/);
});

test('help: 版・既定のポート・区切り文字が入り、placeholder が残らない', () => {
  for (const lang of ['en', 'ja']) {
    const h = msg(lang, 'term.help', { version: '9.9.9', port: 8797, sep: ';', cmd: 'npx albera' });
    assert.ok(h.includes('npx albera ['), `${lang}: 使い方の行は起動のしかた`);
    assert.match(h, /^ALBERA 9\.9\.9: /);
    assert.match(h, /8797/);
    for (const f of ['--port', '--lang', '--demo', '--sessions-dir', '--projects-dir', '--help', '--version', 'ALBERA_ROOTS']) assert.ok(h.includes(f), `${lang}: ${f}`);
    assert.doesNotMatch(h, /\{\w+\}/);
  }
});

test('errorLines: セッションフォルダが無いときは、説明・探した場所 (1 行に 1 つ)・直し方', () => {
  const lines = errorLines('en', 'term.noSessionsDir', { tried: ['/a/b', '/c/d'] });
  assert.deepEqual(lines, [TERM.en['term.noSessionsDir'], '  /a/b', '  /c/d', TERM.en['term.noSessionsDirHint']]);
  assert.deepEqual(errorLines('ja', 'term.badPort', { raw: 'abc' }), [msg('ja', 'term.badPort', { raw: 'abc' })]);
  assert.match(errorLines('ja', 'term.badRoots', { sep: ';', bad: '' })[0], /\(不正: \(空\)\)/);
  assert.match(errorLines('en', 'term.badRoots', { sep: ':', bad: 'rel' })[0], /separated by ":" \(invalid: rel\)/);
  assert.deepEqual(errorLines('en', 'term.badFlag', { flag: '--x' }), ['Unknown option: --x. See: albera --help'], '起動のしかたが無ければ bin 名');
  assert.deepEqual(errorLines('en', 'term.badFlag', { flag: '--x', cmd: 'node /opt/p/server.mjs' }), ['Unknown option: --x. See: node /opt/p/server.mjs --help']);
});
