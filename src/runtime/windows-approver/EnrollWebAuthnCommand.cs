namespace Albera.Approver;

// `enroll --webauthn --accept-unattested`: makes a WebAuthn credential (the person verifies once, on the device that will hold the key: over Remote Desktop, the PC they connect from) and writes down what the Approval
// Authority needs to register it. Public values only: the private key stays in the authenticator, and this program never sees it.
//   1. needs --accept-unattested (a WebAuthn key is made with attestation "none", so it is NOT proven to be hardware-backed; the person says they accept that) and a console, like `approve` and `enroll`: checked before anything is created
//   2. creates the credential for the fixed rp id (WebAuthnCreator): user verification required, attestation none, a new user id every time (it never replaces another credential)
//   3. computes the key record (SPKI from the COSE key, key id = "webauthn-" + first 8 bytes of SHA-256 over the SPKI, alg, credential id) and refuses a key the contract does not allow
//   4. writes the canonical record JSON to %LOCALAPPDATA%\Albera\approver-keys\<keyId>.json (KeyRecordStore): that file is what the installer's `-Mode set-approver -ApproverKeyFile` reads
//   5. prints the record's fields and approverSid, the same kind of warning line as the Hello `enroll`, and the next step: the elevated `albera-host.ps1 -Mode set-approver -ApproverKeyFile <that file>`
// It never talks to the Authority, and the key is NOT registered by this command: keys are added only by the elevated set-approver, behind UAC (there is no run-time add: a same-user process could
// otherwise get one signature at a real approval and register its own key).
internal sealed class EnrollWebAuthnCommand(WebAuthnKit? kit, Func<string> currentUserSid, TextWriter output, TextWriter errors, bool interactive)
{
    public const string UnattestedLine = "attestation: none (accepted with --accept-unattested: this key is NOT proven to be hardware-backed)";
    public const string NextStepLabel = "next (the owner, in an elevated prompt; Windows asks for the administrator's consent): ";

    public int Run(bool acceptUnattested)
    {
        if (kit is null) return Fail(ExitCodes.SignerUnavailable, "webauthn_unavailable");
        if (!acceptUnattested) return Fail(ExitCodes.Refused, "unattested_not_accepted", WebAuthnHints.UnattestedNotAccepted);
        if (!interactive) return Fail(ExitCodes.Refused, "not_interactive");
        string sid = currentUserSid();
        if (sid.Length == 0) return Fail(ExitCodes.Internal, "sid_unavailable"); // before a credential is made
        CreationResult created = WebAuthnCreator.Create(kit.Authenticator, default);
        if (created.Record is not { } record) return Fail(ExitCodes.SignerUnavailable, WebAuthnHints.CreationCode(created.Status), WebAuthnHints.CreationHint(created));
        bool saved = kit.Records.TrySave(record, out string? path);
        output.Write($"WebAuthn approver key ({(record.Alg == ApproverKeyRecord.Es256 ? "ES256, P-256" : "RS256")}; relying party {WebAuthnContract.RpId}). Public values only:\n");
        output.Write($"  \"keyId\": \"{record.KeyId}\",\n");
        output.Write($"  \"kind\": \"{record.Kind}\",\n");
        output.Write($"  \"alg\": {record.Alg},\n");
        output.Write($"  \"publicKey\": \"{Convert.ToBase64String(record.PublicKey)}\",\n");
        output.Write($"  \"credentialId\": \"{B64.Url(record.CredentialId!)}\",\n");
        output.Write($"  \"approverSid\": \"{sid}\",\n");
        output.Write(saved ? $"record file: {path}\n" : "record file: NOT written\n");
        output.Write("approverSid is this account: run approve as the same account, on this PC.\n");
        output.Write(UnattestedLine + "\n");
        if (saved) output.Write($"{NextStepLabel}albera-host.ps1 -Mode set-approver -ApproverKeyFile \"{path}\"\nThis key approves nothing until set-approver has added it to the Authority. The keyId above is the one this file holds.\n");
        return saved ? ExitCodes.Ok : Fail(ExitCodes.Internal, "record_file_failed", "hint: the key was made but its record file could not be written (a different file with that name, or no permission). The values above are the record: save them as <keyId>.json in the approver-keys folder");
    }

    private int Fail(int exitCode, string code, string? hint = null)
    {
        errors.Write($"error: {code}\n");
        if (hint is not null) errors.Write(hint + "\n");
        return exitCode;
    }
}

// The words WebAuthn creation failures and the unattested opt-in are reported with.
internal static class WebAuthnHints
{
    public const string UnattestedNotAccepted = "hint: a WebAuthn key is made with attestation none, so it is NOT proven to be hardware-backed. If you accept that, run the command again with --accept-unattested. Nothing was created";

    public static string CreationCode(WebAuthnStatus status) => status == WebAuthnStatus.Cancelled ? "webauthn_cancelled" : "webauthn_unavailable";

    public static string CreationHint(CreationResult result) => result.Status == WebAuthnStatus.Cancelled
        ? "hint: the WebAuthn prompt was dismissed or timed out; nothing was created. Run the command again"
        : $"hint: Windows could not make a WebAuthn credential ({result.Detail ?? "not available"}). Nothing was kept; the Authority was not told anything";
}
