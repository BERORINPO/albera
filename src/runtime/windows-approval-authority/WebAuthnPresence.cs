using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Albera.ApprovalAuthority;

// WebAuthn presence (docs/architecture/approver-webauthn.md, phase 2). The approver asks an authenticator (Windows Hello on the host or on the PC the owner connects from, a phone, a
// security key) to sign the presence message through WebAuthn. The Authority never sees the client data: it rebuilds the exact bytes from its own message, so an assertion can only
// verify for the entry it was made for. Pure BCL, no OS dependency, and nothing here throws on bad input: every malformed proof is a Mismatch.
//
// A proof is Verified only if all of these hold (rule numbers are the design document's):
//   1. the credential id names a registered webauthn key (the set looks it up; Verify below also checks it against the key it was handed),
//   2. authenticatorData is exactly 37 bytes, starts with SHA-256 of the rp id, has user present (0x01) and user verified (0x04) set, and attested data (0x40) and extensions (0x80) clear,
//   3. the signature verifies over authenticatorData || SHA-256(clientData) with the algorithm the key was registered with: ES256 (P-256, ASN.1 DER signature) or RS256 (RSA 2048..4096,
//      PKCS#1 v1.5, SHA-256), and
//   4. the sign count rule, which needs the count last seen for that key and is therefore the key set's (ApproverKeys.cs).
internal static class WebAuthn
{
    public const string RpId = "approver.albera.local", Origin = "albera://approver";
    public const int AuthenticatorDataBytes = 37, MaxCredentialIdBytes = 1023, MaxSignatureBytes = 512, MaxAuthenticatorDataBytes = 255;
    private const byte FlagUserPresent = 0x01, FlagUserVerified = 0x04, FlagAttestedData = 0x40, FlagExtensions = 0x80;
    private const int FlagsOffset = 32, SignCountOffset = 33;
    private static readonly byte[] RpIdHash = SHA256.HashData(Encoding.UTF8.GetBytes(RpId));

    /// <summary>The client data the approver must have signed over, as exact bytes (UTF-8, no spaces): the challenge is base64url(SHA-256(message)) with no padding.</summary>
    public static byte[] ClientData(ReadOnlySpan<byte> message) =>
        Encoding.UTF8.GetBytes($"{{\"type\":\"webauthn.get\",\"challenge\":\"{Base64Text.EncodeUrl(SHA256.HashData(message))}\",\"origin\":\"{Origin}\",\"crossOrigin\":false}}");

    /// <summary>Rules 1 to 3 for one key. <paramref name="signCount"/> is what the authenticator reported (meaningful only when the result is Verified).</summary>
    public static PresenceResult Verify(ApproverKey key, WebAuthnAssertion assertion, ReadOnlySpan<byte> message, out uint signCount)
    {
        signCount = 0;
        if (key.Kind != ApproverKeyKind.WebAuthn || key.CredentialId is null || !assertion.CredentialId.AsSpan().SequenceEqual(key.CredentialId)) return PresenceResult.Mismatch;
        byte[] data = assertion.AuthenticatorData;
        if (data.Length != AuthenticatorDataBytes || !data.AsSpan(0, RpIdHash.Length).SequenceEqual(RpIdHash)) return PresenceResult.Mismatch;
        byte flags = data[FlagsOffset];
        if ((flags & FlagUserPresent) == 0 || (flags & FlagUserVerified) == 0 || (flags & (FlagAttestedData | FlagExtensions)) != 0) return PresenceResult.Mismatch;
        byte[] signed = [.. data, .. SHA256.HashData(ClientData(message))];
        if (!SignatureVerifies(key, signed, assertion.Signature)) return PresenceResult.Mismatch;
        signCount = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(SignCountOffset, 4));
        return PresenceResult.Verified;
    }

    private static bool SignatureVerifies(ApproverKey key, byte[] signed, byte[] signature)
    {
        if (signature.Length is 0 or > MaxSignatureBytes) return false;
        try
        {
            if (key.Alg == WebAuthnAlgorithms.Es256)
            {
                using ECDsa ecdsa = ECDsa.Create();
                ecdsa.ImportSubjectPublicKeyInfo(key.PublicKey, out _);
                return ecdsa.VerifyData(signed, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
            }
            if (key.Alg != WebAuthnAlgorithms.Rs256) return false;
            using RSA rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(key.PublicKey, out _);
            return rsa.VerifyData(signed, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException) { return false; }
    }
}

/// <summary>The algorithms a webauthn key may be registered with (COSE numbers, as in a key record), and what a public key must be to count as one.</summary>
internal static class WebAuthnAlgorithms
{
    public const int Es256 = -7, Rs256 = -257;
    public const int MinRsaBits = 2048, MaxRsaBits = 4096, MaxPublicKeyBytes = 600;
    private const string NistP256Oid = "1.2.840.10045.3.1.7";

    /// <summary>True only when <paramref name="spki"/> is exactly one SubjectPublicKeyInfo of the kind <paramref name="alg"/> names: a named P-256 key for ES256, an RSA key of 2048 to 4096 bits for RS256.</summary>
    public static bool Accepts(long alg, byte[] spki)
    {
        if (spki.Length is 0 or > MaxPublicKeyBytes) return false;
        try
        {
            if (alg == Es256)
            {
                using ECDsa ecdsa = ECDsa.Create();
                ecdsa.ImportSubjectPublicKeyInfo(spki, out int read);
                ECCurve curve = ecdsa.ExportParameters(false).Curve;
                return read == spki.Length && curve.IsNamed && curve.Oid.Value == NistP256Oid;
            }
            if (alg != Rs256) return false;
            using RSA rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(spki, out int used);
            return used == spki.Length && rsa.KeySize is >= MinRsaBits and <= MaxRsaBits;
        }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException) { return false; }
    }

}

