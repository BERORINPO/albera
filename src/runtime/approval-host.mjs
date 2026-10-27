// Separate loopback browser host for Runtime approvals and controls.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_SESSIONS = 32;
const MAX_BODY_BYTES = 20 * 1024;
const MAX_STREAM_BUFFER = 64 * 1024;
const DEFAULT_SESSION_TTL_MS = 20 * 60 * 1000;
const MAX_SESSION_AGE_MS = 8 * 60 * 60 * 1000;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_FILES = Object.freeze({
  '/': ['approval-ui/index.html', 'text/html; charset=utf-8'],
  '/approval.mjs': ['approval-ui/approval.mjs', 'text/javascript; charset=utf-8'],
  '/approval.css': ['approval-ui/approval.css', 'text/css; charset=utf-8'],
});
const API_TOKEN_SCOPES = Object.freeze(['providers:read', 'runs:read', 'events:read', 'runs:start', 'runs:stop', 'runs:input', 'approvals:read', 'approvals:decide']);

/**
 * Host the approval/control screen on an isolated loopback origin. Runtime API credentials stay server-side;
 * the browser gets an HttpOnly SameSite cookie and a short-lived in-memory CSRF token.
 * @param {{api: {listen: Function, createCredential: Function}, sessionId?: string, sessionLifetimeMs?: number, maxSessions?: number, roots?: string[]}} options
 */
