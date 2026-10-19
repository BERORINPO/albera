// The list's readability pass (v0.2): the family item, and the colour tokens checked against design.md §3 and §3.1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeT } from '../public/i18n.mjs';
import { familyText } from '../public/rows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const en = makeT('en');
const ja = makeT('ja');

test('familyText: 親と子は 1 つの項目 (押した先が同じ)。sep.list でつなぎ、無ければ null', () => {
  const kids = { total: 2, needs_you: 0, trouble: 1, unread: 0, working: 0 };
  assert.equal(familyText(en, { rootId: 'r', parentId: 'p', parentTitle: 'Plan the release', children: kids }), '↳ Parent: Plan the release, 2 child sessions (1 maybe stuck)');
  assert.equal(familyText(ja, { rootId: 'r', parentId: 'p', parentTitle: 'リリースの計画', children: kids }), '↳ 親: リリースの計画、子 2 件 (止まったかも 1)');
  assert.equal(familyText(en, { rootId: 'r', parentId: 'p', parentTitle: null }), '↳ Parent: (not found)');
  assert.equal(familyText(en, { rootId: 'r', parentId: 'p', parentTitle: '' }), `↳ Parent: ${en('untitled')}`);
  assert.equal(familyText(en, { rootId: 'r', children: { total: 1, needs_you: 0, trouble: 0, unread: 0, working: 0 } }), '1 child session');
  assert.equal(familyText(en, { rootId: 'r', children: { total: 0 } }), null);
  assert.equal(familyText(en, null), null);
});

// ---------- tokens: WCAG contrast from the OKLCH values in public/tokens.css ----------

/** @param {[number, number, number]} c OKLCH (L 0-1) → linear sRGB, clamped */
function lin([L, C, h]) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) =>
    Math.min(1, Math.max(0, v)),
  );
}
const lum = (/** @type {[number, number, number]} */ c) => {
  const [r, g, b] = lin(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (/** @type {[number, number, number]} */ a, /** @type {[number, number, number]} */ b) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** @param {string} block @returns {Record<string, [number, number, number]>} */
function parseTokens(block) {
  /** @type {Record<string, [number, number, number]>} */
  const out = {};
  for (const m of block.matchAll(/--((?:color|cv)-[a-z0-9-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)/g)) out[m[1].replace(/^color-/, '')] = [Number(m[2]) / 100, Number(m[3]), Number(m[4])];
  return out;
}
const css = read('public/tokens.css');
const LIGHT = parseTokens(/** @type {RegExpMatchArray} */ (css.match(/:root \{([\s\S]*?)\n\}/))[1]);
const DARK = { ...LIGHT, ...parseTokens(/** @type {RegExpMatchArray} */ (css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/))[1]) };
const DARK_MEDIA = { ...LIGHT, ...parseTokens(/** @type {RegExpMatchArray} */ (css.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}\n/))[1]) };

test('tokens: 暗い色は 2 か所 (OS の設定と data-theme) で同じ値', () => {
  assert.deepEqual(DARK_MEDIA, DARK);
  assert.ok(Object.keys(DARK).length >= 15);
});

test('tokens: 文字は 4.5:1、部品の縁と focus は 3:1 (design.md §3.1、最も悪い面で)', () => {
  const TEXT = ['ink', 'ink-2', 'muted', 'accent'];
  const SURFACES = ['paper', 'paper-2', 'paper-3', 'cv-desk', 'cv-sheet', 'cv-cursor'];
  for (const [name, P] of [['light', LIGHT], ['dark', DARK]]) {
    for (const f of TEXT) for (const s of SURFACES) assert.ok(ratio(P[f], P[s]) >= 4.5, `${name} ${f} / ${s} = ${ratio(P[f], P[s]).toFixed(2)}`);
    assert.ok(ratio(P['on-accent'], P['accent-fill']) >= 4.5, `${name} on-accent`);
    for (const s of ['paper', 'paper-2', 'paper-3', 'cv-sheet', 'cv-cursor']) {
      assert.ok(ratio(P['rule-strong'], P[s]) >= 3, `${name} rule-strong / ${s} = ${ratio(P['rule-strong'], P[s]).toFixed(2)}`);
      assert.ok(ratio(P.focus, P[s]) >= 3, `${name} focus / ${s}`);
    }
  }
});

test('tokens: 暗い画面でも面と罫線が見える (v0.2 の読みやすさの下限。装飾なので 3:1 は求めない)', () => {
  // the dark side pane was "hard to read" at 1.11 (sheet / desk) and 1.52 (hairline / paper)
  assert.ok(ratio(DARK['cv-sheet'], DARK['cv-desk']) >= 1.25, 'dark sheet / desk');
  assert.ok(ratio(DARK.rule, DARK.paper) >= 1.9, 'dark hairline / paper');
  assert.ok(ratio(DARK.rule, DARK['cv-sheet']) >= 1.6, 'dark column hairline / sheet');
  assert.ok(ratio(DARK['paper-2'], DARK.paper) >= 1.15, 'dark cursor band / paper');
  assert.ok(ratio(LIGHT['cv-sheet'], LIGHT['cv-desk']) >= 1.15, 'light sheet / desk');
  // a hairline as loud as a control border would rule every row like a box
  for (const P of [LIGHT, DARK]) assert.ok(ratio(P.rule, P.paper) < ratio(P['rule-strong'], P.paper) - 1);
});

test('design.md §3 は tokens.css (stamp の下) と 1 字も違わない', () => {
  const body = css.slice(css.indexOf(' */\n\n') + ' */\n\n'.length).replace(/\n+$/, '');
  assert.ok(read('spec/design.md').includes('```css\n' + body + '\n```'), 'copy public/tokens.css below the stamp into design.md §3');
});

test('暗い画面でも本文は 400 (日本語の字に 350 は無く、1 行に 2 つの太さが混ざる)', () => {
  const style = read('public/style.css');
  assert.ok(!/font-weight:\s*350/.test(style));
});

test('文の決まり (design.md §9 の 6): 画面のコードと辞書の文字に「·」のつなぎは無い (コメントは除く)', () => {
  const files = fs.readdirSync(path.join(ROOT, 'public')).filter((n) => n.endsWith('.mjs'));
  assert.ok(files.length > 30);
  for (const f of files) {
    read(`public/${f}`).split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*\*.*$/, '').replace(/\s\/\/\s.*$/, '');
      assert.ok(!code.includes('·'), `public/${f}:${i + 1}`);
    });
  }
});

test('一覧の lede は問いを繰り返さない (すぐ下の行が言う)、親子のリンクは言葉と同じに折り返す (親の題名を切らない)', () => {
  const style = read('public/style.css');
  assert.match(style, /^\.lede__q:not\(\.is-note\) \{ display: none; \}/m, 'どの幅でも');
  const rows = read('public/rows.css');
  assert.match(rows, /\.row__meta \.fam \{[^}]*white-space: normal/);
  assert.doesNotMatch(rows, /text-overflow: ellipsis[^}]*\}\s*\.fam|\.fam__p/, '親の題名を「…」で切らない');
});
