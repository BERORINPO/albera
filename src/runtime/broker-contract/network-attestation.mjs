// Network attestation v1 (docs/architecture/approval-tiers.md, "Egress is decided by the Broker, not the request"; issue #115 step 2).
// The Broker reads an environment's effective network configuration and signs a short statement about it. The consumer is the Approval Authority (step 3b): before it signs a
// no-person receipt for environment.start / environment.create it checks this statement (the C# twin is NetworkAttestation.cs, pinned by the same vectors). Signing goes through a
// signer PORT (`{ keyId, sign(bytes) }`): the production scheme is ECDSA P-256 / SHA-256 over the canonical bytes (ecdsa-attestation-signer.mjs, key from host configuration);
// tests also use a Fake. Pure: no I/O, no ambient clock (node:crypto is used for hashing only).
//
// WHAT IT SAYS: for one environment, `network` is "none" | "present" | "unknown", bound to computerId, the VM's own hypervisor id (vmId), generation, projectId,
// leaseId and leaseGeneration (the lease the Control Plane acts under; claims echoed into the statement, each checked by the verifier against its own state, so a VM moved
// to another lease cannot reuse an attestation made under the old one), and observedAt / expiresAt
// (Unix seconds from the BROKER's clock, TTL 60 s by default, at most 300 s). Nothing in a Control Plane request influences `network`: only the adapter facts the Broker reads.
//
// The projectId is the Broker's own record (the VM's Notes, written by create
// from the authorized create operation), not the request's: a VM created before that change has none and cannot be attested until it is re-created.
// The wire format is still v1: no attestation has been issued outside tests, so adding leaseId to the body (10 keys) needed no version bump.
//
// CLASSIFICATION (conservative): no adapters at all = "none"; ANY adapter, connected or not = "present" (a disconnected adapter can be reconnected); anything that could
// not be read or parsed = "unknown". The switch type of a connected adapter is recorded in the facts but never lowers the result.
//
// STALENESS: the statement is evidence at observedAt ONLY. A consumer must re-check at execution time (step 3: re-attest, or compare the VM's state again, immediately
// before it acts); "not expired" means "was true recently", never "is true now". `verifyNetworkAttestation` refuses an expired statement and one bound to a different
// computerId / vmId / generation / projectId / leaseId / leaseGeneration than the caller expects (an expected vmId of `null` means the caller has no VM id of its own to compare:
// the Authority's action DTO does not carry one; the statement's vmId is then only covered by the signature and the digest); it does not decide what "none" or "present" allows.
//
//   preimage = UTF8("albera.network-attestation.v1") 0x00 enc(map)            enc(map) / enc(string) / enc(int) as in action-digest.mjs
//   digest   = "sha256:" lowercase-hex(SHA-256(preimage))                      the signature covers the preimage bytes; keyId and signature are not part of the digest
//   signed   = { attestation, digest, keyId, signature }                       signature = unpadded base64url of the signer's bytes
import { createHash } from 'node:crypto';
import { ID_PATTERN, encMap } from './action-digest.mjs';

export const ATTESTATION_VERSION = 1;
export const ATTESTATION_DOMAIN = 'albera.network-attestation.v1';
export const NETWORK_VALUES = Object.freeze(['none', 'present', 'unknown']);
export const DEFAULT_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 300;
export const MAX_OBSERVED_SKEW_SECONDS = 30;
export const MAX_ADAPTERS = 64;
export const SWITCH_TYPES = Object.freeze(['External', 'Internal', 'Private', 'unknown']);
const MAX_SIGNATURE_BYTES = 128;
const BODY_KEYS = Object.freeze(['computerId', 'expiresAt', 'generation', 'leaseGeneration', 'leaseId', 'network', 'observedAt', 'projectId', 'v', 'vmId']);
const SIGNED_KEYS = Object.freeze(['attestation', 'digest', 'keyId', 'signature']);
const EXPECTED_KEYS = Object.freeze(['computerId', 'generation', 'leaseGeneration', 'leaseId', 'projectId', 'vmId']); // sorted, like the other key lists
const ID_RE = new RegExp(ID_PATTERN);
const VM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export class NetworkAttestationError extends Error {
  /** @param {string} code @param {string} [field] */
  constructor(code, field) { super(code); this.name = 'NetworkAttestationError'; this.code = code; this.field = field; }
}
const fail = (code, field) => new NetworkAttestationError(code, field);
const isCounter = (v) => Number.isSafeInteger(v) && v >= 1;