export function createRuntimeApprovalHost({ api, sessionId, sessionLifetimeMs = DEFAULT_SESSION_TTL_MS, maxSessions = MAX_SESSIONS, roots = [] } = {}) {
  if (!api || typeof api.listen !== 'function' || typeof api.createCredential !== 'function') throw new TypeError('approval host requires a Runtime API');
  if (!Number.isInteger(sessionLifetimeMs) || sessionLifetimeMs < 60_000 || sessionLifetimeMs > 60 * 60 * 1000) throw new TypeError('sessionLifetimeMs must be between 60000 and 3600000');
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS) throw new TypeError('maxSessions must be between 1 and 32');
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) throw new TypeError('roots must contain absolute paths');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) throw new TypeError('sessionId must be 32 lowercase hexadecimal characters');

  const token = api.createCredential(API_TOKEN_SCOPES, {
    ttlMs: MAX_SESSION_AGE_MS,
    ...(sessionId ? { sessionId } : {}),
  });
  const bootstrapCode = randomBytes(32).toString('base64url');
  // Cookie scope has no port component. A high-entropy per-host path keeps the
  // browser session cookie away from unrelated services on the same loopback host.
  const basePath = `/r/${randomBytes(16).toString('hex')}/`;
  const sessions = new Map();
  let bootstrapUsed = false;
  let apiAddress;
  let listenPromise;
  let closePromise;
  let serverClosePromise;
  let serverPort;
  let closing = false;
  const server = http.createServer((req, res) => { void handle(req, res); });

  function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  async function handle(req, res) {
    setSecurityHeaders(res);
    if (closing) return send(res, 503, JSON.stringify({ error: 'host_closing' }));
    const requestHost = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
    if (!['127.0.0.1', 'localhost'].some((host) => requestHost === `${host}:${serverPort}`)) return send(res, 403, JSON.stringify({ error: 'forbidden' }));
    const expectedOrigin = `http://${requestHost}`;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== expectedOrigin) return send(res, 403, JSON.stringify({ error: 'forbidden' }));
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site') return send(res, 403, JSON.stringify({ error: 'forbidden' }));

    let url;
    try { url = new URL(req.url ?? '/', expectedOrigin); } catch { return send(res, 400, JSON.stringify({ error: 'invalid_request' })); }
    if (!url.pathname.startsWith(basePath)) return send(res, 404, JSON.stringify({ error: 'not_found' }));
    const scopedPath = `/${url.pathname.slice(basePath.length)}`;
    if (req.method === 'GET' && Object.hasOwn(UI_FILES, scopedPath)) {
      const [relative, type] = UI_FILES[scopedPath];
      try { return send(res, 200, fs.readFileSync(path.join(ROOT, relative)), type); }
      catch { return send(res, 500, JSON.stringify({ error: 'host_unavailable' })); }
    }
    if (req.method === 'GET' && scopedPath === '/api/session') return readSession(req, res);
    if (req.method === 'POST' && scopedPath === '/api/session') return createSession(req, res, expectedOrigin);
    if (!scopedPath.startsWith('/api/')) return send(res, 404, JSON.stringify({ error: 'not_found' }));

    const authenticatedSession = findSession(req.headers.cookie);
    if (!authenticatedSession) return send(res, 401, JSON.stringify({ error: 'session_required' }));
    const { token: sessionToken, session } = authenticatedSession;
    const scopedUrl = new URL(url);
    scopedUrl.pathname = scopedPath;
    const upstream = upstreamRoute(req.method ?? '', scopedUrl, req.headers['last-event-id']);
    if (!upstream) return send(res, 404, JSON.stringify({ error: 'not_found' }));
    if (req.method !== 'GET') {
      if (origin !== expectedOrigin || (site !== undefined && site !== 'same-origin')) return send(res, 403, JSON.stringify({ error: 'forbidden' }));
      if (!constantTimeStringEqual(req.headers['x-albera-csrf'], session.csrfToken)) return send(res, 403, JSON.stringify({ error: 'csrf_failed' }));
    }

    const now = Date.now();
    session.expiresAt = Math.min(now + sessionLifetimeMs, session.absoluteExpiresAt);
    res.setHeader('Set-Cookie', cookieHeader(sessionToken, session.expiresAt - now));

    let body;
    if (req.method === 'POST') {
      try { body = await readBody(req); }
      catch { return send(res, 400, JSON.stringify({ error: 'invalid_request' })); }
    }
    try { await proxy(req, res, upstream, body); }
    catch {
      if (!res.headersSent && !res.destroyed) send(res, 503, JSON.stringify({ error: 'runtime_unavailable' }));
    }
  }

  function readSession(req, res) {
    const cookie = parseCookie(req.headers.cookie, 'albera_runtime_session');
    const existing = sessionForToken(cookie);
    if (!existing) return send(res, 401, JSON.stringify({ error: 'bootstrap_required' }));
    const now = Date.now();
    existing.expiresAt = Math.min(now + sessionLifetimeMs, existing.absoluteExpiresAt);
    return send(res, 200, JSON.stringify({ csrfToken: existing.csrfToken, expiresAt: existing.expiresAt, roots }), undefined, {
      'Set-Cookie': cookieHeader(cookie, existing.expiresAt - now, basePath),
      'Vary': 'Cookie, Origin',
    });
  }

  async function createSession(req, res, expectedOrigin) {
    if (req.headers.origin !== expectedOrigin || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return send(res, 403, JSON.stringify({ error: 'forbidden' }));
    }
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return send(res, 415, JSON.stringify({ error: 'invalid_content_type' }));
    }
    if (bootstrapUsed) return send(res, 403, JSON.stringify({ error: 'bootstrap_consumed' }));
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, JSON.stringify({ error: 'invalid_request' })); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !constantTimeStringEqual(body.bootstrapCode, bootstrapCode)) return send(res, 403, JSON.stringify({ error: 'bootstrap_invalid' }));
    bootstrapUsed = true;
    purgeSessions();
    if (sessions.size >= maxSessions) return send(res, 503, JSON.stringify({ error: 'session_capacity' }));
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    const absoluteExpiresAt = now + MAX_SESSION_AGE_MS;
    const expiresAt = Math.min(now + sessionLifetimeMs, absoluteExpiresAt);
    sessions.set(hash(sessionToken), { csrfToken, expiresAt, absoluteExpiresAt });
    return send(res, 200, JSON.stringify({ csrfToken, expiresAt, roots }), undefined, {
      'Set-Cookie': cookieHeader(sessionToken, sessionLifetimeMs, basePath),
      'Vary': 'Cookie, Origin',
    });
  }

  function findSession(rawCookie) {
    const value = parseCookie(rawCookie, 'albera_runtime_session');
    const session = sessionForToken(value);
    return session ? { token: value, session } : undefined;
  }

  function sessionForToken(value) {
    if (!value || !/^[A-Za-z0-9_-]{40,48}$/.test(value)) return undefined;
    const key = hash(value);
    const session = sessions.get(key);
    if (!session) return undefined;
    const now = Date.now();
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) { sessions.delete(key); return undefined; }
    return session;
  }

  function purgeSessions() {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now || session.absoluteExpiresAt <= now) sessions.delete(key);
  }

  async function proxy(req, res, upstream, body) {
    if (!apiAddress) return send(res, 503, JSON.stringify({ error: 'runtime_unavailable' }));
    const abort = new AbortController();
    const abortRequest = () => abort.abort();
    req.once('aborted', abortRequest);
    res.once('close', abortRequest);
    const response = await fetch(`http://127.0.0.1:${apiAddress.port}${upstream}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Host: `127.0.0.1:${apiAddress.port}`,
        ...(body?.length ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
      },
      ...(body?.length ? { body } : {}),
      signal: abort.signal,
      redirect: 'error',
    });
    if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
      res.writeHead(response.status, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      if (!response.body) return res.end();
      for await (const chunk of response.body) {
        if (res.destroyed || res.writableEnded) break;
        if (res.writableLength + chunk.byteLength > MAX_STREAM_BUFFER) { abort.abort(); break; }
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      }
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    const data = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
    send(res, response.status, data, type);
  }

  return Object.freeze({
    /** Start the host on loopback, after its isolated Runtime API is listening. */
    async listen(port = 0) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be between 0 and 65535');
      if (closing) throw new Error('approval_host_closed');
      if (listenPromise) return listenPromise;
      listenPromise = (async () => {
        apiAddress = await api.listen(0);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('approval_host_listen_failed');
        serverPort = address.port;
        return Object.freeze({ host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}${basePath}`, bootstrapCode });
      })();
      return listenPromise;
    },
    close({ closeApi = true } = {}) {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        sessions.clear();
        await listenPromise?.catch(() => {});
        const closed = stopServer();
        if (closeApi) await api.close();
        if (closeApi) await closed;
      })();
      return closePromise;
    },
    /** Drain browser requests after a trusted host has closed its private Runtime API. */
    drain() { return serverClosePromise ?? Promise.resolve(); },
    get sessionCount() { purgeSessions(); return sessions.size; },
  });

  function stopServer() {
    if (!server.listening) return Promise.resolve();
    if (!serverClosePromise) {
      serverClosePromise = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    }
    return serverClosePromise;
  }
}

