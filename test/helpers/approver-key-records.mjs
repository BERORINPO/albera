import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

// Builders for the approver key record files of docs/architecture/approver-webauthn.md ("Wire contract (fixed for phases 2 to 4)"), used by the host installer tests.
// A record is { keyId, kind, alg, publicKey, credentialId? }; its canonical bytes are JSON.stringify of it (the keys in exactly that order, no spaces, UTF-8).
// Every key here is made by Node (the reference crypto), the installer under test is PowerShell, so a rule the installer gets wrong against the contract shows up as a disagreement.

export const spkiDer = (publicKey) => publicKey.export({ type: 'spki', format: 'der' });
/** webauthn- or hello- plus the first 8 bytes of SHA-256 over the SPKI DER, lower-case hex. */
export const keyIdFor = (kind, spki) => `${kind === 'webauthn' ? 'webauthn' : 'hello'}-${createHash('sha256').update(spki).digest('hex').slice(0, 16)}`;

export const ecKey = (namedCurve) => generateKeyPairSync('ec', { namedCurve }).publicKey;
export const rsaKey = (modulusLength) => generateKeyPairSync('rsa', { modulusLength }).publicKey;

// ---- hand-built RSA SPKI (DER), for sizes and shapes that are slow or impossible to make with real keys: the installer checks structure, size and exponent, never primality
const derLength = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]); };
const derInteger = (bytes) => der(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
/** An RSA SubjectPublicKeyInfo around a modulus of exactly `bits` bits (top bit set, odd by default) and the given exponent. */
export function rsaSpkiFromModulus({ bits, exponent = 65537, odd = true } = {}) {
  const modulus = randomBytes(Math.ceil(bits / 8));
  modulus[0] = (modulus[0] & (0xff >> (8 * modulus.length - bits))) | (0x80 >> (8 * modulus.length - bits));
  modulus[modulus.length - 1] = odd ? modulus[modulus.length - 1] | 1 : modulus[modulus.length - 1] & 0xfe;
  const e = Buffer.alloc(4); e.writeUInt32BE(exponent);
  const exponentBytes = e.subarray(e.findIndex((b) => b !== 0));
  const algorithm = der(0x30, Buffer.from('06092a864886f70d010101', 'hex'), Buffer.from('0500', 'hex'));
  return der(0x30, algorithm, der(0x03, Buffer.from([0]), der(0x30, derInteger(modulus), derInteger(exponentBytes))));
}

/** The record object (fields in the contract's order) for an SPKI. `keyId` and `credentialId` can be overridden to make a bad one. */
export function makeRecord({ kind = 'webauthn', alg = -7, spki, credentialId, keyId } = {}) {
  const record = { keyId: keyId ?? keyIdFor(kind, spki), kind, alg, publicKey: spki.toString('base64') };
  if (kind === 'webauthn') record.credentialId = credentialId ?? randomBytes(32).toString('base64url');
  return record;
}
/** The canonical bytes of a record: what `enroll --webauthn` writes and what the installer requires. */
export const canonicalBytes = (record) => Buffer.from(JSON.stringify(record), 'utf8');

// ---- the ready-made good records
export const goodEs256 = () => makeRecord({ kind: 'webauthn', alg: -7, spki: spkiDer(ecKey('prime256v1')) });
export const goodRs256 = (bits = 2048) => makeRecord({ kind: 'webauthn', alg: -257, spki: spkiDer(rsaKey(bits)) });
export const goodHello = () => makeRecord({ kind: 'hello-rsa', alg: -257, spki: spkiDer(rsaKey(2048)) });