function readPlain(input, keys, code) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw fail(code);
  const proto = Object.getPrototypeOf(input);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(input).length > 0) throw fail(code);
  const out = Object.create(null);
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!d.enumerable || !Object.hasOwn(d, 'value')) throw fail(code);
    out[key] = d.value;
  }
  const names = Object.keys(out).sort();
  if (names.length !== keys.length || names.some((k, n) => k !== keys[n])) throw fail(code, '$extra');
  return out;
}

/**
 * Classify the adapter facts the Broker read from a VM: [{ connected: boolean, switchType: "External"|"Internal"|"Private"|"unknown"|null }].
 * A connected adapter carries its switch type, a disconnected one carries null. Anything else (not an array, too many entries, an entry of another shape) is "unknown".
 * @returns {'none'|'present'|'unknown'}
 */
export function classifyNetworkAdapters(adapters) {
  try {
    if (!Array.isArray(adapters) || adapters.length > MAX_ADAPTERS) return 'unknown';
    const entries = Array.from(adapters); // one read of the untrusted list; a hostile accessor or Proxy throws here and is "unknown"
    for (const adapter of entries) {
      const facts = readPlain(adapter, ['connected', 'switchType'], 'malformed');
      if (facts.connected === true ? !SWITCH_TYPES.includes(facts.switchType) : !(facts.connected === false && facts.switchType === null)) return 'unknown';
    }
    return entries.length === 0 ? 'none' : 'present';
  }
  catch { return 'unknown'; }
}

/** Validate the attestation body and return a frozen normalized copy. @throws {NetworkAttestationError} code malformed (field names the rule) */
export function validateNetworkAttestation(body) {
  const b = readPlain(body, BODY_KEYS, 'malformed');
  const ok = {
    v: b.v === ATTESTATION_VERSION,
    network: NETWORK_VALUES.includes(b.network),
    computerId: typeof b.computerId === 'string' && ID_RE.test(b.computerId),
    vmId: typeof b.vmId === 'string' && VM_ID_RE.test(b.vmId),
    generation: isCounter(b.generation),
    projectId: typeof b.projectId === 'string' && ID_RE.test(b.projectId),
    leaseId: typeof b.leaseId === 'string' && ID_RE.test(b.leaseId),
    leaseGeneration: isCounter(b.leaseGeneration),
    observedAt: isCounter(b.observedAt),
    expiresAt: isCounter(b.expiresAt),
  };
  for (const [field, good] of Object.entries(ok)) if (!good) throw fail('malformed', field);
  if (b.expiresAt <= b.observedAt || b.expiresAt - b.observedAt > MAX_TTL_SECONDS) throw fail('ttl', 'expiresAt');
  return Object.freeze({ ...b });
}

/** Build the body from what the Broker itself observed. observedAt is the Broker clock in Unix seconds; the TTL is Broker configuration. */
export function createNetworkAttestation({ network, computerId, vmId, generation, projectId, leaseId, leaseGeneration, observedAt, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(ttlSeconds)) throw fail('malformed', 'observedAt');
  return validateNetworkAttestation({ v: ATTESTATION_VERSION, network, computerId, vmId, generation, projectId, leaseId, leaseGeneration, observedAt, expiresAt: observedAt + ttlSeconds });
}

/** The exact bytes that are hashed and signed. @returns {Buffer} */
export function canonicalizeNetworkAttestation(body) {
  return Buffer.concat([Buffer.from(ATTESTATION_DOMAIN, 'utf8'), Buffer.from([0]), encMap(validateNetworkAttestation(body))]);
}
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** @returns {string} "sha256:" + 64 lowercase hex characters */
export function computeNetworkAttestationDigest(body) { return digestOf(canonicalizeNetworkAttestation(body)); }

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * Broker side: sign a body through the signer port. The port is `{ keyId, sign(bytes) }` and returns the signature bytes (1..128); the Broker host owns the key.
 * @returns {Promise<{attestation: object, digest: string, keyId: string, signature: string}>}
 */
