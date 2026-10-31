import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ID_PATTERN, PURPOSES, ActionDigestError, computeActionDigest, validateActionDto } from './broker-contract/action-digest.mjs';
import { MAX_RECEIPT_BYTES } from './broker-contract/receipt-v2.mjs';
import { readSignedNetworkAttestation } from './broker-contract/network-attestation.mjs';
import { parseReceipt } from './broker-contract/receipt-v3.mjs';
import { captureExecutableIdentity } from './executable-identity.mjs';

// Thin Node client for the Approval Authority's SUBMIT pipe (ADR-002 "Receipt v2", Proposed / NOT VERIFIED). Wire: docs/architecture/approval-authority.md.
// The Control Plane can only submit a request and poll for the outcome; it cannot approve, alter or sign. This client never installs or starts the
// Authority, never opens the approver pipe, and nothing in the Observer, the entry layer or the npm package imports it (arch rules 8 and 10, package smoke).
//
// Same transport as the Broker client: Node cannot inspect who owns a pipe server, so this client never opens the pipe itself. It spawns the trusted .NET
// pipe client helper (SHA-256 manifest checked first, no shell). The helper connects with SQOS identification and, on the connected handle and before
// writing anything, verifies the server: pipe owner SID, server process ID (and, in service mode, the SCM-reported PID and session 0), optionally the
// image SHA-256. Only then does it send the one frame and relay the reply. Here `expect` says what the server must be: in production its service name
// (the helper derives the owner SID from it), in tests an owner SID plus the PID of the test server.
//
// Wire (helper <-> Authority, one request per connection): [int32 little-endian length][UTF-8 JSON] each way, at most 2048 bytes. `v` is always 1.
//   submit : { v, verb: "submit", purpose, operationId, idempotencyKey, leaseId, leaseGeneration, brokerEpoch, brokerChallenge, action: { action, projectId, computerId, args }, expectedDigest?, attestation? }
//            `attestation` is a Broker network attestation envelope { attestation, digest, keyId, signature } (network-attestation.mjs). The Authority alone decides what it is worth: only a valid one
//            that says "none" for this very environment lets environment.start skip a person at the standard tier; omitted, forged or stale simply means a prompt.
//            -> { ok: true, approvalId, state: "pending" | "approved", expiresAt }
//   status : { v, verb: "status", approvalId }
//            -> { ok: true, state: "pending", expiresAt } | { ok: true, state: "approved", receipt: <base64 receipt v2 or v3>, signature: <base64 64-byte ECDSA P-256 r||s> }
//            A v3 receipt with basis "policy" is what an action gets when the Authority's own tier policy needs no person for it: submit already answers state "approved", the first status call returns it.
//   error  : { ok: false, code } with one of AUTHORITY_REPLY_CODES (denied, expired, queue full, ... all final for that request)
// Results never carry exception text, paths, native identifiers or any part of the request. Failures are fixed codes.
// Pre-send codes (AUTHORITY_CLIENT_PRESEND_CODES): nothing reached any server, a retry is safe. Every other failure code comes after the frame was written:
// the Authority may have queued the request, so poll or resubmit with the same operationId + idempotencyKey (the Authority returns the first request).
// The receipt is NOT verified here (no signing key is known to the Control Plane): the Broker verifies signature, kid, issuer, binding and single use.
// Trust level: SAME-USER VERIFIED, like the Broker client. The service path (SCM PID, service owner SID, session 0) needs the approved lab (#23); do not wire this client before then.

/** ADR-002: bounded length-prefixed frame, 2 KiB each way (a status reply carries the receipt and its signature). */
export const AUTHORITY_CLIENT_LIMITS = Object.freeze({
  maxRequestBytes: 2048,
  maxResponseBytes: 2048,
  defaultTimeoutMs: 5000,
  minTimeoutMs: 100,
  maxTimeoutMs: 30_000,
});

/** The only `code`s the Authority itself sends. They are all final for the request: nothing was signed unless the state was `approved`. */
export const AUTHORITY_REPLY_CODES = Object.freeze([
  'authority_unavailable',
  'request_invalid',
  'request_expired',
  'human_denied',
  'presence_unavailable',
  'presence_mismatch',
  'queue_full',
]);

