// Test Approval Authority for the Host Broker (ADR-002 "Receipt v2", Proposed). TEST ONLY: an ephemeral ECDSA P-256 key the test pins in the Broker's
// `authorityKeys`, plus a builder for complete v2 receipts. It signs whatever it is asked to sign; it is not the real Authority (src/runtime/approval-authority).
// Imported by test/helpers/windows-broker-harness.mjs and scripts/windows-service-lab-inputs.mjs; there is no command line.
//
// Issuers: the production Broker accepts only PRODUCTION_ISSUER. TEST_ISSUER (`albera-test-*`) is accepted only by the AlberaBrokerTestFaults build, so a
// test that builds the shipped Broker signs with PRODUCTION_ISSUER (the key is what makes it valid), and a test of the refusal signs with TEST_ISSUER.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';

export const PRODUCTION_ISSUER = 'albera-approval-authority';
export const TEST_ISSUER = 'albera-test-approval-authority';
export const BROKER_AUDIENCE = 'albera-host-broker';
/** What the tests configure the Broker with (`leaseId` / `policyVersion` of its service config). A receipt takes `leaseId` from the fence reply, as the Control Plane does. */
export const SYNTHETIC_LEASE_ID = 'test-lease';
export const SYNTHETIC_POLICY_VERSION = 'test-policy-v1';

/** A key pair plus its pinned form. `sign` returns the base64 IEEE P1363 signature the Broker verifies over the exact receipt bytes. */
export function createTestAuthority({ kid = 'test-authority-1' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return Object.freeze({
    kid,
    spki,
    /** The `authorityKeys` entry of the service config. */
    keyEntry: Object.freeze({ kid, spki }),
    /** The `kid=spki` form of the one-shot `serve` command line. */
    serveArgument: `${kid}=${spki}`,
    sign: (receiptBytes) => sign('sha256', Buffer.from(receiptBytes), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
    /** Private key as a JWK ({ x, y, d } base64url): the VM lab signs inside the guest from it, so the key never has to be a file the guest trusts. */
    privateJwk: () => privateKey.export({ format: 'jwk' }),
  });
}

/** A lowercase v4-shaped UUID derived from a name, so a test can name an id ("dup-receipt") and get the same grammar-valid value every time. */
export function stableUuid(name) {
  const bytes = createHash('sha256').update(String(name)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const randomNonce = () => randomBytes(16).toString('base64url');

/**
 * The 22 fields of a v2 receipt (by default for the Broker's fixed `synthetic.noop` action; `args` is the DTO's args map for any other). `fence` is the Broker's fence reply
 * ({ brokerEpoch, leaseGeneration, brokerChallenge }); `name` makes the ids (approvalId, receiptId, operationId, idempotencyKey) readable and repeatable.
 * `overrides` replace any field after the defaults, and `actionDigest` is recomputed from the final action / project / computer unless it is overridden.
 */
export function buildReceiptFields({
  authority, fence, name, now = Math.floor(Date.now() / 1000), ttlSeconds = 120, issuer = PRODUCTION_ISSUER, computerId = 'computer-1', projectId = 'project-1', args = {}, ...overrides
}) {
  const fields = {
    v: 2,
    kid: authority.kid,
    issuer,
    audience: BROKER_AUDIENCE,
    purpose: 'broker.operation',
    approvalId: stableUuid(`${name}-approval`),
    receiptId: stableUuid(`${name}-receipt`),
    nonce: randomNonce(),
    operationId: `${name}-op`,
    idempotencyKey: `idem-${name}`,
    action: 'synthetic.noop',
    actionDigest: '',
    projectId,
    computerId,
    leaseId: fence.leaseId ?? SYNTHETIC_LEASE_ID,
    leaseGeneration: fence.leaseGeneration,
    brokerEpoch: fence.brokerEpoch,
    brokerChallenge: fence.brokerChallenge,
    policyVersion: SYNTHETIC_POLICY_VERSION,
    approverKeyId: 'test-approver-1',
    iat: now,
    exp: now + ttlSeconds,
    ...overrides,
  };
  if (overrides.actionDigest === undefined) {
    fields.actionDigest = computeActionDigest(fields.purpose, { action: fields.action, projectId: fields.projectId, computerId: fields.computerId, args });
  }
  return fields;
}

/** Build and sign: `{ receipt, signature }` (both base64), the Broker's claim request body. Never mutates its input. */
export function signedReceipt(options) {
  const bytes = Buffer.from(JSON.stringify(buildReceiptFields(options)), 'utf8');
  return { receipt: bytes.toString('base64'), signature: options.authority.sign(bytes) };
}
