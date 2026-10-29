import { crc32, deflateSync } from 'node:zlib';

/**
 * In-memory desktop Broker for tests. It records every input, returns a synthetic PNG and can
 * inject failures. It touches no VM, process, file or network. Returns a plain object with
 * own data properties only, which is the shape HyperVDesktopDriver accepts.
 */
export function createMockDesktopBroker({ width = 64, height = 48 } = {}) {
  const inputs = [];
  const captures = [];
  let nextFailure = null;
  let nextScreen = null;

  const takeFailure = () => {
    const failure = nextFailure;
    nextFailure = null;
    return failure;
  };

  return {
    inputs,
    captures,
    /** The next broker call rejects with `{code, outcome}` (fields are copied, not the object). */
    failNext(code, outcome = 'unknown') { nextFailure = { code, outcome }; },
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
      inputs.push(request);
      return { ok: true };
    },
  };
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
