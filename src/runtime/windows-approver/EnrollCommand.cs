namespace Albera.Approver;

// `enroll` makes (or shows) the approver's Windows Hello key and prints the three values the Approval Authority config needs. Public values only: the private key never leaves
// Windows Hello, and nothing is written to disk.
//   enroll            create the key (Hello asks the person once). Refuses if the key already exists (exit 65 already_enrolled).
//   enroll --show     print the same three values for the existing key. No prompt, no change.
//   enroll --replace  after the person types `replace`, make a NEW key in place of the existing one. The old key is lost; the Authority rejects approvals until its config is updated.
// `enroll --check` is not handled here: it is SelfCheckCommand.cs (opens the existing key and signs a self-check message; never creates or replaces).
// create / replace need an interactive console (stdin not redirected). approverKeyId is a suggestion derived from the key (any id in the Authority's id grammar works).
// Issue #101: a key that create / replace just made is attested: Windows must report KeyCredentialAttestationStatus Success (AttestationPolicy), else the key is removed and nothing is printed for the Authority config (exit 69 attestation_refused).
internal sealed class EnrollCommand(IHelloKeyStore store, Func<string> currentUserSid, TextWriter output, TextWriter errors, TextReader input, bool interactive)
{
    public const string ReplaceWord = "replace";

    // The credential name is fixed and another app of the same Windows account could have made or opened it first, so an existing key is never trusted by default.
    private const string AlreadyEnrolledHint = "hint: a key with this name already exists. If you did not make it yourself with this program, another app may have made it: run enroll --replace to make a new one (the old one is lost). enroll --show prints the existing key.";
    private const string ShownWarning = "Warning: trust these values only if they equal what your own first enroll printed. If you did not run enroll yourself, run enroll --replace.\n";

    public int Run(string? option)
    {
        if (option == "show") return Show();
        if (!interactive) return Fail(ExitCodes.Refused, "not_interactive");
        KeyLookup existing = store.Open();
        switch (existing.State)
        {
            case KeyState.Present when option != "replace":
                return Fail(ExitCodes.Refused, "already_enrolled", AlreadyEnrolledHint);
            case KeyState.Present:
                output.Write($"This deletes the current approver key. Approvals fail until the Authority config has the new values.\nType {ReplaceWord} to continue: ");
                output.Flush();
                if (input.ReadLine() != ReplaceWord) return Fail(ExitCodes.Refused, "not_confirmed");
                return Report(store.Create(replace: true));
            case KeyState.Missing:
                return Report(store.Create(replace: false));
            default:
                return Report(existing);
        }
    }

    private int Show()
    {
        KeyLookup lookup = store.Open();
        return lookup.State == KeyState.Missing ? Fail(ExitCodes.Refused, "not_enrolled", "hint: run AlberaApprover.exe enroll") : Report(lookup, shown: true);
    }

    private int Report(KeyLookup lookup, bool shown = false) => lookup.State switch
    {
        KeyState.Present => Print(lookup.PublicKey!, shown, lookup.Detail),
        KeyState.NotAttested => Fail(ExitCodes.SignerUnavailable, "attestation_refused", $"hint: Windows Hello did not attest the new key (attestation status {lookup.Detail}). Only status Success is accepted, so no key was kept and nothing is printed for the Authority config. A PC without hardware key attestation (TPM) cannot enrol an approver key"),
        KeyState.AlreadyExists => Fail(ExitCodes.Refused, "already_enrolled", AlreadyEnrolledHint),
        KeyState.Cancelled => Fail(ExitCodes.SignerUnavailable, "hello_cancelled"),
        _ => Fail(ExitCodes.SignerUnavailable, "hello_unavailable", "hint: Windows Hello must be set up for this account (Settings > Accounts > Sign-in options)"),
    };

    private int Print(byte[] spki, bool shown, string? attestation)
    {
        string sid = currentUserSid();
        if (sid.Length == 0) return Fail(ExitCodes.Internal, "sid_unavailable");
        string keyId = ApproverKeyId.Of(spki);
        output.Write("Windows Hello approver key (RSA-2048). Put these three values in the Authority config:\n");
        output.Write($"  \"approverPublicKey\": \"{Convert.ToBase64String(spki)}\",\n");
        output.Write($"  \"approverKeyId\": \"{keyId}\",\n");
        output.Write($"  \"approverSid\": \"{sid}\",\n");
        output.Write("Public values only. approverSid is this account: run approve as the same account, on this PC.\n");
        if (attestation is not null) output.Write($"attestation: {attestation}\n");
        if (shown) output.Write(ShownWarning);
        return ExitCodes.Ok;
    }

    private int Fail(int exitCode, string code, string? hint = null)
    {
        errors.Write($"error: {code}\n");
        if (hint is not null) errors.Write(hint + "\n");
        return exitCode;
    }
}
