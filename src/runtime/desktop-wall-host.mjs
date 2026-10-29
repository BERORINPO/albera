// Local, view-only "desktop wall": the latest screen of a few VMs, served on loopback.
// It only calls driver.capture(). It never calls driver.act(), keeps one frame per VM in memory
// (no disk, no history) and has no route that changes a VM. ADR-009: unauthenticated screens are not served.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEnvironmentId } from './environment-provider.mjs';

export const WALL_DESKTOP_SESSION_ID = 'wall-view';
export const WALL_OWNER_ID = 'wall-viewer';
export const MAX_WALL_VMS = 16;
const MAX_CONCURRENT_CAPTURES = 2;
const MAX_CONNECTIONS = 64;
const MAX_SESSIONS = 8;
const MAX_BODY_BYTES = 1024;
const BODY_TIMEOUT_MS = 5_000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const LEASE_TTL_MS = 60_000;
const BASE = '/wall/';
const LABEL_RE = /^[\x20-\x7e]{1,32}$/;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_FILES = Object.freeze({
  '/': ['wall-ui/index.html', 'text/html; charset=utf-8'],
  '/wall.mjs': ['wall-ui/wall.mjs', 'text/javascript; charset=utf-8'],
  '/wall.css': ['wall-ui/wall.css', 'text/css; charset=utf-8'],
});
// Only these codes leave the host. Anything else is reported as desktop_unknown.
const SAFE_ERROR_CODES = new Set([
  'desktop_broker_timeout', 'desktop_input_rejected', 'desktop_unavailable', 'desktop_vm_not_found',
  'invalid_desktop_screen_data', 'invalid_desktop_vm', 'invalid_desktop_lease', 'desktop_lease_unavailable',
  'desktop_lease_stale', 'desktop_lease_expired', 'desktop_lease_owner_mismatch', 'desktop_lease_session_mismatch',
]);

/**
 * @param {{vms: {vmId: string, label?: string}[], driver: object|Function, captureIntervalMs?: number, staleAfterMs?: number, now?: () => number}} options
 * `driver` is an object with `capture({vmId, lease})`, or a factory `(resolveCurrentLease) => driver` so the
 * view-only lease stays inside this host.
 */
