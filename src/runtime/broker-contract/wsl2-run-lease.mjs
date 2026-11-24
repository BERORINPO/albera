// WSL2 run lease v1 (ADR-012, decision 4). The WSL bridge runs a job only under a lease the Broker signed for one approved task.start: this file is the statement, and its C# twin is
// Wsl2RunLease.cs, pinned by the same vectors file. A bridge that holds the Broker's public key can check a lease without trusting the Control Plane that carried it.
//
// It is its own kind next to the two attestations: its own domain string and its own eleven body keys, so a lease can never be read as an attestation or the other way round. Same signature
// scheme (ECDSA P-256 / SHA-256 over the canonical bytes, signer port `{ keyId, sign(bytes) }`). The time rule differs on purpose: an attestation is evidence at one moment (at most 300 s),
// and a lease covers a whole run (at most 3600 s, the same bound as the Broker's desktop lease).
//
// WHAT IT SAYS: for the one operation `operationId`, the computer `computerId`, whose isolation class is `isolation` (only ever "wsl2", so a task that asked for a VM cannot be served by
// it), may run against the repository `repositoryId` at exactly `baseOid`, until `expiresAt`, with at most `maxCalls` calls. `issuedAt` and `expiresAt` are Unix seconds from the Broker's clock.
// `actionDigest` ties the lease to the action the owner approved, for the record: the task itself stays with the Control Plane and the model, so the bridge cannot recompute it.
// `leaseGeneration` is the Broker's fence value at the claim. Raising the Broker's generation revokes a Control Plane (ServiceConfig.cs); the bridge's `minLeaseGeneration` does the same for leases already issued.
//
// TWO STEPS, so that nothing unauthenticated is ever acted on: `authenticateWsl2RunLease` (signature and time) gives a lease whose `repositoryId` the bridge may then look up, and
// `requireWsl2RunLeaseBinding` compares it with the bridge's own state. Step 2 takes only the object step 1 returned. Step 2 does not look at the clock, so the bridge checks `expiresAt` again
// after anything slow between the steps, such as reading the head.
//
// WHAT IT DOES NOT DO: both steps are stateless, and a lease is a bearer statement checked against a wall clock, unlike the Broker's desktop lease. So the bridge must keep, on disk, across its own
// restarts, every `operationId` it has begun and its call count, until `expiresAt` + 30 s, and refuse when it cannot. The key for reuse is `operationId`, never the signature: ECDSA signatures are malleable.
//
//   preimage = UTF8("albera.wsl2-run-lease.v1") 0x00 enc(map)      enc(map) / enc(string) / enc(int) as in action-digest.mjs
//   digest   = "sha256:" lowercase-hex(SHA-256(preimage))          the signature covers the preimage bytes; keyId and signature are not part of the digest
//   signed   = { digest, keyId, lease, signature }                 signature = unpadded base64url of the signer's bytes
import { createHash } from 'node:crypto';
import { ID_PATTERN, encMap } from './action-digest.mjs';
import { MAX_OBSERVED_SKEW_SECONDS, readPlain } from './network-attestation.mjs';

export const WSL2_RUN_LEASE_VERSION = 1;
export const WSL2_RUN_LEASE_DOMAIN = 'albera.wsl2-run-lease.v1';
export const WSL2_ISOLATION = 'wsl2';
export const MAX_RUN_LEASE_TTL_SECONDS = 3600;
export const MAX_RUN_LEASE_CALLS = 10_000;
const MAX_SIGNATURE_BYTES = 128;
const BODY_KEYS = Object.freeze(['actionDigest', 'baseOid', 'computerId', 'expiresAt', 'isolation', 'issuedAt', 'leaseGeneration', 'maxCalls', 'operationId', 'repositoryId', 'v']);
const SIGNED_KEYS = Object.freeze(['digest', 'keyId', 'lease', 'signature']);
const EXPECTED_KEYS = Object.freeze(['baseOid', 'computerId', 'minLeaseGeneration', 'operationId', 'repositoryId']);
const BOUND_KEYS = Object.freeze(['baseOid', 'computerId', 'operationId', 'repositoryId']); // sorted: also the order bindings are checked in
const ID_RE = new RegExp(ID_PATTERN);
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export class Wsl2RunLeaseError extends Error {
  /** @param {string} code @param {string} [field] */
  constructor(code, field) { super(code); this.name = 'Wsl2RunLeaseError'; this.code = code; this.field = field; }
}
const fail = (code, field) => new Wsl2RunLeaseError(code, field);
// Only what authenticateWsl2RunLease returned: a body from anywhere else, however well formed, never reaches step 2.
const authenticated = new WeakSet();
const isCounter = (v) => Number.isSafeInteger(v) && v >= 1;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isDigest = (v) => typeof v === 'string' && DIGEST_RE.test(v);
export const isGitOid = (v) => typeof v === 'string' && OID_RE.test(v);

