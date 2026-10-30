import net from 'node:net';

// Thin Node client for the Windows Host Broker Named Pipe (ADR-002, Proposed / NOT VERIFIED).
// Wire source (read-only reference): src/runtime/windows-broker/Program.cs. // arch-allow: the single intended Broker reference; this file is the only client
// The shape below adds no field and does not change the protocol.
// This client only connects to a Broker that is already running. It never spawns, installs or starts it, and nothing in the
// Observer, the entry layer or the npm package imports it (arch rules 8a-8c, package smoke).
//
// Wire (one request per connection, byte mode): [int32 little-endian length][UTF-8 JSON body] in each direction.
//   request body : { "receipt": <base64>, "signature": <base64> }   exactly these two keys; the receipt is signed elsewhere
//   success body : { "ok": true, "state": "UNKNOWN", "action": "synthetic.noop" }
//   denial body  : { "ok": false, "code": "denied" }
// Results never carry exception text, paths, native identifiers or any part of the request. Failures are fixed codes.
// A failure after the request was written leaves the outcome unknown: the Broker may have durably claimed the receipt.

/** ADR-002: bounded length-prefixed frame, 2 KiB maximum request message. The response is far smaller. */
export const BROKER_CLIENT_LIMITS = Object.freeze({
  maxRequestBytes: 2048,
  maxResponseBytes: 256,
  defaultTimeoutMs: 5000,
  minTimeoutMs: 100,
  maxTimeoutMs: 30_000,
});

/** Every `code` this client can return. The Broker itself only ever sends `denied`. */
export const BROKER_CLIENT_ERROR_CODES = Object.freeze([
  'denied',
  'invalid_request',
  'invalid_pipe_name',
  'request_too_large',
  'unsupported_platform',
  'broker_unavailable',
  'access_denied',
  'timeout',
  'response_too_large',
  'invalid_response',
  'transport_error',
]);

const BROKER_DENIAL_CODES = Object.freeze(['denied']);
const BROKER_SUCCESS_STATES = Object.freeze(['UNKNOWN']);
const BROKER_SUCCESS_ACTIONS = Object.freeze(['synthetic.noop']);
const PIPE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const HEADER_BYTES = 4;

/** Carries only an allowlisted code; the message is the code itself, never raw text. */
export class BrokerClientError extends Error {
  constructor(code) {
    const safeCode = BROKER_CLIENT_ERROR_CODES.includes(code) ? code : 'transport_error';
    super(safeCode);
    this.name = 'BrokerClientError';
    this.code = safeCode;
  }
}

const failure = (code) => Object.freeze({ ok: false, code: BROKER_CLIENT_ERROR_CODES.includes(code) ? code : 'transport_error' });

/** `\\.\pipe\<name>` for a plain pipe name; anything that could escape the pipe namespace is rejected. */
export function brokerPipePath(pipeName) {
  if (typeof pipeName !== 'string' || !PIPE_NAME_PATTERN.test(pipeName)) throw new BrokerClientError('invalid_pipe_name');
  return `\\\\.\\pipe\\${pipeName}`;
}

function requireBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new BrokerClientError('invalid_request');
  }
  if (Buffer.from(value, 'base64').toString('base64') !== value) throw new BrokerClientError('invalid_request');
  return value;
}

/** The JSON request body: exactly `receipt` and `signature`, size-bounded. Pure. @returns {Buffer} */
export function buildBrokerRequestBody({ receipt, signature } = {}) {
  const body = Buffer.from(JSON.stringify({ receipt: requireBase64(receipt), signature: requireBase64(signature) }), 'utf8');
  if (body.length > BROKER_CLIENT_LIMITS.maxRequestBytes) throw new BrokerClientError('request_too_large');
  return body;
}

