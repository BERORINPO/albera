using System.Text;

namespace Albera.Approver;

internal enum SignStatus { Signed, Unavailable, NotReady }

/// <summary>Signed: <see cref="Signature"/> is the proof. Unavailable: the Hello key exists but gave no proof (cancelled, locked). NotReady: there is no usable Hello key at all (Hello unsupported, not enrolled, or no signer in this build).</summary>
internal sealed record SignResult(SignStatus Status, byte[]? Signature)
{
    public static SignResult Signed(byte[] signature) => new(SignStatus.Signed, signature);
    public static SignResult Unavailable { get; } = new(SignStatus.Unavailable, null);
    public static SignResult NotReady { get; } = new(SignStatus.NotReady, null);
}

/// <summary>
/// The human-presence step. The shipped implementation (WindowsHello.cs, WindowsHelloPresenceSigner) asks Windows Hello (KeyCredentialManager) to sign <paramref name="message"/>
/// with the approver's RSA-2048 key credential: RSA PKCS#1 v1.5 / SHA-256, a 256-byte signature. The fake (test-faults builds only) signs with an in-memory RSA key.
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
