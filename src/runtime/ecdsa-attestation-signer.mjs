// The production signature scheme for network attestations (issue #115 step 3b): ECDSA P-256 / SHA-256 over the canonical attestation bytes, IEEE P1363 (r || s, 64 bytes),
// the same family as the Approval Authority's receipt signature. Two ports of network-attestation.mjs are implemented here:
//   signer   `{ keyId, sign(bytes) }`                      Broker side. The key is a node KeyObject handed in by the host's configuration code: this file reads no file, no environment
//                                                          variable and no key store, and the repository contains no key. The Hyper-V prototype stays same-user, so the host that
//                                                          builds the Broker passes the key object it loaded (tests pass a freshly generated, in-memory one).
//   verifier `{ keyId, verify(keyId, bytes, signature) }`  the check `verifyNetworkAttestation` takes. The Approval Authority has its own C# twin (PinnedAttestationKey.cs) pinned by the
//                                                          same vectors; this one exists for tests and for any Node-side consumer.
// Both refuse a key that is not an EC P-256 key, and the verifier answers `true` only for a 64-byte signature by the pinned key under the pinned key id.
import { createPublicKey, sign, verify } from 'node:crypto';
import { ID_PATTERN } from './broker-contract/action-digest.mjs';

const ID_RE = new RegExp(ID_PATTERN);
const SIGNATURE_BYTES = 64;
const CURVE = 'prime256v1';

const invalid = () => new TypeError('attestation_key_invalid');

function requireKey(key, type) {
  if (key === null || typeof key !== 'object' || key.type !== type || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== CURVE) throw invalid();
  return key;
}
function requireKeyId(keyId) {
  if (typeof keyId !== 'string' || !ID_RE.test(keyId)) throw invalid();
  return keyId;
}

/**
 * The Broker's signer port for network attestations.
 * @param {{ keyId: string, privateKey: import('node:crypto').KeyObject }} options an EC P-256 private key object from host configuration
 * @returns {{ keyId: string, publicKeySpki: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} `publicKeySpki` is base64 DER SubjectPublicKeyInfo: what the Authority's config pins
 */
export function createEcdsaAttestationSigner({ keyId, privateKey } = {}) {
  requireKeyId(keyId);
  requireKey(privateKey, 'private');
  const publicKeySpki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return Object.freeze({
    keyId,
    publicKeySpki,
    async sign(bytes) { return new Uint8Array(sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' })); },
  });
}

/**
 * The verifier port of `verifyNetworkAttestation` for one pinned key.
 * @param {{ keyId: string, publicKey: import('node:crypto').KeyObject | string }} options a P-256 public key object, or its base64 SPKI
 * @returns {{ keyId: string, verify: (keyId: string, bytes: Uint8Array, signature: Uint8Array) => boolean }}
 */
export function createEcdsaAttestationVerifier({ keyId, publicKey } = {}) {
  requireKeyId(keyId);
  let key;
  try { key = typeof publicKey === 'string' ? createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }) : publicKey; } catch { throw invalid(); }
  requireKey(key, 'public');
  return Object.freeze({
    keyId,
    verify(candidateKeyId, bytes, signature) {
      if (candidateKeyId !== keyId || !(signature instanceof Uint8Array) || signature.length !== SIGNATURE_BYTES) return false;
      try { return verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, signature) === true; } catch { return false; }
    },
  });
}
