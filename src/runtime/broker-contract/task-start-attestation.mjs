// Task-start attestation v1 (docs/architecture/approval-tiers.md, "Step 4 as built"; issue #115 step 4).
// Before a guest.command / task.start is submitted for approval, the Hyper-V Broker side takes a Production checkpoint of the VM and signs ONE statement that says both "this
// environment has no network" and "this checkpoint was taken" for one environment incarnation, lease and operation. At the standard tier the Approval Authority may sign task.start
// without a person only when it verifies this statement (the C# twin is TaskStartAttestation.cs, pinned by the same vectors file). Anything missing or wrong means a person is asked.
//
// It is the network attestation (network-attestation.mjs) plus the checkpoint, as its own kind: its own domain string and its own body keys, so a network attestation can never be
// read as a task-start one (the body has 13 keys, not 10, and the signature covers another domain) and a task-start attestation can never be read as a network one. Same signature
// scheme and the same Broker key (ECDSA P-256 / SHA-256 over the canonical bytes, signer port `{ keyId, sign(bytes) }`), same TTL rule (60 s by default, at most 300 s, Broker clock).
//
// WHAT IT SAYS, bound to computerId, vmId (the VM's own Hyper-V id), generation, projectId, leaseId, leaseGeneration (claims echoed into the statement and checked by the verifier
// against its own state) and operationId (the checkpoint is the one taken for THAT task start: a statement made for one operation cannot be reused for another):
//   network         "none" | "present" | "unknown", read by the Broker (a task-start attestation is only worth anything when it is "none")
//   checkpointId    the Hyper-V snapshot id the Broker got back from Checkpoint-VM (a lowercase GUID)
//   checkpointType  "production" | "standard"; only "production" counts (it does not copy the guest's memory, which may hold secrets, to the host disk)
// Nothing in a Control Plane request influences any of it: the Broker takes the checkpoint itself and reads the adapters itself.
//
// STALENESS is the network attestation's: evidence at observedAt only; the verifier refuses an expired or not-yet-valid statement and any binding that differs from what the caller expects.
//
//   preimage = UTF8("albera.task-start-attestation.v1") 0x00 enc(map)          enc(map) / enc(string) / enc(int) as in action-digest.mjs
//   digest   = "sha256:" lowercase-hex(SHA-256(preimage))                      the signature covers the preimage bytes; keyId and signature are not part of the digest
//   signed   = { attestation, digest, keyId, signature }                       signature = unpadded base64url of the signer's bytes
import { createHash } from 'node:crypto';
import { ID_PATTERN, encMap } from './action-digest.mjs';
import { DEFAULT_TTL_SECONDS, MAX_OBSERVED_SKEW_SECONDS, MAX_TTL_SECONDS, NETWORK_VALUES, isVmId, readPlain } from './network-attestation.mjs';

export const TASK_START_ATTESTATION_VERSION = 1;
export const TASK_START_ATTESTATION_DOMAIN = 'albera.task-start-attestation.v1';
export const CHECKPOINT_TYPES = Object.freeze(['production', 'standard']);
/** The one checkpoint type that lets the Authority skip a person. */
export const REQUIRED_CHECKPOINT_TYPE = 'production';
const MAX_SIGNATURE_BYTES = 128;
const BODY_KEYS = Object.freeze(['checkpointId', 'checkpointType', 'computerId', 'expiresAt', 'generation', 'leaseGeneration', 'leaseId', 'network', 'observedAt', 'operationId', 'projectId', 'v', 'vmId']);
const SIGNED_KEYS = Object.freeze(['attestation', 'digest', 'keyId', 'signature']);
const EXPECTED_KEYS = Object.freeze(['computerId', 'generation', 'leaseGeneration', 'leaseId', 'operationId', 'projectId', 'vmId']); // sorted: also the order bindings are checked in
const ID_RE = new RegExp(ID_PATTERN);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export class TaskStartAttestationError extends Error {
  /** @param {string} code @param {string} [field] */
  constructor(code, field) { super(code); this.name = 'TaskStartAttestationError'; this.code = code; this.field = field; }
}
const fail = (code, field) => new TaskStartAttestationError(code, field);
const isCounter = (v) => Number.isSafeInteger(v) && v >= 1;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);