internal sealed record WebAuthnAssertion(byte[] CredentialId, byte[] AuthenticatorData, byte[] Signature);

// The one byte string the Authority core passes around as a "proof" (it only knows byte[] proofs: the RSA form is the raw 256-byte signature, unchanged). A webauthn assertion is packed as
//   "ALBWA1" | u16 (big endian) credentialId length | credentialId | u8 authenticatorData length | authenticatorData | u16 (big endian) signature length | signature
// with nothing after it. The verifier tells the two forms apart by the 6-byte magic: a raw RSA signature that happens to start with it (2^-48) is read as a webauthn proof and is a Mismatch,
// which fails safe. The same bytes are what policy.json stores (base64) as the proof that authorized a policy.
internal static class WebAuthnProof
{
    private static readonly byte[] Magic = "ALBWA1"u8.ToArray();

    public static bool IsWebAuthn(ReadOnlySpan<byte> proof) => proof.StartsWith(Magic);

    public static byte[] Encode(WebAuthnAssertion a) =>
        [.. Magic, (byte)(a.CredentialId.Length >> 8), (byte)a.CredentialId.Length, .. a.CredentialId, (byte)a.AuthenticatorData.Length, .. a.AuthenticatorData,
            (byte)(a.Signature.Length >> 8), (byte)a.Signature.Length, .. a.Signature];

    /// <returns>false for anything that is not exactly one packed assertion</returns>
    public static bool TryDecode(ReadOnlySpan<byte> proof, out WebAuthnAssertion assertion)
    {
        assertion = new([], [], []);
        if (!IsWebAuthn(proof)) return false;
        ReadOnlySpan<byte> rest = proof[Magic.Length..];
        if (!Take(ref rest, 2, out ReadOnlySpan<byte> credentialId) || !Take(ref rest, 1, out ReadOnlySpan<byte> authenticatorData) || !Take(ref rest, 2, out ReadOnlySpan<byte> signature) || rest.Length != 0) return false;
        assertion = new(credentialId.ToArray(), authenticatorData.ToArray(), signature.ToArray());
        return true;
    }

    // A field with a 1- or 2-byte big-endian length in front of it.
    private static bool Take(ref ReadOnlySpan<byte> rest, int lengthBytes, out ReadOnlySpan<byte> field)
    {
        field = default;
        if (rest.Length < lengthBytes) return false;
        int length = lengthBytes == 1 ? rest[0] : (rest[0] << 8) | rest[1];
        if (rest.Length < lengthBytes + length) return false;
        field = rest.Slice(lengthBytes, length);
        rest = rest[(lengthBytes + length)..];
        return true;
    }
}

// The JSON shape of a webauthn proof on the approver pipe (decide, policy_set, key_remove):
//   {"kind":"webauthn","credentialId":"<base64url>","authenticatorData":"<base64>","signature":"<base64>"}
// Exactly these four keys; base64 is canonical (no whitespace, no stray bits). A shape error is the caller's request_invalid; whether the assertion is any good is the verifier's business.
internal static class WebAuthnWire
{
    public static bool TryRead(IReadOnlyDictionary<string, object> fields, out byte[] proof)
    {
        proof = [];
        if (fields.Count != 4 || fields.GetValueOrDefault("kind") as string != "webauthn" ||
            fields.GetValueOrDefault("credentialId") is not string credentialText || !Base64Text.TryDecodeUrl(credentialText, WebAuthn.MaxCredentialIdBytes, out byte[] credentialId) ||
            fields.GetValueOrDefault("authenticatorData") is not string dataText || !Base64Text.TryDecode(dataText, WebAuthn.MaxAuthenticatorDataBytes, out byte[] data) ||
            fields.GetValueOrDefault("signature") is not string signatureText || !Base64Text.TryDecode(signatureText, WebAuthn.MaxSignatureBytes, out byte[] signature)) return false;
        proof = WebAuthnProof.Encode(new WebAuthnAssertion(credentialId, data, signature));
        return true;
    }
}

/// <summary>Canonical base64: the alphabet only, no whitespace, no non-zero stray bits. (Convert.TryFromBase64String alone skips whitespace and accepts non-canonical tails.)</summary>
internal static class Base64Text
{
    public static string EncodeUrl(ReadOnlySpan<byte> bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Standard base64 with padding, as Convert.ToBase64String writes it.</summary>
    public static bool TryDecode(string text, int maxBytes, out byte[] bytes)
    {
        bytes = [];
        if (text.Length == 0 || text.Length % 4 != 0 || text.Length > (maxBytes + 2) / 3 * 4 || !text.All(c => char.IsAsciiLetterOrDigit(c) || c is '+' or '/' or '=')) return false;
        byte[] buffer = new byte[text.Length / 4 * 3];
        if (!Convert.TryFromBase64String(text, buffer, out int written) || written > maxBytes) return false;
        byte[] decoded = buffer[..written];
        if (!string.Equals(Convert.ToBase64String(decoded), text, StringComparison.Ordinal)) return false;
        bytes = decoded;
        return true;
    }

    /// <summary>base64url without padding (what a credential id is on the wire).</summary>
    public static bool TryDecodeUrl(string text, int maxBytes, out byte[] bytes)
    {
        bytes = [];
        if (text.Length == 0 || text.Length % 4 == 1 || !text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) return false;
        string standard = text.Replace('-', '+').Replace('_', '/') + new string('=', (4 - text.Length % 4) % 4);
        return TryDecode(standard, maxBytes, out bytes);
    }
}
