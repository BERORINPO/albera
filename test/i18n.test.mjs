import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EN } from '../public/dict-en.mjs';
import { JA } from '../public/dict-ja.mjs';
import { DICT, detectLang, makeT, otherLang } from '../public/i18n.mjs';

const PH = /\{(\w+)\}/g;
/** @param {unknown} entry */
const forms = (entry) => (typeof entry === 'string' ? [entry] : Object.values(/** @type {Record<string, string>} */ (entry)));
/** @param {unknown} entry */
const placeholders = (entry) => new Set(forms(entry).flatMap((s) => [...s.matchAll(PH)].map((m) => m[1])));

test('辞書: en と ja は同じキーを持つ', () => {
  const e = Object.keys(EN).sort();
  const j = Object.keys(JA).sort();
  assert.deepEqual(e.filter((k) => !(k in JA)), [], 'ja に無いキー');
  assert.deepEqual(j.filter((k) => !(k in EN)), [], 'en に無いキー');
  assert.equal(e.length, j.length);
  assert.ok(e.length > 300, `キーの数: ${e.length}`);
});

test('辞書: キーごとに placeholder の組が同じ (複数形の全部の形を合わせて)', () => {
  for (const key of Object.keys(EN)) {
    const a = [...placeholders(EN[key])].sort();
    const b = [...placeholders(JA[key])].sort();
    assert.deepEqual(a, b, key);
    // 複数形の各形は、その組の一部しか使わない (one で {n} を省くのは可)
    for (const f of forms(EN[key])) for (const m of f.matchAll(PH)) assert.ok(b.includes(m[1]), `${key}: ${m[1]}`);
  }
});

test('辞書: 空の文字列は無い。複数形は en だけで、one と other を持つ。複数形の数は n', () => {
  for (const [lang, dict] of Object.entries(DICT)) {
    for (const [key, entry] of Object.entries(dict)) {
      for (const f of forms(entry)) assert.ok(f.length > 0, `${lang} ${key}`);
      if (typeof entry !== 'string') {
        assert.equal(lang, 'en', `${key}: 複数形は en だけ`);
        assert.deepEqual(Object.keys(entry).sort(), ['one', 'other'], key);
        assert.ok(placeholders(entry).has('n'), `${key}: 複数形の数は {n}`);
      }
    }
  }
});

test('辞書: 画面の言葉の決まり (感嘆符・絵文字を使わない、欄の名前は 1 つ)', () => {
  for (const [lang, dict] of Object.entries(DICT)) {
    for (const [key, entry] of Object.entries(dict)) {
      for (const f of forms(entry)) {
        assert.ok(!/[!！]/.test(f), `${lang} ${key}: 感嘆符`);
        assert.ok(!/\p{Extended_Pictographic}/u.test(f.replace(/[✓↗↳←→③○]/g, '')), `${lang} ${key}: 絵文字`);
      }
    }
  }
  assert.equal(EN['bucket.needs_you.title'], 'Needs you');
  assert.equal(JA['bucket.cleanup.title'], '片付け');
});

test('makeT: 複数形を n で選び、無いキーは英語、それも無ければキーそのもの', () => {
  const en = makeT('en');
  const ja = makeT('ja');
  assert.equal(en('sel.moreLines', { n: 1 }), '… and 1 more line');
  assert.equal(en('sel.moreLines', { n: 2 }), '… and 2 more lines');
  assert.equal(en('sel.moreLines', { n: 0 }), '… and 0 more lines');
  assert.equal(ja('sel.moreLines', { n: 1 }), '… ほか 1 行');
  assert.equal(en('no.such.key'), 'no.such.key');
  assert.equal(en.has('app.name'), true);
  assert.equal(en.has('pr.state.DRAFT'), false);
  assert.equal(en.lang, 'en');
  assert.equal(makeT('fr').lang, 'en');
  assert.equal(en('banner.filter', { q: '{n}', n: 3 }), 'Filtering by “{n}”: 3 matches', '値の中の {n} は展開しない');
});

test('t.parts: {name} に DOM のノードなどを差し込める', () => {
  const node = { tag: 'code' };
  assert.deepEqual(makeT('en').parts('lede.offlineNote', { cmd: node }), ['Start the board again in a terminal: ', node, ' (from a clone: npm start). This page connects by itself.']);
  const ja = makeT('ja').parts('lede.offlineNote', { cmd: node });
  assert.equal(ja[1], node);
});

test('detectLang: ?lang= > 保存した切替 > navigator.languages の最初の en / ja > en', () => {
  assert.equal(detectLang({ search: '?lang=ja', saved: 'en', languages: ['en-US'] }), 'ja');
  assert.equal(detectLang({ search: '?lang=en', saved: 'ja', languages: ['ja-JP'] }), 'en');
  assert.equal(detectLang({ search: '?lang=xx', saved: 'ja', languages: [] }), 'ja');
  assert.equal(detectLang({ search: '', saved: undefined, languages: ['ja-JP', 'en-US'] }), 'ja');
  assert.equal(detectLang({ search: '', saved: undefined, languages: ['fr-FR', 'de'] }), 'en');
  assert.equal(detectLang({ search: '', saved: undefined, languages: ['fr-FR', 'ja'] }), 'ja');
  assert.equal(detectLang({ search: '', saved: 'bogus', languages: ['en-GB'] }), 'en');
  assert.equal(detectLang({}), 'en');
  assert.equal(otherLang('en'), 'ja');
  assert.equal(otherLang('ja'), 'en');
});
