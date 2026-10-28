// In-process bridge between RuntimeGateway authorization and a trusted host approval UI.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PROFILE_MINIMUM_VERSIONS } from './profile-policy.mjs';

const ACTIONS = new Set(['start', 'stop', 'input']);
const PROVIDERS = new Set(['claude', 'codex', 'opencode']);
const PROFILES = new Set(['read-only', 'read-only-streaming']);
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_PENDING_APPROVALS = 32;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * Create a bounded, one-use approval queue. The caller must keep `decide` inside the trusted host;
 * exposing it to a task credential would let that client approve its own execution.
 */
export function createRuntimeApprovalBroker({ timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, makeId = randomUUID } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError('timeoutMs must be between 1000 and 300000');
  if (typeof now !== 'function' || typeof makeId !== 'function') throw new TypeError('clock and ID factory must be functions');

  const pending = new Map();
  const listeners = new Set();
  let closed = false;

  const notify = () => {
    const snapshot = Object.freeze(listPending());
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* UI notifications never affect authorization decisions */ }
    }
  };

  function settle(id, approved, announce = true) {
    const item = pending.get(id);
    if (!item) return false;
    pending.delete(id);
    clearTimeout(item.timer);
    item.resolve(approved);
    if (announce) notify();
    return true;
  }

  function authorize(request) {
    if (closed || pending.size >= MAX_PENDING_APPROVALS) return Promise.resolve(false);
    const approval = projectApproval(request);
    if (!approval) return Promise.resolve(false);
    const id = makeId();
    if (typeof id !== 'string' || id.length < 16 || id.length > 128 || pending.has(id)) return Promise.resolve(false);
    const expiresAt = now() + timeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, false), timeoutMs);
      timer.unref?.();
      pending.set(id, { id, approval, expiresAt, resolve, timer });
      notify();
    });
  }

  function listPending() {
    const time = now();
    let expired = false;
    for (const item of pending.values()) if (item.expiresAt <= time) expired = settle(item.id, false, false) || expired;
    if (expired) notify();
    return [...pending.values()].map(({ id, approval, expiresAt }) => Object.freeze({
      id, expiresAt, request: approval,
    }));
  }

  return Object.freeze({
    authorize,
    listPending,
    /** Resolve one still-pending request. Every request can be decided only once. */
    decide(id, approved) {
      if (closed || typeof id !== 'string' || typeof approved !== 'boolean') return false;
      return settle(id, approved);
    },
    /** Subscribe to bounded pending-queue snapshots; returned snapshots contain projected data only. */
    subscribe(listener) {
      if (closed || typeof listener !== 'function') return () => {};
      listeners.add(listener);
      try { listener(listPending()); } catch { /* observers cannot authorize or deny runs */ }
      return () => listeners.delete(listener);
    },
    /** Closing the trusted host denies every pending request and prevents later requests. */
    close() {
      if (closed) return;
      closed = true;
      for (const id of [...pending.keys()]) settle(id, false);
      listeners.clear();
    },
    get size() { return pending.size; },
  });
}