/** Validate the lease body and return a frozen normalized copy. @throws {Wsl2RunLeaseError} code malformed | ttl (field names the rule) */
export function validateWsl2RunLease(body) {
  const b = readPlain(body, BODY_KEYS, 'malformed', fail);
  const ok = {
    v: b.v === WSL2_RUN_LEASE_VERSION,
    operationId: isId(b.operationId),
    actionDigest: isDigest(b.actionDigest),
    leaseGeneration: isCounter(b.leaseGeneration),
    computerId: isId(b.computerId),
    isolation: b.isolation === WSL2_ISOLATION,
    repositoryId: isId(b.repositoryId),
    baseOid: isGitOid(b.baseOid),
    maxCalls: isCounter(b.maxCalls) && b.maxCalls <= MAX_RUN_LEASE_CALLS,
    issuedAt: isCounter(b.issuedAt),
    expiresAt: isCounter(b.expiresAt),
  };
  for (const [field, good] of Object.entries(ok)) if (!good) throw fail('malformed', field);
  if (b.expiresAt <= b.issuedAt || b.expiresAt - b.issuedAt > MAX_RUN_LEASE_TTL_SECONDS) throw fail('ttl', 'expiresAt');
  return Object.freeze({ ...b });
}

/** Build the body. `issuedAt` is the Broker clock in Unix seconds; `ttlSeconds` and `maxCalls` are the Broker's own limits, never a caller's. */
export function createWsl2RunLease({ operationId, actionDigest, leaseGeneration, computerId, repositoryId, baseOid, maxCalls, issuedAt, ttlSeconds }) {
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(ttlSeconds)) throw fail('malformed', 'issuedAt');
  return validateWsl2RunLease({ v: WSL2_RUN_LEASE_VERSION, operationId, actionDigest, leaseGeneration, computerId, isolation: WSL2_ISOLATION, repositoryId, baseOid, maxCalls, issuedAt, expiresAt: issuedAt + ttlSeconds });
}

/** The exact bytes that are hashed and signed. @returns {Buffer} */
export function canonicalizeWsl2RunLease(body) {
  return Buffer.concat([Buffer.from(WSL2_RUN_LEASE_DOMAIN, 'utf8'), Buffer.from([0]), encMap(validateWsl2RunLease(body))]);
}
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** @returns {string} "sha256:" + 64 lowercase hex characters */
export function computeWsl2RunLeaseDigest(body) { return digestOf(canonicalizeWsl2RunLease(body)); }

/**
 * Sign a body through the signer port (`{ keyId, sign(bytes) }`).
 * @returns {Promise<{digest: string, keyId: string, lease: object, signature: string}>}
 */
export async function signWsl2RunLease(body, signer) {
  const lease = validateWsl2RunLease(body);
  if (signer === null || typeof signer !== 'object' || typeof signer.sign !== 'function' || typeof signer.keyId !== 'string' || !ID_RE.test(signer.keyId)) throw fail('signer_invalid');
  const bytes = canonicalizeWsl2RunLease(lease);
  let signature;
  try { signature = await signer.sign(bytes); } catch { throw fail('signer_failed'); }
  if (!(signature instanceof Uint8Array) || signature.length < 1 || signature.length > MAX_SIGNATURE_BYTES) throw fail('signer_failed');
  return Object.freeze({ digest: digestOf(bytes), keyId: signer.keyId, lease, signature: Buffer.from(signature).toString('base64url') });
}

/**
 * Shape and digest only (no signature, no clock). An attestation is `malformed` here (its envelope and body have other keys), whatever its signature.
 * @returns {{lease: object, digest: string, keyId: string, bytes: Buffer, signatureBytes: Buffer}}
 * @throws {Wsl2RunLeaseError} code malformed | ttl | digest
 */
