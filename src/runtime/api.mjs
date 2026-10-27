// Experimental authenticated Runtime API. It is intentionally separate from the read-only Observer.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 20 * 1024;
const MAX_STREAMS = 4;
const MAX_STREAM_LIFETIME_MS = 60_000;
const MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_CREDENTIALS = 256;
const MAX_TRACKED_RUNS = 64;
const MAX_EVENT_SCAN = 256;
const MAX_PENDING_STREAM_EVENTS = 256;
const API_SCOPES = new Set(['health', 'runs:read', 'events:read', 'runs:start', 'runs:stop']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(['claude', 'codex', 'opencode']);
const RUN_STATUSES = new Set(['starting', 'running', 'stopping', 'stopped', 'exited', 'failed', 'interrupted']);
const EVENT_TYPES = new Set(['started', 'stop_requested', 'stopped', 'exited', 'failed', 'stop_failed']);
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGABRT']);
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const GATEWAY_ERRORS = new Set([
  'confirmation_required', 'unknown_provider', 'invalid_args', 'cwd_not_allowed', 'executable_unavailable',
  'capacity', 'unknown_run', 'spawn_failed', 'stop_failed', 'authorization_failed', 'gateway_closed',
  'unsupported_profile', 'profile_unavailable', 'audit_unavailable',
]);

class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/**
 * Create an isolated loopback API. Bearer credentials are never persisted; optional audit records omit credential values.
 * The Gateway still performs its separate host authorization; possession of this token alone cannot launch.
 * @param {{gateway: {start: Function, stop: Function, list: Function, events: Function}, pollIntervalMs?: number, streamLifetimeMs?: number, maxStreams?: number}} options
 */
export function createRuntimeApi({ gateway, journal, pollIntervalMs = 250, streamLifetimeMs = MAX_STREAM_LIFETIME_MS, maxStreams = MAX_STREAMS } = {}) {
  if (!gateway || ['start', 'stop', 'list', 'events'].some((method) => typeof gateway[method] !== 'function')) throw new TypeError('Runtime API requires a Gateway');
  if (journal !== undefined && (!journal || typeof journal.append !== 'function' || typeof journal.list !== 'function')) throw new TypeError('journal must provide append() and list()');
  if (journal !== undefined && typeof gateway.close !== 'function') throw new TypeError('audited Gateway must provide close() for fail-closed cleanup');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 1000) throw new TypeError('pollIntervalMs must be between 100 and 1000');
  if (!Number.isInteger(streamLifetimeMs) || streamLifetimeMs < 1000 || streamLifetimeMs > MAX_STREAM_LIFETIME_MS) throw new TypeError('streamLifetimeMs must be between 1000 and 60000');
  if (!Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > MAX_STREAMS) throw new TypeError('maxStreams must be between 1 and 4');

  const credentials = new Map();
  const runOwners = new Map();
  const recoveredRuns = new Map();
  const pendingJournalEvents = new Map();
  let gatewayEventCursor = 0;
  let capturePromise;
  if (journal) restoreJournalState(journal, runOwners, recoveredRuns);
  /** @type {Set<() => void>} */
  const streams = new Set();
  let closing = false;
  let auditFailure = false;
  let listenPromise;
  let closePromise;
  let captureTimer;
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 32;

  async function handle(req, res) {
    setSecurityHeaders(res);
    if (auditFailure) return sendJson(res, 503, { error: 'audit_unavailable' });
    if (closing) return sendJson(res, 503, { error: 'api_closed' });
    const port = server.address()?.port;
    if (!Number.isInteger(port)) return sendJson(res, 503, { error: 'api_not_listening' });
    if (!validHost(req.headers.host, port)) return sendJson(res, 403, { error: 'forbidden' });
    if (!validOrigin(req.headers.origin, port)) return sendJson(res, 403, { error: 'forbidden' });
    const urlPath = (() => { try { return new URL(req.url ?? '/', 'http://127.0.0.1').pathname; } catch { return ''; } })();
    const scope = requiredScope(req.method, urlPath);
    if (!scope) return sendJson(res, 404, { error: 'not_found' });
    const credential = authenticate(req.headers.authorization, credentials, scope);
    if (!credential) return sendJson(res, 401, { error: 'unauthorized' });

    let url;
    try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
    catch { return sendJson(res, 400, { error: 'invalid_request' }); }

    try {
      if (req.method === 'GET' && url.pathname === '/v1/health') return sendJson(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/v1/runs') {
        const liveRuns = gateway.list().filter((run) => run && runOwners.get(run.id) === credential.sessionId).map(projectRun).filter(Boolean);
        const liveIds = new Set(liveRuns.map((run) => run.id));
        const restored = [...recoveredRuns.values()].filter((run) => runOwners.get(run.id) === credential.sessionId && !liveIds.has(run.id));
        return sendJson(res, 200, { runs: [...liveRuns, ...restored].slice(-MAX_TRACKED_RUNS) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/events') {
        const after = queryInteger(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
        const limit = queryInteger(url.searchParams.get('limit'), 100, 100);
        if (journal) {
          await captureGatewayEvents();
          return sendJson(res, 200, { events: journal.list({ sessionId: credential.sessionId, kind: 'event', after, limit }).map(projectJournalEvent).filter(Boolean) });
        }
        return sendJson(res, 200, { events: sessionEvents(gateway, runOwners, credential.sessionId, after, limit).events });
      }
      if (req.method === 'GET' && url.pathname === '/v1/events/stream') {
        const after = eventCursor(req, url);
        return streamEvents(req, res, after, credential.sessionId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const input = await readJson(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_request');
        const keys = Object.keys(input);
        if (keys.some((key) => !['provider', 'cwd', 'prompt', 'profile'].includes(key))) throw new ApiError(400, 'invalid_request');
        const request = /** @type {{provider: string, cwd: string, prompt: string, profile?: string}} */ ({ provider: input.provider, cwd: input.cwd, prompt: input.prompt });
        if (Object.hasOwn(input, 'profile')) request.profile = input.profile;
        const requestId = randomUUID();
        const auditProvider = PROVIDERS.has(request.provider) ? request.provider : undefined;
        await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.start', phase: 'requested', ...(auditProvider ? { provider: auditProvider } : {}) });
        let run;
        try { run = await gateway.start(request); }
        catch (error) {
          try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.start', phase: safeFailurePhase(error), ...(auditProvider ? { provider: auditProvider } : {}), errorCode: safeGatewayCode(error) }); }
          catch (auditError) {
            try { await gateway.close(); } catch { /* stop any execution whose failed start could not be audited */ }
            throw auditError;
          }
          throw error;
        }
        const safeRun = projectRun(run);
        if (!safeRun) {
          try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.start', phase: 'failed', ...(auditProvider ? { provider: auditProvider } : {}), errorCode: 'runtime_invalid_response' }); }
          catch { auditFailure = Boolean(journal); }
          try { await gateway.close?.(); } catch { /* fail closed even if cleanup reports an error */ }
          throw new ApiError(502, 'runtime_invalid_response');
        }
        try {
          await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.start', phase: 'accepted', provider: safeRun.provider, runId: safeRun.id });
        } catch {
          auditFailure = true;
          try { await gateway.close?.(); } catch { /* fail closed even if cleanup reports an error */ }
          throw new ApiError(503, 'audit_unavailable');
        }
        pruneRunOwners(runOwners, gateway.list(), recoveredRuns);
        runOwners.set(safeRun.id, credential.sessionId);
        recoveredRuns.set(safeRun.id, safeRun);
        while (recoveredRuns.size > MAX_TRACKED_RUNS) recoveredRuns.delete(recoveredRuns.keys().next().value);
        if (journal) await captureGatewayEvents();
        return sendJson(res, 202, { run: safeRun });
      }
      const stopMatch = req.method === 'POST' && url.pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/);
      if (stopMatch) {
        if (!UUID_RE.test(stopMatch[1])) throw new ApiError(404, 'not_found');
        if (runOwners.get(stopMatch[1]) !== credential.sessionId) throw new ApiError(404, 'not_found');
        if (recoveredRuns.has(stopMatch[1]) && !gateway.list().some((run) => run?.id === stopMatch[1])) throw new ApiError(409, 'run_not_active');
        const body = await readBody(req);
        if (body.length !== 0) throw new ApiError(400, 'invalid_request');
        const requestId = randomUUID();
        await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.stop', phase: 'requested', runId: stopMatch[1] });
        let run;
        try { run = await gateway.stop(stopMatch[1]); }
        catch (error) {
          try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.stop', phase: safeFailurePhase(error), runId: stopMatch[1], errorCode: safeGatewayCode(error) }); }
          catch (auditError) {
            try { await gateway.close(); } catch { /* stop remaining executions when a stop decision cannot be audited */ }
            throw auditError;
          }
          throw error;
        }
        const safeRun = projectRun(run);
        if (!safeRun) {
          try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.stop', phase: 'failed', runId: stopMatch[1], errorCode: 'runtime_invalid_response' }); }
          catch { auditFailure = Boolean(journal); }
          try { await gateway.close?.(); } catch { /* fail closed even if cleanup reports an error */ }
          throw new ApiError(502, 'runtime_invalid_response');
        }
        try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.stop', phase: 'accepted', runId: safeRun.id }); }
        catch {
          auditFailure = true;
          try { await gateway.close?.(); } catch { /* fail closed even if cleanup reports an error */ }
          throw new ApiError(503, 'audit_unavailable');
        }
        if (journal) await captureGatewayEvents();
        return sendJson(res, 200, { run: safeRun });
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof ApiError) return sendJson(res, error.status, { error: error.code });
      const code = error && typeof error === 'object' && typeof error.code === 'string' && GATEWAY_ERRORS.has(error.code)
        ? error.code
        : 'runtime_error';
      const status = code === 'confirmation_required' ? 403
        : code === 'unknown_run' ? 404
          : code === 'capacity' ? 429
            : code === 'gateway_closed' ? 503
              : ['unsupported_profile', 'profile_unavailable'].includes(code) ? 422
                : ['unknown_provider', 'invalid_args', 'cwd_not_allowed'].includes(code) ? 400
                  : 500;
      return sendJson(res, status, { error: code });
    }
  }

  async function writeAudit(record) {
    if (!journal) return;
    try { await journal.append({ ...record, at: Date.now() }); }
    catch {
      await failClosed();
      throw new ApiError(503, 'audit_unavailable');
    }
  }

  async function failClosed() {
    if (auditFailure) return;
    auditFailure = true;
    clearInterval(captureTimer);
    captureTimer = undefined;
    for (const close of [...streams]) close();
    try { await gateway.close(); } catch { /* keep the API unavailable even if cleanup is uncertain */ }
  }

  function captureGatewayEvents() {
    if (!journal || closing || auditFailure) return Promise.resolve();
    if (capturePromise) return capturePromise;
    capturePromise = (async () => {
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const batch = gateway.events({ after: gatewayEventCursor, limit: 100 });
        if (!Array.isArray(batch)) throw new Error('invalid_gateway_events');
        let advanced = false;
        for (const raw of batch) {
          if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= gatewayEventCursor) continue;
          gatewayEventCursor = raw.id;
          advanced = true;
          const event = projectEvent(raw);
          if (event) pendingJournalEvents.set(event.id, event);
        }
        for (const [sourceId, event] of pendingJournalEvents) {
          const sessionId = runOwners.get(event.runId);
          if (!sessionId) continue;
          const stored = await journal.append({
            kind: 'event', sessionId, eventType: event.type, at: event.at, provider: event.provider, runId: event.runId,
            ...(event.code === undefined ? {} : { code: event.code }), ...(event.signal === undefined ? {} : { signal: event.signal }),
          });
          pendingJournalEvents.delete(sourceId);
          recoveredRuns.set(event.runId, applyRecoveredEvent(recoveredRuns.get(event.runId), event, stored.sequence));
        }
        while (pendingJournalEvents.size > MAX_PENDING_STREAM_EVENTS) pendingJournalEvents.delete(pendingJournalEvents.keys().next().value);
        if (!advanced || batch.length < 100) break;
      }
    })().catch(async () => {
      await failClosed();
      throw new ApiError(503, 'audit_unavailable');
    }).finally(() => { capturePromise = undefined; });
    return capturePromise;
  }

  function streamEvents(req, res, after, sessionId) {
    if (streams.size >= maxStreams) return sendJson(res, 429, { error: 'stream_limit' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const deadline = Date.now() + streamLifetimeMs;
    let closed = false;
    let timer;
    let lastKeepalive = Date.now();
    const pendingEvents = new Map();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      streams.delete(close);
      if (!res.writableEnded) res.end();
    };
    streams.add(close);
    res.once('close', close);
    req.once('aborted', close);
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      if (closed || res.destroyed) return close();
      try {
        if (Date.now() >= deadline || res.writableLength > MAX_BUFFERED_RESPONSE_BYTES) return close();
        if (journal) {
          await captureGatewayEvents();
          const events = journal.list({ sessionId, kind: 'event', after, limit: 100 });
          for (const record of events) {
            const event = projectJournalEvent(record);
            if (!event) continue;
            res.write(`id: ${event.id}\nevent: lifecycle\ndata: ${JSON.stringify(event)}\n\n`);
            after = event.id;
          }
          if (Date.now() - lastKeepalive >= 15_000 && res.writableLength < 1024) {
            res.write(': keepalive\n\n');
            lastKeepalive = Date.now();
          }
          return;
        }
        const newlyOwned = [];
        for (const [id, event] of pendingEvents) {
          const owner = runOwners.get(event.runId);
          if (owner === sessionId) newlyOwned.push(event);
          if (owner !== undefined) pendingEvents.delete(id);
        }
        const page = sessionEvents(gateway, runOwners, sessionId, after, 100);
        for (const event of [...newlyOwned, ...page.events]) {
          if (closed || res.writableLength > MAX_BUFFERED_RESPONSE_BYTES) return close();
          res.write(`id: ${event.id}\nevent: lifecycle\ndata: ${JSON.stringify(event)}\n\n`);
        }
        for (const event of page.pendingEvents) pendingEvents.set(event.id, event);
        while (pendingEvents.size > MAX_PENDING_STREAM_EVENTS) pendingEvents.delete(pendingEvents.keys().next().value);
        after = page.scannedAfter;
        if (Date.now() - lastKeepalive >= 15_000 && res.writableLength < 1024) {
          res.write(': keepalive\n\n');
          lastKeepalive = Date.now();
        }
      } catch { close(); }
      finally { polling = false; }
    };
    timer = setInterval(() => { void poll(); }, pollIntervalMs);
    timer.unref?.();
    void poll();
  }

  return Object.freeze({
    /** Mint a session-scoped capability in the trusted host; no credential-minting route exists. */
    createCredential(scopes, { ttlMs = 60 * 60 * 1000, sessionId } = {}) {
      if (closing) throw new ApiError(503, 'api_closed');
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== 'string' || !API_SCOPES.has(scope))) throw new TypeError('scopes must be a non-empty list of supported API scopes');
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_CREDENTIAL_LIFETIME_MS) throw new TypeError('ttlMs must be between 1000 and 86400000');
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) throw new TypeError('sessionId must be 32 lowercase hexadecimal characters');
      purgeExpiredCredentials(credentials);
      if (credentials.size >= MAX_CREDENTIALS) throw new RangeError('credential_capacity');
      const token = randomBytes(32).toString('hex');
      const digest = createHash('sha256').update(token).digest('hex');
      credentials.set(digest, { scopes: new Set(scopes), expiresAt: Date.now() + ttlMs, sessionId: sessionId ?? randomBytes(16).toString('hex') });
      return token;
    },
    /** Revoke a session capability immediately without affecting other sessions. */
    revokeCredential(token) {
      if (typeof token !== 'string') return false;
      const digest = createHash('sha256').update(token).digest('hex');
      return credentials.delete(digest);
    },
    /** Bind only to IPv4 loopback; callers cannot choose a public interface. @param {number} [port] */
    listen(port = 0) {
      if (closing) return Promise.reject(new ApiError(503, 'api_closed'));
      if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new TypeError('port must be between 0 and 65535'));
      if (listenPromise) return listenPromise;
      listenPromise = new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') return reject(new Error('api_listen_failed'));
          if (journal) {
            captureTimer = setInterval(() => { void captureGatewayEvents().catch(() => {}); }, pollIntervalMs);
            captureTimer.unref?.();
          }
          resolve(Object.freeze({ host: '127.0.0.1', port: address.port }));
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, '127.0.0.1');
      });
      return listenPromise;
    },
    /** Close the API only. Gateway/process ownership remains with its trusted host. */
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(captureTimer);
      captureTimer = undefined;
      credentials.clear();
      for (const close of [...streams]) close();
      closePromise = (async () => {
        await capturePromise?.catch(() => {});
        if (!server.listening && !listenPromise) return;
        if (!server.listening && listenPromise) {
          await listenPromise.then(() => new Promise((resolve) => server.close(() => resolve())), () => undefined);
          return;
        }
        await new Promise((resolve) => server.close(() => resolve()));
      })();
      return closePromise;
    },
  });
}

