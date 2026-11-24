// Architecture check (npm run arch). Reads table 1 of spec/architecture.md and checks the dependency
// direction, forbidden APIs, fake pairs and cycles. False-safe: a rule that checked nothing fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['shared', 'core', 'adapter', 'entry'];
const ALLOWED = {
  shared: ['shared'],
  core: ['core', 'shared'],
  adapter: ['adapter', 'core', 'shared', 'node'],
  entry: ['entry', 'adapter', 'core', 'shared', 'node'],
};
const FORBIDDEN_IN_PURE = [
  [/\bprocess\./, 'process'],
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/new\s+Date\s*\(\s*\)/, 'new Date()'],
  [/\bperformance\.now\s*\(/, 'performance.now()'],
  [/\bfetch\s*\(/, 'fetch('],
  [/\bcrypto\.subtle\b/, 'crypto.subtle'],
  [/\brequire\s*\(/, 'require('],
  [/\bimport\s*\(/, 'import('],
];
const FORBIDDEN_IN_TEMPLATE = [
  [/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/, 'HTML string injection'],
  [/\b(?:src|href)\s*=\s*["']https?:/i, 'external resource'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, 'network call'],
];
const ALLOW_MARK = /\/\/ arch-allow: \S/;
// The one outside link the page may hold (owner's decision 2026-11-25, spec/architecture.md): a plain <a> to the fixed
// ALBERA issue form, opened by a click. It loads nothing and carries nothing from the map. Exactly this attribute, only in
// template.html, at most once; any other https link is still an "external resource".
export const ALLOWED_LINK = 'href="https://github.com/BERORINPO/albera/issues/new?template=from-a-copy.yml"';
/** The text with the allowed link removed, and how many were removed (only <a> tags count). */
export function withoutAllowedLink(text) {
  let removed = 0;
  const out = text.replace(/<a\b[^>]*>/g, (tag) => {
    if (!tag.includes(ALLOWED_LINK)) return tag;
    removed++;
    return tag.split(ALLOWED_LINK).join('');
  });
  return { text: out, removed };
}

function roleTable() {
  const md = readFileSync(join(ROOT, 'spec', 'architecture.md'), 'utf8');
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes('役割対応表'));
  assert.ok(at >= 0, 'spec/architecture.md has no 役割対応表');
  const table = {};
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const cells = line.split('|').map((c) => c.trim());
    if (ROLES.includes(cells[1])) table[cells[1]] = cells[2].split(/\s+/).filter(Boolean);
  }
  return table;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const SPEC_PATTERNS = [
  /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
// Block comments become the same number of newlines so line numbers survive. A line comment needs
// whitespace (or the line start) before "//", so "//" inside a string or regex like /^https:\/\// stays code.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/.*$/gm, '$1');

/** Forbidden-API hits in one file's text: [{line, name}] plus how many were suppressed by arch-allow. */
export function scanForbidden(text, rules = FORBIDDEN_IN_PURE) {
  const original = text.split(/\r?\n/);
  const hits = [];
  let allowed = 0;
  stripComments(text).split(/\r?\n/).forEach((code, i) => {
    for (const [re, name] of rules) {
      if (!re.test(code)) continue;
      if (ALLOW_MARK.test(original[i] || '')) { allowed++; continue; }
      hits.push({ line: i + 1, name });
    }
  });
  return { hits, allowed };
}
const specifiers = (text) => SPEC_PATTERNS.flatMap((re) => [...stripComments(text).matchAll(re)].map((m) => m[1]));
const isBuiltin = (s) => s.startsWith('node:') || builtinModules.includes(s);

// ---------- collect ----------
const table = roleTable();
const files = []; // {abs, rel, role, text}
const missingPaths = [];
for (const role of ROLES) {
  for (const p of table[role] || []) {
    const abs = join(ROOT, p);
    let ok = false;
    try { ok = statSync(abs).isDirectory(); } catch { ok = false; }
    if (!ok) { missingPaths.push(p); continue; }
    for (const f of walk(abs)) {
      files.push({ abs: f, rel: relative(ROOT, f).replace(/\\/g, '/'), role, text: readFileSync(f, 'utf8') });
    }
  }
}
const roleOfFile = (abs) => files.find((f) => f.abs === abs)?.role ?? null;
const jsFiles = files.filter((f) => /\.m?js$/.test(f.abs));
const edges = []; // {from, to, fromRole, toRole}
const problems = { direction: [], packages: [] };
for (const f of jsFiles) {
  for (const s of specifiers(f.text)) {
    if (s.startsWith('.')) {
      const target = resolve(dirname(f.abs), s);
      const toRole = roleOfFile(target);
      edges.push({ from: f.abs, to: target, fromRole: f.role, toRole });
      if (!toRole) problems.direction.push(`${f.rel} imports ${s}, which is outside table 1`);
      else if (!ALLOWED[f.role].includes(toRole)) problems.direction.push(`${f.rel} (${f.role}) imports ${toRole}: ${s}`);
    } else if (isBuiltin(s)) {
      edges.push({ from: f.abs, to: s, fromRole: f.role, toRole: 'node' });
      if (!ALLOWED[f.role].includes('node')) problems.direction.push(`${f.rel} (${f.role}) imports a node built-in: ${s}`);
    } else problems.packages.push(`${f.rel} imports package ${s} (dependencies must stay at 0)`);
  }
}
let suppressed = 0;

// ---------- tests ----------
test('arch: table 1 paths exist and every role has files (false-safe)', () => {
  assert.deepEqual(missingPaths, [], `paths in table 1 that do not exist: ${missingPaths.join(' ')}`);
  for (const role of ROLES) assert.ok(jsFiles.some((f) => f.role === role), `role ${role} has no .mjs/.js file`);
});

test('arch: dependency direction entry -> adapter -> core -> shared', () => {
  assert.ok(edges.length > 0, 'no import was checked (false-safe)');
  assert.ok(edges.some((e) => e.toRole === 'shared'), 'no import into shared was checked (false-safe)');
  assert.deepEqual(problems.direction, []);
  assert.deepEqual(problems.packages, []);
});

test('arch: core and shared use no outside world (process, clock, network, dynamic import)', () => {
  const pure = jsFiles.filter((f) => f.role === 'core' || f.role === 'shared');
  assert.ok(pure.length > 0, 'no core/shared file scanned (false-safe)');
  const hits = [];
  for (const f of pure) {
    const found = scanForbidden(f.text);
    suppressed += found.allowed;
    hits.push(...found.hits.map((h) => `${f.rel}:${h.line} uses ${h.name}`));
  }
  console.log(`arch: forbidden-API scan over ${pure.length} files, arch-allow suppressions: ${suppressed}`);
  assert.deepEqual(hits, []);
});

test('arch: every adapter has a fake-*.mjs pair', () => {
  const adapters = jsFiles.filter((f) => f.role === 'adapter');
  const real = adapters.filter((f) => !f.rel.split('/').pop().startsWith('fake-'));
  assert.ok(real.length > 0, 'no adapter found (false-safe)');
  const names = new Set(adapters.map((f) => f.rel.split('/').pop()));
  const lacking = real.map((f) => f.rel.split('/').pop()).filter((n) => !names.has(`fake-${n}`));
  assert.deepEqual(lacking, [], `adapters without fake: ${lacking.join(' ')}`);
});

test('arch: no import cycles', () => {
  const graph = new Map(jsFiles.map((f) => [f.abs, []]));
  for (const e of edges) if (graph.has(e.from) && graph.has(e.to)) graph.get(e.from).push(e.to);
  assert.ok([...graph.values()].some((v) => v.length), 'no file-to-file import (false-safe)');
  const state = new Map();
  const cycles = [];
  const visit = (n, trail) => {
    state.set(n, 1);
    for (const m of graph.get(n)) {
      if (state.get(m) === 1) cycles.push([...trail, n, m].map((p) => relative(ROOT, p)).join(' -> '));
      else if (!state.has(m)) visit(m, [...trail, n]);
    }
    state.set(n, 2);
  };
  for (const n of graph.keys()) if (!state.has(n)) visit(n, []);
  assert.deepEqual(cycles, []);
});

test('arch: the HTML template builds no HTML from strings and loads nothing from outside', () => {
  // The page code lives in template.html and src/entry/page/*.js (joined into one <script> by render.mjs).
  const templates = files.filter((f) => f.role === 'entry' && (f.abs.endsWith('.html') || /[\\/]page[\\/][^\\/]+\.js$/.test(f.abs)));
  assert.ok(templates.some((f) => f.abs.endsWith('.html')), 'no template found (false-safe)');
  assert.ok(templates.filter((f) => f.abs.endsWith('.js')).length >= 3, 'page scripts not scanned (false-safe)');
  let allowedLinks = 0;
  const hits = templates.flatMap((f) => {
    const { text, removed } = f.abs.endsWith('.html') ? withoutAllowedLink(f.text) : { text: f.text, removed: 0 };
    allowedLinks += removed;
    return FORBIDDEN_IN_TEMPLATE.filter(([re]) => re.test(text)).map(([, name]) => `${f.rel}: ${name}`);
  });
  console.log(`arch: allowed outside links in the page: ${allowedLinks} (at most 1)`);
  assert.ok(allowedLinks <= 1, 'the allowed link appears more than once');
  assert.deepEqual(hits, []);
});

test('arch self-test: only the exact allowed link passes; any other https link is still caught', () => {
  const rule = FORBIDDEN_IN_TEMPLATE.find(([, name]) => name === 'external resource')[0];
  const ok = withoutAllowedLink(`<a class="x" ${ALLOWED_LINK} target="_blank">a</a>`);
  assert.equal(ok.removed, 1);
  assert.ok(!rule.test(ok.text));
  for (const bad of [
    '<a href="https://github.com/BERORINPO/albera/issues/new?template=from-a-copy.yml&body=x">a</a>',
    '<a href="https://example.com/">a</a>',
    `<img src="https://e.invalid/x.png" data-x='${ALLOWED_LINK}'>`,
    `<a ${ALLOWED_LINK}>a</a><link href="https://e.invalid/x.css">`,
  ]) assert.ok(rule.test(withoutAllowedLink(bad).text), bad);
});

test('arch self-test: the forbidden-API scan fails on planted violations (false-safe guard)', () => {
  const planted = [
    "const u = 'a//b'; process.env.X;",
    'if (/^https:\\/\\//.test(x)) fetch(y);',
    '/* a',
    '   b */ const t = Date.now();',
    '// process.env in a comment is fine',
    'const ok = 1; // fet( in a trailing comment is fine',
    'const k = process.env.K; // arch-allow: planted to test the mark',
  ].join('\n');
  const { hits, allowed } = scanForbidden(planted);
  assert.deepEqual(hits, [
    { line: 1, name: 'process' },
    { line: 2, name: 'fetch(' },
    { line: 4, name: 'Date.now()' },
  ]);
  assert.equal(allowed, 1);
});