function upstreamRoute(method, url, lastEventId) {
  if (method === 'GET' && url.pathname === '/api/providers') return '/v1/providers';
  if (method === 'GET' && url.pathname === '/api/runs') return '/v1/runs';
  if (method === 'GET' && url.pathname === '/api/approvals') return '/v1/approvals';
  if (method === 'GET' && url.pathname === '/api/events') return `/v1/events?after=${safeCursor(url.searchParams.get('after'))}&limit=100`;
  if (method === 'GET' && url.pathname === '/api/events/stream') {
    const after = typeof lastEventId === 'string' && /^\d{1,16}$/.test(lastEventId) ? safeCursor(lastEventId) : safeCursor(url.searchParams.get('after'));
    return `/v1/events/stream?after=${after}`;
  }
  if (method === 'POST' && url.pathname === '/api/runs') return '/v1/runs';
  let match = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (method === 'POST' && match && UUID_RE.test(match[1])) return `/v1/approvals/${match[1]}`;
  match = url.pathname.match(/^\/api\/runs\/([^/]+)\/(stop|input)$/);
  if (method === 'POST' && match && UUID_RE.test(match[1])) return `/v1/runs/${match[1]}/${match[2]}`;
  return null;
}

function safeCursor(raw) {
  if (raw === null || raw === '') return '0';
  return /^\d{1,16}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? raw : 'invalid';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookie(header, key) {
  if (typeof header !== 'string' || header.length > 4096) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== key) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function cookieHeader(value, ttlMs, pathScope) {
  return `albera_runtime_session=${value}; HttpOnly; SameSite=Strict; Path=${pathScope}; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function constantTimeStringEqual(received, expected) {
  if (typeof received !== 'string' || received.length > 128) return false;
  const left = Buffer.from(hash(received));
  const right = Buffer.from(hash(expected));
  return timingSafeEqual(left, right);
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
