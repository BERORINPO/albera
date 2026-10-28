import { createHash, randomBytes } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1024;

/**
 * Create short-lived, in-memory Guest event-ingress capabilities.
 *
 * `resolveActiveContext` is trusted Host code. It must resolve an ACTIVE, unexpired
 * Lease for the requested Computer/Run and return the current Computer generation.
 * The capability authenticates only the source of provisional Guest claims; it is
 * not an approval, attestation, or authorization for Control/Broker operations.
 * Restarting this service revokes all outstanding capabilities.
 */
export function createGuestSessionCapabilityService({
  resolveActiveContext,
  now = () => new Date().toISOString(),
  ttlMs = DEFAULT_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  if (typeof resolveActiveContext !== 'function') throw new TypeError('guest_session_context_resolver_required');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new TypeError('guest_session_ttl_invalid');
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 10_000) throw new TypeError('guest_session_capacity_invalid');

  const sessions = new Map();
  let closed = false;

  return Object.freeze({
    async issue(input = {}) {
      assertOpen();
      const request = readIssueRequest(input);
      const { computerId, runId } = request;
      if (!isId(computerId) || !isId(runId)) throw new Error('guest_session_unavailable');
      const timestamp = readNow();
      const context = await resolveContext(computerId, runId);
      assertOpen();
      const expiry = Math.min(Date.parse(timestamp) + ttlMs, Date.parse(context.leaseExpiresAt));
      if (!Number.isFinite(expiry) || expiry <= Date.parse(timestamp)) throw new Error('guest_session_unavailable');

      prune(Date.parse(timestamp));
      for (const [digest, entry] of sessions) {
        if (entry.computerId === computerId && entry.runId === runId) sessions.delete(digest);
      }
      if (sessions.size >= maxSessions) throw new Error('guest_session_capacity');

      const credential = randomBytes(32).toString('base64url');
      if (!TOKEN_RE.test(credential)) throw new Error('guest_session_unavailable');
      const expiresAt = new Date(expiry).toISOString();
      sessions.set(digest(credential), Object.freeze({
        computerId, runId, generation: context.generation, expiresAt,
      }));
      return Object.freeze({
        credential,
        expiresAt,
        scope: Object.freeze({ computerId, runId, generation: context.generation }),
      });
    },

    /** Suitable for `createGuestEventIntake({ authenticateTransport })`. */
    async authenticateTransport({ transport } = {}) {
      if (closed) return null;
      const credential = readCredential(transport);
      if (!credential || !TOKEN_RE.test(credential)) return null;
      const key = digest(credential);
      const session = sessions.get(key);
      if (!session) return null;

      let timestamp;
      try { timestamp = readNow(); } catch { return null; }
      if (Date.parse(session.expiresAt) <= Date.parse(timestamp)) {
        sessions.delete(key);
        return null;
      }

      let current;
      try { current = await resolveContext(session.computerId, session.runId); }
      catch { sessions.delete(key); return null; }
      if (closed || sessions.get(key) !== session) return null;
      if (current.generation !== session.generation) {
        sessions.delete(key);
        return null;
      }
      return Object.freeze({
        computerId: session.computerId,
        runId: session.runId,
        generation: session.generation,
      });
    },

    close() {
      closed = true;
      sessions.clear();
    },
  });

  function assertOpen() { if (closed) throw new Error('guest_session_unavailable'); }
  function readNow() {
    const value = now();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('guest_session_unavailable');
    return new Date(Date.parse(value)).toISOString();
  }
  async function resolveContext(computerId, runId) {
    let value;
    try { value = await resolveActiveContext(Object.freeze({ computerId, runId })); }
    catch { throw new Error('guest_session_unavailable'); }
    const context = readContext(value);
    if (context.computerId !== computerId || context.runId !== runId
      || Date.parse(context.leaseExpiresAt) <= Date.parse(readNow())) throw new Error('guest_session_unavailable');
    return context;
  }
  function prune(timestamp) {
    for (const [key, entry] of sessions) if (Date.parse(entry.expiresAt) <= timestamp) sessions.delete(key);
  }
}

function readContext(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    if (Object.getOwnPropertySymbols(input).length) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors);
    if (keys.length !== 4 || keys.some((key) => !['computerId', 'runId', 'generation', 'leaseExpiresAt'].includes(key))) throw new Error();
    if (keys.some((key) => !Object.hasOwn(descriptors[key], 'value'))) throw new Error();
    const value = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
    if (!isId(value.computerId) || !isId(value.runId) || !Number.isSafeInteger(value.generation) || value.generation < 1
      || typeof value.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.leaseExpiresAt))) throw new Error();
    return Object.freeze(value);
  } catch { throw new Error('guest_session_unavailable'); }
}

function readCredential(transport) {
  try {
    if (!transport || typeof transport !== 'object' || Array.isArray(transport)) return null;
    const prototype = Object.getPrototypeOf(transport);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(transport).length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(transport);
    if (Object.keys(descriptors).length !== 1 || !Object.hasOwn(descriptors, 'guestSessionCredential')) return null;
    const descriptor = descriptors.guestSessionCredential;
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.length > 64) return null;
    return descriptor.value;
  } catch { return null; }
}

function readIssueRequest(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    if (Object.getOwnPropertySymbols(input).length) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.keys(descriptors).length !== 2 || !Object.hasOwn(descriptors, 'computerId')
      || !Object.hasOwn(descriptors, 'runId')
      || Object.keys(descriptors).some((key) => !Object.hasOwn(descriptors[key], 'value'))) throw new Error();
    return Object.freeze({ computerId: descriptors.computerId.value, runId: descriptors.runId.value });
  } catch { throw new Error('guest_session_unavailable'); }
}

function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function isId(value) { return typeof value === 'string' && ID_RE.test(value); }
