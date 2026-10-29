// Control room host (spec/room.md): the desktop wall turned into a canvas, plus Bero's events and one write route.
// Same host model as desktop-wall-host: 127.0.0.1 only, Host/Origin checks, one-time bootstrap code -> HttpOnly
// SameSite=Strict cookie, CSP, no-store, safe error codes. Screens are captured with a view-only (HUMAN) lease.
// The only write route is POST api/decide: it runs the Effect of an open card that this host itself showed.
// The task text of a started job is fixed English built here; nothing from a request body reaches a task.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEnvironmentId } from './environment-provider.mjs';
import { cleanText, isCode, isId, validAct, validCheck, validCheckReport, validLedgerEntry, EFFECTS, LEDGER_CODES, MAX_CHECKS_PER_VM, MAX_TEXT } from './room-contract.mjs';

export const ROOM_DESKTOP_SESSION_ID = 'room-view';
export const ROOM_OWNER_ID = 'room-viewer';
export const MAX_ROOM_VMS = 8;
export const MAX_STATE_EVENTS = 200;
export const MAX_PINNED_FRAMES = 8;
const MAX_KEPT_EVENTS = 2000;
const MAX_KEPT_CARDS = 64;
const MAX_CONCURRENT_CAPTURES = 2;
const MAX_CONNECTIONS = 64;
const MAX_SESSIONS = 8;
const MAX_SESSION_BODY = 1024;
const MAX_DECIDE_BODY = 256;
const BODY_TIMEOUT_MS = 5_000;
const STOP_WAIT_MS = 5_000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const LEASE_TTL_MS = 60_000;
const MAX_TASK_LENGTH = 2000;
const BASE = '/room/';
const LABEL_RE = /^[\x20-\x7e]{1,32}$/;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const UI_NAMES = ['room.css', 'cam.css', 'figure.css', 'bero.css', 'canvas.mjs', 'app.mjs', 'api.mjs', 'i18n.mjs', 'words-canvas.mjs',
  'cam.mjs', 'words-cam.mjs', 'figure.mjs', 'ledger.mjs', 'words-figure.mjs', 'bero.mjs', 'cards.mjs', 'words-bero.mjs'];
const UI_FILES = Object.freeze(Object.fromEntries([['/', 'index.html'], ...UI_NAMES.map((name) => [`/${name}`, name])]
  .map(([route, name]) => [route, Object.freeze([`room-ui/${name}`, TYPES[path.extname(name)]])])));
const SAFE_ERROR_CODES = new Set([
  'desktop_broker_timeout', 'desktop_input_rejected', 'desktop_unavailable', 'desktop_vm_not_found',
  'invalid_desktop_screen_data', 'invalid_desktop_vm', 'invalid_desktop_lease', 'desktop_lease_unavailable',
  'desktop_lease_stale', 'desktop_lease_expired', 'desktop_lease_owner_mismatch', 'desktop_lease_session_mismatch',
]);
const DECIDE_CODES = new Set(['card_unknown', 'card_closed', 'choice_unknown']);
const CHECK_TIMEOUT_MS = 65_000; // the checker's own limit is 60 s; this one only keeps a VM's queue moving
const CHECK_CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;

/** Fixed task texts for card effects. Only the VM's own task (given at start) is ever added to them. */
export const NUDGE_TASK = 'Something may be blocking the screen, such as a dialog or a message box. '
  + 'Close or answer it in the safest way (do not delete or discard anything), then reply with one line starting with DONE. '
  + 'If you cannot, reply with one line starting with FAILED and the reason.';
export function recheckTask(task) {
  return 'Do not change anything on this desktop. Look at the screen (take screenshots, scroll if needed) and decide whether '
    + `this task is really done: "${cleanText(task, MAX_TASK_LENGTH)}". Reply with one line starting with DONE if the screen shows it is done, `
    + 'or with one line starting with FAILED and what is missing.';
}

