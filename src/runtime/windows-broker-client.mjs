import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from './executable-identity.mjs';

// Thin Node client for the Windows Host Broker Named Pipe (ADR-002, Proposed / NOT VERIFIED).
// Wire source (read-only reference): src/runtime/windows-broker/Program.cs. // arch-allow: the single intended Broker reference; this file is the only client
// The shape below adds no field and does not change the protocol.
// This client only reaches a Broker that is already running. It never installs or starts the Broker, and nothing in the
// Observer, the entry layer or the npm package imports it (arch rules 8a-8c, package smoke).
//
// Node cannot inspect who owns a pipe server, so this client never opens the pipe itself. It spawns a small trusted .NET pipe
// client (SHA-256 manifest checked first, no shell). That helper connects with SQOS identification and, on the connected handle
// and before writing anything, verifies the server: pipe owner SID, server process ID (and, in service mode, the SCM-reported
// PID and session 0), optionally the server image SHA-256. Only then does it send the one frame and report the Broker's reply.
//
// Wire (helper <-> Broker, one request per connection, byte mode): [int32 little-endian length][UTF-8 JSON body] each way.
//   request body : { "receipt": <base64>, "signature": <base64> }   exactly these two keys; the receipt is signed elsewhere
//   success body : { "ok": true, "state": "UNKNOWN", "action": "synthetic.noop" }
//   denial body  : { "ok": false, "code": "denied" }
// Results never carry exception text, paths, native identifiers or any part of the request. Failures are fixed codes.
// Pre-send codes (BROKER_CLIENT_PRESEND_CODES): the receipt never left this process pair, so a retry is safe. Any other failure
// code, and `denied`, comes after the frame was written: the Broker may have durably claimed the receipt.
// Trust level: SAME-USER VERIFIED. A same-user process cannot pass for the Broker unless it is the expected PID/owner/image.
// SERVICE IDENTITY NOT VERIFIED: the SCM PID, `NT SERVICE\AlberaHostBroker` owner and session 0 path exists but has only run
// against test servers; it needs the approved lab (#23) before any caller relies on it. Do not wire this client until then.

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
  'server_identity_mismatch',
  'server_identity_unavailable',
  'helper_unavailable',
  'timeout',
  'response_too_large',
  'invalid_response',
  'transport_error',
]);

/** Failures that happen before the receipt is written to the pipe: nothing reached any server, retrying is safe. */
export const BROKER_CLIENT_PRESEND_CODES = Object.freeze([
  'invalid_request',
  'invalid_pipe_name',
  'request_too_large',
  'unsupported_platform',
  'broker_unavailable',
  'access_denied',
  'server_identity_mismatch',
  'server_identity_unavailable',
  'helper_unavailable',
]);

const HELPER_EXIT_CODES = Object.freeze([0, 64, 70]);
const HELPER_FAILURE_CODES = Object.freeze(BROKER_CLIENT_ERROR_CODES.filter((code) => !['invalid_pipe_name', 'request_too_large', 'unsupported_platform', 'helper_unavailable'].includes(code)));
const BROKER_SUCCESS_STATES = Object.freeze(['UNKNOWN']);
const BROKER_SUCCESS_ACTIONS = Object.freeze(['synthetic.noop']);
const PIPE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const SID_PATTERN = /^S-1-\d{1,10}(?:-\d{1,10}){1,15}$/u;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HELPER_GRACE_MS = 3000; // the helper has its own deadline; this only catches a helper that hangs past it
const HELPER_MAX_STDOUT_BYTES = 1024;
const DEFAULT_HELPER_PATH = fileURLToPath(new URL('./windows-broker-pipe-client/bin/Release/net10.0-windows/win-x64/publish/albera-windows-broker-pipe-client.exe', import.meta.url)); // arch-allow: the only reference to the pipe client helper; its SHA-256 manifest is verified before every launch

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
const codeOfError = (error) => (error instanceof BrokerClientError ? error.code : 'transport_error');

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

/** Validate a parsed Broker reply against the fixed schema. Returns a fresh frozen result, never the input. */
export function validateBrokerResponse(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BrokerClientError('invalid_response');
  const keys = Object.keys(value).sort().join(',');
  if (value.ok === true && keys === 'action,ok,state' && BROKER_SUCCESS_STATES.includes(value.state) && BROKER_SUCCESS_ACTIONS.includes(value.action)) {
    return Object.freeze({ ok: true, state: value.state, action: value.action });
  }
  if (value.ok === false && keys === 'code,ok' && value.code === 'denied') return Object.freeze({ ok: false, code: 'denied' });
  throw new BrokerClientError('invalid_response');
}

