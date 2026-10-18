// smoke: start a server that reads this PC's real data (the Claude app's sessions) read-only on a free port,
// fetch / and /api/board, and check the shape and the counts. Prints counts per pile and stops. Exit 1 on failure.
// Prints only counts and timings (never titles, IDs or paths).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEANUP_REASONS, DEFAULT_PORT, FORBIDDEN_OUTPUT_KEYS } from '../src/shared/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30000;
const READY_RE = /http:\/\/127\.0\.0\.1:\d+/;
const FORMAT_SUSPECTS = [null, 'no_timestamps', 'no_session_files'];
/** @type {string[]} */
const failures = [];
const expect = (/** @type {boolean} */ ok, /** @type {string} */ msg) => {
  if (!ok) failures.push(msg);
};

/** A free port from the OS, never the default port (a board the owner runs may want it). @returns {Promise<number>} */
async function freePort() {
  for (;;) {
    const port = await osPort();
    if (port !== DEFAULT_PORT) return port;
  }
}

/** @returns {Promise<number>} */
function osPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
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

async function main() {
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
    for (const k of FORBIDDEN_OUTPUT_KEYS) expect(!api.text.includes(`"${k}"`), `the output contains ${k}`);
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
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  } finally {
    child.kill();
  }
  if (failures.length) {
    console.error(`smoke: ${failures.length} failures:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log('smoke: OK');
}

main();
