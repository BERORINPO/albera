// FAKE signer for network attestations (#115 step 2). It stands in for the Broker host's signer port `{ keyId, sign(bytes) }` and the verifier's `verify(keyId, bytes, signature)`
// in tests. It uses HMAC-SHA256 with a random per-instance secret that exists only in memory: no key material is stored or shipped, and a symmetric MAC is a test device,
// not the production signature scheme: the real one is ECDSA P-256 (ecdsa-attestation-signer.mjs; the Authority verifies with the public half it pins in its config).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** @param {{ keyId?: string, secret?: Uint8Array }} [options] */
export function createFakeAttestationSigner({ keyId = 'albera-test-broker-1', secret = randomBytes(32) } = {}) {
  const mac = (bytes) => createHmac('sha256', secret).update(bytes).digest();
  return Object.freeze({
    keyId,
    async sign(bytes) { return new Uint8Array(mac(bytes)); },
    /** Matches the verifier port of verifyNetworkAttestation: exactly the signer's own key id and a MAC over exactly these bytes. */
    verify(candidateKeyId, bytes, signature) {
      const expected = mac(bytes);
      return candidateKeyId === keyId && signature.length === expected.length && timingSafeEqual(expected, signature);
    },
  });
}