/** Failures that happen before the frame is written to the pipe: nothing reached any server, retrying is safe. */
export const AUTHORITY_CLIENT_PRESEND_CODES = Object.freeze([
  'invalid_request',
  'invalid_pipe_name',
  'request_too_large',
  'unsupported_platform',
  'authority_unreachable',
  'access_denied',
  'server_identity_mismatch',
  'server_identity_unavailable',
  'helper_unavailable',
]);

const POST_SEND_CODES = Object.freeze(['timeout', 'transport_error', 'invalid_response', 'response_too_large']);

/** Every `code` this client can return. */
export const AUTHORITY_CLIENT_ERROR_CODES = Object.freeze([...AUTHORITY_CLIENT_PRESEND_CODES, ...POST_SEND_CODES, ...AUTHORITY_REPLY_CODES]);

const HELPER_EXIT_CODES = Object.freeze([0, 64, 70]);
// What the helper may report at exit 0 (the helper's own word for an unreachable pipe is `broker_unavailable`; it is mapped to `authority_unreachable`).
const HELPER_EXIT0_FAILURES = Object.freeze(['broker_unavailable', 'access_denied', 'server_identity_mismatch', 'server_identity_unavailable', ...POST_SEND_CODES, ...AUTHORITY_REPLY_CODES]);
const ID_RE = new RegExp(ID_PATTERN, 'u');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u; // the receipt contract's uuid
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/u; // 128 bits, unpadded base64url, canonical form
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PIPE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const SID_PATTERN = /^S-1-\d{1,10}(?:-\d{1,10}){1,15}$/u;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNATURE_BYTES = 64;
const MAX_PIPE_ROOT_SEGMENTS = 4;
const MAX_PIPE_NAME_LENGTH = 256; // the helper's bound
const SUBMIT_PIPE_SUFFIX = 'submit\\v1';
const HELPER_GRACE_MS = 3000; // the helper has its own deadline; this only catches a helper that hangs past it
const HELPER_MAX_STDOUT_BYTES = 16 * 1024; // a 2 KiB reply whose base64 '+' the helper re-serialises as + stays far below this
const DEFAULT_HELPER_PATH = fileURLToPath(new URL('./windows-broker-pipe-client/bin/Release/net10.0-windows/win-x64/publish/albera-windows-broker-pipe-client.exe', import.meta.url)); // arch-allow: the one trusted pipe client helper (shared with the Broker client); its SHA-256 manifest is verified before every launch

const CONNECTION_KEYS = ['pipeRoot', 'expect', 'timeoutMs', 'helperPath', 'spawnImpl'];
const SUBMIT_KEYS = ['purpose', 'operationId', 'idempotencyKey', 'leaseId', 'leaseGeneration', 'brokerEpoch', 'brokerChallenge', 'action', 'includeDigest', 'attestation', ...CONNECTION_KEYS];
const STATUS_KEYS = ['approvalId', ...CONNECTION_KEYS];

/** Carries only an allowlisted code; the message is the code itself, never raw text. */
export class AuthorityClientError extends Error {
  constructor(code) {
    const safeCode = AUTHORITY_CLIENT_ERROR_CODES.includes(code) ? code : 'transport_error';
    super(safeCode);
    this.name = 'AuthorityClientError';
    this.code = safeCode;
  }
}

const failure = (code) => Object.freeze({ ok: false, code: AUTHORITY_CLIENT_ERROR_CODES.includes(code) ? code : 'transport_error' });
const codeOfError = (error) => (error instanceof AuthorityClientError ? error.code : 'transport_error');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCounter = (value) => Number.isSafeInteger(value) && value >= 1;
const bad = (code = 'invalid_request') => new AuthorityClientError(code);

/**
 * `<pipeRoot>\submit\v1`, the Authority's submit pipe, for a root made of 1..4 backslash-separated plain tokens. The root is the caller's configuration
 * (the Authority's own pipe root); anything that could escape the pipe namespace (dots, slashes, empty segments) is rejected. Pure.
 */