/** Validate the attestation body and return a frozen normalized copy. @throws {TaskStartAttestationError} code malformed | ttl (field names the rule) */
export function validateTaskStartAttestation(body) {
  const b = readPlain(body, BODY_KEYS, 'malformed', fail);
  const ok = {
    v: b.v === TASK_START_ATTESTATION_VERSION,
    network: NETWORK_VALUES.includes(b.network),
    computerId: isId(b.computerId),
    vmId: isVmId(b.vmId),
    generation: isCounter(b.generation),
    projectId: isId(b.projectId),
    leaseId: isId(b.leaseId),
    leaseGeneration: isCounter(b.leaseGeneration),
    operationId: isId(b.operationId),
    checkpointId: isVmId(b.checkpointId), // a Hyper-V snapshot id has the same lowercase GUID form as a VM id
    checkpointType: CHECKPOINT_TYPES.includes(b.checkpointType),
    observedAt: isCounter(b.observedAt),
    expiresAt: isCounter(b.expiresAt),
  };
  for (const [field, good] of Object.entries(ok)) if (!good) throw fail('malformed', field);
  if (b.expiresAt <= b.observedAt || b.expiresAt - b.observedAt > MAX_TTL_SECONDS) throw fail('ttl', 'expiresAt');
  return Object.freeze({ ...b });
}

/** True when the statement says what the Authority needs to skip a person: no network AND a Production checkpoint. It says nothing about bindings, signature or time. */
export const provesCheckpointedNoNetwork = (attestation) => attestation?.network === 'none' && attestation?.checkpointType === REQUIRED_CHECKPOINT_TYPE;

/** Build the body from what the Broker itself observed and got back from Hyper-V. observedAt is the Broker clock in Unix seconds; the TTL is Broker configuration. */
export function createTaskStartAttestation({
  network, computerId, vmId, generation, projectId, leaseId, leaseGeneration, operationId, checkpointId, checkpointType = REQUIRED_CHECKPOINT_TYPE, observedAt, ttlSeconds = DEFAULT_TTL_SECONDS,
}) {
  if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(ttlSeconds)) throw fail('malformed', 'observedAt');
  return validateTaskStartAttestation({
    v: TASK_START_ATTESTATION_VERSION, network, computerId, vmId, generation, projectId, leaseId, leaseGeneration, operationId, checkpointId, checkpointType, observedAt, expiresAt: observedAt + ttlSeconds,
  });
}

/** The exact bytes that are hashed and signed. @returns {Buffer} */
export function canonicalizeTaskStartAttestation(body) {
  return Buffer.concat([Buffer.from(TASK_START_ATTESTATION_DOMAIN, 'utf8'), Buffer.from([0]), encMap(validateTaskStartAttestation(body))]);
}
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** @returns {string} "sha256:" + 64 lowercase hex characters */
export function computeTaskStartAttestationDigest(body) { return digestOf(canonicalizeTaskStartAttestation(body)); }

/**
 * Broker side: sign a body through the signer port (`{ keyId, sign(bytes) }`, the same port as the network attestation's).
 * @returns {Promise<{attestation: object, digest: string, keyId: string, signature: string}>}
 */
export async function signTaskStartAttestation(body, signer) {
  const attestation = validateTaskStartAttestation(body);
  if (signer === null || typeof signer !== 'object' || typeof signer.sign !== 'function' || typeof signer.keyId !== 'string' || !ID_RE.test(signer.keyId)) throw fail('signer_invalid');
  const bytes = canonicalizeTaskStartAttestation(attestation);
  let signature;
  try { signature = await signer.sign(bytes); } catch { throw fail('signer_failed'); }
  if (!(signature instanceof Uint8Array) || signature.length < 1 || signature.length > MAX_SIGNATURE_BYTES) throw fail('signer_failed');
  return Object.freeze({ attestation, digest: digestOf(bytes), keyId: signer.keyId, signature: Buffer.from(signature).toString('base64url') });
}

