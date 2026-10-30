using System.Text;

namespace Albera.Approver;

internal enum SignStatus { Signed, Unavailable, NotBuilt }

/// <summary>Signed: <see cref="Signature"/> is the proof. Unavailable: Hello exists but gave no proof (cancelled, not enrolled, locked). NotBuilt: this build has no signer at all.</summary>
internal sealed record SignResult(SignStatus Status, byte[]? Signature)
{
    public static SignResult Signed(byte[] signature) => new(SignStatus.Signed, signature);
    public static SignResult Unavailable { get; } = new(SignStatus.Unavailable, null);
    public static SignResult NotBuilt { get; } = new(SignStatus.NotBuilt, null);
}

/// <summary>
/// The human-presence step. The real implementation (owner-gated, NOT built here) asks Windows Hello (KeyCredentialManager) to sign <paramref name="message"/> with the
/// approver's RSA-2048 key credential: RSA PKCS#1 v1.5 / SHA-256, a 256-byte signature. The fake (test-faults builds only) signs with an in-memory RSA key.
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

// What every build without a Windows Hello implementation ships: it cannot approve. `approve` then sends nothing to the Authority (the request stays pending for
// a build that can sign, or expires); `deny` and `list` work.
internal sealed class NotBuiltPresenceSigner : IPresenceSigner
{
    public SignResult Sign(byte[] message) => SignResult.NotBuilt;
}
