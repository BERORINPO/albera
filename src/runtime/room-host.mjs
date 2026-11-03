// Control room host (spec/room.md): the desktop wall turned into a canvas, plus Bero's events and one write route.
// Same host model as desktop-wall-host: 127.0.0.1 only, Host/Origin checks, one-time bootstrap code -> HttpOnly
// SameSite=Strict cookie, CSP, no-store, safe error codes. Screens are captured with a view-only (HUMAN) lease.
// Two launch routes. CLI (no `bootstrapSink`): the code is returned by listen() for the terminal and works once.
// Service (`bootstrapSink`, docs/architecture/control-plane-service.md section 4): the code goes only to the sink
// (a file), is replaced after every use and every 10 minutes, and listen() does not return it.
// Both routes: /api/session takes 10 wrong codes a minute (the right code is never limited), and a GET of an /api/ route needs Sec-Fetch-Site same-origin or none.
// Write routes: POST api/decide (the Effect of an open card that this host itself showed) and the `apiRoutes` a caller registers (room-settings-routes.mjs, room-job-routes.mjs).
// A registered route is only reached after this host's own checks (Host, Origin AND Sec-Fetch-Site same-origin for a write, JSON content type, session cookie, body limit); it never sees a request object.
// The task text of a job started by a card is fixed English built here; nothing from a request body reaches that task. The one exception is the job screen (room-job-routes.mjs): the owner's typed
// task reaches the hands only as the exact string a person approved (task-start-gate rule), never straight from the request.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEnvironmentId } from './environment-provider.mjs';
import { isLabel } from './workspace.mjs';
import { cleanText, isCode, isId, validAct, validCheck, validCheckReport, validLedgerEntry, EFFECTS, LEDGER_CODES, MAX_CHECKS_PER_VM, MAX_TEXT } from './room-contract.mjs';
import { createStartRunner, gatedRecheckTask, GATED_NUDGE_TASK } from './room-starts.mjs';
import { FEEDBACK_ORIGIN } from './feedback-contract.mjs';

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
const MAX_API_ROUTES = 32;
const DEFAULT_ROUTE_BODY = 1024;
const MAX_ROUTE_BODY = 4096;
const ROUTE_PATH_RE = /^\/api(?:\/[a-z][a-z0-9-]{0,31}){1,4}$/;
const RESERVED_ROUTE_PATHS = new Set(['/api/session', '/api/decide', '/api/state']);
const RESERVED_ROUTE_PREFIXES = ['/api/vms/', '/api/frames/'];
const BODY_TIMEOUT_MS = 5_000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // provisional; 8 h until 2026-11-03. A cookie is not kept per port (control-plane-service.md section 4)
const SESSION_RATE_LIMIT = 10;
const SESSION_RATE_WINDOW_MS = 60_000;
export const BOOTSTRAP_ROTATE_MS = 10 * 60 * 1000;
const LEASE_TTL_MS = 60_000;
const MAX_TASK_LENGTH = 2000;
const BASE = '/room/';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const UI_NAMES = ['room.css', 'cam.css', 'figure.css', 'bero.css', 'canvas.mjs', 'app.mjs', 'api.mjs', 'i18n.mjs', 'words-canvas.mjs',
  'cam.mjs', 'words-cam.mjs', 'figure.mjs', 'ledger.mjs', 'words-figure.mjs', 'bero.mjs', 'cards.mjs', 'words-bero.mjs',
  'panels.css', 'words-panels.mjs', 'settings.mjs', 'jobs.mjs', 'feedback.mjs', 'words-feedback.mjs'];
