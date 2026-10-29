// Experimental authenticated Runtime API. It is intentionally separate from the read-only Observer.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { listRuntimeProviderCapabilities } from './provider-catalog.mjs';

const MAX_BODY_BYTES = 20 * 1024;
const MAX_STREAMS = 4;
const MAX_STREAM_LIFETIME_MS = 60_000;
const MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_CREDENTIALS = 256;
const MAX_TRACKED_RUNS = 64;
const MAX_PENDING_STREAM_EVENTS = 256;
const MAX_SESSION_EVENT_LOGS = 256;
const MAX_SESSION_EVENTS = 256;
const API_SCOPES = new Set(['health', 'providers:read', 'runs:read', 'events:read', 'runs:start', 'runs:stop', 'runs:input', 'approvals:read', 'approvals:decide', 'environments:execute', 'environments:reconcile']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(['claude', 'codex', 'opencode']);
const PROFILES = new Set(['read-only', 'read-only-streaming']);
const INPUT_MODES = new Set(['claude-stream-json']);
const RUN_STATUSES = new Set(['starting', 'running', 'stopping', 'stopped', 'exited', 'failed', 'interrupted']);
const EVENT_TYPES = new Set(['started', 'stop_requested', 'stopped', 'exited', 'failed', 'stop_failed', 'input_sent']);
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGABRT']);
const STOP_REASONS = new Set(['user_cancel', 'timeout', 'host_shutdown']);
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const GATEWAY_ERRORS = new Set([
  'confirmation_required', 'unknown_provider', 'invalid_args', 'cwd_not_allowed', 'executable_unavailable',
  'capacity', 'unknown_run', 'spawn_failed', 'stop_failed', 'authorization_failed', 'gateway_closed',
  'unsupported_profile', 'profile_unavailable', 'cli_version_unavailable', 'audit_unavailable', 'input_unavailable', 'input_not_ready',
  'input_busy', 'input_failed',
]);

class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/**
 * Create an isolated loopback API. Bearer credentials are never persisted; optional audit records omit credential values.
 * The Gateway still performs its separate host authorization; possession of this token alone cannot launch.
 * @param {{gateway: {start: Function, stop: Function, list: Function, events: Function, subscribeEvents?: Function, sendInput?: Function}, pollIntervalMs?: number, streamLifetimeMs?: number, maxStreams?: number}} options
 */
export function createRuntimeApi({ gateway, journal, approvalBroker, environmentControlPlane, pollIntervalMs = 250, streamLifetimeMs = MAX_STREAM_LIFETIME_MS, maxStreams = MAX_STREAMS } = {}) {
  if (!gateway || ['start', 'stop', 'list', 'events'].some((method) => typeof gateway[method] !== 'function')) throw new TypeError('Runtime API requires a Gateway');
  if (journal !== undefined && (!journal || typeof journal.append !== 'function' || typeof journal.list !== 'function')) throw new TypeError('journal must provide append() and list()');
  if (approvalBroker !== undefined && (!approvalBroker || typeof approvalBroker.listPending !== 'function' || typeof approvalBroker.decide !== 'function' || typeof approvalBroker.close !== 'function')) throw new TypeError('approvalBroker must provide listPending(), decide() and close()');
  if (environmentControlPlane !== undefined && (!environmentControlPlane || typeof environmentControlPlane !== 'object')) throw new TypeError('environmentControlPlane must provide execute() and reconcile()');
  const environmentExecute = environmentControlPlane ? captureApiMethod(environmentControlPlane, 'execute') : undefined;
  const environmentReconcile = environmentControlPlane ? captureApiMethod(environmentControlPlane, 'reconcile') : undefined;
  if (journal !== undefined && typeof gateway.close !== 'function') throw new TypeError('audited Gateway must provide close() for fail-closed cleanup');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 1000) throw new TypeError('pollIntervalMs must be between 100 and 1000');
  if (!Number.isInteger(streamLifetimeMs) || streamLifetimeMs < 1000 || streamLifetimeMs > MAX_STREAM_LIFETIME_MS) throw new TypeError('streamLifetimeMs must be between 1000 and 60000');
  if (!Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > MAX_STREAMS) throw new TypeError('maxStreams must be between 1 and 4');

  const credentials = new Map();
  const runOwners = new Map();
  const recoveredRuns = new Map();
  const pendingGatewayEvents = new Map();
  const sessionEventLogs = new Map();
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
  const unsubscribeGatewayEvents = typeof gateway.subscribeEvents === 'function'
    ? gateway.subscribeEvents(() => { void captureGatewayEvents().catch(() => {}); })
    : undefined;
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
      if (req.method === 'GET' && url.pathname === '/v1/providers') {
        return sendJson(res, 200, { providers: listRuntimeProviderCapabilities() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/approvals') {
        if (!approvalBroker) throw new ApiError(404, 'not_found');
        const approvals = approvalBroker.listPending();
        if (!Array.isArray(approvals) || approvals.length > 32) throw new ApiError(503, 'approval_unavailable');
        return sendJson(res, 200, { approvals });
      }
      if (req.method === 'POST' && url.pathname === '/v1/environments/operations') {
        if (!environmentControlPlane) throw new ApiError(404, 'not_found');
        const input = await readJson(req);
        let operation;
        try { operation = projectEnvironmentOperation(await environmentExecute({ sessionId: credential.sessionId, input }), credential.sessionId); }
        catch (error) { throw environmentApiError(error); }
        return sendJson(res, 200, { operation });
      }
      const reconcileMatch = req.method === 'POST' && url.pathname.match(/^\/v1\/environments\/operations\/([^/]+)\/reconcile$/);
      if (reconcileMatch) {
        if (!environmentControlPlane) throw new ApiError(404, 'not_found');
        const body = await readBody(req);
        if (body.length !== 0) throw new ApiError(400, 'invalid_request');
        let operation;
        try { operation = projectEnvironmentOperation(await environmentReconcile({ sessionId: credential.sessionId, operationId: reconcileMatch[1] }), credential.sessionId); }
        catch (error) { throw environmentApiError(error); }
        return sendJson(res, 200, { operation });
      }
      const approvalMatch = req.method === 'POST' && url.pathname.match(/^\/v1\/approvals\/([^/]+)$/);
      if (approvalMatch) {
        if (!approvalBroker) throw new ApiError(404, 'not_found');
        if (!UUID_RE.test(approvalMatch[1])) throw new ApiError(404, 'not_found');
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
          || !['approve', 'deny'].includes(body.decision)) throw new ApiError(400, 'invalid_request');
        if (!approvalBroker.decide(approvalMatch[1], body.decision === 'approve')) throw new ApiError(404, 'not_found');
        return sendJson(res, 200, { decided: true });
      }
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
        await captureGatewayEvents();
        return sendJson(res, 200, { events: sessionEvents(sessionEventLogs, credential.sessionId, after, limit) });
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
        await captureAvailableGatewayEvents();
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
            try { await gateway.close(); } catch { /* stop remaining executions when the stop request cannot be audited */ }
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
        await captureGatewayEvents();
        return sendJson(res, 200, { run: safeRun });
      }
      const inputMatch = req.method === 'POST' && url.pathname.match(/^\/v1\/runs\/([^/]+)\/input$/);
      if (inputMatch) {
        if (!UUID_RE.test(inputMatch[1]) || runOwners.get(inputMatch[1]) !== credential.sessionId) throw new ApiError(404, 'not_found');
        if (recoveredRuns.has(inputMatch[1]) && !gateway.list().some((run) => run?.id === inputMatch[1])) throw new ApiError(409, 'run_not_active');
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
          || typeof body.text !== 'string' || body.text.length === 0) throw new ApiError(400, 'invalid_request');
        if (typeof gateway.sendInput !== 'function') throw new ApiError(422, 'input_unavailable');
        const requestId = randomUUID();
        await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.input', phase: 'requested', runId: inputMatch[1] });
        let run;
        try { run = await gateway.sendInput(inputMatch[1], body.text); }
        catch (error) {
          try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.input', phase: safeFailurePhase(error), runId: inputMatch[1], errorCode: safeGatewayCode(error) }); }
          catch (auditError) {
            try { await gateway.close(); } catch { /* stop executions when input authorization could not be recorded */ }
            throw auditError;
          }
          throw error;
        }
        const safeRun = projectRun(run);
        if (!safeRun) {
          try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.input', phase: 'failed', runId: inputMatch[1], errorCode: 'runtime_invalid_response' }); }
          catch { auditFailure = Boolean(journal); }
          try { await gateway.close?.(); } catch { /* fail closed on malformed Gateway response */ }
          throw new ApiError(502, 'runtime_invalid_response');
        }
        try { await writeAudit({ sessionId: credential.sessionId, requestId, action: 'run.input', phase: 'accepted', provider: safeRun.provider, runId: safeRun.id }); }
        catch {
          auditFailure = true;
          try { await gateway.close?.(); } catch { /* fail closed if accepted input cannot be audited */ }
          throw new ApiError(503, 'audit_unavailable');
        }
        await captureGatewayEvents();
        return sendJson(res, 200, { run: safeRun });
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const apiError = projectApiError(error);
      if (apiError) return sendJson(res, apiError.status, { error: apiError.code });
      const code = safeGatewayCode(error);
      const status = code === 'confirmation_required' ? 403
        : code === 'unknown_run' ? 404
          : code === 'capacity' ? 429
            : code === 'gateway_closed' ? 503
              : ['unsupported_profile', 'profile_unavailable', 'cli_version_unavailable', 'input_unavailable'].includes(code) ? 422
            : ['input_not_ready', 'input_busy'].includes(code) ? 409
              : ['input_failed'].includes(code) ? 502
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
    if (closing || auditFailure) return Promise.resolve();
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
          if (event) pendingGatewayEvents.set(event.id, event);
        }
        for (const [sourceId, event] of pendingGatewayEvents) {
          const sessionId = runOwners.get(event.runId);
          if (!sessionId) continue;
          if (journal) {
            const stored = await journal.append({
              kind: 'event', sessionId, eventType: event.type, at: event.at, provider: event.provider, runId: event.runId,
              ...(event.code === undefined ? {} : { code: event.code }), ...(event.signal === undefined ? {} : { signal: event.signal }),
              ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
              ...(event.force === undefined ? {} : { force: event.force }),
            });
            recoveredRuns.set(event.runId, applyRecoveredEvent(recoveredRuns.get(event.runId), event, stored.sequence));
          } else {
            appendSessionEvent(sessionEventLogs, sessionId, event);
          }
          pendingGatewayEvents.delete(sourceId);
        }
        while (pendingGatewayEvents.size > MAX_PENDING_STREAM_EVENTS) pendingGatewayEvents.delete(pendingGatewayEvents.keys().next().value);
        if (!advanced || batch.length < 100) break;
      }
    })().catch(async () => {
      if (!journal) return;
      await failClosed();
      throw new ApiError(503, 'audit_unavailable');
    }).finally(() => {
      capturePromise = undefined;
      if (!closing && !auditFailure && [...pendingGatewayEvents.values()].some((event) => runOwners.has(event.runId))) {
        queueMicrotask(() => { void captureGatewayEvents().catch(() => {}); });
      }
    });
    return capturePromise;
  }

  async function captureAvailableGatewayEvents() {
    await captureGatewayEvents();
    // A lifecycle callback can race the start audit append, leaving an event pending while its
    // run owner is installed. A second pass drains it immediately instead of waiting for the poll.
    if ([...pendingGatewayEvents.values()].some((event) => runOwners.has(event.runId))) await captureGatewayEvents();
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
        await captureGatewayEvents();
        const events = sessionEvents(sessionEventLogs, sessionId, after, 100);
        for (const event of events) {
          if (closed || res.writableLength > MAX_BUFFERED_RESPONSE_BYTES) return close();
          res.write(`id: ${event.id}\nevent: lifecycle\ndata: ${JSON.stringify(event)}\n\n`);
          after = event.id;
        }
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
      if (!approvalBroker && scopes.some((scope) => scope.startsWith('approvals:'))) throw new TypeError('approval scopes require an approval broker');
      if (!environmentControlPlane && scopes.some((scope) => scope.startsWith('environments:'))) throw new TypeError('environment scopes require an environment control plane');
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_CREDENTIAL_LIFETIME_MS) throw new TypeError('ttlMs must be between 1000 and 86400000');
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) throw new TypeError('sessionId must be 32 lowercase hexadecimal characters');
      purgeExpiredCredentials(credentials);
      if (credentials.size >= MAX_CREDENTIALS) throw new RangeError('credential_capacity');
      const token = randomBytes(32).toString('hex');
      const digest = createHash('sha256').update(token).digest('hex');
      credentials.set(digest, { scopes: new Set(scopes), expiresAt: Date.now() + ttlMs, sessionId: sessionId ?? randomBytes(16).toString('hex') });
      return token;
    },
    /** Force a final trusted-host lifecycle capture before shutdown; this is not an HTTP route. */
    async flushEvents() {
      if (capturePromise) await capturePromise;
      return captureGatewayEvents();
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
          captureTimer = setInterval(() => { void captureGatewayEvents().catch(() => {}); }, pollIntervalMs);
          captureTimer.unref?.();
          resolve(Object.freeze({ host: '127.0.0.1', port: address.port }));
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, '127.0.0.1');
      });
      return listenPromise;
    },
    /** Close the API, deny pending approvals, and leave active Gateway/process ownership with its trusted host. */
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(captureTimer);
      captureTimer = undefined;
      unsubscribeGatewayEvents?.();
      credentials.clear();
      for (const close of [...streams]) close();
      approvalBroker?.close();
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
          finishedAt: null, exitCode: null, signal: null, treeStopConfirmed: null, stopReason: null,
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
  else if (event.type === 'stop_requested') { run.status = 'stopping'; run.stopReason = event.stopReason ?? null; }
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
  if (record.stopReason !== undefined) {
    if (!STOP_REASONS.has(record.stopReason) || !['stop_requested', 'stop_failed'].includes(record.eventType)) return null;
    event.stopReason = record.stopReason;
  }
  if (record.force !== undefined) {
    if (typeof record.force !== 'boolean' || record.eventType !== 'stop_requested') return null;
    event.force = record.force;
  }
  if (record.code === null || Number.isSafeInteger(record.code)) event.code = record.code;
  if (record.signal === null || (typeof record.signal === 'string' && SIGNALS.has(record.signal))) event.signal = record.signal;
  return event;
}