export async function signNetworkAttestation(body, signer) {
  const attestation = validateNetworkAttestation(body);
  if (signer === null || typeof signer !== 'object' || typeof signer.sign !== 'function' || typeof signer.keyId !== 'string' || !ID_RE.test(signer.keyId)) throw fail('signer_invalid');
  const bytes = canonicalizeNetworkAttestation(attestation);
  let signature;
  try { signature = await signer.sign(bytes); } catch { throw fail('signer_failed'); }
  if (!(signature instanceof Uint8Array) || signature.length < 1 || signature.length > MAX_SIGNATURE_BYTES) throw fail('signer_failed');
  return Object.freeze({ attestation, digest: digestOf(bytes), keyId: signer.keyId, signature: base64url(signature) });
}

/**
 * Shape and digest only (no signature, no clock): the attestation is well formed and its digest is the one recomputed from the body.
 * @returns {{attestation: object, digest: string, keyId: string, bytes: Buffer, signatureBytes: Buffer}}
 * @throws {NetworkAttestationError} code malformed | digest
 */
export function readSignedNetworkAttestation(signed) {
  const s = readPlain(signed, SIGNED_KEYS, 'malformed');
  if (typeof s.keyId !== 'string' || !ID_RE.test(s.keyId)) throw fail('malformed', 'keyId');
  if (typeof s.digest !== 'string' || !DIGEST_RE.test(s.digest)) throw fail('malformed', 'digest');
  const decoded = typeof s.signature === 'string' && BASE64URL_RE.test(s.signature) ? Buffer.from(s.signature, 'base64url') : null;
  if (!decoded || decoded.length < 1 || decoded.length > MAX_SIGNATURE_BYTES || decoded.toString('base64url') !== s.signature) throw fail('malformed', 'signature');
  const attestation = validateNetworkAttestation(s.attestation);
  const bytes = canonicalizeNetworkAttestation(attestation);
  if (digestOf(bytes) !== s.digest) throw fail('digest', 'digest');
  return { attestation, digest: s.digest, keyId: s.keyId, bytes, signatureBytes: decoded };
}

function readExpected(expected) {
  const e = readPlain(expected, EXPECTED_KEYS, 'invalid_expected');
  for (const field of ['computerId', 'projectId', 'leaseId']) if (typeof e[field] !== 'string' || !ID_RE.test(e[field])) throw fail('invalid_expected', field);
  if (e.vmId !== null && (typeof e.vmId !== 'string' || !VM_ID_RE.test(e.vmId))) throw fail('invalid_expected', 'vmId');
  for (const field of ['generation', 'leaseGeneration']) if (!isCounter(e[field])) throw fail('invalid_expected', field);
  return e;
}

/**
 * Full check, in this order: shape, TTL and digest, signature (the injected `verify(keyId, bytes, signatureBytes)` must return exactly true), not yet valid, expired,
 * then every binding in `expected` (computerId, vmId, generation, projectId, leaseId, leaseGeneration), all of which come from the caller's own trusted state. Returns the
 * attestation; it says nothing about whether "none" is enough for an action.
 * @param {object} signed
 * @param {{clock: () => number, verify: (keyId: string, bytes: Buffer, signature: Buffer) => boolean, expected: object}} ctx clock returns Unix seconds
 * @throws {NetworkAttestationError} code invalid_context invalid_expected malformed digest signature ttl not_yet_valid expired binding (field names a fixed field)
 */
export function verifyNetworkAttestation(signed, ctx) {
  const { clock, verify, expected } = ctx ?? {};
  if (typeof clock !== 'function' || typeof verify !== 'function') throw fail('invalid_context');
  const trusted = readExpected(expected);
  const { attestation, keyId, bytes, signatureBytes } = readSignedNetworkAttestation(signed);
  let genuine = false;
  try { genuine = verify(keyId, bytes, signatureBytes) === true; } catch { genuine = false; }
  if (!genuine) throw fail('signature', 'signature');
  // The clock is read AFTER the signature check: a slow verifier must not let an attestation that expired meanwhile pass.
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw fail('invalid_context', 'clock');
  if (attestation.observedAt > now + MAX_OBSERVED_SKEW_SECONDS) throw fail('not_yet_valid', 'observedAt');
  if (now >= attestation.expiresAt) throw fail('expired', 'expiresAt');
  for (const field of EXPECTED_KEYS) if (trusted[field] !== null && attestation[field] !== trusted[field]) throw fail('binding', field);
  return attestation;
}
