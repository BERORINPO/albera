using System.Security.Cryptography;

namespace Albera.ApprovalAuthority;

// The Broker's attestation public key, pinned in the Authority's trusted config (attestationPublicKey + attestationKeyId; issue #115 step 3b). ECDSA P-256 / SHA-256 over the canonical
// attestation bytes, IEEE P1363 (r || s, 64 bytes): the same family as the Authority's own receipt signature. Only the PUBLIC half ever exists here. A statement signed by any other key,
// or under any other key id, does not verify. With no key pinned the Authority never has one of these and every attestation is ignored (the action then needs a person).
internal sealed class PinnedAttestationKey : IDisposable
{
    public const int SignatureBytes = 64, MaxPublicKeyBytes = 512;
    private const string NistP256Oid = "1.2.840.10045.3.1.7";

    private readonly ECDsa key;

    private PinnedAttestationKey(string keyId, ECDsa key)
    {
        KeyId = keyId;
        this.key = key;
    }

    public string KeyId { get; }

    /// <summary>null unless <paramref name="spki"/> is exactly one SubjectPublicKeyInfo of a named ECDSA P-256 public key (no trailing bytes, no explicit curve parameters).</summary>
    public static PinnedAttestationKey? TryCreate(string keyId, byte[] spki)
    {
        if (spki.Length is 0 or > MaxPublicKeyBytes) return null;
        ECDsa ecdsa = ECDsa.Create();
        try
        {
            ecdsa.ImportSubjectPublicKeyInfo(spki, out int read);
            ECCurve curve = ecdsa.ExportParameters(false).Curve;
            if (read == spki.Length && curve.IsNamed && curve.Oid.Value == NistP256Oid) return new PinnedAttestationKey(keyId, ecdsa);
        }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException) { }
        ecdsa.Dispose();
        return null;
    }

    /// <summary>The verifier handed to NetworkAttestation.Verify: true only for the pinned key id and a 64-byte signature of exactly these bytes by the pinned key.</summary>
    public bool Verify(string keyId, byte[] bytes, byte[] signature)
    {
        if (!string.Equals(keyId, KeyId, StringComparison.Ordinal) || signature.Length != SignatureBytes) return false;
        return key.VerifyData(bytes, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    public void Dispose() => key.Dispose();
}
