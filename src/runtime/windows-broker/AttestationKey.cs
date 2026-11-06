using System.Security.Cryptography;

// The Broker's attestation key (ADR-002 Amendment 2026-11-04, "Config additions"; AGM-2). It signs the WSL2 run lease of a newly claimed wsl2 task.start (ADR-012, decision 4).
// The key is a CNG machine key that the installer created: the Broker only OPENS it by name (Microsoft Software Key Storage Provider) and never creates, exports or deletes one.
// ECDSA P-256 only; the signature is the IEEE P1363 pair r || s over SHA-256, which is what the contract's verifiers take.
// A configured key that cannot be opened, is not P-256, or cannot sign a probe ends the start (BROKER_FATAL=ATTESTATION_KEY_UNUSABLE, exit 77): it is never treated as "no key".
// No key configured is the safe fallback: claims work as before and a wsl2 claim's reply has no lease.

/// <summary>The optional config key `attestation`: the CNG key name and the contract id the lease names its signer by.</summary>
internal sealed record AttestationConfig(string KeyName, string KeyId);

/// <summary>An opened key reduced to what the Broker needs: the id it signs under and a signing function over the contract's preimage.</summary>
internal sealed class AttestationSigner(string keyId, Func<byte[], byte[]> sign)
{
    public string KeyId { get; } = keyId;
    public byte[] Sign(byte[] preimage) => sign(preimage);
}

internal static class AttestationKeys
{
    private const int MaxKeyNameLength = 64;
    private static readonly byte[] Probe = "albera.attestation-key.probe"u8.ToArray();

    /// <summary>1 to 64 letters, digits, dots, underscores and hyphens.</summary>
    internal static bool IsKeyName(string name) => name.Length is >= 1 and <= MaxKeyNameLength && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-');

    /// <summary>The signer for the configured key, or null when it cannot be used (never throws for a key problem).</summary>
    internal static AttestationSigner? TryOpen(AttestationConfig config)
    {
        try
        {
            ECDsa? key = OpenKey(config.KeyName);
            if (key is null || key.KeySize != 256) { key?.Dispose(); return null; }
            byte[] Sign(byte[] data) => key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            if (Sign(Probe).Length != 64) return null; // proves now, not at the first claim, that the key can sign
            return new AttestationSigner(config.KeyId, SignerFor(Sign));
        }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException or InvalidOperationException or PlatformNotSupportedException or IOException or UnauthorizedAccessException) { return null; }
    }

#if ALBERA_BROKER_TEST_FAULTS
    // Test-only (never in a shipped build): ALBERA_BROKER_TEST_ATTESTATION_PKCS8 names a PKCS#8 file whose key stands in for the CNG key, so a test needs no machine key and no
    // administrator rights. ALBERA_BROKER_TEST_ATTESTATION_SIGN_FAILS=1 makes the opened key fail on every real signature (the start probe still passes).
    private static ECDsa? OpenKey(string keyName)
    {
        if (Environment.GetEnvironmentVariable("ALBERA_BROKER_TEST_ATTESTATION_PKCS8") is not { Length: > 0 } file) return OpenCng(keyName);
        ECDsa key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(File.ReadAllBytes(file), out _);
        return key;
    }

    private static Func<byte[], byte[]> SignerFor(Func<byte[], byte[]> sign) =>
        Environment.GetEnvironmentVariable("ALBERA_BROKER_TEST_ATTESTATION_SIGN_FAILS") == "1" ? _ => throw new CryptographicException() : sign;
#else
    private static ECDsa? OpenKey(string keyName) => OpenCng(keyName);
    private static Func<byte[], byte[]> SignerFor(Func<byte[], byte[]> sign) => sign;
#endif

    // The production path: an existing machine key of the Microsoft Software Key Storage Provider, opened by name. Never created here.
    private static ECDsa? OpenCng(string keyName)
    {
        CngKey cng = CngKey.Open(keyName, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.MachineKey);
        if (cng.Algorithm != CngAlgorithm.ECDsaP256) { cng.Dispose(); return null; }
        return new ECDsaCng(cng);
    }
}