export function authoritySubmitPipeName(pipeRoot) {
  const segments = typeof pipeRoot === 'string' ? pipeRoot.split('\\') : [];
  if (segments.length < 1 || segments.length > MAX_PIPE_ROOT_SEGMENTS || !segments.every((segment) => PIPE_SEGMENT_PATTERN.test(segment))) throw bad('invalid_pipe_name');
  const name = `${pipeRoot}\\${SUBMIT_PIPE_SUFFIX}`;
  if (name.length > MAX_PIPE_NAME_LENGTH) throw bad('invalid_pipe_name');
  return name;
}

function requireKeys(options, allowed) {
  if (!isObject(options) || Object.keys(options).some((key) => !allowed.includes(key))) throw bad();
}
function requireId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw bad();
  return value;
}
function requireCounter(value) {
  if (!isCounter(value)) throw bad();
  return value;
}
function requireApprovalId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw bad();
  return value;
}

/** The attestation envelope as it goes on the wire: shape and digest checked (not the signature: that is the Authority's), exactly the four envelope keys. */
function attestationWire(value) {
  try {
    const { attestation, digest, keyId, signatureBytes } = readSignedNetworkAttestation(value); // one read of the caller's object; everything below comes from this copy
    return { attestation: { ...attestation }, digest, keyId, signature: signatureBytes.toString('base64url') };
  } catch { throw bad(); }
}

function sizedText(request) {
  const text = JSON.stringify(request);
  if (Buffer.byteLength(text, 'utf8') > AUTHORITY_CLIENT_LIMITS.maxRequestBytes) throw bad('request_too_large');
  return text;
}

/**
 * The submit request text: exactly the Authority's keys in a fixed order, the action DTO validated and normalised by the shared contract, size-bounded.
 * `includeDigest: true` also sends `expectedDigest` = this client's own computation of the action digest; the Authority recomputes it and answers
 * `request_invalid` on a difference, which catches a Node / .NET divergence before a human sees the request. `attestation` (optional) is a signed Broker network attestation
 * envelope, checked here for shape and digest only; a malformed one is `invalid_request` before anything is sent. Pure. @returns {string}
 */
export function buildSubmitRequestText(fields) {
  requireKeys(fields, SUBMIT_KEYS);
  if (!PURPOSES.includes(fields.purpose) || (fields.includeDigest !== undefined && typeof fields.includeDigest !== 'boolean')) throw bad();
  let dto;
  try { dto = validateActionDto(fields.purpose, fields.action); } catch (error) { throw error instanceof ActionDigestError ? bad() : error; }
  if (typeof fields.brokerChallenge !== 'string' || !CHALLENGE_PATTERN.test(fields.brokerChallenge)) throw bad();
  return sizedText({
    v: 1,
    verb: 'submit',
    purpose: fields.purpose,
    operationId: requireId(fields.operationId),
    idempotencyKey: requireId(fields.idempotencyKey),
    leaseId: requireId(fields.leaseId),
    leaseGeneration: requireCounter(fields.leaseGeneration),
    brokerEpoch: requireCounter(fields.brokerEpoch),
    brokerChallenge: fields.brokerChallenge,
    action: { action: dto.action, projectId: dto.projectId, computerId: dto.computerId, args: dto.args },
    ...(fields.includeDigest === true ? { expectedDigest: computeActionDigest(fields.purpose, dto) } : {}),
    ...(fields.attestation === undefined ? {} : { attestation: attestationWire(fields.attestation) }),
  });
}

/** The status request text: the approval id the submit reply returned. Pure. @returns {string} */
export function buildStatusRequestText({ approvalId } = {}) {
  return sizedText({ v: 1, verb: 'status', approvalId: requireApprovalId(approvalId) });
}

/** Validate a parsed reply to `submit`. Returns a fresh frozen result, never the input. */
export function validateSubmitResponse(value) {
  if (!isObject(value)) throw bad('invalid_response');
  const keys = Object.keys(value).sort().join(',');
  if (value.ok === true && keys === 'approvalId,expiresAt,ok,state' && typeof value.approvalId === 'string' && UUID_PATTERN.test(value.approvalId)
    && (value.state === 'pending' || value.state === 'approved') && isCounter(value.expiresAt)) {
    return Object.freeze({ ok: true, approvalId: value.approvalId, state: value.state, expiresAt: value.expiresAt });
  }
  return validateFailure(value, keys);
}

