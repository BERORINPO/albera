using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;

namespace Albera.Approver;

// The key record of the wire contract (docs/architecture/approver-webauthn.md, "Wire contract"): public data only, one record per approver key.
//   {"keyId":"webauthn-0123456789abcdef","kind":"webauthn","alg":-7,"publicKey":"<base64 SPKI>","credentialId":"<base64url, no padding>"}
//   {"keyId":"hello-951a135537287eae","kind":"hello-rsa","alg":-257,"publicKey":"<base64 SPKI>"}
// The canonical bytes are that JSON with the keys in exactly this order, no spaces, UTF-8, credentialId left out for hello-rsa. The record file written by `enroll --webauthn` holds exactly these bytes (the installer pins the key from it).
// Only PUBLIC key material is ever created or imported in this file (RSA / ECDsa objects built from a public SPKI or public parameters); there is no key generation and no export of a private key.

/// <summary>Base64url without padding, the form of credential ids and challenges. Decoding accepts only the canonical spelling.</summary>
internal static class B64
{
    public static string Url(ReadOnlySpan<byte> data) => Base64Url.EncodeToString(data);

    public static byte[]? TryFromUrl(string text)
    {
        try
        {
            byte[] bytes = Base64Url.DecodeFromChars(text);
            return Url(bytes) == text ? bytes : null;
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException) { return null; }
    }
}

internal static class KeyFailure
{
    /// <summary>What the platform crypto throws for a key it cannot use: a malformed or off-curve key is a CryptographicException, or on Windows a PlatformNotSupportedException ("the specified curve or its parameters are not valid"), or an ArgumentException. Found by a test with an off-curve point.</summary>
    public static bool IsKeyFailure(this Exception ex) => ex is CryptographicException or PlatformNotSupportedException or ArgumentException;
}

/// <summary>What a public key (SPKI, DER) is: a P-256 EC key, or an RSA key of some size. null for anything else, for trailing bytes after the SPKI, and for an unparseable key.</summary>
internal readonly record struct PublicKeyShape(bool IsP256, int RsaBits)
{
    private const string NistP256Oid = "1.2.840.10045.3.1.7";

    public static PublicKeyShape? Classify(byte[] spki)
    {
        try
        {
            using RSA rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(spki, out int rsaRead);
            return rsaRead == spki.Length ? new PublicKeyShape(false, rsa.KeySize) : null;
        }
        catch (Exception ex) when (ex.IsKeyFailure()) { }
        try
        {
            using ECDsa ec = ECDsa.Create();
            ec.ImportSubjectPublicKeyInfo(spki, out int ecRead);
            ECCurve curve = ec.ExportParameters(false).Curve;
            return ecRead == spki.Length && ec.KeySize == 256 && curve.IsNamed && (curve.Oid.Value == NistP256Oid || curve.Oid.FriendlyName is "nistP256" or "ECDSA_P256") ? new PublicKeyShape(true, 0) : null;
        }
        catch (Exception ex) when (ex.IsKeyFailure()) { return null; }
    }
}

internal sealed record ApproverKeyRecord(string KeyId, string Kind, int Alg, byte[] PublicKey, byte[]? CredentialId)
{
    public const string WebAuthnKind = "webauthn", HelloKind = "hello-rsa";
    public const int Es256 = -7, Rs256 = -257, MaxCredentialIdBytes = 1023, MaxRsaBits = 4096;

    /// <summary>A record whose fields agree with each other and with the contract (key type for the alg, RSA size, credential id length, key id derived from the SPKI), or null. The approver never makes a record the Authority would refuse.</summary>
    public static ApproverKeyRecord? TryCreate(string kind, int alg, byte[] spki, byte[]? credentialId)
    {
        if (PublicKeyShape.Classify(spki) is not { } shape) return null;
        bool consistent = (kind, alg) switch
        {
            (WebAuthnKind, Es256) => shape.IsP256,
            (WebAuthnKind, Rs256) => !shape.IsP256 && shape.RsaBits is >= 2048 and <= MaxRsaBits,
            (HelloKind, Rs256) => !shape.IsP256 && shape.RsaBits == 2048,
            _ => false,
        };
        if (!consistent || (kind == WebAuthnKind) != (credentialId is not null) || credentialId is { Length: < 1 or > MaxCredentialIdBytes }) return null;
        return new ApproverKeyRecord(ApproverKeyId.Of(kind == WebAuthnKind ? "webauthn" : "hello", spki), kind, alg, spki, credentialId);
    }