export function createDesktopWallHost({ vms, driver, captureIntervalMs = 2000, staleAfterMs = 10_000, now = Date.now } = {}) {
  const tiles = normalizeVms(vms);
  if (!Number.isInteger(captureIntervalMs) || captureIntervalMs < 10 || captureIntervalMs > 60_000) throw new TypeError('captureIntervalMs must be between 10 and 60000');
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 100 || staleAfterMs > 3_600_000) throw new TypeError('staleAfterMs must be between 100 and 3600000');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  // View-only lease: HUMAN owner, generation 1, expiry renewed by this host before each capture.
  let leaseExpiresAt = now() + LEASE_TTL_MS;
  const currentLease = () => ({
    desktopSessionId: WALL_DESKTOP_SESSION_ID, ownerType: 'HUMAN', ownerId: WALL_OWNER_ID,
    generation: 1, expiresAt: new Date(leaseExpiresAt).toISOString(),
  });
  const wallDriver = typeof driver === 'function' ? driver(async () => currentLease()) : driver;
  if (!wallDriver || typeof wallDriver.capture !== 'function') throw new TypeError('wall host requires a driver with capture()');

  const frames = new Map(tiles.map((tile) => [tile.vmId, { png: null, capturedAt: null, error: null }]));
  const basePath = BASE;
  const bootstrapCode = randomBytes(32).toString('base64url');
  const sessions = new Map();
  let bootstrapUsed = false;
  let timer;
  let serverPort;
  let closed = false;
  let active = 0;
  const queue = [];
  const queued = new Map(); // vmId -> promise of the capture queued or running for it
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 5_000;
  server.requestTimeout = BODY_TIMEOUT_MS + 5_000;
  server.keepAliveTimeout = 5_000;

  /** Queue one capture per VM (never two for the same VM) and resolve when they all finished. */
  function captureOnce() {
    return Promise.all(tiles.map((tile) => schedule(tile.vmId)));
  }

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
      const shot = await wallDriver.capture({ vmId, lease: currentLease() });
      if (closed) return;
      if (!(shot?.png instanceof Uint8Array)) throw Object.assign(new Error('x'), { code: 'invalid_desktop_screen_data' });
      frame.png = Buffer.from(shot.png); // replaces the previous frame: only the latest is kept
      frame.capturedAt = now();
      frame.error = null;
    } catch (error) {
      if (!closed) frame.error = safeErrorCode(error);
    }
  }

  function describe(tile) {
    const frame = frames.get(tile.vmId);
    const status = frame.error ? 'error'
      : frame.capturedAt === null ? 'pending'
        : now() - frame.capturedAt > staleAfterMs ? 'stale' : 'live';
    return {
      vmId: tile.vmId, label: tile.label,
      capturedAt: frame.capturedAt === null ? null : new Date(frame.capturedAt).toISOString(),
      status, error: frame.error,
    };
  }

  function json(res, status, body, headers) { send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', headers); }
  function send(res, status, body, type, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

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
    if (!url.pathname.startsWith(basePath)) return json(res, 404, { error: 'not_found' });
    const scoped = `/${url.pathname.slice(basePath.length)}`;

    if (req.method === 'GET' && Object.hasOwn(UI_FILES, scoped)) {
      const [relative, type] = UI_FILES[scoped];
      try { return send(res, 200, fs.readFileSync(path.join(ROOT, relative)), type); }
      catch { return json(res, 500, { error: 'host_unavailable' }); }
    }
    if (scoped === '/api/session' && req.method === 'POST') return createSession(req, res, expectedOrigin);
    if (!scoped.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    const token = sessionToken(req.headers.cookie);
    if (!token) return json(res, 401, { error: 'session_required' });
    if (req.method !== 'GET') return json(res, 405, { error: 'read_only' });
    if (scoped === '/api/session') return json(res, 200, { ok: true });
    if (scoped === '/api/vms') return json(res, 200, { staleAfterMs, vms: tiles.map(describe) });
    const match = scoped.match(/^\/api\/vms\/([^/]+)\/screen\.png$/);
    let vmId;
    try { vmId = match ? decodeURIComponent(match[1]) : undefined; } catch { vmId = undefined; }
    const frame = vmId === undefined ? undefined : frames.get(vmId);
    if (!frame || !frame.png) return json(res, 404, { error: 'not_found' });
    return send(res, 200, frame.png, 'image/png', { 'Content-Length': String(frame.png.length) });
  }

  async function createSession(req, res, expectedOrigin) {
    if (req.headers.origin !== expectedOrigin || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) return json(res, 403, { error: 'forbidden' });
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { error: 'invalid_content_type' });
    if (bootstrapUsed) return json(res, 403, { error: 'bootstrap_consumed' });
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return json(res, 400, { error: 'invalid_request' }); }
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
      'Set-Cookie': `albera_wall_session=${token}; HttpOnly; SameSite=Strict; Path=${basePath}; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
  }

  function sessionToken(rawCookie) {
    if (typeof rawCookie !== 'string' || rawCookie.length > 4096) return undefined;
    for (const part of rawCookie.split(';')) {
      const at = part.indexOf('=');
      if (at < 0 || part.slice(0, at).trim() !== 'albera_wall_session') continue;
      const value = part.slice(at + 1).trim();
      if (!/^[A-Za-z0-9_-]{40,48}$/.test(value)) return undefined;
      const session = sessions.get(hash(value));
      const t = now();
      if (!session || session.expiresAt <= t || session.absoluteExpiresAt <= t) { sessions.delete(hash(value)); return undefined; }
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
    /** Start serving on 127.0.0.1 and begin periodic capture. Returns `{ url, bootstrapCode }`. */
    async listen(port = 0) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be between 0 and 65535');
      if (closed) throw new Error('wall_host_closed');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('wall_host_listen_failed');
      serverPort = address.port;
      void captureOnce();
      timer = setInterval(() => { void captureOnce(); }, captureIntervalMs);
      timer.unref?.();
      return Object.freeze({ host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}${basePath}`, bootstrapCode });
    },
    /** One capture round for every VM; resolves when all finished. Used by tests and the first paint. */
    captureOnce,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      sessions.clear();
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
  if (!Array.isArray(vms) || vms.length < 1 || vms.length > MAX_WALL_VMS) throw new TypeError('vms must contain 1 to 16 entries');
  const seen = new Set();
  return Object.freeze(vms.map((entry) => {
    const vmId = entry?.vmId;
    const label = entry?.label ?? vmId;
    if (!isEnvironmentId(vmId) || seen.has(vmId)) throw new TypeError('invalid_wall_vm');
    if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new TypeError('invalid_wall_label');
    seen.add(vmId);
    return Object.freeze({ vmId, label });
  }));
}

function safeErrorCode(error) {
  const code = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'desktop_unknown';
}

function readBody(req) {
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
      if (size > MAX_BODY_BYTES) { finish(reject, new Error('body_too_large')); req.destroy(); return; }
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
