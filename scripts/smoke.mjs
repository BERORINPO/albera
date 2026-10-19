// smoke: start a server that reads this PC's real data (the Claude app's sessions) read-only on a free port,
// fetch / and /api/board, and check the shape and the counts. Prints counts per pile and stops. Exit 1 on failure.
// Prints only counts and timings (never titles, IDs or paths).
// v0.2: one more block for recent sessions, as counts and shares only: context seen, guessed windows, levels, compactions,
// activity seen, share per kind (a warning when 'tool' passes 50%), step coverage, cleaned-text hits. Never names,
// titles, paths, commands or IDs. The JSON is walked as a tree: no forbidden key anywhere, 'state' only inside prs[].
// Every activity label is also checked (counts only) for an absolute path, what a path with spaces leaves, a UUID (or its
// capped head), a long hex run, key-like or secret-looking tokens (key=value, password: x, --password x, user:pass@), an e-mail,
// a URL, and control or invisible characters (the ones cleanText removes): any hit fails.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksSecret } from '../src/core/text.mjs';
import { ACTIVITY_KINDS, CAP, CLEANUP_REASONS, DEFAULT_PORT, FORBIDDEN_OUTPUT_KEYS, FORBIDDEN_WIRE_KEYS } from '../src/shared/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30000;
const READY_RE = /http:\/\/127\.0\.0\.1:\d+/;
const FORMAT_SUSPECTS = [null, 'no_timestamps', 'no_session_files'];
const LEVELS = ['notice', 'due', 'soon'];
const WINDOWS = [200_000, 1_000_000];
const TOOL_WARN_SHARE = 0.5;
// PIGEONHOLES_TEST_PORTS=18970-18989 keeps the smoke server inside a port range (as in test/server.test.mjs)
const PORT_RANGE = /^(\d+)-(\d+)$/.exec(process.env.PIGEONHOLES_TEST_PORTS ?? '');
/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const warnings = [];
const expect = (/** @type {boolean} */ ok, /** @type {string} */ msg) => {
  if (!ok) failures.push(msg);
};

/** A free port from the OS (or from PIGEONHOLES_TEST_PORTS), never the default port (a board the owner runs may want it). @returns {Promise<number>} */
async function freePort() {
  if (PORT_RANGE) {
    const [min, max] = [Number(PORT_RANGE[1]), Number(PORT_RANGE[2])];
    for (let p = min; p <= max; p++) if (p !== DEFAULT_PORT && (await listenOn(p)) === p) return p;
    throw new Error(`no free port in ${min}-${max}`);
  }
  for (;;) {
    const port = await listenOn(0);
    if (port != null && port !== DEFAULT_PORT) return port;
  }
}