export function readSignedWsl2RunLease(signed) {
  const s = readPlain(signed, SIGNED_KEYS, 'malformed', fail);
  if (!isId(s.keyId)) throw fail('malformed', 'keyId');
  if (typeof s.digest !== 'string' || !DIGEST_RE.test(s.digest)) throw fail('malformed', 'digest');
  const decoded = typeof s.signature === 'string' && BASE64URL_RE.test(s.signature) ? Buffer.from(s.signature, 'base64url') : null;
  if (!decoded || decoded.length < 1 || decoded.length > MAX_SIGNATURE_BYTES || decoded.toString('base64url') !== s.signature) throw fail('malformed', 'signature');
  const lease = validateWsl2RunLease(s.lease);
  const bytes = canonicalizeWsl2RunLease(lease);
  if (digestOf(bytes) !== s.digest) throw fail('digest', 'digest');
  return { lease, digest: s.digest, keyId: s.keyId, bytes, signatureBytes: decoded };
}

function readExpected(expected) {
  const e = readPlain(expected, EXPECTED_KEYS, 'invalid_expected', fail);
  for (const field of ['computerId', 'operationId', 'repositoryId']) if (!isId(e[field])) throw fail('invalid_expected', field);
  if (!isGitOid(e.baseOid)) throw fail('invalid_expected', 'baseOid');
  if (!isCounter(e.minLeaseGeneration)) throw fail('invalid_expected', 'minLeaseGeneration');
  return e;
}

/**
 * Step 1, in this order: shape, TTL and digest, signature (the injected `verify(keyId, bytes, signatureBytes)` must return exactly true), not yet valid, expired.
 * Only what this returns may be used: nothing in a lease is read before it has passed here.
 * @param {object} signed
 * @param {{clock: () => number, verify: (keyId: string, bytes: Buffer, signature: Buffer) => boolean}} ctx clock returns Unix seconds
 * @returns {object} the authenticated lease
 * @throws {Wsl2RunLeaseError} code invalid_context malformed ttl digest signature not_yet_valid expired (field names a fixed field)
 */
export function authenticateWsl2RunLease(signed, ctx) {
  const { clock, verify } = ctx ?? {};
  if (typeof clock !== 'function' || typeof verify !== 'function') throw fail('invalid_context');
  const { lease, keyId, bytes, signatureBytes } = readSignedWsl2RunLease(signed);
  let genuine = false;
  try { genuine = verify(keyId, bytes, signatureBytes) === true; } catch { genuine = false; }
  if (!genuine) throw fail('signature', 'signature');
  // The clock is read AFTER the signature check: a slow verifier must not let a lease that expired meanwhile pass.
  let now;
  try { now = clock(); } catch { throw fail('invalid_context', 'clock'); }
  if (!Number.isSafeInteger(now) || now < 0) throw fail('invalid_context', 'clock');
  if (lease.issuedAt > now + MAX_OBSERVED_SKEW_SECONDS) throw fail('not_yet_valid', 'issuedAt');
  if (now >= lease.expiresAt) throw fail('expired', 'expiresAt');
  authenticated.add(lease);
  return lease;
}

/**
 * Step 2: the authenticated lease against the bridge's own state. Where each value comes from: `computerId` and `minLeaseGeneration` from the bridge's config; `operationId` and `repositoryId`
 * from the request, which the bridge must have mapped through its own repository table; `baseOid` from the head the bridge read itself, in the folder that table names.
 * @param {object} lease what authenticateWsl2RunLease returned
 * @param {{baseOid: string, computerId: string, minLeaseGeneration: number, operationId: string, repositoryId: string}} expected
 * @returns {object} the lease
 * @throws {Wsl2RunLeaseError} code unauthenticated invalid_expected binding generation (field names a fixed field)
 */
export function requireWsl2RunLeaseBinding(lease, expected) {
  if (lease === null || typeof lease !== 'object' || !authenticated.has(lease)) throw fail('unauthenticated');
  const trusted = readExpected(expected);
  for (const field of BOUND_KEYS) if (lease[field] !== trusted[field]) throw fail('binding', field);
  if (lease.leaseGeneration < trusted.minLeaseGeneration) throw fail('generation', 'leaseGeneration');
  return lease;
}
