import { crc32, deflateSync } from 'node:zlib';
import { MAX_SCREEN_DIMENSION, planDesktopInput } from './desktop-control.mjs';

/**
 * In-memory desktop Broker for tests. It records every input, returns a synthetic PNG and can
 * inject failures. It touches no VM, process, file or network. Returns a plain object with
 * own data properties only, which is the shape HyperVDesktopDriver accepts.
 * Each input is planned with `planDesktopInput` and run on a fake device like desktop-io.ps1 does:
 * `device` lists the primitive steps applied, and a failing step releases what the plan held down.
 */
export function createMockDesktopBroker({ width = 64, height = 48 } = {}) {
  const inputs = [];
  const captures = [];
  const device = [];
  let nextFailure = null;
  let nextStepFailure = null;
  let nextScreen = null;

  const takeFailure = () => {
    const failure = nextFailure;
    nextFailure = null;
    return failure;
  };

  return {
    inputs,
    captures,
    device,
    /** The next broker call rejects with `{code, outcome}` (fields are copied, not the object). */
    failNext(code, outcome = 'unknown') { nextFailure = { code, outcome }; },
    /** The next input fails at plan step `index` (0-based), after applying the steps before it. */
    failNextAtStep(index, code = 'desktop_input_rejected') { nextStepFailure = { index, code }; },
    /** The next capture returns these bytes instead of a synthetic PNG. */
    returnNextScreen(bytes) { nextScreen = bytes; },
    async captureVmScreen(request) {
      captures.push(request);
      const failure = takeFailure();
      if (failure) throw Object.assign(new Error('mock_broker_failure'), failure);
      if (nextScreen) {
        const bytes = nextScreen;
        nextScreen = null;
        return bytes;
      }
      return syntheticPng(request.width ?? width, request.height ?? height);
    },
    async sendVmInput(request) {
      const failure = takeFailure();
      if (failure) throw Object.assign(new Error('mock_broker_failure'), failure);
      const steps = planDesktopInput(request.action, { width: MAX_SCREEN_DIMENSION, height: MAX_SCREEN_DIMENSION });
      inputs.push({ ...request, steps });
      const stepFailure = nextStepFailure;
      nextStepFailure = null;
      runPlan(steps, device, stepFailure);
      return { ok: true };
    },
  };
}

// Mirrors Invoke-Plan in desktop-io.ps1: track what is held, and on failure release it in reverse.
function runPlan(steps, device, failure) {
  const held = [];
  steps.forEach((step, index) => {
    if (failure && index === failure.index) {
      for (const item of held.reverse()) device.push(item.op === 'press' ? { op: 'release', vk: item.vk } : { op: 'up', button: item.button });
      throw Object.assign(new Error('mock_broker_failure'), { code: failure.code, outcome: 'unknown' });
    }
    device.push(step);
    if (step.op === 'press' || step.op === 'down') held.push(step);
    if (step.op === 'release') removeLast(held, (item) => item.op === 'press' && item.vk === step.vk);
    if (step.op === 'up') removeLast(held, (item) => item.op === 'down' && item.button === step.button);
  });
}

function removeLast(list, match) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (match(list[i])) {
      list.splice(i, 1);
      return;
    }
  }
}

/** A valid, all-black 8-bit grayscale PNG. */
export function syntheticPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const rows = Buffer.alloc((width + 1) * height); // filter byte 0 + zeroed pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