function validateFailure(value, keys) {
  if (value.ok === false && keys === 'code,ok' && AUTHORITY_REPLY_CODES.includes(value.code)) return failure(value.code);
  throw bad('invalid_response');
}

const canonicalBase64 = (value) => typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && BASE64_PATTERN.test(value) && Buffer.from(value, 'base64').toString('base64') === value;

/**
 * Validate a parsed reply to `status` for `approvalId`. An approved reply must carry a canonical base64 receipt that parses as receipt v2 or v3 (structure only),
 * names this very approval, and a canonical base64 signature of 64 bytes. The signature itself is the Broker's to verify.
 */
export function validateStatusResponse(value, approvalId) {
  if (!isObject(value)) throw bad('invalid_response');
  const keys = Object.keys(value).sort().join(',');
  if (value.ok === true && keys === 'expiresAt,ok,state' && value.state === 'pending' && isCounter(value.expiresAt)) {
    return Object.freeze({ ok: true, state: 'pending', expiresAt: value.expiresAt });
  }
  if (value.ok === true && keys === 'ok,receipt,signature,state' && value.state === 'approved' && canonicalBase64(value.receipt) && canonicalBase64(value.signature)) {
    const receiptBytes = Buffer.from(value.receipt, 'base64');
    const parsed = receiptBytes.length <= MAX_RECEIPT_BYTES ? parseReceipt(receiptBytes) : { ok: false };
    if (parsed.ok && parsed.receipt.approvalId === approvalId && Buffer.from(value.signature, 'base64').length === SIGNATURE_BYTES) {
      return Object.freeze({ ok: true, state: 'approved', receipt: value.receipt, signature: value.signature });
    }
    throw bad('invalid_response');
  }
  return validateFailure(value, keys);
}

/** What the helper must find when it inspects the pipe server. Exactly one of `pid` / `serviceName`. Pure. */
export function validateServerExpectation(expect) {
  if (!isObject(expect)) throw bad();
  const { ownerSid, pid, serviceName, imageSha256, ...rest } = expect;
  const valid = Object.keys(rest).length === 0
    && (pid === undefined) !== (serviceName === undefined)
    && (pid === undefined || (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff))
    && (serviceName === undefined || (typeof serviceName === 'string' && SERVICE_NAME_PATTERN.test(serviceName)))
    && (ownerSid === undefined ? serviceName !== undefined : typeof ownerSid === 'string' && SID_PATTERN.test(ownerSid))
    && (imageSha256 === undefined || (typeof imageSha256 === 'string' && SHA256_PATTERN.test(imageSha256)));
  if (!valid) throw bad();
  return Object.freeze({ ...(ownerSid === undefined ? {} : { ownerSid }), ...(pid === undefined ? {} : { pid }), ...(serviceName === undefined ? {} : { serviceName }), ...(imageSha256 === undefined ? {} : { imageSha256 }) });
}

/** Parse the helper's single stdout line plus its exit code into a result. Pure; any deviation is a post-send `transport_error`. */
export function parseHelperResult(stdout, exitCode, validate) {
  const fail = () => failure('transport_error');
  if (typeof stdout !== 'string' || !HELPER_EXIT_CODES.includes(exitCode) || !/^[^\r\n]+\r?\n?$/u.test(stdout)) return fail();
  let value;
  try { value = JSON.parse(stdout); } catch { return fail(); }
  if (!isObject(value)) return fail();
  if (value.ok === true) {
    try { return exitCode === 0 ? validate(value) : fail(); } catch { return fail(); }
  }
  if (value.ok !== false || Object.keys(value).sort().join(',') !== 'code,ok') return fail();
  // Exit 64 (bad input) and 70 (internal error) each carry only their own codes; anything else is a helper that misbehaves.
  const allowed = exitCode === 64 ? ['invalid_request'] : exitCode === 70 ? ['server_identity_unavailable', 'transport_error'] : HELPER_EXIT0_FAILURES;
  if (!allowed.includes(value.code)) return fail();
  return failure(value.code === 'broker_unavailable' ? 'authority_unreachable' : value.code);
}

function resolveTimeout(timeoutMs) {
  if (timeoutMs === undefined) return AUTHORITY_CLIENT_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < AUTHORITY_CLIENT_LIMITS.minTimeoutMs || timeoutMs > AUTHORITY_CLIENT_LIMITS.maxTimeoutMs) throw bad();
  return timeoutMs;
}

