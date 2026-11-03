import { MAX_SCREEN_DIMENSION, planDesktopInput, validateDesktopScreen } from './desktop-control.mjs';
import { ID_PATTERN } from './broker-contract/action-digest.mjs';
import { MAX_SCREEN_PNG_BYTES } from './hyperv-desktop-driver.mjs';

/**
 * What the desktop Broker client (windows-desktop-broker-client.mjs) and its Fake (fake-desktop-broker-client.mjs) share: the argument checks, the error shape and the
 * PNG header check. Pure: no process, file, clock or network access. The bounds are the Broker's own (ADR-002 "Amendment 2026-11-03", "Desktop pipe"); the Broker
 * enforces them again, so a call that passes here can still be refused there, but a call that fails here never leaves the process.
 *
 * Interface (a drop-in for the prototype's `captureVmScreen` / `sendVmInput`, hyperv-desktop-broker-prototype.mjs):
 *   captureVmScreen({ vmId, width, height })  -> Promise<Buffer>   the PNG; `vmId` is the Broker's `computerId`
 *   sendVmInput({ vmId, action, lease })      -> Promise<{ ok: true }>   `lease` is `{ desktopSessionId, generation }`: the claim's operationId and the Broker's lease generation
 *   close()                                   -> Promise<void>     ends every session
 * A failure is an Error with data properties `code` (one of the codes hyperv-desktop-driver.mjs knows), `outcome` ('not_applied' | 'unknown') and, when a session was involved, `brokerCode`.
 */
export const DESKTOP_BROKER_LIMITS = Object.freeze({
  minCaptureSide: 64,
  maxCaptureSide: 1920,
  maxCapturePixels: 1920 * 1080,
  maxPngBytes: MAX_SCREEN_PNG_BYTES,
  maxRequestBytes: 16 * 1024,
  maxReplyHeaderBytes: 256,
  maxLeaseGeneration: Number.MAX_SAFE_INTEGER,
});

const CONTRACT_ID = new RegExp(ID_PATTERN, 'u'); // the Broker's own id grammar (at most 64 characters), not the looser one of the environment contract
const isId = (value) => typeof value === 'string' && CONTRACT_ID.test(value);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_HEADER_BYTES = 33; // signature + IHDR chunk (length, type, 13 data bytes, crc)

/** The error every desktop client call rejects with. `outcome` is 'not_applied' only when nothing reached the Broker. */
export function desktopClientError(code, outcome = 'unknown', brokerCode = undefined) {
  return Object.assign(new Error(code), { code, outcome: outcome === 'not_applied' ? 'not_applied' : 'unknown', ...(brokerCode === undefined ? {} : { brokerCode }) });
}

function checkedComputerId(vmId) {
  if (!isId(vmId)) throw desktopClientError('desktop_vm_not_found', 'not_applied');
  return vmId;
}

/** `{ computerId, width, height }` for a capture, or a TypeError('invalid_desktop_screen') / not_applied error. */
export function checkCaptureRequest({ vmId, width, height } = {}) {
  const computerId = checkedComputerId(vmId);
  const size = validateDesktopScreen({ width, height });
  const { minCaptureSide: min, maxCaptureSide: max, maxCapturePixels } = DESKTOP_BROKER_LIMITS;
  if (size.width < min || size.height < min || size.width > max || size.height > max || size.width * size.height > maxCapturePixels) throw new TypeError('invalid_desktop_screen');
  return Object.freeze({ computerId, width: size.width, height: size.height });
}

/**
 * `{ computerId, operationId, leaseGeneration, steps }` for an input: the action planned into the Broker's primitive steps (the same plan the prototype sends), and the lease the
 * act session opens with. Anything wrong is a 'not_applied' error: `desktop_input_rejected` for the action or the lease (a missing lease is a wiring mistake, not a Broker answer), `desktop_vm_not_found` for the id.
 */
export function checkInputRequest({ vmId, action, lease } = {}) {
  const computerId = checkedComputerId(vmId);
  const operationId = lease?.desktopSessionId;
  const leaseGeneration = lease?.generation;
  if (!isId(operationId) || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw desktopClientError('desktop_input_rejected', 'not_applied');
  let steps;
  try { steps = planDesktopInput(action, { width: MAX_SCREEN_DIMENSION, height: MAX_SCREEN_DIMENSION }); } catch { throw desktopClientError('desktop_input_rejected', 'not_applied'); }
  if (new TextEncoder().encode(JSON.stringify({ input: { steps } })).length > DESKTOP_BROKER_LIMITS.maxRequestBytes) throw desktopClientError('desktop_input_rejected', 'not_applied');
  return Object.freeze({ computerId, operationId, leaseGeneration, steps });
}

/** `{ width, height }` from the IHDR of a PNG, or null when `bytes` is not a PNG with a complete header. */
export function readPngHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PNG_HEADER_BYTES || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isIhdr = view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452;
  return isIhdr ? Object.freeze({ width: view.getUint32(16), height: view.getUint32(20) }) : null;
}