function projectApproval(request) {
  if (!request || typeof request !== 'object' || !ACTIONS.has(request.action) || !PROVIDERS.has(request.provider)) return null;
  const output = { action: request.action, provider: request.provider };
  if (request.profile !== undefined) {
    if (typeof request.profile !== 'string' || !PROFILES.has(request.profile)) return null;
    output.profile = request.profile;
  }
  if (request.minimumCliVersion !== undefined) {
    if (typeof request.minimumCliVersion !== 'string' || !Object.values(PROFILE_MINIMUM_VERSIONS).includes(request.minimumCliVersion)) return null;
    output.minimumCliVersion = request.minimumCliVersion;
  }
  if (request.versionCheck !== undefined) {
    if (request.versionCheck !== true) return null;
    output.versionCheck = true;
  }
  if (request.executable !== undefined) {
    if (typeof request.executable !== 'string' || !path.isAbsolute(request.executable) || request.executable.length > 4096) return null;
    output.executable = request.executable;
  }
  if (request.executableSha256 !== undefined) {
    if (typeof request.executableSha256 !== 'string' || !SHA256_RE.test(request.executableSha256)) return null;
    output.executableSha256 = request.executableSha256;
  }
  if (request.cwd !== undefined) {
    if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd) || request.cwd.length > 4096) return null;
    output.cwd = request.cwd;
  }
  if (request.args !== undefined) {
    if (!Array.isArray(request.args) || request.args.length > 256
      || request.args.some((arg) => typeof arg !== 'string' || arg.length > 8192)) return null;
    if (request.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 32 * 1024) return null;
    output.args = Object.freeze([...request.args]);
  }
  if (request.initialInput !== undefined) {
    if (typeof request.initialInput !== 'string' || Buffer.byteLength(request.initialInput) > 16 * 1024) return null;
    output.initialInput = request.initialInput;
  }
  if (request.text !== undefined) {
    if (typeof request.text !== 'string' || Buffer.byteLength(request.text) > 16 * 1024) return null;
    output.text = request.text;
  }
  if (request.runId !== undefined) {
    if (typeof request.runId !== 'string' || !RUN_ID_RE.test(request.runId)) return null;
    output.runId = request.runId;
  }
  if (request.force !== undefined) {
    if (typeof request.force !== 'boolean') return null;
    output.force = request.force;
  }
  if (request.platform !== undefined) {
    if (typeof request.platform !== 'string' || request.platform.length > 32) return null;
    output.platform = request.platform;
  }
  if (request.maxDurationMs !== undefined) {
    if (!Number.isSafeInteger(request.maxDurationMs) || request.maxDurationMs < 1 || request.maxDurationMs > 3_600_000) return null;
    output.maxDurationMs = request.maxDurationMs;
  }
  if (request.maxActive !== undefined) {
    if (!Number.isSafeInteger(request.maxActive) || request.maxActive < 1 || request.maxActive > 4) return null;
    output.maxActive = request.maxActive;
  }
  if (request.environment !== undefined) {
    if (!request.environment || typeof request.environment !== 'object' || Array.isArray(request.environment)) return null;
    const { providerVariables, endpointOverrides } = request.environment;
    if (!Array.isArray(providerVariables) || providerVariables.length > 32
      || providerVariables.some((name) => typeof name !== 'string' || !ENV_NAME_RE.test(name))
      || !Array.isArray(endpointOverrides) || endpointOverrides.length > 8
      || endpointOverrides.some((endpoint) => !endpoint || typeof endpoint !== 'object'
        || typeof endpoint.variable !== 'string' || !ENV_NAME_RE.test(endpoint.variable)
        || !['http', 'https', 'invalid'].includes(endpoint.protocol)
        || (endpoint.host !== null && (typeof endpoint.host !== 'string' || endpoint.host.length > 253)))) return null;
    output.environment = Object.freeze({
      providerVariables: Object.freeze([...providerVariables]),
      endpointOverrides: Object.freeze(endpointOverrides.map((endpoint) => Object.freeze({
        variable: endpoint.variable, protocol: endpoint.protocol, host: endpoint.host,
      }))),
    });
  }
  if (request.action === 'start'
    && (!output.profile || !output.executable || !output.cwd || !output.args || !output.environment
      || !output.executableSha256 || !output.platform || !output.maxDurationMs || !output.maxActive
      || output.minimumCliVersion !== PROFILE_MINIMUM_VERSIONS[output.profile] || output.versionCheck !== true)) return null;
  if (request.action === 'stop' && (!output.runId || typeof output.force !== 'boolean')) return null;
  if (request.action === 'input' && (!output.runId || typeof output.text !== 'string' || output.text.length === 0)) return null;
  return Object.freeze(output);
}
