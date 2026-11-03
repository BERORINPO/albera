import { checkCaptureRequest, checkInputRequest, desktopClientError } from './desktop-broker-client-contract.mjs';
import { syntheticPng } from './mock-desktop-broker.mjs';

/**
 * In-memory stand-in for the desktop Broker client (windows-desktop-broker-client.mjs): the same interface, the same argument checks and error shape
 * (desktop-broker-client-contract.mjs), and the Broker's lease rules, without a helper process, a pipe or a VM.
 *   - `captureVmScreen` works for a configured computer and returns a synthetic PNG of the asked size; an unknown computer is refused like the Broker does (fixed `denied`).
 *   - `sendVmInput` is accepted only for the lease the Broker holds for that computer: `grantLease` plays a recorded task.start claim (generation counts per computer from 1, a newer
 *     grant replaces the older lease). Anything else is `denied`, outcome unknown, like the real client.
 * Test controls (not part of the client interface): `captures`, `inputs`, `grantLease`, `expireLeases`, `failNext`, `isClosed`.
 */
export function createFakeDesktopBrokerClient({ computers = ['computer-1'] } = {}) {
  const known = new Set(computers);
  const generations = new Map(); // computerId -> last generation handed out
  const leases = new Map(); // computerId -> { operationId, generation }
  const captures = [];
  const inputs = [];
  let nextFailure = null;
  let closed = false;

  const guard = () => {
    if (closed) throw desktopClientError('desktop_unavailable', 'not_applied', 'closed');
    const failure = nextFailure;
    nextFailure = null;
    if (failure) throw desktopClientError(failure.code, failure.outcome, 'transport_error');
  };
  const denied = () => desktopClientError('desktop_unavailable', 'unknown', 'denied');

  return Object.freeze({
    captures,
    inputs,
    /** What a recorded task.start claim does in the Broker: the lease for `operationId` on `computerId`; returns its generation. */
    grantLease(computerId, operationId) {
      if (!known.has(computerId)) throw new TypeError('unknown_computer');
      const generation = (generations.get(computerId) ?? 0) + 1;
      generations.set(computerId, generation);
      leases.set(computerId, { operationId, generation });
      return generation;
    },
    /** Every lease ends (expiry, or a Broker restart): input is refused until the next grant. */
    expireLeases() { leases.clear(); },
    /** The next call rejects with `{ code, outcome }` (a client-level code such as `desktop_broker_timeout`). */
    failNext(code, outcome = 'unknown') { nextFailure = { code, outcome }; },
    isClosed: () => closed,
    async captureVmScreen(request) {
      const { computerId, width, height } = checkCaptureRequest(request);
      guard();
      if (!known.has(computerId)) throw denied();
      captures.push({ computerId, width, height });
      return syntheticPng(width, height);
    },
    async sendVmInput(request) {
      const { computerId, operationId, leaseGeneration, steps } = checkInputRequest(request);
      guard();
      const lease = leases.get(computerId);
      if (!lease || lease.operationId !== operationId || lease.generation !== leaseGeneration) throw denied();
      inputs.push({ computerId, operationId, leaseGeneration, steps });
      return Object.freeze({ ok: true });
    },
    async close() { closed = true; },
  });
}