/**
 * Shape and digest only (no signature, no clock). A network attestation is `malformed` here (its body has other keys), whatever its signature.
 * @returns {{attestation: object, digest: string, keyId: string, bytes: Buffer, signatureBytes: Buffer}}
 * @throws {TaskStartAttestationError} code malformed | ttl | digest
 */
export function readSignedTaskStartAttestation(signed) {
  const s = readPlain(signed, SIGNED_KEYS, 'malformed', fail);
  if (!isId(s.keyId)) throw fail('malformed', 'keyId');
  if (typeof s.digest !== 'string' || !DIGEST_RE.test(s.digest)) throw fail('malformed', 'digest');
  const decoded = typeof s.signature === 'string' && BASE64URL_RE.test(s.signature) ? Buffer.from(s.signature, 'base64url') : null;
  if (!decoded || decoded.length < 1 || decoded.length > MAX_SIGNATURE_BYTES || decoded.toString('base64url') !== s.signature) throw fail('malformed', 'signature');
  const attestation = validateTaskStartAttestation(s.attestation);
  const bytes = canonicalizeTaskStartAttestation(attestation);
  if (digestOf(bytes) !== s.digest) throw fail('digest', 'digest');
  return { attestation, digest: s.digest, keyId: s.keyId, bytes, signatureBytes: decoded };
}

function readExpected(expected) {
  const e = readPlain(expected, EXPECTED_KEYS, 'invalid_expected', fail);
  for (const field of ['computerId', 'projectId', 'leaseId', 'operationId']) if (!isId(e[field])) throw fail('invalid_expected', field);
  if (!isVmId(e.vmId)) throw fail('invalid_expected', 'vmId');
  for (const field of ['generation', 'leaseGeneration']) if (!isCounter(e[field])) throw fail('invalid_expected', field);
  return e;
}

/**
 * Full check, in this order: shape, TTL and digest, signature (the injected `verify(keyId, bytes, signatureBytes)` must return exactly true), not yet valid, expired, then every binding
 * in `expected` (computerId, generation, leaseGeneration, leaseId, operationId, projectId, vmId), all of which come from the caller's own trusted state. Returns the attestation; whether
 * it is ENOUGH (network none, Production checkpoint) is `provesCheckpointedNoNetwork`, decided by the caller.
 * @param {object} signed
 * @param {{clock: () => number, verify: (keyId: string, bytes: Buffer, signature: Buffer) => boolean, expected: object}} ctx clock returns Unix seconds
 * @throws {TaskStartAttestationError} code invalid_context invalid_expected malformed ttl digest signature not_yet_valid expired binding (field names a fixed field)
 */
export function verifyTaskStartAttestation(signed, ctx) {
  const { clock, verify, expected } = ctx ?? {};
  if (typeof clock !== 'function' || typeof verify !== 'function') throw fail('invalid_context');
  const trusted = readExpected(expected);
  const { attestation, keyId, bytes, signatureBytes } = readSignedTaskStartAttestation(signed);
  let genuine = false;
  try { genuine = verify(keyId, bytes, signatureBytes) === true; } catch { genuine = false; }
  if (!genuine) throw fail('signature', 'signature');
  // The clock is read AFTER the signature check: a slow verifier must not let a statement that expired meanwhile pass.
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw fail('invalid_context', 'clock');
  if (attestation.observedAt > now + MAX_OBSERVED_SKEW_SECONDS) throw fail('not_yet_valid', 'observedAt');
  if (now >= attestation.expiresAt) throw fail('expired', 'expiresAt');
  for (const field of EXPECTED_KEYS) if (attestation[field] !== trusted[field]) throw fail('binding', field);
  return attestation;
}
