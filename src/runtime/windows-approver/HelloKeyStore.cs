using System.Security.Cryptography;

namespace Albera.Approver;

internal enum KeyState { Present, Missing, AlreadyExists, Cancelled, Unavailable, NotAttested }

/// <summary>
/// The outcome of looking at or creating the approver's Hello key. <see cref="PublicKey"/> (SPKI, DER) is set only when the state is Present. No private material ever appears here.
/// <see cref="Detail"/> is a one-line attestation summary: set on Present for a key that Create just made (and attested, or accepted unattested), and on NotAttested for the refused result. Open() never sets it.
/// <see cref="CouldOptIn"/> is true only on a NotAttested result that --accept-unattested would have accepted (AttestationPolicy.IsOptInResult), so the hint may name the flag.
/// </summary>
internal sealed record KeyLookup(KeyState State, byte[]? PublicKey, string? Detail = null, bool CouldOptIn = false)
{
    public static KeyLookup Of(KeyState state) => new(state, null);
    public static KeyLookup Present(byte[] publicKey, string? attestation = null) => new(KeyState.Present, publicKey, attestation);
    public static KeyLookup NotAttested(string reason, bool couldOptIn = false) => new(KeyState.NotAttested, null, reason, couldOptIn);
}

/// <summary>
/// Which attestation results `enroll` accepts for the key it just made (issue #101). Windows reports KeyCredentialAttestationStatus Success, UnknownError, NotSupported or
/// TemporaryFailure for KeyCredential.GetAttestationAsync. By default exactly ONE passes: Success, with a non-empty certificate chain and a non-empty attestation statement.
/// NotSupported (no attestation: this PC cannot attest the key) is refused by default and accepted ONLY when the person passes `enroll --accept-unattested` AND both buffers are empty
/// (that is what this PC returns); the key is then kept and says so on screen. TemporaryFailure (retry later; accepting it would let an unattested key through), UnknownError, an exception,
/// Success with an empty buffer, NotSupported with a buffer and any status name this code does not know (a future value) are refused even with the flag. The status is compared as text
/// so this file knows nothing about WinRT.
/// What a pass means is documented in docs/architecture/approver-app.md ("Attestation at enroll"): Windows said it produced an attestation; this program does NOT validate the chain,
/// the statement's signature or the key binding.
/// </summary>
internal static class AttestationPolicy
{
    public const string AcceptedStatus = "Success";
    public const string OptInStatus = "NotSupported";
    public const string OptInFlag = "--accept-unattested";

    public static bool Accepts(string status, int chainBytes, int statementBytes, bool acceptUnattested) =>
        (status == AcceptedStatus && chainBytes > 0 && statementBytes > 0) || (acceptUnattested && IsOptInResult(status, chainBytes, statementBytes));

    /// <summary>The one result the flag can accept: NotSupported with empty buffers.</summary>
    public static bool IsOptInResult(string status, int chainBytes, int statementBytes) => status == OptInStatus && chainBytes == 0 && statementBytes == 0;

    public static string Summary(string status, int chainBytes, int statementBytes, bool acceptUnattested) =>
        !Accepts(status, chainBytes, statementBytes, acceptUnattested) ? $"{status} (certificate chain {chainBytes} bytes, statement {statementBytes} bytes)"
        : IsOptInResult(status, chainBytes, statementBytes) ? $"{status} (accepted with {OptInFlag}: this key is NOT proven to be hardware-backed)"
        : $"{status} (Windows Hello reports the key as attested; certificate chain {chainBytes} bytes, statement {statementBytes} bytes; the chain and statement are NOT verified by this program)";
}

/// <summary>
/// The approver's Windows Hello key credential (fixed name). Open never shows a Hello prompt. Create does (the person verifies once): with replace=false it fails with
/// AlreadyExists when the key exists, with replace=true it makes a new key in its place. A key that Create just made is attested (AttestationPolicy; acceptUnattested is the person's explicit
/// `--accept-unattested`); if the attestation is not accepted Create removes that key again and returns NotAttested, so an unattested key never stays behind. The shipped implementation is WindowsHello.cs; test-faults builds use an in-memory fake.
/// </summary>
internal interface IHelloKeyStore
{
    KeyLookup Open();
    KeyLookup Create(bool replace, bool acceptUnattested);
}

/// <summary>The suggested approverKeyId: "hello-" + the first 8 bytes of SHA-256 over the SPKI, lower-case hex (a valid id in the Authority's grammar). Shared by `enroll` and `enroll --check`.</summary>
internal static class ApproverKeyId
{
    public static string Of(byte[] spki) => "hello-" + Convert.ToHexStringLower(SHA256.HashData(spki).AsSpan(0, 8));
}