function pruneRunOwners(runOwners, runs, recoveredRuns = new Map()) {
  const visibleIds = new Set((Array.isArray(runs) ? runs : [])
    .filter((run) => run && typeof run.id === 'string' && UUID_RE.test(run.id))
    .map((run) => run.id));
  for (const runId of runOwners.keys()) if (!visibleIds.has(runId) && !recoveredRuns.has(runId)) runOwners.delete(runId);
  while (runOwners.size > MAX_TRACKED_RUNS) {
    const oldest = runOwners.keys().next().value;
    runOwners.delete(oldest);
    recoveredRuns.delete(oldest);
  }
}

function restoreJournalState(journal, runOwners, recoveredRuns) {
  let after = 0;
  let count = 0;
  for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
    const page = journal.list({ after, limit: 100 });
    if (!Array.isArray(page) || page.length > 100) throw new TypeError('journal.list() returned an invalid page');
    if (page.length === 0) break;
    for (const record of page) {
      if (!Number.isSafeInteger(record?.sequence) || record.sequence <= after) throw new TypeError('journal.list() returned invalid ordering');
      after = record.sequence;
      if (++count > 20_000) throw new TypeError('journal recovery capacity exceeded');
      if ((record.kind ?? 'audit') === 'event') {
        const prior = recoveredRuns.get(record.runId);
        if (prior && runOwners.get(record.runId) === record.sessionId) {
          recoveredRuns.set(record.runId, applyRecoveredEvent(prior, projectJournalEvent(record), record.sequence));
        }
      } else if (record.action === 'run.start' && record.phase === 'accepted' && record.runId && record.provider) {
        runOwners.set(record.runId, record.sessionId);
        recoveredRuns.set(record.runId, {
          id: record.runId, provider: record.provider, status: 'starting', startedAt: record.at,
          finishedAt: null, exitCode: null, signal: null, treeStopConfirmed: null,
        });
      }
    }
    while (recoveredRuns.size > MAX_TRACKED_RUNS) recoveredRuns.delete(recoveredRuns.keys().next().value);
    while (runOwners.size > MAX_TRACKED_RUNS) {
      const oldest = runOwners.keys().next().value;
      runOwners.delete(oldest);
      recoveredRuns.delete(oldest);
    }
    if (page.length < 100) break;
  }
  if (count >= 20_000 && journal.list({ after, limit: 1 }).length) throw new TypeError('journal recovery capacity exceeded');
  const recoveredAt = Date.now();
  for (const [runId, run] of recoveredRuns) {
    if (['starting', 'running', 'stopping'].includes(run.status)) recoveredRuns.set(runId, { ...run, status: 'interrupted', finishedAt: recoveredAt });
  }
}

