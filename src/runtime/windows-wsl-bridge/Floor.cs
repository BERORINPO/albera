using System.Security.Cryptography;

namespace Albera.WslBridge;

/// <summary>The oldest WSL and kernel a run may start on (ADR-012, decision 12), with an expiry: past it the bridge refuses too, so a forgotten floor cannot go stale in silence.</summary>
internal sealed record Floor(Version MinWsl, Version MinKernel, long ExpiresAt)
{
    /// <summary>null when a run may start, otherwise the refusal word.</summary>
    public string? Check(WslVersions? versions, long now)
    {
        if (versions is null) return Reason.WslUnavailable;
        if (now >= ExpiresAt) return Reason.FloorExpired;
        if (versions.Wsl < MinWsl) return Reason.WslOld;
        return versions.Kernel < MinKernel ? Reason.KernelOld : null;
    }
}

/// <summary>The Broker's public key, pinned in the bridge's config. ECDSA P-256 / SHA-256, r || s (64 bytes), for exactly one key id. Only the public half exists here.</summary>
internal sealed class BrokerKey : IDisposable
{
    private const int SignatureBytes = 64, MaxSpkiBytes = 512;
    private const string NistP256Oid = "1.2.840.10045.3.1.7";
    private readonly string _keyId;
    private readonly ECDsa _key;

    private BrokerKey(string keyId, ECDsa key) { _keyId = keyId; _key = key; }

    /// <summary>null unless <paramref name="spki"/> is exactly one SubjectPublicKeyInfo of a named P-256 public key.</summary>
    public static BrokerKey? TryCreate(string keyId, byte[] spki)
    {
        if (spki.Length is 0 or > MaxSpkiBytes) return null;
        ECDsa ecdsa = ECDsa.Create();
        try
        {
            ecdsa.ImportSubjectPublicKeyInfo(spki, out int read);
            ECCurve curve = ecdsa.ExportParameters(false).Curve;
            if (read == spki.Length && curve.IsNamed && curve.Oid.Value == NistP256Oid) return new BrokerKey(keyId, ecdsa);
        }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException) { }
        ecdsa.Dispose();
        return null;
    }

    public bool Verify(string keyId, byte[] bytes, byte[] signature) =>
        string.Equals(keyId, _keyId, StringComparison.Ordinal) && signature.Length == SignatureBytes
        && _key.VerifyData(bytes, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    public void Dispose() => _key.Dispose();
}
