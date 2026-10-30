using System.Security.Cryptography;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal sealed class SignerUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Signs the exact receipt bytes. ECDSA P-256 / SHA-256, IEEE P1363 (r || s, 64 bytes), as the Broker verifies.</summary>
internal interface IReceiptSigner
{
    /// <summary>The receipt `issuer`: the production issuer for the real key, a test issuer (rejected by production validation) for fakes.</summary>
    string Issuer { get; }

    /// <exception cref="SignerUnavailableException">the key cannot be used right now</exception>
    byte[] Sign(ReadOnlySpan<byte> receipt);
}

// The real signer: a PERSISTED, named ECDSA P-256 key in the machine key store (NCRYPT_MACHINE_KEY_FLAG = CngKeyOpenOptions.MachineKey), in the
// software KSP or the TPM's Platform Crypto Provider. It only OPENS an existing key. It never creates, exports or imports one: creating the key (and
// restricting its ACL to the service account) is the installer's job, outside this process. A missing, foreign or wrong-algorithm key is
// SignerUnavailableException, which the service reports as exit 77 at start-up and as `authority_unavailable` at run time.
internal sealed class CngMachineKeySigner : IReceiptSigner, IDisposable
{
    private static readonly CngProvider PlatformProvider = new("Microsoft Platform Crypto Provider");
    private readonly CngKey key;
    private readonly ECDsaCng ecdsa;

    private CngMachineKeySigner(CngKey key) { this.key = key; ecdsa = new ECDsaCng(key); }

    public string Issuer => ReceiptV2.Issuer;

    public byte[] PublicKeySpki => ecdsa.ExportSubjectPublicKeyInfo();

    public static CngMachineKeySigner Open(string keyName, SigningProvider provider)
    {
        CngKey? opened = null;
        try
        {
            opened = CngKey.Open(keyName, provider == SigningProvider.Tpm ? PlatformProvider : CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.MachineKey);
            if (opened.Algorithm != CngAlgorithm.ECDsaP256 || opened.KeySize != 256) throw new SignerUnavailableException("signing key is not ECDSA P-256");
            return new CngMachineKeySigner(opened);
        }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException or PlatformNotSupportedException)
        {
            opened?.Dispose();
            throw new SignerUnavailableException("signing key cannot be opened", ex);
        }
        catch (SignerUnavailableException)
        {
            opened?.Dispose();
            throw;
        }
    }

    public byte[] Sign(ReadOnlySpan<byte> receipt)
    {
        try { return ecdsa.SignData(receipt, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation); }
        catch (CryptographicException ex) { throw new SignerUnavailableException("signing failed", ex); }
    }

    public void Dispose()
    {
        ecdsa.Dispose();
        key.Dispose();
    }
}

#if ALBERA_AUTHORITY_TEST_FAULTS
// Test-only (not in the shipped build): an in-memory ECDSA P-256 key. Its issuer is a test issuer, so a receipt it signs can never pass production
// validation even if someone pinned its public key by mistake. `Failing` makes every Sign throw, to exercise `authority_unavailable`.
internal sealed class FakeReceiptSigner : IReceiptSigner, IDisposable
{
    private readonly ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public string Issuer => "albera-test-approval-authority";
    public bool Failing { get; set; }
    public byte[] PublicKeySpki => key.ExportSubjectPublicKeyInfo();

    public byte[] Sign(ReadOnlySpan<byte> receipt) =>
        Failing ? throw new SignerUnavailableException("fake signer is failing") : key.SignData(receipt, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    public void Dispose() => key.Dispose();
}
#endif
