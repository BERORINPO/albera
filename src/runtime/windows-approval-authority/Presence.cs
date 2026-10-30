using System.Security.Cryptography;
using System.Text;

namespace Albera.ApprovalAuthority;

internal enum PresenceResult { Verified, Mismatch, Unavailable }

/// <summary>Checks that a human co-signed the exact message the Authority built for one pending request.</summary>
internal interface IHumanPresenceVerifier
{
    PresenceResult Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof);
}

// The bytes the approver's Windows Hello key signs for one pending request (UTF-8, 0x00 separated; every part is ASCII from a fixed grammar, so the
// encoding is unambiguous). The Authority rebuilds it from its OWN entry, so a signature only verifies for this approvalId, this action digest (which
// covers purpose, action, project, computer and args) and this per-entry random challenge: it cannot be replayed on another request.
//   "albera.presence.v1" 0x00 approvalId 0x00 actionDigest 0x00 challenge
internal static class PresenceMessage
{
    public const string Domain = "albera.presence.v1";

    public static byte[] Build(string approvalId, string actionDigest, string challenge) =>
        Encoding.UTF8.GetBytes($"{Domain}\0{approvalId}\0{actionDigest}\0{challenge}");
}

// The real verifier: an RSA-2048 PKCS#1 v1.5 / SHA-256 signature (what a Windows Hello KeyCredential produces) over the message, checked against ONE
// public key pinned in the config. Pure BCL, no OS dependency: the Authority never talks to Hello itself, the approver's UI does and hands the signature
// over the approver pipe. Any malformed proof is a mismatch, never an exception.
internal sealed class RsaPresenceVerifier : IHumanPresenceVerifier, IDisposable
{
    public const int KeyBits = 2048, SignatureBytes = KeyBits / 8;
    private readonly RSA key;

    private RsaPresenceVerifier(RSA key) { this.key = key; }

    /// <returns>null unless <paramref name="spki"/> is exactly one SubjectPublicKeyInfo holding an RSA-2048 public key</returns>
    public static RsaPresenceVerifier? TryCreate(byte[] spki)
    {
        RSA rsa = RSA.Create();
        try
        {
            rsa.ImportSubjectPublicKeyInfo(spki, out int used);
            if (used == spki.Length && rsa.KeySize == KeyBits) return new RsaPresenceVerifier(rsa);
        }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException) { }
        rsa.Dispose();
        return null;
    }

    public PresenceResult Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof)
    {
        if (proof.Length != SignatureBytes) return PresenceResult.Mismatch;
        try { return key.VerifyData(message, proof, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1) ? PresenceResult.Verified : PresenceResult.Mismatch; }
        catch (CryptographicException) { return PresenceResult.Mismatch; }
    }

    public void Dispose() => key.Dispose();
}

#if ALBERA_AUTHORITY_TEST_FAULTS
// Test-only (not in the shipped build): stands in for a person at Windows Hello. The proof is SHA-256("albera-fake-presence" 0x00 message) for
// Verified, the single byte 0x55 for "Hello is not reachable" (Unavailable), anything else is a Mismatch.
internal sealed class FakePresenceVerifier : IHumanPresenceVerifier
{
    public static byte[] ProofFor(ReadOnlySpan<byte> message)
    {
        byte[] prefix = Encoding.UTF8.GetBytes("albera-fake-presence\0");
        return SHA256.HashData([.. prefix, .. message]);
    }

    public static readonly byte[] UnavailableProof = [0x55];

    public PresenceResult Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof)
    {
        if (proof.SequenceEqual(UnavailableProof)) return PresenceResult.Unavailable;
        return proof.SequenceEqual(ProofFor(message)) ? PresenceResult.Verified : PresenceResult.Mismatch;
    }
}
#endif
