using System.Security.Cryptography;
using System.Text;

namespace Albera.Approver;

// The bytes the self-check asks Hello to sign: "albera.selfcheck.v1" 0x00 <64 lower-case hex chars = 32 random bytes> (UTF-8). The domain word differs from PresenceMessage.Domain
// ("albera.presence.v1"), and neither domain word plus its 0x00 is a prefix of the other, so a self-check signature can never be a valid presence signature for any request
// (and the Authority, which rebuilds presence messages from its own entries, would never accept it). The nonce is fresh per run, so a recorded signature proves nothing later.
internal static class SelfCheckMessage
{
    public const string Domain = "albera.selfcheck.v1";
    public const int NonceBytes = 32;

    public static byte[] Build(byte[] nonce) => Encoding.UTF8.GetBytes($"{Domain}\0{Convert.ToHexStringLower(nonce)}");
}

// `enroll --check [--expect <approverKeyId>]`: proves, on this PC and without the Approval Authority, that the EXISTING Windows Hello key `AlberaApprover.v1` can sign.
//   1. needs an interactive console (exit 65 not_interactive), like approve / enroll
//   2. opens the existing key only: no key -> exit 69 not_enrolled. It never creates, replaces or deletes a key.
//   3. optional --expect: if the key's id differs, prints KEY_MISMATCH and exits 65 BEFORE Hello is asked (nothing to prove about a key you did not expect)
//   4. asks Hello (one prompt) to sign SelfCheckMessage, then verifies the signature locally with the public key of the same credential (PresenceSignature, RSA-2048 PKCS#1 v1.5 / SHA-256)
// stdout on success is exactly three lines (`self-check: OK`, `approverKeyId: ...`, `approverSid: ...`). Nothing is sent anywhere: no pipe, no network, no file; the only I/O is the console.
// A passing check shows the key signs and matches its public key. It does NOT show who made the key (same limit as `enroll --show`; docs/architecture/approver-app.md "Known limits").
internal sealed class SelfCheckCommand(IHelloKeyStore store, IPresenceSigner signer, Func<string> currentUserSid, Func<byte[]> nonce, TextWriter output, TextWriter errors, bool interactive, HelloGate gate)
{
    public int Run(string? expectedKeyId)
    {
        if (!interactive) return Fail(ExitCodes.Refused, "not_interactive");
        if (gate.Check() is { } refusal) return Fail(ExitCodes.Refused, refusal.Code, refusal.Hint); // issue #101: only from the approver's own package, before Hello is opened
        KeyLookup lookup = store.Open(); // never shows a Hello prompt
        if (lookup.State != KeyState.Present) return NotUsable(lookup.State);
        string keyId = ApproverKeyId.Of(lookup.PublicKey!);
        string sid = currentUserSid();
        if (sid.Length == 0) return Fail(ExitCodes.Internal, "sid_unavailable");
        if (expectedKeyId is not null && !string.Equals(expectedKeyId, keyId, StringComparison.Ordinal))
        {
            output.Write($"self-check: KEY_MISMATCH\napproverKeyId: {keyId}\n");
            return Fail(ExitCodes.Refused, "key_mismatch", "hint: the enrolled key is not the one you expected. Do not use it until you know who made it (enroll --replace makes a new one)");
        }
        byte[] message = SelfCheckMessage.Build(nonce());
        SignResult signed = signer.Sign(message); // the one Hello prompt
        switch (signed.Status)
        {
            case SignStatus.Unavailable:
                return Fail(ExitCodes.SignerUnavailable, "hello_no_proof", "hint: Windows Hello did not verify you (cancelled or locked); run the check again");
            case SignStatus.Signed when PresenceSignature.Verify(lookup.PublicKey!, message, signed.Signature!):
                output.Write($"self-check: OK\napproverKeyId: {keyId}\napproverSid: {sid}\n");
                return ExitCodes.Ok;
            case SignStatus.Signed:
                output.Write("self-check: FAILED\n");
                // 70, not 65: the app refused nothing; the key and its own signature disagree, which should not happen with a healthy Hello key.
                return Fail(ExitCodes.Internal, "self_check_failed", "hint: Hello signed, but the signature does not verify with the enrolled public key. Do not use this key: run enroll --replace");
            default:
                return Fail(ExitCodes.SignerUnavailable, "presence_signer_unavailable", "hint: run AlberaApprover.exe enroll (Windows Hello key missing or Hello not set up); nothing was signed");
        }
    }

    private int NotUsable(KeyState state) => state switch
    {
        KeyState.Missing => Fail(ExitCodes.SignerUnavailable, "not_enrolled", "hint: run AlberaApprover.exe enroll"),
        KeyState.Cancelled => Fail(ExitCodes.SignerUnavailable, "hello_cancelled"),
        _ => Fail(ExitCodes.SignerUnavailable, "hello_unavailable", "hint: Windows Hello must be set up for this account (Settings > Accounts > Sign-in options)"),
    };

    private int Fail(int exitCode, string code, string? hint = null)
    {
        errors.Write($"error: {code}\n");
        if (hint is not null) errors.Write(hint + "\n");
        return exitCode;
    }
}