function appendSessionEvent(logs, sessionId, event) {
  let log = logs.get(sessionId);
  if (!log) {
    if (logs.size >= MAX_SESSION_EVENT_LOGS) logs.delete(logs.keys().next().value);
    log = { nextId: 1, events: [] };
    logs.set(sessionId, log);
  }
  const projected = { ...event, id: log.nextId++ };
  log.events.push(projected);
  if (log.events.length > MAX_SESSION_EVENTS) log.events.splice(0, log.events.length - MAX_SESSION_EVENTS);
}

function sessionEvents(logs, sessionId, after, limit) {
  const log = logs.get(sessionId);
  if (!log) return [];
  return log.events.filter((event) => event.id > after).slice(0, limit).map((event) => ({ ...event }));
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
function safeFailurePhase(error) { return readOwnDataProperty(error, 'code') === 'confirmation_required' ? 'denied' : 'failed'; }
function safeGatewayCode(error) {
  const code = readOwnDataProperty(error, 'code');
  return typeof code === 'string' && GATEWAY_ERRORS.has(code) ? code : 'runtime_error';
}
function projectApiError(error) {
  try {
    if (!(error instanceof ApiError)) return null;
    const status = readOwnDataProperty(error, 'status');
    const code = readOwnDataProperty(error, 'code');
    if (!Number.isSafeInteger(status) || typeof code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(code)) return null;
    return { status, code };
  } catch {
    return null;
  }
}
function readOwnDataProperty(value, key) {
  try {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function purgeExpiredCredentials(credentials) {
  const now = Date.now();
  for (const [digest, entry] of credentials) if (entry.expiresAt <= now) credentials.delete(digest);
}
function requiredScope(method, pathname) {
  if (method === 'GET' && pathname === '/v1/health') return 'health';
  if (method === 'GET' && pathname === '/v1/providers') return 'providers:read';
  if (method === 'GET' && pathname === '/v1/approvals') return 'approvals:read';
  if (method === 'POST' && /^\/v1\/approvals\/[^/]+$/.test(pathname)) return 'approvals:decide';
  if (method === 'GET' && pathname === '/v1/runs') return 'runs:read';
  if (method === 'GET' && ['/v1/events', '/v1/events/stream'].includes(pathname)) return 'events:read';
  if (method === 'POST' && pathname === '/v1/runs') return 'runs:start';
  if (method === 'POST' && /^\/v1\/runs\/[^/]+\/stop$/.test(pathname)) return 'runs:stop';
  if (method === 'POST' && /^\/v1\/runs\/[^/]+\/input$/.test(pathname)) return 'runs:input';
  if (method === 'POST' && pathname === '/v1/environments/operations') return 'environments:execute';
  if (method === 'POST' && /^\/v1\/environments\/operations\/[^/]+\/reconcile$/.test(pathname)) return 'environments:reconcile';
  return null;
}

function environmentApiError(error) {
  const allowed = new Set(['unauthorized', 'unknown_operation', 'invalid_request', 'authorization_denied', 'authorization_invalid', 'authorization_expired', 'lease_not_authorized', 'lease_expired', 'stale_generation', 'idempotency_conflict', 'operation_id_conflict', 'provider_mismatch', 'policy_unavailable', 'operation_unavailable']);
  const candidate = readOwnDataProperty(error, 'code');
  const code = typeof candidate === 'string' && allowed.has(candidate) ? candidate : 'operation_unavailable';
  const status = code === 'unauthorized' ? 401
    : code === 'unknown_operation' ? 404
      : code === 'invalid_request' ? 400
        : ['authorization_denied', 'authorization_invalid', 'authorization_expired', 'lease_not_authorized', 'lease_expired'].includes(code) ? 403
          : ['stale_generation', 'idempotency_conflict', 'operation_id_conflict'].includes(code) ? 409
            : code === 'provider_mismatch' ? 400 : 503;
  return new ApiError(status, code);
}
function captureApiMethod(target, name) {
  let current = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw new TypeError(`environmentControlPlane.${name} must be a data method`);
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError(`environmentControlPlane.${name} is required`);
}
function projectEnvironmentOperation(operation, sessionId) {
  const fields = ['operationId', 'subjectId', 'projectId', 'taskId', 'runId', 'computerId', 'leaseId', 'generation', 'action', 'status', 'desiredState', 'observedState', 'observedAt', 'errorCode', 'createdAt', 'updatedAt'];
  const subject = operation && typeof operation === 'object' ? Object.getOwnPropertyDescriptor(operation, 'subjectId') : undefined;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) || !subject || !Object.hasOwn(subject, 'value') || subject.value !== sessionId) throw new ApiError(502, 'runtime_invalid_response');
  const result = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(operation, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) result[key] = descriptor.value;
  }
  return result;
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
  if (typeof run.profile === 'string' && PROFILES.has(run.profile)) result.profile = run.profile;
  if (run.provider === 'claude' && run.profile === 'read-only-streaming'
    && typeof run.inputMode === 'string' && INPUT_MODES.has(run.inputMode)) result.inputMode = run.inputMode;
  for (const key of ['startedAt', 'finishedAt']) if (run[key] === null || (typeof run[key] === 'number' && Number.isFinite(run[key]))) result[key] = run[key];
  if (run.exitCode === null || (Number.isInteger(run.exitCode) && Number.isSafeInteger(run.exitCode))) result.exitCode = run.exitCode;
  if (run.signal === null || (typeof run.signal === 'string' && SIGNALS.has(run.signal))) result.signal = run.signal;
  if (run.treeStopConfirmed === null || typeof run.treeStopConfirmed === 'boolean') result.treeStopConfirmed = run.treeStopConfirmed;
  if (run.stopReason === null || STOP_REASONS.has(run.stopReason)) result.stopReason = run.stopReason;
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
  if (event.stopReason !== undefined && STOP_REASONS.has(event.stopReason)
    && ['stop_requested', 'stop_failed'].includes(event.type)) result.stopReason = event.stopReason;
  if (typeof event.force === 'boolean' && event.type === 'stop_requested') result.force = event.force;
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
