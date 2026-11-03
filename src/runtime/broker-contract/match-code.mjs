// Match code v1: the 4 digits that the room and the approver app both show for one approval, so a person can tell they are looking at the same request.
// The C# twin is MatchCode.cs next to the approver app; match-code-vectors.json pins both (including the preimage bytes and the hash).
// Pure: no I/O, no clock, no randomness (node:crypto is used for hashing only). It is a display aid, not an authorization: the approval itself is still the
// digest-bound receipt, and the code reveals nothing the room does not already show.
//
//   H        = SHA-256( UTF8("albera.match-code.v1") 0x00 UTF8(approvalId) 0x00 UTF8(actionDigest) )          32 bytes
//   code     = zero-padded 4 decimal digits of  u32be(H[0..4])  mod 10000
//   decoy k  = u32be(H[4k..4k+4]) mod 10000 for k = 1, 2; while it equals the correct code or an earlier decoy, add 1 (mod 10000). So the 3 values are distinct.
//              No other pending approval's code is ever used as a decoy.
//   order    = Fisher-Yates over [correct, decoy1, decoy2]:  i = 2: j = H[12] mod 3, swap(i, j);  i = 1: j = H[13] mod 2, swap(i, j)
//   choices  = the three values in that order, each as 4 digits;  correctIndex = the position of the correct code
//
// approvalId is a lowercase UUID (8-4-4-4-12 hex digits); actionDigest is "sha256:" + 64 lowercase hex digits. Anything else throws MatchCodeError.
import { createHash } from 'node:crypto';

export const MATCH_CODE_DOMAIN = 'albera.match-code.v1';
export const MATCH_CODE_DIGITS = 4;
export const MATCH_CODE_CHOICES = 3;
const MODULUS = 10 ** MATCH_CODE_DIGITS;
const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACTION_DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

export class MatchCodeError extends Error {
  /** @param {string} field */
  constructor(field) { super('invalid_match_input'); this.name = 'MatchCodeError'; this.code = 'invalid_match_input'; this.field = field; }
}

function requireInputs(approvalId, actionDigest) {
  if (typeof approvalId !== 'string' || !APPROVAL_ID_RE.test(approvalId)) throw new MatchCodeError('approvalId');
  if (typeof actionDigest !== 'string' || !ACTION_DIGEST_RE.test(actionDigest)) throw new MatchCodeError('actionDigest');
}

/** The exact bytes that are hashed. @throws {MatchCodeError} field approvalId | actionDigest */
export function matchCodePreimage(approvalId, actionDigest) {
  requireInputs(approvalId, actionDigest);
  return Buffer.concat([Buffer.from(MATCH_CODE_DOMAIN, 'utf8'), Buffer.of(0), Buffer.from(approvalId, 'utf8'), Buffer.of(0), Buffer.from(actionDigest, 'utf8')]);
}

const hashOf = (approvalId, actionDigest) => createHash('sha256').update(matchCodePreimage(approvalId, actionDigest)).digest();
const digits = (value) => String(value).padStart(MATCH_CODE_DIGITS, '0');

/** @returns {string} the 4-digit code for this approval and action digest. @throws {MatchCodeError} */
export function computeMatchCode(approvalId, actionDigest) {
  return digits(hashOf(approvalId, actionDigest).readUInt32BE(0) % MODULUS);
}

/**
 * The window's three candidates: the correct code and two decoys made from other ranges of the same hash, in a hash-determined order.
 * @returns {Readonly<{ code: string, choices: readonly string[], correctIndex: number }>}
 * @throws {MatchCodeError}
 */
export function computeMatchChoices(approvalId, actionDigest) {
  const hash = hashOf(approvalId, actionDigest);
  const values = [hash.readUInt32BE(0) % MODULUS];
  for (const offset of [4, 8]) {
    let value = hash.readUInt32BE(offset) % MODULUS;
    while (values.includes(value)) value = (value + 1) % MODULUS;
    values.push(value);
  }
  const order = [0, 1, 2]; // 0 is the correct code
  [[2, hash[12] % 3], [1, hash[13] % 2]].forEach(([i, j]) => { [order[i], order[j]] = [order[j], order[i]]; });
  return Object.freeze({ code: digits(values[0]), choices: Object.freeze(order.map((k) => digits(values[k]))), correctIndex: order.indexOf(0) });
}