// The page imports ./feedback-contract.mjs, so it is asked for as /room/feedback-contract.mjs; the file is the runtime's own (shared with the intake Worker), not one of room-ui/. A fixed entry, never a joined path.
const UI_FILES = Object.freeze(Object.fromEntries([
  ...[['/', 'index.html'], ...UI_NAMES.map((name) => [`/${name}`, name])].map(([route, name]) => [route, Object.freeze([`room-ui/${name}`, TYPES[path.extname(name)]])]),
  ['/feedback-contract.mjs', Object.freeze(['feedback-contract.mjs', TYPES['.mjs']])],
]));
const SAFE_ERROR_CODES = new Set([
  'desktop_broker_timeout', 'desktop_input_rejected', 'desktop_unavailable', 'desktop_vm_not_found',
  'invalid_desktop_screen_data', 'invalid_desktop_vm', 'invalid_desktop_lease', 'desktop_lease_unavailable',
  'desktop_lease_stale', 'desktop_lease_expired', 'desktop_lease_owner_mismatch', 'desktop_lease_session_mismatch',
]);
const DECIDE_CODES = new Set(['card_unknown', 'card_closed', 'choice_unknown']);
const CHECK_TIMEOUT_MS = 65_000; // the checker's own limit is 60 s; this one only keeps a VM's queue moving
const CHECK_CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;
const CSP_CONNECT_SELF = "'self'";
const cspFor = (connectSrc) => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${connectSrc}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`;

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
 * Start approval (`startGate`, task-start-gate.mjs): when given, a card's nudge / recheck starts a job only after `startGate.startApproved({vmId, task})` says ok.
 * That is slow, so the decide route answers `pending_approval` at once and the outcome is a later ledger entry (`start_approved` / `start_refused`; room-starts.mjs).
 * Without a gate the room starts jobs as before (local demo): the CLI says so when it starts.
 * Service launch route (`bootstrapSink` = { publish({port, code}), clear() }, both may be async): the sink gets every new code and is cleared at close.
 * A first publish that fails makes listen() fail; a later failure goes to `onBootstrapError(code)` (the old code is already invalid by then).
 * `feedback` (default false): the room's feedback panel may send to the intake Worker (feedback-contract.mjs), so the CSP connect-src gets exactly that origin and nothing else. With false the CSP is what it always was.
 * It does not register the route (`GET /api/feedback`, room-feedback-routes.mjs): the caller passes that in `apiRoutes`, with the same switch.
 * `apiRoutes` = [{ method: 'GET'|'POST', path: '/api/...', maxBody?: bytes (POST, default 1024, at most 4096), handle({ body }) -> { status, body } }]. The host runs its checks first (see the head of this file);
 * `body` is the parsed JSON object (POST only). `handle` never sees the request or the cookie, and a throw becomes `500 route_failed` with no detail. A path of the host itself cannot be registered.
 */
export function createRoomHost({
  vms, driver, board, journal, director, fleet, checker = null, checks = {}, startGate = null, checkTimeoutMs = CHECK_TIMEOUT_MS,
  captureIntervalMs = 1000, staleAfterMs = 10_000, tickMs = 1000, now = Date.now,
  bootstrapSink = null, bootstrapRotateMs = BOOTSTRAP_ROTATE_MS, onBootstrapError = () => {}, apiRoutes = [], feedback = false,
} = {}) {
  if (typeof feedback !== 'boolean') throw new TypeError('feedback must be a boolean');
  const csp = cspFor(feedback ? `${CSP_CONNECT_SELF} ${FEEDBACK_ORIGIN}` : CSP_CONNECT_SELF);
  const tiles = normalizeVms(vms);
  const routes = normalizeApiRoutes(apiRoutes);
  const checksByVm = normalizeChecks(checks, tiles);
  if (checksByVm.size > 0 && typeof checker?.run !== 'function') throw new TypeError('room host requires a checker with run() when checks are given');
  if (!Number.isInteger(checkTimeoutMs) || checkTimeoutMs < 10 || checkTimeoutMs > 600_000) throw new TypeError('checkTimeoutMs must be between 10 and 600000');
  if (!Number.isInteger(captureIntervalMs) || captureIntervalMs < 10 || captureIntervalMs > 60_000) throw new TypeError('captureIntervalMs must be between 10 and 60000');
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 100 || staleAfterMs > 3_600_000) throw new TypeError('staleAfterMs must be between 100 and 3600000');
  if (!Number.isInteger(tickMs) || tickMs < 10 || tickMs > 60_000) throw new TypeError('tickMs must be between 10 and 60000');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (bootstrapSink !== null && (typeof bootstrapSink?.publish !== 'function' || typeof bootstrapSink?.clear !== 'function')) throw new TypeError('bootstrapSink needs publish() and clear()');
  if (!Number.isInteger(bootstrapRotateMs) || bootstrapRotateMs < 10 || bootstrapRotateMs > 3_600_000) throw new TypeError('bootstrapRotateMs must be between 10 and 3600000');
  if (typeof onBootstrapError !== 'function') throw new TypeError('onBootstrapError must be a function');
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

  // With a gate every start goes through it, so a fleet that would start initial jobs by itself in run() is refused (it must report 0 of them).
  if (startGate !== null && fleet.initialJobCount !== 0) throw new TypeError('room host with a start gate requires a fleet without initial jobs');
  const starts = createStartRunner({ fleet, gate: startGate, journal, isClosed: () => closed });
  const byId = new Map(tiles.map((tile) => [tile.vmId, tile]));
  const frames = new Map(tiles.map((tile) => [tile.vmId, { png: null, capturedAt: null, error: null }]));
  const pinned = new Map(); // frameId -> png (oldest first)
  const events = []; // RoomEvent[], seq ascending
  const cards = new Map(); // cardId -> { vmId, code, choices, closed }
  const checkChains = new Map(); // vmId -> the promise of the VM's last queued check
  const checkStates = new Map(); // vmId -> {state: checking|passed|failed|unavailable, checks, failed, detail} for the camera
  const runs = new Map(); // vmId -> how many hands runs started (a check belongs to the run it was queued in)
  let bootstrapCode = newCode();
  let rotateTimer;
  let publishChain = Promise.resolve(); // sink calls run one at a time, in the order the codes were made
  const failedSessionCalls = []; // times of the recent /api/session calls that had a wrong code
  // Cookies do not separate ports: every host gets its own cookie name (fixed at listen), so two rooms
  // (or a room and a demo) on 127.0.0.1 never overwrite each other's session.
  let cookieName = `albera_room_${randomBytes(6).toString('hex')}`;
  const sessions = new Map();
  let bootstrapUsed = false; // CLI route only; the service route replaces the code instead
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
    if (event?.type === 'start') { runs.set(vmId, (runs.get(vmId) ?? 0) + 1); checkStates.delete(vmId); }
    if (vmChecks) checkStates.set(vmId, Object.freeze({ state: 'checking', checks: vmChecks.length, failed: 0, detail: '' }));
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
    const run = runs.get(vmId) ?? 0; // the run this DONE belongs to, taken now (the check itself may start later)
    const next = (checkChains.get(vmId) ?? Promise.resolve()).then(() => runCheck(vmId, vmChecks, run));
    checkChains.set(vmId, next);
    void next.finally(() => { if (checkChains.get(vmId) === next) checkChains.delete(vmId); });
  }

  async function runCheck(vmId, vmChecks, run) {
    let timer;
    const timeout = new Promise((resolve) => {
      // A referenced timer (cleared in finally): an unref'd one lets Node 22 end the event loop while a check still waits.
      timer = setTimeout(() => resolve({ verdict: 'unavailable', results: [], code: 'guest_check_timeout' }), checkTimeoutMs);
    });
    let report;
    try { report = await Promise.race([Promise.resolve().then(() => checker.run(vmId, vmChecks)), timeout]); }
    catch { report = { verdict: 'unavailable', results: [], code: 'guest_check_failed' }; }
    finally { clearTimeout(timer); }
    if (!validCheckReport(report, vmChecks.length)) report = { verdict: 'unavailable', results: [], code: 'guest_check_invalid' };
    if (closed) return;
    const params = checkDoneParams(report, vmChecks.length);
    // The camera shows the verdict until the VM's next run starts; a check of an older run never overwrites a newer one.
    if ((runs.get(vmId) ?? 0) === run) checkStates.set(vmId, Object.freeze({ state: params.verdict, checks: params.checks, failed: params.failed, detail: params.detail }));
    try { journal.record({ vmId, actor: 'bero', code: 'check_done', params }); } catch { /* keep going */ }
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
    if (effect === 'stop') { starts.cancel(vmId); return fleet.stopVm(vmId) ? 'stopped' : 'not_running'; }
    if (effect !== 'nudge' && effect !== 'recheck') return 'none';
    const original = byId.get(vmId).task;
    if (effect === 'recheck' && !original) return 'no_task';
    const gated = starts.gated; // a gate needs texts that fit a task.start action (256 bytes)
    const task = effect === 'nudge' ? (gated ? GATED_NUDGE_TASK : NUDGE_TASK) : (gated ? gatedRecheckTask(original) : recheckTask(original));
    return starts.start(vmId, task);
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

  // ---- registered routes (room-settings-routes.mjs, room-job-routes.mjs) ----

  /** The order is fixed: this page (Origin + Sec-Fetch-Site for a write, Sec-Fetch-Site for a read), then the content type, then the session, and only then the body. */
  async function runRoute(route, req, res, expectedOrigin) {
    const write = route.method === 'POST';
    if (write ? !strictSameOriginWrite(req, expectedOrigin) : !sameOriginRead(req)) return json(res, 403, { error: 'forbidden' });
    if (write && !isJson(req)) return json(res, 415, { error: 'invalid_content_type' });
    if (!sessionToken(req.headers.cookie)) return json(res, 401, { error: 'session_required' });
    let body;
    if (write) {
      const declared = req.headers['content-length'];
      if (declared !== undefined && !(/^\d{1,9}$/.test(declared) && Number(declared) <= route.maxBody)) return json(res, 413, { error: 'body_too_large' }, { Connection: 'close' });
      try { body = JSON.parse((await readBody(req, route.maxBody, false)).toString('utf8')); }
      catch (error) { return error?.message === 'body_too_large' ? json(res, 413, { error: 'body_too_large' }, { Connection: 'close' }) : json(res, 400, { error: 'invalid_request' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid_request' });
    }
    if (closed) return json(res, 503, { error: 'host_closing' });
    let out;
    try { out = await route.handle({ body }); } catch { out = null; }
    const valid = Number.isInteger(out?.status) && out.status >= 200 && out.status <= 599 && out.body !== null && typeof out.body === 'object';
    return valid ? json(res, out.status, out.body) : json(res, 500, { error: 'route_failed' });
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
      status, error: frame.error, agent: agents[tile.vmId] ?? null, check: checkStates.get(tile.vmId) ?? null,
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
    setSecurityHeaders(res, csp);
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
    const route = routes.get(`${req.method} ${scoped}`);
    if (route) return runRoute(route, req, res, expectedOrigin);
    // Another port on 127.0.0.1 is same-site, so a no-cors GET from its page would carry the cookie: a read must say it is ours.
    if (req.method === 'GET' && !sameOriginRead(req)) return json(res, 403, { error: 'forbidden' });
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

  /**
   * A call to /api/session that did not bring the right code. At most SESSION_RATE_LIMIT of them in SESSION_RATE_WINDOW_MS (shared by all senders),
   * then 429. The right code is never counted or limited, so another local user cannot lock the owner out by sending wrong ones.
   */
  function rejectSession(res, status, error) {
    const t = now();
    while (failedSessionCalls.length > 0 && failedSessionCalls[0] <= t - SESSION_RATE_WINDOW_MS) failedSessionCalls.shift();
    if (failedSessionCalls.length >= SESSION_RATE_LIMIT) return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(SESSION_RATE_WINDOW_MS / 1000) });
    failedSessionCalls.push(t);
    return json(res, status, { error });
  }

  async function createSession(req, res, expectedOrigin) {
    if (!sameOriginWrite(req, expectedOrigin)) return json(res, 403, { error: 'forbidden' });
    if (!isJson(req)) return json(res, 415, { error: 'invalid_content_type' });
    if (bootstrapUsed) return json(res, 403, { error: 'bootstrap_consumed' });
    let body;
    try { body = JSON.parse((await readBody(req, MAX_SESSION_BODY)).toString('utf8')); } catch { return rejectSession(res, 400, 'invalid_request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) return rejectSession(res, 403, 'bootstrap_invalid');
    purgeSessions();
    if (sessions.size >= MAX_SESSIONS) return json(res, 503, { error: 'session_capacity' });
    if (bootstrapUsed) return json(res, 403, { error: 'bootstrap_consumed' }); // the body read yielded
    if (!constantTimeEqual(body.bootstrapCode, bootstrapCode)) return rejectSession(res, 403, 'bootstrap_invalid');
    if (bootstrapSink) rotateBootstrap(); // the code just used is already invalid; the new one reaches the sink in the background
    else bootstrapUsed = true;
    const token = randomBytes(32).toString('base64url');
    const at = now();
    sessions.set(hash(token), { expiresAt: at + SESSION_TTL_MS, absoluteExpiresAt: at + SESSION_MAX_AGE_MS });
    return json(res, 200, { ok: true }, {
      // The browser keeps the cookie for the absolute lifetime; the server enforces the sliding idle limit.
      // (A Max-Age of the idle limit would make the browser drop a session that is still in use.)
      'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=${SESSION_MAX_AGE_MS / 1000}`,
    });
  }

  // ---- service route: the code lives in the sink ----

  function publishBootstrap() {
    const code = bootstrapCode;
    const run = publishChain.then(() => bootstrapSink.publish({ port: serverPort, code }));
    publishChain = run.catch(() => { if (!closed) safeReport('bootstrap_publish_failed'); });
    return run;
  }

  function safeReport(code) { try { onBootstrapError(code); } catch { /* a reporter must not stop the host */ } }

  /** New code (the old one stops working now), a new 10-minute timer, and the sink gets the new code. */
  function rotateBootstrap() {
    if (closed) return;
    bootstrapCode = newCode();
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(rotateBootstrap, bootstrapRotateMs);
    rotateTimer.unref?.();
    publishBootstrap().catch(() => {}); // the failure is already reported through publishChain
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
    /** Start serving on 127.0.0.1, capturing and ticking. Returns `{ url, bootstrapCode }` (no `bootstrapCode` on the service route: it went to the sink). */
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
      if (bootstrapSink) {
        try { await publishBootstrap(); }
        catch { await shutdown(); throw new Error('room_bootstrap_publish_failed'); }
        rotateTimer = setTimeout(rotateBootstrap, bootstrapRotateMs);
        rotateTimer.unref?.();
      }
      void captureOnce();
      captureTimer = setInterval(() => { void captureOnce(); }, captureIntervalMs);
      captureTimer.unref?.();
      tickTimer = setInterval(tickOnce, tickMs);
      tickTimer.unref?.();
      const where = { host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}${BASE}` };
      return Object.freeze(bootstrapSink ? where : { ...where, bootstrapCode });
    },
    captureOnce,
    tickOnce,
    recordFleetEvent,
    /**
     * Ask to start a job on a room VM by the same path a card uses (with a gate: approval first, then `start_approved` / `start_refused` in the ledger; room-starts.mjs).
     * This is how a gated room starts its initial jobs. Resolves with the runner's answer ('pending_approval', 'started', a fleet code), or 'vm_unknown' / 'host_closing'.
     */
    requestStart(vmId, task) {
      if (closed) return Promise.resolve('host_closing');
      return byId.has(vmId) && typeof task === 'string' && task.length > 0 ? starts.start(vmId, task) : Promise.resolve('vm_unknown');
    },
    /** Resolves when every queued automatic check has recorded its `check_done`. */
    async checksSettled() { while (checkChains.size > 0) await Promise.allSettled([...checkChains.values()]); },
    /** The session cookie name of this host (unique per host instance). */
    get cookieName() { return cookieName; },
    close: shutdown,
  });

  async function shutdown() {
    if (closed) return;
    closed = true;
    clearInterval(captureTimer);
    clearInterval(tickTimer);
    clearTimeout(rotateTimer);
    sessions.clear();
    pinned.clear();
    for (const frame of frames.values()) { frame.png = null; }
    if (server.listening) {
      const stopped = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await stopped;
    }
    if (bootstrapSink) {
      await publishChain; // a publish in flight ends first, so the file is not written again after it is cleared
      try { await bootstrapSink.clear(); } catch { safeReport('bootstrap_clear_failed'); }
    }
  }
}

function newCode() { return randomBytes(32).toString('base64url'); }

/** `apiRoutes` -> Map of "METHOD /path" -> frozen route. A path of this host's own (session, decide, state, screens, frames) cannot be taken, and a method + path can be registered once. */
function normalizeApiRoutes(apiRoutes) {
  if (!Array.isArray(apiRoutes) || apiRoutes.length > MAX_API_ROUTES) throw new TypeError('invalid_room_api_routes');
  const out = new Map();
  for (const route of apiRoutes) {
    const { method, path: routePath, handle } = route ?? {};
    const maxBody = route?.maxBody ?? DEFAULT_ROUTE_BODY;
    if ((method !== 'GET' && method !== 'POST') || typeof routePath !== 'string' || !ROUTE_PATH_RE.test(routePath)) throw new TypeError('invalid_room_api_routes');
    if (RESERVED_ROUTE_PATHS.has(routePath) || RESERVED_ROUTE_PREFIXES.some((prefix) => routePath.startsWith(prefix))) throw new TypeError('invalid_room_api_routes');
    if (typeof handle !== 'function' || !Number.isInteger(maxBody) || maxBody < 2 || maxBody > MAX_ROUTE_BODY) throw new TypeError('invalid_room_api_routes');
    const key = `${method} ${routePath}`;
    if (out.has(key)) throw new TypeError('invalid_room_api_routes');
    out.set(key, Object.freeze({ method, path: routePath, maxBody, handle }));
  }
  return out;
}

function normalizeVms(vms) {
  if (!Array.isArray(vms) || vms.length < 1 || vms.length > MAX_ROOM_VMS) throw new TypeError('vms must contain 1 to 8 entries');
  const seen = new Set();
  return Object.freeze(vms.map((entry) => {
    const vmId = entry?.vmId;
    const label = entry?.label ?? vmId;
    const task = entry?.task ?? '';
    if (!isEnvironmentId(vmId) || !isId(vmId) || seen.has(vmId)) throw new TypeError('invalid_room_vm');
    if (!isLabel(label)) throw new TypeError('invalid_room_label');
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

/** A write of a registered route: Origin is this origin AND Sec-Fetch-Site is same-origin (a request with no Sec-Fetch-Site header is refused, unlike api/decide). */
function strictSameOriginWrite(req, expectedOrigin) {
  return req.headers.origin === expectedOrigin && req.headers['sec-fetch-site'] === 'same-origin';
}

/** A read of an /api/ route must come from this page or from a person's own navigation: Sec-Fetch-Site is required and is same-origin or none. */
function sameOriginRead(req) {
  const site = req.headers['sec-fetch-site'];
  return site === 'same-origin' || site === 'none';
}

function isJson(req) { return req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() === 'application/json'; }

function safeErrorCode(error) {
  const code = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'desktop_unknown';
}

/** `destroyOnLimit: false` keeps the connection so the caller can still answer 413 (the caller then asks for `Connection: close`). */
function readBody(req, maxBytes, destroyOnLimit = true) {
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
      if (size > maxBytes) { finish(reject, new Error('body_too_large')); if (destroyOnLimit) req.destroy(); return; }
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

function setSecurityHeaders(res, csp) {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