/** What the helper must find when it inspects the pipe server. Exactly one of `pid` / `serviceName`. Pure. */
export function validateServerExpectation(expect) {
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) throw new BrokerClientError('invalid_request');
  const { ownerSid, pid, serviceName, imageSha256, ...rest } = expect;
  const valid = Object.keys(rest).length === 0
    && (pid === undefined) !== (serviceName === undefined)
    && (pid === undefined || (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff))
    && (serviceName === undefined || (typeof serviceName === 'string' && SERVICE_NAME_PATTERN.test(serviceName)))
    && (ownerSid === undefined ? serviceName !== undefined : typeof ownerSid === 'string' && SID_PATTERN.test(ownerSid))
    && (imageSha256 === undefined || (typeof imageSha256 === 'string' && SHA256_PATTERN.test(imageSha256)));
  if (!valid) throw new BrokerClientError('invalid_request');
  return Object.freeze({ ...(ownerSid === undefined ? {} : { ownerSid }), ...(pid === undefined ? {} : { pid }), ...(serviceName === undefined ? {} : { serviceName }), ...(imageSha256 === undefined ? {} : { imageSha256 }) });
}

/** Parse the helper's single stdout line plus its exit code into a result. Pure; any deviation is a post-send `transport_error`. */
export function parseHelperResult(stdout, exitCode) {
  const fail = () => failure('transport_error');
  if (typeof stdout !== 'string' || !HELPER_EXIT_CODES.includes(exitCode) || !/^[^\r\n]+\r?\n?$/u.test(stdout)) return fail();
  let value;
  try { value = JSON.parse(stdout); } catch { return fail(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  if (value.ok === true) {
    try { return exitCode === 0 ? validateBrokerResponse(value) : fail(); } catch { return fail(); }
  }
  const keys = Object.keys(value).sort().join(',');
  if (value.ok !== false || keys !== 'code,ok' || !HELPER_FAILURE_CODES.includes(value.code)) return fail();
  // Exit 64 (bad input) and 70 (internal error) each carry only their own codes; anything else is a helper that misbehaves.
  const allowedForExit = exitCode === 64 ? ['invalid_request'] : exitCode === 70 ? ['server_identity_unavailable', 'transport_error'] : HELPER_FAILURE_CODES;
  return allowedForExit.includes(value.code) ? failure(value.code) : fail();
}

function resolveTimeout(timeoutMs) {
  if (timeoutMs === undefined) return BROKER_CLIENT_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < BROKER_CLIENT_LIMITS.minTimeoutMs || timeoutMs > BROKER_CLIENT_LIMITS.maxTimeoutMs) {
    throw new BrokerClientError('invalid_request');
  }
  return timeoutMs;
}

/** The helper must match the SHA-256 recorded next to it at build time. Same scheme as the Job Guardian. */
async function verifyHelper(helperPath, manifestPath) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest?.sha256 !== 'string' || !SHA256_PATTERN.test(manifest.sha256)) throw new Error('invalid_manifest');
    if ((await captureExecutableIdentity(helperPath)).sha256 !== manifest.sha256) throw new Error('helper_digest_mismatch');
  } catch { throw new BrokerClientError('helper_unavailable'); }
}

/** Run the helper once: one JSON line in, one JSON line out. Resolves with a result, never throws. */
function runHelper(spawnImpl, helperPath, line, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    let spawned = false;
    let settled = false;
    let timer;
    let stdout = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      resolve(result);
    };
    try {
      child = spawnImpl(helperPath, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { finish(failure('helper_unavailable')); return; }
    timer = setTimeout(() => finish(failure('timeout')), timeoutMs + HELPER_GRACE_MS);
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => finish(failure(spawned ? 'transport_error' : 'helper_unavailable')));
    child.stdin.on('error', () => {}); // a helper that already exited is reported through its exit code
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > HELPER_MAX_STDOUT_BYTES) finish(failure('transport_error'));
    });
    child.once('close', (code) => finish(parseHelperResult(stdout, code)));
    child.stdin.end(line);
  });
}

/**
 * Send one signed receipt to an already running Broker pipe and return the validated result.
 * The helper verifies the pipe server against `expect` before anything is written. Never throws for operational
 * failures; returns `{ ok: false, code }` with an allowlisted code instead (see BROKER_CLIENT_PRESEND_CODES).
 * @param {{ pipeName: string, receipt: string, signature: string, expect: { ownerSid?: string, pid?: number, serviceName?: string, imageSha256?: string }, timeoutMs?: number,
 *   helperPath?: string, spawnImpl?: typeof spawn }} options
 *   `helperPath` and `spawnImpl` are test seams. A custom helper still needs a `<helperPath>.manifest.json` with its SHA-256.
 */
export async function sendBrokerRequest({ pipeName, receipt, signature, expect, timeoutMs, helperPath = DEFAULT_HELPER_PATH, spawnImpl } = {}) {
  try {
    brokerPipePath(pipeName);
    buildBrokerRequestBody({ receipt, signature });
    const server = validateServerExpectation(expect);
    const timeout = resolveTimeout(timeoutMs);
    if (spawnImpl === undefined && process.platform !== 'win32') throw new BrokerClientError('unsupported_platform');
    await verifyHelper(helperPath, `${helperPath}.manifest.json`);
    const line = `${JSON.stringify({ pipeName, receipt, signature, timeoutMs: timeout, expect: server })}\n`;
    return await runHelper(spawnImpl ?? spawn, helperPath, line, timeout);
  } catch (error) {
    return failure(codeOfError(error));
  }
}