/** Length-prefix a body (int32 little-endian). Pure. @returns {Buffer} */
export function encodeBrokerFrame(body) {
  if (!Buffer.isBuffer(body) || body.length < 1 || body.length > BROKER_CLIENT_LIMITS.maxRequestBytes) {
    throw new BrokerClientError('request_too_large');
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** The full request frame to write to the pipe. Pure. @returns {Buffer} */
export function buildBrokerRequestFrame(request) {
  return encodeBrokerFrame(buildBrokerRequestBody(request));
}

/** Validate a parsed response against the fixed schema. Returns a fresh frozen result, never the input. */
export function validateBrokerResponse(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BrokerClientError('invalid_response');
  const keys = Object.keys(value).sort().join(',');
  if (value.ok === true && keys === 'action,ok,state' && BROKER_SUCCESS_STATES.includes(value.state) && BROKER_SUCCESS_ACTIONS.includes(value.action)) {
    return Object.freeze({ ok: true, state: value.state, action: value.action });
  }
  if (value.ok === false && keys === 'code,ok' && BROKER_DENIAL_CODES.includes(value.code)) {
    return Object.freeze({ ok: false, code: value.code });
  }
  throw new BrokerClientError('invalid_response');
}

/** Decode one complete response frame (length prefix + JSON body, no trailing bytes). Pure. */
export function parseBrokerResponseFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < HEADER_BYTES) throw new BrokerClientError('invalid_response');
  const length = frame.readInt32LE(0);
  if (length > BROKER_CLIENT_LIMITS.maxResponseBytes) throw new BrokerClientError('response_too_large');
  if (length < 1 || frame.length !== HEADER_BYTES + length) throw new BrokerClientError('invalid_response');
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(HEADER_BYTES)));
  } catch {
    throw new BrokerClientError('invalid_response');
  }
  return validateBrokerResponse(parsed);
}

/** Map a socket error to a fixed code using only its errno-style `code`; the message is never read. */
export function mapBrokerTransportError(error) {
  if (error instanceof BrokerClientError) return error.code;
  const errno = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  if (errno === 'ENOENT' || errno === 'EBUSY' || errno === 'ECONNREFUSED') return 'broker_unavailable';
  if (errno === 'EACCES' || errno === 'EPERM') return 'access_denied';
  return 'transport_error';
}

function resolveTimeout(timeoutMs) {
  if (timeoutMs === undefined) return BROKER_CLIENT_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < BROKER_CLIENT_LIMITS.minTimeoutMs || timeoutMs > BROKER_CLIENT_LIMITS.maxTimeoutMs) {
    throw new BrokerClientError('invalid_request');
  }
  return timeoutMs;
}

function exchange(socket, frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = Buffer.alloc(0);
    let settled = false;
    let timer;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle(value);
    };
    timer = setTimeout(() => finish(reject, new BrokerClientError('timeout')), timeoutMs);
    socket.once('error', (error) => finish(reject, new BrokerClientError(mapBrokerTransportError(error))));
    socket.once('connect', () => socket.write(frame));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      received = Buffer.concat(chunks);
      const declared = received.length >= HEADER_BYTES ? received.readInt32LE(0) : 0;
      if (declared > BROKER_CLIENT_LIMITS.maxResponseBytes || received.length > HEADER_BYTES + BROKER_CLIENT_LIMITS.maxResponseBytes) {
        finish(reject, new BrokerClientError('response_too_large'));
      }
    });
    // The Broker closes the connection after its single response, so completion (and any trailing byte) shows at `end`.
    const complete = () => {
      try { finish(resolve, parseBrokerResponseFrame(received)); } catch (error) { finish(reject, error); }
    };
    socket.once('end', complete);
    socket.once('close', complete);
  });
}

function defaultConnect(pipePath) {
  if (process.platform !== 'win32') throw new BrokerClientError('unsupported_platform');
  return net.createConnection(pipePath);
}

/**
 * Send one signed receipt to an already running Broker pipe and return the validated result.
 * Never throws for operational failures; returns `{ ok: false, code }` with an allowlisted code instead.
 * @param {{ pipeName: string, receipt: string, signature: string, timeoutMs?: number, connect?: (pipePath: string) => import('node:net').Socket }} options
 *   `connect` is a test seam for a fake transport; it receives only the validated pipe path.
 */
export async function sendBrokerRequest({ pipeName, receipt, signature, timeoutMs, connect = defaultConnect } = {}) {
  try {
    const pipePath = brokerPipePath(pipeName);
    const frame = buildBrokerRequestFrame({ receipt, signature });
    const timeout = resolveTimeout(timeoutMs);
    return await exchange(connect(pipePath), frame, timeout);
  } catch (error) {
    return failure(mapBrokerTransportError(error));
  }
}
