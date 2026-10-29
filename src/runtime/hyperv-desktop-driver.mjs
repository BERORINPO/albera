import {
  DesktopControlError,
  assertLeaseCurrent,
  validateDesktopAction,
  validateDesktopLease,
  validateDesktopScreen,
} from './desktop-control.mjs';
import { isEnvironmentId } from './environment-provider.mjs';

// Same approach as hyperv-environment-provider: only these two typed Broker methods
// are ever reachable. No operation can name a command, script, path or Broker method.
const BROKER_METHODS = Object.freeze({ capture: 'captureVmScreen', act: 'sendVmInput' });
const SAFE_BROKER_ERROR_CODES = new Set([
  'desktop_broker_timeout', 'desktop_input_rejected', 'desktop_unavailable', 'desktop_vm_not_found',
]);
export const DEFAULT_DESKTOP_SCREEN = Object.freeze({ width: 1024, height: 768 });
export const MAX_SCREEN_PNG_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_HEADER_BYTES = 33; // signature + IHDR chunk (length, type, 13 data bytes, crc)

/**
 * Typed adapter seam for a host-side Hyper-V synthetic keyboard/mouse/thumbnail Broker client.
 * No IPC, process, PowerShell or Hyper-V code lives here; the injected client is the trusted boundary.
 * `resolveCurrentLease(desktopSessionId)` is a trusted host seam returning the live lease record.
 */
export class HyperVDesktopDriver {
  #brokerMethods;
  #resolveCurrentLease;
  #now;
  #screen;

  constructor({ broker, resolveCurrentLease, now = Date.now, screen = DEFAULT_DESKTOP_SCREEN }) {
    const descriptors = readBrokerDescriptors(broker);
    if (!descriptors || typeof resolveCurrentLease !== 'function' || typeof now !== 'function') {
      throw new TypeError('invalid_hyperv_desktop_broker_client');
    }
    const methods = {};
    for (const [key, name] of Object.entries(BROKER_METHODS)) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError('invalid_hyperv_desktop_broker_client');
      }
      methods[key] = descriptor.value.bind(broker);
    }
    this.#brokerMethods = Object.freeze(methods);
    this.#resolveCurrentLease = resolveCurrentLease;
    this.#now = now;
    this.#screen = validateDesktopScreen(screen);
  }

  /** Returns `{ png, width, height }`; `png` is a validated copy of untrusted screen data. */
  async capture({ vmId, lease } = {}) {
    await this.#authorize(vmId, lease);
    return this.#capture(vmId);
  }

  /** Returns `{ ok: true }`; a `screenshot` action returns the capture result instead. */
  async act({ vmId, lease, action } = {}) {
    let normalized;
    try {
      normalized = validateDesktopAction(action, this.#screen);
    }
    catch {
      throw new DesktopControlError('invalid_desktop_action', { outcome: 'not_applied' });
    }
    await this.#authorize(vmId, lease);
    if (normalized.action === 'screenshot') return this.#capture(vmId);
    try {
      await this.#brokerMethods.act({ vmId, action: normalized });
    }
    catch (error) {
      throw mapBrokerError(error);
    }
    return Object.freeze({ ok: true });
  }

  async #capture(vmId) {
    let raw;
    try {
      raw = await this.#brokerMethods.capture({ vmId, width: this.#screen.width, height: this.#screen.height });
    }
    catch (error) {
      throw mapBrokerError(error);
    }
    return Object.freeze(parseScreenPng(raw, this.#screen));
  }

  async #authorize(vmId, lease) {
    if (!isEnvironmentId(vmId)) throw new DesktopControlError('invalid_desktop_vm', { outcome: 'not_applied' });
    let held;
    try {
      held = validateDesktopLease(lease);
    }
    catch {
      throw new DesktopControlError('invalid_desktop_lease', { outcome: 'not_applied' });
    }
    let current;
    try {
      current = await this.#resolveCurrentLease(held.desktopSessionId);
    }
    catch {
      throw new DesktopControlError('desktop_lease_unavailable', { outcome: 'not_applied' });
    }
    assertLeaseCurrent(held, current, this.#now());
  }
}

/** Screen data comes from the guest-facing device: check size, signature and IHDR before use. */
function parseScreenPng(raw, screen) {
  const bad = () => new DesktopControlError('invalid_desktop_screen_data', { outcome: 'not_applied' });
  if (!(raw instanceof Uint8Array) || raw.length < PNG_HEADER_BYTES || raw.length > MAX_SCREEN_PNG_BYTES) throw bad();
  const png = Buffer.from(raw); // copy: the Broker keeps no handle to what we return
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)
    || png.readUInt32BE(8) !== 13 || png.toString('latin1', 12, 16) !== 'IHDR') throw bad();
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== screen.width || height !== screen.height) throw bad();
  return { png, width, height };
}

function mapBrokerError(error) {
  const codeCandidate = dataProperty(error, 'code');
  const outcomeCandidate = dataProperty(error, 'outcome');
  const code = typeof codeCandidate === 'string' && SAFE_BROKER_ERROR_CODES.has(codeCandidate) ? codeCandidate : 'desktop_unknown';
  return new DesktopControlError(code, { outcome: outcomeCandidate === 'not_applied' ? 'not_applied' : 'unknown' });
}

function readBrokerDescriptors(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!Object.values(descriptors).every((descriptor) => Object.hasOwn(descriptor, 'value'))) return null;
    return descriptors;
  } catch {
    return null;
  }
}

function dataProperty(value, key) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  catch {
    return undefined;
  }
}