    /// <summary>The canonical bytes: the keys in the contract's order, no spaces, UTF-8.</summary>
    public byte[] CanonicalBytes()
    {
        string tail = CredentialId is null ? "" : $",\"credentialId\":\"{B64.Url(CredentialId)}\"";
        return Encoding.UTF8.GetBytes($"{{\"keyId\":\"{KeyId}\",\"kind\":\"{Kind}\",\"alg\":{Alg},\"publicKey\":\"{Convert.ToBase64String(PublicKey)}\"{tail}}}");
    }
}

// The public key inside a WebAuthn attestation: a COSE_Key (RFC 9052) CBOR map. Read strictly: definite lengths only, integer keys, integer or byte-string values, no duplicate key, no extra key, exact sizes.
//   EC2 / ES256:  {1: 2, 3: -7, -1: 1 (P-256), -2: x (32 bytes), -3: y (32 bytes)}
//   RSA / RS256:  {1: 3, 3: -257, -1: n (256..512 bytes, no leading zero), -2: e (1..8 bytes)}
// The result is the SPKI (DER) of a PUBLIC key built from those numbers; a point that is not on the curve, or a modulus that is not a valid RSA key, is refused by the platform crypto and gives null.
internal static class CoseKey
{
    private const int MaxEntries = 8;

    /// <summary>Reads one COSE_Key at <paramref name="position"/> and moves past it. null on any deviation (position is then undefined).</summary>
    public static (int Alg, byte[] Spki)? TryRead(byte[] data, ref int position)
    {
        if (!TryHead(data, ref position, out int major, out long count) || major != 5 || count is < 1 or > MaxEntries) return null;
        Dictionary<long, long> numbers = [];
        Dictionary<long, byte[]> strings = [];
        for (long i = 0; i < count; i++)
        {
            if (!TryHead(data, ref position, out int keyMajor, out long keyValue) || keyMajor is not (0 or 1)) return null;
            long key = keyMajor == 0 ? keyValue : -1 - keyValue;
            if (numbers.ContainsKey(key) || strings.ContainsKey(key) || !TryHead(data, ref position, out int valueMajor, out long value)) return null;
            if (valueMajor is 0 or 1) numbers[key] = valueMajor == 0 ? value : -1 - value;
            else if (valueMajor == 2 && value <= data.Length - position)
            {
                strings[key] = data[position..(position + (int)value)];
                position += (int)value;
            }
            else return null;
        }
        return numbers.GetValueOrDefault(1, -1) switch
        {
            2 => Ec2(numbers, strings),
            3 => Rsa(numbers, strings),
            _ => null,
        };
    }

    private static (int, byte[])? Ec2(Dictionary<long, long> numbers, Dictionary<long, byte[]> strings)
    {
        if (numbers.Count != 3 || strings.Count != 2 || numbers.GetValueOrDefault(3) != ApproverKeyRecord.Es256 || numbers.GetValueOrDefault(-1) != 1) return null;
        if (!strings.TryGetValue(-2, out byte[]? x) || !strings.TryGetValue(-3, out byte[]? y) || x.Length != 32 || y.Length != 32) return null;
        try
        {
            using ECDsa ec = ECDsa.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = x, Y = y } });
            return (ApproverKeyRecord.Es256, ec.ExportSubjectPublicKeyInfo());
        }
        catch (Exception ex) when (ex.IsKeyFailure()) { return null; }
    }

    private static (int, byte[])? Rsa(Dictionary<long, long> numbers, Dictionary<long, byte[]> strings)
    {
        if (numbers.Count != 2 || strings.Count != 2 || numbers.GetValueOrDefault(3) != ApproverKeyRecord.Rs256) return null;
        if (!strings.TryGetValue(-1, out byte[]? n) || !strings.TryGetValue(-2, out byte[]? e) || n.Length is < 256 or > 512 || n[0] == 0 || e.Length is < 1 or > 8) return null;
        try
        {
            using RSA rsa = RSA.Create(new RSAParameters { Modulus = n, Exponent = e });
            return (ApproverKeyRecord.Rs256, rsa.ExportSubjectPublicKeyInfo());
        }
        catch (Exception ex) when (ex.IsKeyFailure()) { return null; }
    }

    // One CBOR item head: major type and the argument (the length, or the integer). Indefinite lengths and reserved values are refused; so is an 8-byte argument above long.MaxValue.
    private static bool TryHead(byte[] data, ref int position, out int major, out long value)
    {
        major = 0;
        value = 0;
        if (position >= data.Length) return false;
        byte head = data[position++];
        major = head >> 5;
        int info = head & 31;
        if (info < 24)
        {
            value = info;
            return true;
        }
        int width = info switch { 24 => 1, 25 => 2, 26 => 4, 27 => 8, _ => 0 };
        if (width == 0 || position + width > data.Length) return false;
        for (int i = 0; i < width; i++) value = (value << 8) | data[position++];
        return value >= 0;
    }
}