/** The helper must match the SHA-256 recorded next to it at build time. Same scheme as the Job Guardian and the Broker client. */
async function verifyHelper(helperPath, manifestPath) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest?.sha256 !== 'string' || !SHA256_PATTERN.test(manifest.sha256)) throw new Error('invalid_manifest');
    if ((await captureExecutableIdentity(helperPath)).sha256 !== manifest.sha256) throw new Error('helper_digest_mismatch');
  } catch { throw bad('helper_unavailable'); }
}

/** Run the helper once: one JSON line in, one JSON line out. Resolves with a result, never throws. */
function runHelper(spawnImpl, helperPath, line, timeoutMs, validate) {
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
    child.once('close', (code) => finish(parseHelperResult(stdout, code, validate)));
    child.stdin.end(line);
  });
}

/** One helper run: check the keys, the pipe, the request text, the expectation and the timeout, then launch the verified helper. Never throws. */
function isPlainOptions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function exchange(options, allowedKeys, buildRequestText, validate) {
  try {
    if (!isPlainOptions(options)) throw bad('invalid_request');
    requireKeys(options, allowedKeys);
    const pipeName = authoritySubmitPipeName(options.pipeRoot);
    const requestText = buildRequestText(options);
    const server = validateServerExpectation(options.expect);
    const timeout = resolveTimeout(options.timeoutMs);
    const { helperPath = DEFAULT_HELPER_PATH, spawnImpl } = options;
    if (spawnImpl === undefined && process.platform !== 'win32') throw bad('unsupported_platform');
    await verifyHelper(helperPath, `${helperPath}.manifest.json`);
    const line = `${JSON.stringify({ pipeName, authority: requestText, timeoutMs: timeout, expect: server })}\n`;
    return await runHelper(spawnImpl ?? spawn, helperPath, line, timeout, validate);
  } catch (error) {
    return failure(codeOfError(error));
  }
}

/**
 * Submit one action for human approval and return the validated reply: `{ ok: true, approvalId, state: 'pending' | 'approved', expiresAt }` or `{ ok: false, code }`.
 * The helper verifies the pipe server against `expect` before anything is written. Never throws for operational failures; returns an allowlisted code (see
 * AUTHORITY_CLIENT_PRESEND_CODES). The Authority returns the first request for the same operationId + idempotencyKey, so resubmitting after an unknown outcome is safe.
 * @param {{ pipeRoot: string, purpose: string, operationId: string, idempotencyKey: string, leaseId: string, leaseGeneration: number, brokerEpoch: number,
 *   brokerChallenge: string, action: { action: string, projectId: string, computerId: string, args: object }, includeDigest?: boolean, attestation?: object,
 *   expect: { ownerSid?: string, pid?: number, serviceName?: string, imageSha256?: string }, timeoutMs?: number, helperPath?: string, spawnImpl?: typeof spawn }} options
 *   `helperPath` and `spawnImpl` are test seams. A custom helper still needs a `<helperPath>.manifest.json` with its SHA-256.
 */
export function submitApproval(options = {}) {
  return exchange(options, SUBMIT_KEYS, buildSubmitRequestText, validateSubmitResponse);
}

/**
 * Poll one approval: `{ ok: true, state: 'pending', expiresAt }`, `{ ok: true, state: 'approved', receipt, signature }` (both base64, ready for the Broker) or
 * `{ ok: false, code }` (`human_denied`, `request_expired`, ... are final; resubmit with a new idempotencyKey). Same pre-send / post-send rules as `submitApproval`.
 * @param {{ pipeRoot: string, approvalId: string, expect: object, timeoutMs?: number, helperPath?: string, spawnImpl?: typeof spawn }} options
 */
export function getApprovalStatus(options = {}) {
  // Read the options once: the approvalId that is sent is the one the reply is checked against, even if the caller's object changes during the I/O.
  const snapshot = isPlainOptions(options) ? { ...options } : options;
  return exchange(snapshot, STATUS_KEYS, buildStatusRequestText, (value) => validateStatusResponse(value, snapshot.approvalId));
}
