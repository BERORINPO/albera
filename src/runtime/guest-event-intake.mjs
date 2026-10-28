// Authenticated transport-to-journal boundary for Guest claims.
// This module does not implement or establish transport authentication.
import { validateGuestEvent } from './boundary-protocols.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_STORE_ERRORS = new Set([
  'guest_computer_unknown', 'guest_generation_stale', 'guest_lease_inactive',
  'guest_message_id_conflict', 'guest_event_replayed', 'guest_event_sequence_mismatch',
  'store_closed', 'store_busy', 'store_capacity',
]);

export class GuestEventIntakeError extends Error {
  constructor(code) { super(code); this.name = 'GuestEventIntakeError'; this.code = code; }
}

/**
 * Compose a trusted transport authenticator, Host-owned peer/run resolver, and durable Store.
 * `authenticateTransport` must derive peer identity from the transport, never from Guest payload.
 */
export function createGuestEventIntake({ store, authenticateTransport, resolveGuestContext } = {}) {
  const recordGuestEvent = captureMethod(store, 'recordGuestEvent');
  if (typeof authenticateTransport !== 'function') throw new TypeError('guest_transport_authenticator_required');
  if (typeof resolveGuestContext !== 'function') throw new TypeError('guest_context_resolver_required');

  return Object.freeze({
    async receive({ transport, message } = {}) {
      let peer;
      try { peer = await authenticateTransport(Object.freeze({ transport })); }
      catch { throw new GuestEventIntakeError('guest_authentication_failed'); }
      if (peer === undefined || peer === null || peer === false) throw new GuestEventIntakeError('guest_authentication_failed');

      let event;
      try {
        event = validateGuestEvent(message);
      } catch { throw new GuestEventIntakeError('guest_event_invalid'); }

      let context;
      try { context = await resolveGuestContext(Object.freeze({ peer })); }
      catch { throw new GuestEventIntakeError('guest_context_unavailable'); }
      if (!isHostContext(context)) throw new GuestEventIntakeError('guest_context_unavailable');
      if (event.computerId !== context.computerId || event.runId !== context.runId) {
        throw new GuestEventIntakeError('guest_identity_mismatch');
      }
      if (event.generation !== context.generation) throw new GuestEventIntakeError('guest_generation_stale');

      // The Store performs its own validation and adds the trusted `untrusted_guest` provenance.
      try { return recordGuestEvent(message); }
      catch (error) {
        throw new GuestEventIntakeError(safeStoreErrorCode(error));
      }
    },
  });
}

function safeStoreErrorCode(error) {
  try {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return 'guest_event_store_unavailable';
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    return SAFE_STORE_ERRORS.has(code) ? code : 'guest_event_store_unavailable';
  } catch {
    return 'guest_event_store_unavailable';
  }
}

function captureMethod(target, name) {
  if (!target || typeof target !== 'object') throw new TypeError('guest_event_store_required');
  let current = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw new TypeError('guest_event_store_method_invalid');
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError('guest_event_store_method_required');
}

function isHostContext(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== 3
      || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) return false;
    return ID_RE.test(descriptors.computerId?.value) && ID_RE.test(descriptors.runId?.value)
      && Number.isSafeInteger(descriptors.generation?.value) && descriptors.generation.value > 0;
  } catch { return false; }
}