/**
 * @param {{vms: {vmId: string, label?: string, task?: string}[], driver: object|Function, board: object, journal: object,
 *   director: object, fleet: object, captureIntervalMs?: number, staleAfterMs?: number, tickMs?: number, now?: () => number}} options
 * `driver` is `capture({vmId, lease})` or a factory `(resolveCurrentLease) => driver`, as for the wall.
 * `vms[].task` is the task the VM's hands were first given; `recheck` asks about it.
 * Wire the fleet's `onEvent` to `host.recordFleetEvent` so hands entries reach the journal in order.
 * Automatic checks (spec/room.md §7): `checks` = { vmId: Check[] } and `checker.run(vmId, checks)`. When a VM with
 * checks ends with `claimed_done`, `check_started` is recorded before `hands_ended`, the checker runs (one at a time
 * per VM) and `check_done` records the verdict. VMs without checks behave as before.
 */
export function createRoomHost({
  vms, driver, board, journal, director, fleet, checker = null, checks = {}, checkTimeoutMs = CHECK_TIMEOUT_MS,
  captureIntervalMs = 1000, staleAfterMs = 10_000, tickMs = 1000, now = Date.now,
} = {}) {
  const tiles = normalizeVms(vms);
  const checksByVm = normalizeChecks(checks, tiles);
  if (checksByVm.size > 0 && typeof checker?.run !== 'function') throw new TypeError('room host requires a checker with run() when checks are given');
  if (!Number.isInteger(checkTimeoutMs) || checkTimeoutMs < 10 || checkTimeoutMs > 600_000) throw new TypeError('checkTimeoutMs must be between 10 and 600000');
  if (!Number.isInteger(captureIntervalMs) || captureIntervalMs < 10 || captureIntervalMs > 60_000) throw new TypeError('captureIntervalMs must be between 10 and 60000');
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 100 || staleAfterMs > 3_600_000) throw new TypeError('staleAfterMs must be between 100 and 3600000');
  if (!Number.isInteger(tickMs) || tickMs < 10 || tickMs > 60_000) throw new TypeError('tickMs must be between 10 and 60000');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof board?.snapshot !== 'function') throw new TypeError('room host requires a board with snapshot()');
  if (!['record', 'recordFleetEvent', 'since', 'lastSeq'].every((m) => typeof journal?.[m] === 'function')) throw new TypeError('room host requires a room journal');
  if (typeof director?.tick !== 'function' || typeof director?.decide !== 'function') throw new TypeError('room host requires a Bero director');
  if (!['startJob', 'stopVm'].every((m) => typeof fleet?.[m] === 'function')) throw new TypeError('room host requires a fleet with startJob() and stopVm()');

  let leaseExpiresAt = now() + LEASE_TTL_MS;
  const currentLease = () => ({
    desktopSessionId: ROOM_DESKTOP_SESSION_ID, ownerType: 'HUMAN', ownerId: ROOM_OWNER_ID,
    generation: 1, expiresAt: new Date(leaseExpiresAt).toISOString(),
  });
  const viewDriver = typeof driver === 'function' ? driver(async () => currentLease()) : driver;
  if (!viewDriver || typeof viewDriver.capture !== 'function') throw new TypeError('room host requires a driver with capture()');

  const byId = new Map(tiles.map((tile) => [tile.vmId, tile]));
  const frames = new Map(tiles.map((tile) => [tile.vmId, { png: null, capturedAt: null, error: null }]));
  const pinned = new Map(); // frameId -> png (oldest first)
  const events = []; // RoomEvent[], seq ascending
  const cards = new Map(); // cardId -> { vmId, code, choices, closed }
  const checkChains = new Map(); // vmId -> the promise of the VM's last queued check
  const bootstrapCode = randomBytes(32).toString('base64url');
  // Cookies do not separate ports: every host gets its own cookie name (fixed at listen), so two rooms
  // (or a room and a demo) on 127.0.0.1 never overwrite each other's session.
  let cookieName = `albera_room_${randomBytes(6).toString('hex')}`;
  const sessions = new Map();
  let bootstrapUsed = false;
  let eventSeq = 0;
  let frameSeq = 0;
  let cursor = 0; // last journal seq handed to the director
  let captureTimer;
  let tickTimer;
  let serverPort;
  let closed = false;
  let active = 0;
  const queue = [];
  const queued = new Map();
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 5_000;
  server.requestTimeout = BODY_TIMEOUT_MS + 5_000;
  server.keepAliveTimeout = 5_000;

  // ---- capture (same queueing as the wall: one capture per VM at a time, at most 2 at once) ----

  function captureOnce() { return Promise.all(tiles.map((tile) => schedule(tile.vmId))); }

  function schedule(vmId) {
    if (closed) return Promise.resolve();
    if (queued.has(vmId)) return queued.get(vmId);
    const job = new Promise((resolve) => { queue.push({ vmId, resolve }); });
    queued.set(vmId, job);
    pump();
    return job;
  }

  function pump() {
    while (!closed && active < MAX_CONCURRENT_CAPTURES && queue.length > 0) {
      const job = queue.shift();
      active++;
      void captureVm(job.vmId).finally(() => { active--; queued.delete(job.vmId); job.resolve(); pump(); });
    }
    if (closed) for (const job of queue.splice(0)) { queued.delete(job.vmId); job.resolve(); }
  }

  async function captureVm(vmId) {
    const frame = frames.get(vmId);
    leaseExpiresAt = now() + LEASE_TTL_MS;
    try {
      const shot = await viewDriver.capture({ vmId, lease: currentLease() });
      if (closed) return;
      if (!(shot?.png instanceof Uint8Array)) throw Object.assign(new Error('x'), { code: 'invalid_desktop_screen_data' });
      frame.png = Buffer.from(shot.png);
      frame.capturedAt = now();
      frame.error = null;
    } catch (error) {
      if (!closed) frame.error = safeErrorCode(error);
    }
  }

  /** Keep the VM's current frame under a new id (at most 8 kept, the oldest is dropped). null when there is none. */
  function pinFrame(vmId) {
    const png = frames.get(vmId)?.png;
    if (!png) return null;
    const frameId = `frame-${++frameSeq}`;
    pinned.set(frameId, png);
    while (pinned.size > MAX_PINNED_FRAMES) pinned.delete(pinned.keys().next().value);
    return frameId;
  }

  // ---- events, tick, journal ----

  function push(event) {
    const next = { seq: eventSeq + 1, ...event };
    eventSeq = next.seq;
    events.push(Object.freeze(next));
    if (events.length > MAX_KEPT_EVENTS) events.splice(0, events.length - MAX_KEPT_EVENTS);
  }

  /**
   * Fleet onEvent -> journal. A job start becomes `hands_started` with its task; other events go to the journal as is.
   * A DONE claim on a VM with checks first records `check_started` (so it comes before `hands_ended`), then queues the check.
   */
  function recordFleetEvent(vmId, event) {
    if (closed || !byId.has(vmId)) return;
    const vmChecks = event?.type === 'end' && event.outcome === 'claimed_done' ? checksByVm.get(vmId) : undefined;
    try {
      if (event?.type === 'start') journal.record({ vmId, actor: 'hands', code: 'hands_started', params: { task: cleanText(event.task) } });
      else {
        if (vmChecks) journal.record({ vmId, actor: 'bero', code: 'check_started', params: { count: vmChecks.length } });
        journal.recordFleetEvent(vmId, event);
      }
    } catch { /* a journal failure must not stop the hands */ }
    if (vmChecks) queueCheck(vmId, vmChecks);
  }

  // ---- automatic checks (one at a time per VM; the checker never sees anything but the VM id and its fixed checks) ----

  function queueCheck(vmId, vmChecks) {
    const next = (checkChains.get(vmId) ?? Promise.resolve()).then(() => runCheck(vmId, vmChecks));
    checkChains.set(vmId, next);
    void next.finally(() => { if (checkChains.get(vmId) === next) checkChains.delete(vmId); });
  }

  async function runCheck(vmId, vmChecks) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ verdict: 'unavailable', results: [], code: 'guest_check_timeout' }), checkTimeoutMs);
      timer.unref?.();
    });
    let report;
    try { report = await Promise.race([Promise.resolve().then(() => checker.run(vmId, vmChecks)), timeout]); }
    catch { report = { verdict: 'unavailable', results: [], code: 'guest_check_failed' }; }
    finally { clearTimeout(timer); }
    if (!validCheckReport(report, vmChecks.length)) report = { verdict: 'unavailable', results: [], code: 'guest_check_invalid' };
    if (closed) return;
    try { journal.record({ vmId, actor: 'bero', code: 'check_done', params: checkDoneParams(report, vmChecks.length) }); } catch { /* keep going */ }
  }

  function validDirectorLedger(item) {
    return Boolean(item) && item.actor === 'bero' && isCode(item.code, LEDGER_CODES) && (item.vmId === null || byId.has(item.vmId));
  }

  /** Fill a 'ba' figure's empty `before` frame with the VM's current frame. Returns a new act (the input is not changed). */
  function withPinnedFrame(act) {
    const figure = act.type === 'card' ? act.card?.figure : act.type === 'figure' ? act.figure : null;
    if (figure?.kind !== 'ba' || !byId.has(figure.vmId) || figure.before?.frameId) return act;
    const filled = { ...figure, before: { frameId: pinFrame(figure.vmId) } };
    return act.type === 'card' ? { ...act, card: { ...act.card, figure: filled } } : { ...act, figure: filled };
  }

  function acceptAct(raw) {
    const act = withPinnedFrame(raw);
    if (!validAct(act)) return;
    if (act.type === 'card') {
      if (!byId.has(act.card.vmId) || cards.has(act.card.cardId)) return;
      cards.set(act.card.cardId, { vmId: act.card.vmId, code: act.card.code, choices: act.card.choices.map((c) => ({ ...c })), closed: false });
      trimCards();
    }
    push({ kind: 'bero', act });
  }

  function trimCards() {
    for (const [cardId, card] of cards) {
      if (cards.size <= MAX_KEPT_CARDS) return;
      if (card.closed) cards.delete(cardId);
    }
  }

  function readEntries() {
    try { return journal.since(cursor).filter(validLedgerEntry); } catch { return []; }
  }

  /** One round: new journal entries -> ledger events -> director -> its ledger items and acts. Synchronous. */
  function tickOnce() {
    if (closed) return;
    const entries = readEntries();
    for (const entry of entries) { push({ kind: 'ledger', entry }); cursor = Math.max(cursor, entry.seq); }
    let out;
    try { out = director.tick({ now: now(), agents: board.snapshot(), entries }); } catch { out = null; }
    for (const item of Array.isArray(out?.ledger) ? out.ledger : []) {
      if (!validDirectorLedger(item)) continue;
      let entry;
      try { entry = journal.record({ vmId: item.vmId, actor: 'bero', code: item.code, params: item.params }); } catch { entry = null; }
      if (validLedgerEntry(entry)) { push({ kind: 'ledger', entry }); cursor = Math.max(cursor, entry.seq); }
    }
    for (const act of Array.isArray(out?.acts) ? out.acts : []) acceptAct(act);
  }

  // ---- decide ----

  async function runEffect(effect, vmId) {
    if (effect === 'stop') return fleet.stopVm(vmId) ? 'stopped' : 'not_running';
    if (effect !== 'nudge' && effect !== 'recheck') return 'none';
    const original = byId.get(vmId).task;
    if (effect === 'recheck' && !original) return 'no_task';
    const task = effect === 'nudge' ? NUDGE_TASK : recheckTask(original);
    if (fleet.stopVm(vmId) && typeof fleet.idle === 'function') {
      await Promise.race([fleet.idle(vmId), new Promise((resolve) => { setTimeout(resolve, STOP_WAIT_MS).unref?.(); })]);
    }
    const started = fleet.startJob(vmId, task);
    return started?.ok ? 'started' : (typeof started?.code === 'string' && isCode(started.code) ? started.code : 'not_started');
  }

  async function decide(req, res, expectedOrigin) {
    if (!sameOriginWrite(req, expectedOrigin)) return json(res, 403, { error: 'forbidden' });
    if (!isJson(req)) return json(res, 415, { error: 'invalid_content_type' });
    if (!sessionToken(req.headers.cookie)) return json(res, 401, { error: 'session_required' });
    let body;
    try { body = JSON.parse((await readBody(req, MAX_DECIDE_BODY)).toString('utf8')); } catch { return json(res, 400, { error: 'invalid_request' }); }
    if (closed) return json(res, 503, { error: 'host_closing' });
    // Only these two fields are read. Anything else in the body (for example task text) is ignored.
    const cardId = body && typeof body === 'object' && !Array.isArray(body) ? body.cardId : undefined;
    const choiceId = body && typeof body === 'object' && !Array.isArray(body) ? body.choiceId : undefined;
    if (!isId(cardId) || !isId(choiceId)) return json(res, 400, { error: 'invalid_request' });
    const card = cards.get(cardId);
    if (!card) return json(res, 404, { error: 'card_unknown' });
    if (card.closed) return json(res, 409, { error: 'card_closed' });
    const choice = card.choices.find((c) => c.choiceId === choiceId);
    if (!choice) return json(res, 409, { error: 'choice_unknown' });
    let out;
    try { out = director.decide(cardId, choiceId, now()); } catch { out = null; }
    if (!out?.ok) return json(res, 409, { error: DECIDE_CODES.has(out?.code) ? out.code : 'decide_failed' });
    card.closed = true; // set before any await: a second choice on this card is refused
    // The effect is the one on the card this host showed, for that card's VM (not what the director returns now).
    const effect = EFFECTS.includes(choice.effect) ? choice.effect : 'dismiss';
    for (const item of Array.isArray(out.ledger) ? out.ledger : []) {
      if (validDirectorLedger(item)) { try { journal.record({ vmId: item.vmId, actor: 'bero', code: item.code, params: item.params }); } catch { /* keep going */ } }
    }
    try { journal.record({ vmId: card.vmId, actor: 'human', code: 'human_choice', params: { cardCode: card.code, choiceCode: choice.code, effect } }); } catch { /* keep going */ }
    push({ kind: 'card_closed', cardId, choiceId });
    const result = await runEffect(effect, card.vmId);
    return json(res, 200, { ok: true, effect, result });
  }

  // ---- HTTP ----

  function describe(tile, agents) {
    const frame = frames.get(tile.vmId);
    const status = frame.error ? 'error'
      : frame.capturedAt === null ? 'pending'
        : now() - frame.capturedAt > staleAfterMs ? 'stale' : 'live';
    return {
      vmId: tile.vmId, label: tile.label,
      capturedAt: frame.capturedAt === null ? null : new Date(frame.capturedAt).toISOString(),
      status, error: frame.error, agent: agents[tile.vmId] ?? null,
    };
  }

  function state(url) {
    const raw = url.searchParams.get('since') ?? '0';
    if (!/^\d{1,15}$/.test(raw)) return null;
    const asked = Number(raw);
    const since = asked > eventSeq ? 0 : asked; // the host restarted: start over
    const out = events.filter((ev) => ev.seq > since).slice(0, MAX_STATE_EVENTS);
    let agents;
    try { agents = board.snapshot(); } catch { agents = {}; }
    return {
      now: now(), staleAfterMs, vms: tiles.map((tile) => describe(tile, agents)),
      events: out, nextSince: out.length ? out[out.length - 1].seq : since,
    };
  }

  function json(res, status, body, headers) { send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', headers); }
  function send(res, status, body, type, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }
  function png(res, bytes) { return send(res, 200, bytes, 'image/png', { 'Content-Length': String(bytes.length) }); }

  async function handle(req, res) {
    setSecurityHeaders(res);
    if (closed) return json(res, 503, { error: 'host_closing' });
    const requestHost = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
    if (!['127.0.0.1', 'localhost'].some((host) => requestHost === `${host}:${serverPort}`)) return json(res, 403, { error: 'forbidden' });
    const expectedOrigin = `http://${requestHost}`;
    if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) return json(res, 403, { error: 'forbidden' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'forbidden' });
    let url;
    try { url = new URL(req.url ?? '/', expectedOrigin); } catch { return json(res, 400, { error: 'invalid_request' }); }
    if (!url.pathname.startsWith(BASE)) return json(res, 404, { error: 'not_found' });
    const scoped = `/${url.pathname.slice(BASE.length)}`;

    if (req.method === 'GET' && Object.hasOwn(UI_FILES, scoped)) {
      const [relative, type] = UI_FILES[scoped];
      try { return send(res, 200, fs.readFileSync(path.join(ROOT, relative)), type); }
      catch { return json(res, 500, { error: 'host_unavailable' }); }
    }
    if (scoped === '/api/session' && req.method === 'POST') return createSession(req, res, expectedOrigin);
    if (scoped === '/api/decide' && req.method === 'POST') return decide(req, res, expectedOrigin);
    if (!scoped.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    if (!sessionToken(req.headers.cookie)) return json(res, 401, { error: 'session_required' });
    if (req.method !== 'GET' || scoped === '/api/decide') return json(res, 405, { error: 'method_not_allowed' });
    if (scoped === '/api/session') return json(res, 200, { ok: true });
    if (scoped === '/api/state') {
      const body = state(url);
      return body ? json(res, 200, body) : json(res, 400, { error: 'invalid_request' });
    }
    const screen = matchId(scoped, /^\/api\/vms\/([^/]+)\/screen\.png$/);
    if (screen !== undefined) {
      const frame = frames.get(screen);
      return frame?.png ? png(res, frame.png) : json(res, 404, { error: 'not_found' });
    }
    const frameId = matchId(scoped, /^\/api\/frames\/([^/]+)\.png$/);
    const pinnedPng = frameId === undefined ? undefined : pinned.get(frameId);
    return pinnedPng ? png(res, pinnedPng) : json(res, 404, { error: 'not_found' });
  }

  async function createSession(req, res, expectedOrigin) {
    if (!sameOriginWrite(req, expectedOrigin)) return json(res, 403, { error: 'forbidden' });
    if (!isJson(req)) return json(res, 415, { error: 'invalid_content_type' });
    if (bootstrapUsed) return json(res, 403, { error: 'bootstrap_consumed' });
    let body;
    try { body = JSON.parse((await readBody(req, MAX_SESSION_BODY)).toString('utf8')); } catch { return json(res, 400, { error: 'invalid_request' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) return json(res, 403, { error: 'bootstrap_invalid' });
    purgeSessions();
    if (sessions.size >= MAX_SESSIONS) return json(res, 503, { error: 'session_capacity' });
    if (bootstrapUsed) return json(res, 403, { error: 'bootstrap_consumed' }); // the body read yielded
    if (!constantTimeEqual(body.bootstrapCode, bootstrapCode)) return json(res, 403, { error: 'bootstrap_invalid' });
    bootstrapUsed = true;
    const token = randomBytes(32).toString('base64url');
    const at = now();
    sessions.set(hash(token), { expiresAt: at + SESSION_TTL_MS, absoluteExpiresAt: at + SESSION_MAX_AGE_MS });
    return json(res, 200, { ok: true }, {
      // The browser keeps the cookie for the absolute lifetime; the server enforces the sliding idle limit.
      // (A Max-Age of the idle limit would make the browser drop a session that is still in use.)
      'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=${SESSION_MAX_AGE_MS / 1000}`,
    });
  }

  function sessionToken(rawCookie) {
    if (typeof rawCookie !== 'string' || rawCookie.length > 4096) return undefined;
    // Every cookie with our name is tried: a stale or malformed one must not hide a valid one in the same header.
    for (const part of rawCookie.split(';')) {
      const at = part.indexOf('=');
      if (at < 0 || part.slice(0, at).trim() !== cookieName) continue;
      const value = part.slice(at + 1).trim();
      if (!/^[A-Za-z0-9_-]{40,48}$/.test(value)) continue;
      const session = sessions.get(hash(value));
      const t = now();
      if (!session || session.expiresAt <= t || session.absoluteExpiresAt <= t) { sessions.delete(hash(value)); continue; }
      session.expiresAt = Math.min(t + SESSION_TTL_MS, session.absoluteExpiresAt);
      return value;
    }
    return undefined;
  }

  function purgeSessions() {
    const t = now();
    for (const [key, session] of sessions) if (session.expiresAt <= t || session.absoluteExpiresAt <= t) sessions.delete(key);
  }

  return Object.freeze({
    /** Start serving on 127.0.0.1, capturing and ticking. Returns `{ url, bootstrapCode }`. */
    async listen(port = 0) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be between 0 and 65535');
      if (closed) throw new Error('room_host_closed');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('room_host_listen_failed');
      serverPort = address.port;
      cookieName = `albera_room_${serverPort}_${randomBytes(6).toString('hex')}`;
      void captureOnce();
      captureTimer = setInterval(() => { void captureOnce(); }, captureIntervalMs);
      captureTimer.unref?.();
      tickTimer = setInterval(tickOnce, tickMs);
      tickTimer.unref?.();
      return Object.freeze({ host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}${BASE}`, bootstrapCode });
    },
    captureOnce,
    tickOnce,
    recordFleetEvent,
    /** Resolves when every queued automatic check has recorded its `check_done`. */
    async checksSettled() { while (checkChains.size > 0) await Promise.allSettled([...checkChains.values()]); },
    /** The session cookie name of this host (unique per host instance). */
    get cookieName() { return cookieName; },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(captureTimer);
      clearInterval(tickTimer);
      sessions.clear();
      pinned.clear();
      for (const frame of frames.values()) { frame.png = null; }
      if (server.listening) {
        const stopped = new Promise((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        await stopped;
      }
    },
  });
}

function normalizeVms(vms) {
  if (!Array.isArray(vms) || vms.length < 1 || vms.length > MAX_ROOM_VMS) throw new TypeError('vms must contain 1 to 8 entries');
  const seen = new Set();
  return Object.freeze(vms.map((entry) => {
    const vmId = entry?.vmId;
    const label = entry?.label ?? vmId;
    const task = entry?.task ?? '';
    if (!isEnvironmentId(vmId) || !isId(vmId) || seen.has(vmId)) throw new TypeError('invalid_room_vm');
    if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new TypeError('invalid_room_label');
    if (typeof task !== 'string' || task.length > MAX_TASK_LENGTH) throw new TypeError('invalid_room_task');
    seen.add(vmId);
    return Object.freeze({ vmId, label, task });
  }));
}

/** { vmId: Check[] } -> Map of frozen copies. Every VM must be a room VM, with 1 to 8 valid checks. */
function normalizeChecks(checks, tiles) {
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks)) throw new TypeError('invalid_room_checks');
  const known = new Set(tiles.map((tile) => tile.vmId));
  const out = new Map();
  for (const [vmId, list] of Object.entries(checks)) {
    if (!known.has(vmId)) throw new TypeError('invalid_room_checks');
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CHECKS_PER_VM || !list.every(validCheck)) throw new TypeError('invalid_room_checks');
    out.set(vmId, Object.freeze(list.map((check) => Object.freeze({ ...check }))));
  }
  return out;
}

/** `check_done` params: verdict, how many checks, how many did not pass, and the first problem ("path: finding" or the code). */
function checkDoneParams(report, count) {
  const bad = report.results.filter((result) => result.finding !== 'ok');
  const code = typeof report.code === 'string' && CHECK_CODE_RE.test(report.code) ? report.code : '';
  const detail = bad.length ? `${bad[0].path}: ${bad[0].finding}` : report.verdict === 'unavailable' ? (code || 'guest_unavailable') : '';
  return { verdict: report.verdict, checks: count, failed: bad.length, detail: cleanText(detail, MAX_TEXT) };
}

function matchId(scoped, re) {
  const match = scoped.match(re);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

/** A write must come from this origin: Origin is required (not just checked when present), Sec-Fetch-Site same-origin. */
function sameOriginWrite(req, expectedOrigin) {
  const site = req.headers['sec-fetch-site'];
  return req.headers.origin === expectedOrigin && (site === undefined || site === 'same-origin');
}

function isJson(req) { return req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() === 'application/json'; }

function safeErrorCode(error) {
  const code = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'desktop_unknown';
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (callback, value) => { if (!settled) { settled = true; clearTimeout(timer); callback(value); } };
    const timer = setTimeout(() => { finish(reject, new Error('request_body_timeout')); req.destroy(); }, BODY_TIMEOUT_MS);
    timer.unref?.();
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) { finish(reject, new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.once('end', () => finish(resolve, Buffer.concat(chunks)));
    req.once('error', (error) => finish(reject, error));
    req.once('aborted', () => finish(reject, new Error('request_aborted')));
  });
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function constantTimeEqual(received, expected) {
  if (typeof received !== 'string' || received.length > 128) return false;
  return timingSafeEqual(Buffer.from(hash(received)), Buffer.from(hash(expected)));
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
