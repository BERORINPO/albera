using System.Security.Cryptography;

namespace Albera.Approver;

// `enroll` makes (or shows) the approver's Windows Hello key and prints the three values the Approval Authority config needs. Public values only: the private key never leaves
// Windows Hello, and nothing is written to disk.
//   enroll            create the key (Hello asks the person once). Refuses if the key already exists (exit 65 already_enrolled).
//   enroll --show     print the same three values for the existing key. No prompt, no change.
//   enroll --replace  after the person types `replace`, make a NEW key in place of the existing one. The old key is lost; the Authority rejects approvals until its config is updated.
// create / replace need an interactive console (stdin not redirected). approverKeyId is a suggestion derived from the key (any id in the Authority's id grammar works).
internal sealed class EnrollCommand(IHelloKeyStore store, Func<string> currentUserSid, TextWriter output, TextWriter errors, TextReader input, bool interactive)
{
    public const string ReplaceWord = "replace";

    public int Run(string? option)
    {
        if (option == "show") return Show();
        if (!interactive) return Fail(ExitCodes.Refused, "not_interactive");
        KeyLookup existing = store.Open();
        switch (existing.State)
        {
            case KeyState.Present when option != "replace":
                return Fail(ExitCodes.Refused, "already_enrolled", "hint: enroll --show prints its values again; enroll --replace makes a new key (the old one is lost)");
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
        return lookup.State == KeyState.Missing ? Fail(ExitCodes.Refused, "not_enrolled", "hint: run AlberaApprover.exe enroll") : Report(lookup);
    }

    private int Report(KeyLookup lookup) => lookup.State switch
    {
        KeyState.Present => Print(lookup.PublicKey!),
        KeyState.AlreadyExists => Fail(ExitCodes.Refused, "already_enrolled"),
        KeyState.Cancelled => Fail(ExitCodes.SignerUnavailable, "hello_cancelled"),
        _ => Fail(ExitCodes.SignerUnavailable, "hello_unavailable", "hint: Windows Hello must be set up for this account (Settings > Accounts > Sign-in options)"),
    };

    private int Print(byte[] spki)
    {
        string sid = currentUserSid();
        if (sid.Length == 0) return Fail(ExitCodes.Internal, "sid_unavailable");
        string keyId = "hello-" + Convert.ToHexStringLower(SHA256.HashData(spki).AsSpan(0, 8));
        output.Write("Windows Hello approver key (RSA-2048). Put these three values in the Authority config:\n");
        output.Write($"  \"approverPublicKey\": \"{Convert.ToBase64String(spki)}\",\n");
        output.Write($"  \"approverKeyId\": \"{keyId}\",\n");
        output.Write($"  \"approverSid\": \"{sid}\",\n");
        output.Write("Public values only. approverSid is this account: run approve as the same account, on this PC.\n");
        return ExitCodes.Ok;
    }

    private int Fail(int exitCode, string code, string? hint = null)
    {
        errors.Write($"error: {code}\n");
        if (hint is not null) errors.Write(hint + "\n");
        return exitCode;
    }
}
