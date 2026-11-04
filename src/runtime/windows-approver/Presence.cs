using System.Security.Cryptography;
using System.Text;

namespace Albera.Approver;

internal enum SignStatus { Signed, Unavailable, NotReady }

/// <summary>
/// Signed: <see cref="Signature"/> (a Hello RSA signature) or <see cref="Proof"/> (a WebAuthn assertion) is the proof. Unavailable: the key exists but gave no proof (cancelled, locked). NotReady: there is no usable key at all
/// (Hello unsupported, not enrolled, WebAuthn not available, or no signer in this build). <see cref="Detail"/> is a short reason for the hint line (WebAuthn only; fixed vocabulary, never request text).
/// </summary>
internal sealed record SignResult(SignStatus Status, byte[]? Signature, WebAuthnAssertion? Proof = null, string? Detail = null)
{
    public static SignResult Signed(byte[] signature) => new(SignStatus.Signed, signature);
    public static SignResult SignedWebAuthn(WebAuthnAssertion proof) => new(SignStatus.Signed, null, proof);
    public static SignResult Unavailable { get; } = new(SignStatus.Unavailable, null);
    public static SignResult NotReady { get; } = new(SignStatus.NotReady, null);
    public static SignResult NotReadyBecause(string detail) => new(SignStatus.NotReady, null, null, detail);
}

/// <summary>
/// The Windows Hello human-presence step. The shipped implementation (WindowsHello.cs, WindowsHelloPresenceSigner) asks Windows Hello (KeyCredentialManager) to sign <paramref name="message"/>
/// with the approver's RSA-2048 key credential: RSA PKCS#1 v1.5 / SHA-256, a 256-byte signature. The fake (test-faults builds only) signs with an in-memory RSA key.
/// A WebAuthn key is not an IPresenceSigner: it needs the credential ids the Authority has registered, so WebAuthnSigner takes them (PresenceSigning.cs picks one of the two).
/// </summary>
internal interface IPresenceSigner
{
    SignResult Sign(byte[] message);
}

// The bytes the approver's Hello key signs (UTF-8, 0x00 separated), exactly as the Authority rebuilds them from its OWN entry
// (the Authority's Presence.cs; docs/architecture/approval-authority.md):
//   "albera.presence.v1" 0x00 approvalId 0x00 actionDigest 0x00 challenge
// The digest used here is the one this app RECOMPUTED from the fields it showed, never the one the Authority sent.
internal static class PresenceMessage
{
    public const string Domain = "albera.presence.v1";

    public static byte[] Build(string approvalId, string actionDigest, string challenge) =>
        Encoding.UTF8.GetBytes($"{Domain}\0{approvalId}\0{actionDigest}\0{challenge}");
}

// Local check of a Hello signature against the credential's own public key (SPKI, DER): RSA-2048, PKCS#1 v1.5, SHA-256, a 256-byte signature. These are the same parameters the
// Authority verifies presence with (its own code: the approver shares no project with it); only the self-check uses this, since `approve` leaves verification to the Authority.
// The only RSA object here holds a PUBLIC key imported from SPKI; no key is created.
internal static class PresenceSignature
{
    public const int Bytes = 256;

    public static bool Verify(byte[] spki, byte[] message, byte[] signature)
    {
        if (signature.Length != Bytes) return false;
        try
        {
            using RSA rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(spki, out _);
            return rsa.KeySize == 2048 && rsa.VerifyData(message, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        }
        catch (CryptographicException) { return false; }
    }
}