function applyRecoveredEvent(prior, event, sequence) {
  if (!prior || !event) return prior;
  const run = { ...prior };
  if (event.type === 'started') { run.status = 'running'; run.startedAt = event.at; }
  else if (event.type === 'stop_requested') run.status = 'stopping';
  else if (event.type === 'stopped' || event.type === 'exited' || event.type === 'failed') {
    run.status = event.type;
    run.finishedAt = event.at;
    if (event.code !== undefined) run.exitCode = event.code;
    if (event.signal !== undefined) run.signal = event.signal;
  }
  run.lastEventSequence = sequence;
  return run;
}

function projectJournalEvent(record) {
  if (!record || record.kind !== 'event' || !Number.isSafeInteger(record.eventId) || record.eventId < 1
    || !UUID_RE.test(record.runId ?? '') || !PROVIDERS.has(record.provider) || !EVENT_TYPES.has(record.eventType)
    || !Number.isSafeInteger(record.at) || record.at < 0) return null;
  const event = { id: record.eventId, runId: record.runId, provider: record.provider, type: record.eventType, at: record.at };
  if (record.code === null || Number.isSafeInteger(record.code)) event.code = record.code;
  if (record.signal === null || (typeof record.signal === 'string' && SIGNALS.has(record.signal))) event.signal = record.signal;
  return event;
}