/** Bind and release a port (0 = any). @param {number} want @returns {Promise<number|null>} null when it is taken */
function listenOn(want) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(null));
    s.listen(want, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

/** Environment without any PIGEONHOLES_* from the caller, so only the flags below decide. */
function cleanEnv() {
  /** @type {Record<string, string|undefined>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PIGEONHOLES_')) env[k] = v;
  return env;
}

/** @param {number} port */
function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'entry', 'server.mjs'), '--port', String(port), '--lang', 'en'], {
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no startup line')), TIMEOUT_MS);
    child.stdout.on('data', () => {
      if (READY_RE.test(out)) {
        clearTimeout(timer);
        resolve(out.trim());
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited (exit ${code}): ${err.trim()}`));
    });
  });
  return { child, ready };
}

/** @param {number} port @param {string} p @param {Record<string, string>} [headers] */
async function get(port, p, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, etag: res.headers.get('etag'), csp: res.headers.get('content-security-policy'), text: await res.text() };
}

/** @param {any} b */
function checkShape(b) {
  expect(b.v === 2, 'v is not 2');
  const c = b.counts ?? {};
  for (const k of ['needs_you', 'trouble', 'unread', 'working', 'recent', 'cleanup', 'recommended', 'active', 'archived']) {
    expect(Number.isInteger(c[k]) && c[k] >= 0, `counts.${k} is not a non-negative integer`);
  }
  expect(c.needs_you + c.trouble + c.unread + c.working + c.recent + c.cleanup === c.active, 'the piles do not add up to counts.active');
  expect(c.recommended <= c.cleanup, 'more suggestions than archive candidates');
  expect(c.active + c.archived === b.stats.parsed + b.stats.stale, 'active + archived differs from the records read');
  expect(c.active > 0, 'no unarchived sessions (the real data was not read)');
  expect(b.stats.demo === false, 'stats.demo is not false');
  expect(FORMAT_SUSPECTS.includes(b.stats.formatSuspect), `unknown stats.formatSuspect: ${String(b.stats.formatSuspect)}`);
  for (const k of ['needs_you', 'trouble', 'unread', 'working']) expect(Array.isArray(b.buckets?.[k]) && b.buckets[k].length === c[k], `buckets.${k} differs from counts`);
  expect(b.recentGroups.reduce((/** @type {number} */ n, /** @type {any} */ g) => n + g.items.length, 0) === c.recent, 'recentGroups differ from counts.recent');
  expect(b.cleanupGroups.map((/** @type {any} */ g) => g.reason).join() === CLEANUP_REASONS.map((r) => r.key).join(), 'cleanup groups are not in the fixed order');
  expect(b.cleanupGroups.reduce((/** @type {number} */ n, /** @type {any} */ g) => n + g.count, 0) === c.cleanup, 'cleanupGroups differ from counts.cleanup');
  const cards = [...Object.values(b.buckets).flat(), ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items)];
  for (const card of /** @type {any[]} */ (cards)) {
    expect(/^local_[0-9a-f-]{36}$/.test(card.id), 'a card ID has the wrong shape');
    expect(Array.from(card.title).length <= 200 && Array.from(card.body).length <= 600, 'title / body over the cap');
    expect(!('reasonText' in card), 'reasonText is still on the wire (v2 sends codes only)');
  }
  // oldest first for the piles that wait on you
  for (const k of ['needs_you', 'trouble', 'unread']) {
    const s = b.buckets[k].map((/** @type {any} */ x) => x.since);
    expect(s.every((/** @type {number} */ v, /** @type {number} */ i) => i === 0 || s[i - 1] <= v), `buckets.${k} is not oldest first`);
  }
}

/** Every key in the JSON tree, and how often 'state' sits outside an element of a `prs` array. @param {unknown} root */
function wireKeys(root) {
  /** @type {Set<string>} */
  const keys = new Set();
  let stateOutsidePrs = 0;
  /** @param {unknown} v @param {boolean} inPr */
  const walk = (v, inPr) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, false);
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      if (k === 'state' && !inPr) stateOutsidePrs++;
      if (k === 'prs' && Array.isArray(x)) for (const pr of x) walk(pr, true);
      else walk(x, false);
    }
  };
  walk(root, false);
  return { keys, stateOutsidePrs };
}

const cps = (/** @type {unknown} */ s) => (typeof s === 'string' ? Array.from(s).length : 0);
const pct = (/** @type {number} */ n, /** @type {number} */ of) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '-');

// What must never reach a label (activity.target / note / step) after commandHead and cleanText: every hit of these
// fails the smoke. A '/' or '\' on its own (and/or, a relative path, a regex) is only counted. Strings are never printed.
// (the same shapes and thresholds as cleanText in src/core/text.mjs, so a hit means it slipped through; the long-run rule is cleanText's own looksSecret)
const longMixedRun = (/** @type {string} */ v) => (v.match(/[A-Za-z0-9+/_-]{24,}/g) ?? []).some(looksSecret);
// password: x / token = x / --password x with a value that is not masked and not one lowercase word; user:pass@ with an unmasked pass
const SPACED_SECRET_RE = /\b(?:password|passwd|passphrase|pass|pwd|secret|token)\b(?:\s*[:=]\s+|\s+[:=]\s*)(?!•••)(?![a-z]+[.,;:!?]?(?:\s|$))\S/i;
const FLAG_SECRET_RE = /(?<![\w-])--(?:password|passwd|pass|pwd|token|secret|api-?key|auth-?token)\s+(?!•••)(?!-)\S/i;
const USERINFO_RE = /[\w.%+-]+:(?!•••)[^\s@/:]+@[\w-]/;
/** @type {Record<string, RegExp | ((v: string) => boolean)>} */
const LEAKS = {
  absPath: /(?:^|[\s"'(=:])(?:[A-Za-z]:[\\/]|\\\\\w|\\(?:Users|home)\\|\/(?:Users|home|mnt|var|tmp|etc|opt|private|srv|root)\/|~[A-Za-z0-9._-]*[\\/])/,
  // what a Windows path with spaces leaves when only its first part was cut: a segment with a space between two backslashes
  spacedPath: /\\[^\\\n]* [^\\\n]*\\/,
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/i,
  hex: /[0-9a-f]{16,}/i,
  key: /\b(?:(?:sk-|gh[pousr]_|xox[a-z]-|glpat-)[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{16,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})|\b(?:Bearer|Basic|Token)\s+(?!•••)[A-Za-z0-9._~+/=-]{8,}/,
  token: longMixedRun,
  secret: (v) => /\b[\w.-]*(?:pass|pwd|token|secret|key|auth)[\w.-]*(?:=|:(?![\s/]))(?!•••)\S/i.test(v) || SPACED_SECRET_RE.test(v) || FLAG_SECRET_RE.test(v) || USERINFO_RE.test(v),
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/,
  url: /\b(?:https?|ftp|file):\/\//i,
  // control characters and the invisible ones cleanText removes (format characters such as bidi overrides, zero width, soft hyphen, tags)
  control: /[\u0000-\u001f\u007f-\u009f͏ᅟᅠㅤ︀-️]|\p{Cf}/u,
};
const COUNT_ONLY = { slash: /\//, backslash: /\\/ };
/** Every leak check fires on each of its synthetic samples and stays quiet on plain words (no green while checking nothing). */
function leakSelfTest() {
  const bs = String.fromCharCode(92);
  const pw = ['hun', 'ter2'].join('');
  /** @type {Record<string, string[]>} */
  const samples = {
    absPath: [`Read C:${bs}work${bs}plan.md`, `path:C:${bs}x${bs}y.md`, `Read ${bs}Users${bs}x${bs}y.md`, 'Edit ~someone/notes/x.md'],
    spacedPath: [`List Some One${bs}OneDrive - Example${bs}x`],
    uuid: ['123e4567-e89b-12d3-a456-426614174000', '12345678-1234-1234-1234-1234567…'],
    hex: ['deadbeefdeadbeef00'],
    key: ['use sk-' + 'A1b2C3d4'],
    token: ['abc123DEF456ghi789JKL012mno'],
    secret: ['API_TOKEN=' + 'x'.repeat(4), `Use password: ${pw}`, `--password ${pw}`, `admin:${pw}@host`, `pwd=${pw}`],
    email: ['someone@example.com'],
    url: ['see https://example.com'],
    control: [`a${String.fromCharCode(27)}[31m`, `a${String.fromCharCode(0x202e)}b`, `a${String.fromCharCode(0xad)}b`, `a${String.fromCharCode(0x200b)}b`],
  };
  const plain = ['Run the unit tests for parser.mjs: step 2/3', 'Check token: expiry', 'Edit 2026-10-18-release-notes.md', `Edit src${bs}core${bs}text.mjs`];
  for (const [k, c] of Object.entries(LEAKS)) {
    const hit = (/** @type {string} */ v) => (typeof c === 'function' ? c(v) : c.test(v));
    for (const s of samples[k] ?? ['']) expect(hit(s), `the label check ${k} misses one of its own samples`);
    for (const p of plain) expect(!hit(p), `the label check ${k} fires on plain words`);
  }
}
/** Counts per kind (never the strings). @param {string[]} labels @param {Record<string, RegExp | ((v: string) => boolean)>} checks */
function countHits(labels, checks) {
  return Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, labels.filter((v) => (typeof c === 'function' ? c(v) : c.test(v))).length]));
}

/** The v0.2 fields: shape checks, then counts and shares only (never content). @param {any} b */
function checkLabels(b) {
  const s = b.stats;
  expect(Number.isInteger(s.contextSeen) && s.contextSeen >= 0, 'stats.contextSeen is not a non-negative integer');
  expect(Number.isInteger(s.activitySeen) && s.activitySeen >= 0, 'stats.activitySeen is not a non-negative integer');
  expect(typeof s.contextSuspect === 'boolean', 'stats.contextSuspect is not a boolean');
  const live = /** @type {any[]} */ ([...Object.values(b.buckets).flat(), ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items)]);
  const archive = /** @type {any[]} */ (b.cleanupGroups.flatMap((/** @type {any} */ g) => [...(g.items ?? []), ...(g.projects ?? []).flatMap((/** @type {any} */ p) => p.items)]));
  expect(archive.every((c) => !c.activity && !c.context && c.detail?.contextExceeded == null), 'a To archive card carries activity, context or contextExceeded');
  expect(b.buckets.needs_you.every((/** @type {any} */ c) => !c.activity), 'a Needs you card carries activity');
  const ctx = live.filter((c) => c.context).map((c) => c.context);
  if (s.contextSuspect) expect(ctx.length === 0, 'contextSuspect is on but cards still carry context');
  for (const c of ctx) {
    expect(WINDOWS.includes(c.window) && typeof c.inferred === 'boolean', 'a context has an unknown window');
    expect(Number.isInteger(c.pct) && c.pct >= 0 && c.pct <= 100 && c.used >= 0 && c.compactAt > 0, 'a context has numbers out of range');
    expect(c.level == null || LEVELS.includes(c.level), 'a context has an unknown level');
  }
  const acts = live.filter((c) => c.activity);
  for (const c of acts) {
    const a = c.activity;
    expect(ACTIVITY_KINDS.includes(a.kind), 'an activity has an unknown kind');
    expect(a.live === (c.bucket === 'working'), 'activity.live differs from the Working pile');
    expect(cps(a.target) <= CAP.ACT_TARGET && cps(a.note) <= CAP.ACT_TEXT && cps(a.step) <= CAP.ACT_TEXT, 'an activity string is over the cap');
  }
  const byLevel = LEVELS.map((l) => `${l} ${ctx.filter((c) => c.level === l).length}`).join(' · ');
  const guessed = ctx.filter((c) => c.inferred);
  const pastGuess = guessed.filter((c) => c.used > c.compactAt).length;
  const compacted = ctx.filter((c) => c.compacted).length;
  console.log(
    `context (recent): seen ${s.contextSeen} of ${s.recentWithTranscript} with a transcript · on cards ${ctx.length} · guessed windows ${guessed.length} (past the guessed compact point ${pastGuess}) · ${byLevel} · compactions seen ${compacted} · format suspect ${s.contextSuspect}`,
  );
  /** @type {Record<string, number>} */
  const kinds = {};
  for (const c of acts) kinds[c.activity.kind] = (kinds[c.activity.kind] ?? 0) + 1;
  const shares = Object.entries(kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${pct(n, acts.length)}`).join(' · ');
  const texts = acts.flatMap((c) => [c.activity.note, c.activity.step]).filter((v) => typeof v === 'string');
  const masked = texts.filter((v) => v.includes('•••')).length;
  const shortened = texts.filter((v) => v.includes('…')).length;
  const steps = acts.filter((c) => c.activity.step).length;
  const notes = acts.filter((c) => c.activity.note).length;
  console.log(`activity (recent): seen ${s.activitySeen} · on cards ${acts.length} · kinds: ${shares || 'none'}`);
  console.log(`activity words: steps ${pct(steps, acts.length)} · notes ${pct(notes, acts.length)} · cleaned: masked ${masked} · shortened ${shortened}`);
  const labels = acts.flatMap((c) => [c.activity.target, c.activity.note, c.activity.step]).filter((v) => typeof v === 'string');
  const leaks = countHits(labels, LEAKS);
  const seps = countHits(labels, COUNT_ONLY);
  console.log(`label checks (${labels.length} strings): ${Object.entries({ ...leaks, ...seps }).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  for (const [k, n] of Object.entries(leaks)) if (n > 0) failures.push(`${n} activity label(s) look like ${k} (cleanText or commandHead let it through)`);
  if (acts.length > 0 && (kinds.tool ?? 0) / acts.length > TOOL_WARN_SHARE) {
    warnings.push(`'tool' is ${pct(kinds.tool, acts.length)} of the activity kinds: tool names or shapes may have changed`);
  }
}

async function main() {
  leakSelfTest();
  const port = await freePort();
  const { child, ready } = startServer(port);
  try {
    console.log(await ready);
    const page = await get(port, '/');
    expect(page.status === 200 && page.text.includes('name="pigeonholes"'), `/ is not the 200 board page (${page.status})`);
    expect(!!page.csp && page.csp.includes("default-src 'self'"), 'no CSP header');
    const t0 = Date.now();
    const api = await get(port, '/api/board');
    const ms = Date.now() - t0;
    expect(api.status === 200, `/api/board is not 200 (${api.status})`);
    const b = JSON.parse(api.text);
    checkShape(b);
    const wire = wireKeys(b);
    for (const k of [...FORBIDDEN_OUTPUT_KEYS, ...FORBIDDEN_WIRE_KEYS]) expect(!wire.keys.has(k), `the output has the key ${k}`);
    expect(wire.stateOutsidePrs === 0, `'state' appears outside prs[] (${wire.stateOutsidePrs} times)`);
    const again = await get(port, '/api/board', api.etag ? { 'If-None-Match': api.etag } : {});
    expect(again.status === 304 || again.status === 200, `the second /api/board is ${again.status}`);
    const c = b.counts;
    const s = b.stats;
    console.log(`piles: needs you ${c.needs_you} · stuck? ${c.trouble} · unread ${c.unread} · working ${c.working} · recent ${c.recent} · to archive ${c.cleanup} (suggested ${c.recommended})`);
    console.log(`total: unarchived ${c.active} · archived ${c.archived}`);
    console.log(`to archive by reason: ${b.cleanupGroups.map((/** @type {any} */ g) => `${g.reason} ${g.count}`).join(' · ')}`);
    console.log(`read: files ${s.files} · parsed ${s.parsed} · unreadable ${s.bad} · previous value ${s.stale} · recent ${s.recentTotal} (with transcript ${s.recentWithTranscript} / missing ${s.transcriptsMissingRecent} / unknown format ${s.unknownTurnRecent})`);
    console.log(`format suspect: ${s.formatSuspect ?? 'none'} · transcripts folder missing: ${s.transcriptsDirMissing}`);
    console.log(`time: build ${s.scanMs} ms · fetch ${ms} ms · second fetch ${again.status} · body ${Math.round(api.text.length / 1024)} KB`);
    checkLabels(b);
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  } finally {
    child.kill();
  }
  for (const w of warnings) console.log(`smoke: warning: ${w}`);
  if (failures.length) {
    console.error(`smoke: ${failures.length} failures:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log('smoke: OK');
}

main();
