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

/** Every record-file case: the bytes of a file and the exact reasons the installer must give (null = valid). `anyOf` where a PowerShell parser detail decides which of two words comes out. */
export function approverRecordCases() {
  const es = goodEs256();
  const text = (record) => JSON.stringify(record);
  const swap = (record, from, to) => Buffer.from(text(record).replace(from, to), 'utf8');
  const withHash = (kind, alg, spki, extra = {}) => ({ ...makeRecord({ kind, alg, spki }), ...extra });
  const rsa2048 = spkiDer(rsaKey(2048));
  const edSpki = spkiDer(ecKey('prime256v1'));
  const offCurve = Buffer.from(edSpki); offCurve[offCurve.length - 1] ^= 0x01;   // one bit of Y flipped: the point is no longer on the curve
  const bytes = (record) => canonicalBytes(record);
  const cases = [
    // valid
    { name: 'es256', bytes: bytes(es), reasons: null },
    { name: 'rs256_2048', bytes: bytes(makeRecord({ alg: -257, spki: rsa2048 })), reasons: null },
    { name: 'rs256_3072', bytes: bytes(goodRs256(3072)), reasons: null },
    { name: 'rs256_4096_edge', bytes: bytes(makeRecord({ alg: -257, spki: rsaSpkiFromModulus({ bits: 4096 }) })), reasons: null },
    { name: 'hello_2048', bytes: bytes(goodHello()), reasons: null },
    { name: 'credential_1023_bytes', bytes: bytes(makeRecord({ spki: edSpki, credentialId: Buffer.alloc(1023, 7).toString('base64url') })), reasons: null },
    { name: 'credential_1_byte', bytes: bytes(makeRecord({ spki: edSpki, credentialId: Buffer.from([9]).toString('base64url') })), reasons: null },
    // the key id and the key
    { name: 'wrong_key_id', bytes: bytes({ ...es, keyId: `${es.keyId.slice(0, -1)}${es.keyId.endsWith('0') ? '1' : '0'}` }), reasons: ['record_key_id_mismatch'] },
    { name: 'webauthn_with_hello_prefix', bytes: bytes({ ...es, keyId: keyIdFor('hello-rsa', Buffer.from(es.publicKey, 'base64')) }), reasons: ['record_key_id_form', 'record_key_id_mismatch'] },
    { name: 'hello_with_webauthn_prefix', bytes: bytes({ ...goodHello(), keyId: 'webauthn-0123456789abcdef' }), reasons: ['record_key_id_form', 'record_key_id_mismatch'] },
    { name: 'key_id_upper_case', bytes: bytes({ ...es, keyId: es.keyId.toUpperCase().replace('WEBAUTHN-', 'webauthn-') }), reasons: ['record_key_id_form', 'record_key_id_mismatch'] },
    { name: 'wrong_curve_p384', bytes: bytes(withHash('webauthn', -7, spkiDer(ecKey('secp384r1')))), reasons: ['record_curve'] },
    { name: 'wrong_curve_k1', bytes: bytes(withHash('webauthn', -7, spkiDer(ecKey('secp256k1')))), reasons: ['record_curve'] },
    { name: 'point_not_on_curve', bytes: bytes(withHash('webauthn', -7, offCurve)), reasons: ['record_point_not_on_curve'] },
    { name: 'rsa_1024', bytes: bytes(withHash('webauthn', -257, rsaSpkiFromModulus({ bits: 1024 }))), reasons: ['record_rsa_size'] },
    { name: 'rsa_2047', bytes: bytes(withHash('webauthn', -257, rsaSpkiFromModulus({ bits: 2047 }))), reasons: ['record_rsa_size'] },
    { name: 'rsa_4104', bytes: bytes(withHash('webauthn', -257, rsaSpkiFromModulus({ bits: 4104 }))), reasons: ['record_rsa_size'] },
    { name: 'hello_rsa_3072', bytes: bytes(withHash('hello-rsa', -257, spkiDer(rsaKey(3072)))), reasons: ['record_rsa_size'] },
    { name: 'rsa_exponent_3', bytes: bytes(withHash('webauthn', -257, rsaSpkiFromModulus({ bits: 2048, exponent: 3 }))), reasons: ['record_rsa_exponent'] },
    { name: 'rsa_even_modulus', bytes: bytes(withHash('webauthn', -257, rsaSpkiFromModulus({ bits: 2048, odd: false }))), reasons: ['record_public_key_not_rsa'] },
    { name: 'ec_key_with_rs256', bytes: bytes(withHash('webauthn', -257, edSpki)), reasons: ['record_public_key_not_rsa'] },
    { name: 'rsa_key_with_es256', bytes: bytes(withHash('webauthn', -7, rsa2048)), reasons: ['record_curve'] },
    { name: 'alg_eddsa', bytes: bytes({ ...es, alg: -8 }), reasons: ['record_alg'] },
    { name: 'hello_with_es256', bytes: bytes(withHash('hello-rsa', -7, rsa2048)), reasons: ['record_alg', 'record_curve'] },
    { name: 'public_key_without_padding', bytes: bytes({ ...es, publicKey: Buffer.from(es.publicKey, 'base64').toString('base64url') }), reasons: ['record_public_key_encoding'] },
    // the credential id
    { name: 'credential_empty', bytes: bytes({ ...es, credentialId: '' }), reasons: ['record_credential_id_length'] },
    { name: 'credential_1024_bytes', bytes: bytes({ ...es, credentialId: Buffer.alloc(1024, 7).toString('base64url') }), reasons: ['record_credential_id_length'] },
    { name: 'credential_padded', bytes: bytes({ ...es, credentialId: `${Buffer.alloc(31, 7).toString('base64url')}=` }), reasons: ['record_credential_id_form'] },
    { name: 'credential_standard_alphabet', bytes: bytes({ ...es, credentialId: 'ab+d/f' }), reasons: ['record_credential_id_form'] },
    { name: 'credential_stray_bits', bytes: bytes({ ...es, credentialId: 'AB' }), reasons: ['record_credential_id_form'] },
    { name: 'credential_length_1_mod_4', bytes: bytes({ ...es, credentialId: 'AAAAA' }), reasons: ['record_credential_id_form'] },
    { name: 'credential_not_a_string', bytes: Buffer.from(text(es).replace(/"credentialId":"[^"]*"/u, '"credentialId":7')), reasons: ['record_field_types'] },
    // fields
    { name: 'extra_field', bytes: bytes({ ...es, extra: 1 }), reasons: ['record_fields'] },
    { name: 'webauthn_without_credential', bytes: bytes((({ credentialId, ...rest }) => rest)(es)), reasons: ['record_fields'] },
    { name: 'hello_with_credential', bytes: bytes({ ...goodHello(), credentialId: 'AAAA' }), reasons: ['record_fields'] },
    { name: 'missing_alg', bytes: bytes((({ alg, ...rest }) => rest)(es)), reasons: ['record_fields'] },
    { name: 'kind_unknown', bytes: bytes({ ...es, kind: 'fido' }), reasons: ['record_kind'] },
    { name: 'alg_as_string', bytes: bytes({ ...es, alg: '-7' }), reasons: ['record_field_types'] },
    { name: 'alg_with_fraction', bytes: Buffer.from(text(es).replace('"alg":-7', '"alg":-7.5')), reasons: ['record_field_types'] },
    { name: 'key_id_null', bytes: bytes({ ...es, keyId: null }), reasons: ['record_field_types'] },
    // canonical bytes
    { name: 'pretty_printed', bytes: Buffer.from(JSON.stringify(es, null, 2)), reasons: ['record_not_canonical'] },
    { name: 'trailing_newline', bytes: Buffer.from(`${text(es)}\n`), reasons: ['record_not_canonical'] },
    { name: 'trailing_crlf', bytes: Buffer.from(`${text(es)}\r\n`), reasons: ['record_not_canonical'] },
    { name: 'leading_space', bytes: Buffer.from(` ${text(es)}`), reasons: ['record_not_canonical'] },
    { name: 'keys_reordered', bytes: bytes({ alg: es.alg, keyId: es.keyId, kind: es.kind, publicKey: es.publicKey, credentialId: es.credentialId }), reasons: ['record_not_canonical'] },
    { name: 'unicode_escape', bytes: swap(es, '"kind":"webauthn"', '"kind":"webauth\\u006e"'), reasons: ['record_not_canonical'] },
    { name: 'repeated_key', bytes: swap(es, `{"keyId":"${es.keyId}",`, `{"keyId":"${es.keyId}","keyId":"${es.keyId}",`), anyOf: ['record_not_canonical', 'record_syntax'] },
    { name: 'byte_order_mark', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(es)]), reasons: ['record_bom'] },
    { name: 'invalid_utf8', bytes: Buffer.from([0x7b, 0xff, 0xfe, 0xfd, 0x7d]), reasons: ['record_not_utf8'] },
    { name: 'utf16_file', bytes: Buffer.from(text(es), 'utf16le'), anyOf: ['record_syntax', 'record_not_utf8'] },
    // one record per file
    { name: 'array_of_one', bytes: Buffer.from(`[${text(es)}]`), reasons: ['record_not_one_object'] },
    { name: 'two_records_in_a_row', bytes: Buffer.from(`${text(es)}${text(goodEs256())}`), reasons: ['record_syntax'] },
    { name: 'two_records_on_two_lines', bytes: Buffer.from(`${text(es)}\n${text(goodEs256())}`), reasons: ['record_syntax'] },
    { name: 'json_null', bytes: Buffer.from('null'), reasons: ['record_not_one_object'] },
    { name: 'json_string', bytes: Buffer.from('"x"'), reasons: ['record_not_one_object'] },
    { name: 'not_json', bytes: Buffer.from('not json'), reasons: ['record_syntax'] },
    { name: 'empty_file', bytes: Buffer.alloc(0), reasons: ['record_empty'] },
    { name: 'file_too_large', bytes: Buffer.alloc(5000, 0x20), reasons: ['record_too_large'] },
  ];
  return cases;
}