function sessionEvents(gateway, runOwners, sessionId, after, limit) {
  const events = [];
  const pendingEvents = [];
  let scannedAfter = after;
  let scanned = 0;
  while (events.length < limit && scanned < MAX_EVENT_SCAN) {
    const batchLimit = Math.min(100, MAX_EVENT_SCAN - scanned);
    const batch = gateway.events({ after: scannedAfter, limit: batchLimit });
    if (!Array.isArray(batch) || batch.length === 0) break;
    const priorCursor = scannedAfter;
    for (const raw of batch) {
      if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= scannedAfter) continue;
      scannedAfter = raw.id;
      scanned++;
      const event = projectEvent(raw);
      if (event) {
        const owner = runOwners.get(event.runId);
        if (owner === sessionId) events.push(event);
        else if (owner === undefined) pendingEvents.push(event);
      }
      if (events.length >= limit || scanned >= MAX_EVENT_SCAN) break;
    }
    if (scannedAfter === priorCursor || batch.length < batchLimit) break;
  }
  return { events, pendingEvents, scannedAfter };
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
function validHost(host, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return typeof host === 'string' && allowed.has(host.toLowerCase());
}
function validOrigin(origin, port) {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
function authenticate(header, credentials, requiredScope) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 256) return false;
  const candidate = createHash('sha256').update(header.slice(7)).digest();
  const digestHex = candidate.toString('hex');
  let matched;
  for (const [storedHex, entry] of credentials) {
    const stored = Buffer.from(storedHex, 'hex');
    if (timingSafeEqual(candidate, stored)) matched = entry;
  }
  purgeExpiredCredentials(credentials);
  return matched && matched.expiresAt > Date.now() && matched.scopes.has(requiredScope) ? matched : false;
}
function safeFailurePhase(error) { return error?.code === 'confirmation_required' ? 'denied' : 'failed'; }
function safeGatewayCode(error) { return typeof error?.code === 'string' && GATEWAY_ERRORS.has(error.code) ? error.code : 'runtime_error'; }
function purgeExpiredCredentials(credentials) {
  const now = Date.now();
  for (const [digest, entry] of credentials) if (entry.expiresAt <= now) credentials.delete(digest);
}
function requiredScope(method, pathname) {
  if (method === 'GET' && pathname === '/v1/health') return 'health';
  if (method === 'GET' && pathname === '/v1/runs') return 'runs:read';
  if (method === 'GET' && ['/v1/events', '/v1/events/stream'].includes(pathname)) return 'events:read';
  if (method === 'POST' && pathname === '/v1/runs') return 'runs:start';
  if (method === 'POST' && /^\/v1\/runs\/[^/]+\/stop$/.test(pathname)) return 'runs:stop';
  return null;
}
function sendJson(res, status, value) {
  if (res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function projectRun(run) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || !UUID_RE.test(run.id)
    || typeof run.provider !== 'string' || !PROVIDERS.has(run.provider)
    || typeof run.status !== 'string' || !RUN_STATUSES.has(run.status)) return null;
  const result = {};
  result.id = run.id;
  result.provider = run.provider;
  result.status = run.status;
  for (const key of ['startedAt', 'finishedAt']) if (run[key] === null || (typeof run[key] === 'number' && Number.isFinite(run[key]))) result[key] = run[key];
  if (run.exitCode === null || (Number.isInteger(run.exitCode) && Number.isSafeInteger(run.exitCode))) result.exitCode = run.exitCode;
  if (run.signal === null || (typeof run.signal === 'string' && SIGNALS.has(run.signal))) result.signal = run.signal;
  if (run.treeStopConfirmed === null || typeof run.treeStopConfirmed === 'boolean') result.treeStopConfirmed = run.treeStopConfirmed;
  return result;
}
function projectEvent(event) {
  if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.id) || event.id < 0
    || typeof event.runId !== 'string' || !UUID_RE.test(event.runId)
    || typeof event.provider !== 'string' || !PROVIDERS.has(event.provider)
    || typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)
    || typeof event.at !== 'number' || !Number.isFinite(event.at)) return null;
  const result = {};
  for (const key of ['id', 'runId', 'provider', 'type', 'at']) result[key] = event[key];
  if (event.code === null || (Number.isInteger(event.code) && Number.isSafeInteger(event.code))) result.code = event.code;
  if (event.signal === null || (typeof event.signal === 'string' && SIGNALS.has(event.signal))) result.signal = event.signal;
  return result;
}
function queryInteger(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ApiError(400, 'invalid_request');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new ApiError(400, 'invalid_request');
  return parsed;
}
function eventCursor(req, url) {
  const header = req.headers['last-event-id'];
  if (header !== undefined && typeof header !== 'string') throw new ApiError(400, 'invalid_request');
  return queryInteger(header === undefined ? url.searchParams.get('after') : header, 0, Number.MAX_SAFE_INTEGER);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new ApiError(415, 'content_type_required');
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_request'); }
}
