using System.Security.Cryptography;
using Albera.Approver;

// Issue #101. (1) The attestation rule at enroll (HelloKeyStore.cs, AttestationPolicy): only Success with non-empty buffers keeps the key. (2) The action details are shown, and the
// typed yes is taken, before Hello is asked. Fakes only: no Hello, no key.
internal static partial class Harness
{
    /// <summary>Records what had been printed at the moment Hello was asked.</summary>
    private sealed class OrderRecordingSigner(Func<string> printed, SignResult result) : IPresenceSigner
    {
        public string? PrintedBeforeHello;
        public SignResult Sign(byte[] message) { PrintedBeforeHello = printed(); return result; }
    }

    private static void OrderChecks()
    {
        Check("approve: the request (id, every digest input, digest, check) is printed and the exact word yes is taken BEFORE Hello is asked", () =>
        {
            Run ordered = null!;
            OrderRecordingSigner signer = new(() => ordered.Out.ToString(), SignResult.Signed(Sign(PresenceMessage.Build(Id1, DigestOf(), Challenge))));
            ordered = new Run(Listing(Entry()), signer);
            Assert(RunApprove(ordered) == ExitCodes.Ok, ordered.Err.ToString());
            string printed = signer.PrintedBeforeHello ?? "";
            foreach (string field in new[] { $"request {Id1}", "purpose: \"broker.operation\"", "action: \"environment.start\"", "projectId: \"proj-alpha\"", "computerId: \"pc-01\"", "args: 3", "\"vmName\" = \"alpha\" (string)", $"actionDigest: {DigestOf()[..15]}", "digest check: OK", "Type yes to approve exactly this request: " })
                Assert(printed.Contains(field), $"printed before Hello: {field}");
            Assert(printed.IndexOf("digest check: OK", StringComparison.Ordinal) < printed.IndexOf("Type yes", StringComparison.Ordinal), "the request comes before the question");
            Assert(!printed.Contains("result:"), "nothing is reported as decided before Hello");
        });
    }

    private const string OptInLine = "attestation: NotSupported (accepted with --accept-unattested: this key is NOT proven to be hardware-backed)";

    private static void AttestationChecks()
    {
        Check("attestation policy without the opt-in: exactly Success with a non-empty chain and a non-empty statement passes; every other status, an empty buffer, other spelling and an unknown value are refused", () =>
        {
            Assert(AttestationPolicy.Accepts("Success", 1, 1, false) && AttestationPolicy.Accepts("Success", 3000, 700, false), "Success passes");
            foreach ((string status, int chain, int statement) in new[] { ("Success", 0, 100), ("Success", 100, 0), ("Success", 0, 0), ("NotSupported", 0, 0), ("NotSupported", 100, 100), ("TemporaryFailure", 100, 100), ("UnknownError", 100, 100),
                ("success", 100, 100), ("SUCCESS", 100, 100), ("Success ", 100, 100), ("Exception", 0, 0), ("", 100, 100), ("0", 100, 100), ("4", 100, 100), ("FutureValue", 100, 100) })
                Assert(!AttestationPolicy.Accepts(status, chain, statement, false), $"{status} {chain} {statement}");
            Assert(AttestationPolicy.AcceptedStatus == "Success" && AttestationPolicy.OptInStatus == "NotSupported" && AttestationPolicy.OptInFlag == "--accept-unattested", "the accepted status, the one opt-in status and its flag");
            Assert(AttestationPolicy.Summary("Success", 10, 20, false).Contains("NOT verified"), "a pass says what it does not prove");
        });
        Check("attestation policy with --accept-unattested: Success still passes, NotSupported with empty buffers is the ONE addition; everything else (other statuses, odd spellings, Success with empty buffers, NotSupported with buffers) is refused", () =>
        {
            Assert(AttestationPolicy.Accepts("Success", 1, 1, true) && AttestationPolicy.Accepts("NotSupported", 0, 0, true), "Success and NotSupported(empty) pass");
            foreach ((string status, int chain, int statement) in new[] { ("Success", 0, 100), ("Success", 100, 0), ("Success", 0, 0), ("NotSupported", 100, 100), ("NotSupported", 1, 0), ("NotSupported", 0, 1), ("TemporaryFailure", 0, 0), ("TemporaryFailure", 100, 100),
                ("UnknownError", 0, 0), ("UnknownError", 100, 100), ("notsupported", 0, 0), ("NOTSUPPORTED", 0, 0), ("NotSupported ", 0, 0), ("Exception", 0, 0), ("", 0, 0), ("1", 0, 0), ("FutureValue", 0, 0) })
                Assert(!AttestationPolicy.Accepts(status, chain, statement, true), $"{status} {chain} {statement}");
            Assert(AttestationPolicy.Summary("NotSupported", 0, 0, true) == "NotSupported (accepted with --accept-unattested: this key is NOT proven to be hardware-backed)", "the fixed wording");
            Assert(!AttestationPolicy.Summary("NotSupported", 0, 0, false).Contains("accepted"), "a refusal never says accepted");
        });
        Check("enroll, each status with and without --accept-unattested: Success passes either way; NotSupported is refused by default (the hint names the flag) and kept with the flag; TemporaryFailure / UnknownError / empty buffers are refused even with the flag (no flag in the hint)", () =>
        {
            foreach (bool flag in new[] { false, true })
                foreach (string attestation in new[] { "Success", "NotSupported", "TemporaryFailure", "UnknownError", "Empty" })
                {
                    Enrolling run = new(null, attestation: attestation);
                    int exit = run.Run(null, acceptUnattested: flag);
                    bool expectKept = attestation == "Success" || (attestation == "NotSupported" && flag);
                    string label = $"{attestation} flag={flag}";
                    if (expectKept)
                    {
                        Assert(exit == ExitCodes.Ok && run.Err.ToString() == "" && run.Store.Open().State == KeyState.Present, $"{label}: kept ({run.Err})");
                        Assert(run.Out.ToString().Split('\n').Count(l => l.StartsWith("  \"", StringComparison.Ordinal)) == 3 && !run.Out.ToString().Contains("approverAttestation"), $"{label}: exactly the three config values");
                        string[] lines = run.Out.ToString().Split('\n').Where(l => l.StartsWith("attestation: ", StringComparison.Ordinal)).ToArray();
                        Assert(lines.Length == 1 && (attestation == "Success" ? lines[0].StartsWith("attestation: Success (") : lines[0] == OptInLine), $"{label}: one attestation line: {run.Out}");
                        continue;
                    }
                    Assert(exit == ExitCodes.SignerUnavailable && run.Err.ToString().StartsWith("error: attestation_refused\nhint: Windows Hello did not attest the new key") && run.Out.ToString() == "", $"{label}: refused ({run.Err})");
                    Assert(run.Err.ToString().Contains(attestation == "Empty" ? "Success (certificate chain 0 bytes" : $"{attestation} (certificate chain"), $"{label}: the status is named: {run.Err}");
                    Assert(run.Err.ToString().Contains("--accept-unattested") == (attestation == "NotSupported"), $"{label}: only the NotSupported refusal names the flag: {run.Err}");
                    Assert(run.Store.Open().State == KeyState.Missing, $"{label}: no key is left behind");
                    Assert(!run.Err.ToString().Contains("approverPublicKey") && !run.Out.ToString().Contains("approverPublicKey"), $"{label}: no config value");
                }
        });
        Check("enroll --replace, each status x flag: the typed word is still required; a refused key leaves none (the replaced one is gone, as for any replace); NotSupported with the flag is kept; declining keeps the existing key", () =>
        {
            foreach (bool flag in new[] { false, true })
                foreach (string attestation in new[] { "NotSupported", "TemporaryFailure" })
                {
                    Enrolling run = new(Hello, attestation: attestation);
                    int exit = run.Run("replace", "replace\n", acceptUnattested: flag);
                    bool kept = attestation == "NotSupported" && flag;
                    Assert(kept ? exit == ExitCodes.Ok && run.Out.ToString().Contains(OptInLine) && run.Store.Open().State == KeyState.Present
                        : exit == ExitCodes.SignerUnavailable && run.Err.ToString().StartsWith("error: attestation_refused\n") && !run.Out.ToString().Contains("approverPublicKey") && run.Store.Open().State == KeyState.Missing, $"{attestation} flag={flag}: {run.Err}");
                    Enrolling declined = new(Hello, attestation: attestation);
                    Assert(declined.Run("replace", "no\n", acceptUnattested: flag) == ExitCodes.Refused && declined.Store.Open().State == KeyState.Present && declined.Out.ToString().Contains("Type replace"), $"{attestation} flag={flag}: declining");
                }
        });
        Check("enroll: the flag does not change the other refusals (existing key, no console) and --show never prints an attestation line", () =>
        {
            Enrolling existing = new(Hello, attestation: "NotSupported");
            Assert(existing.Run(null, acceptUnattested: true) == ExitCodes.Refused && existing.Err.ToString().StartsWith("error: already_enrolled\n") && existing.Store.Open().State == KeyState.Present, existing.Err.ToString());
            Enrolling redirected = new(null, attestation: "NotSupported");
            Assert(redirected.Run(null, interactive: false, acceptUnattested: true) == ExitCodes.Refused && redirected.Err.ToString().StartsWith("error: not_interactive\n") && redirected.Store.Open().State == KeyState.Missing, redirected.Err.ToString());
            Enrolling shown = new(Hello, attestation: "NotSupported");
            Assert(shown.Run("show", interactive: false) == ExitCodes.Ok && !shown.Out.ToString().Contains("attestation:"), "--show claims nothing about attestation");
        });
        Check("CommandLine: --accept-unattested belongs to enroll (create / replace) only; with --show, --check, --expect, another verb, twice, first or alone it is not a command", () =>
        {
            Assert(CommandLine.TryParse(["enroll", "--accept-unattested"]) == new CommandLine("enroll", null, null, AcceptUnattested: true), "enroll --accept-unattested");
            Assert(CommandLine.TryParse(["enroll", "--replace", "--accept-unattested"]) == new CommandLine("enroll", null, "replace", AcceptUnattested: true), "enroll --replace --accept-unattested");
            Assert(CommandLine.TryParse(["enroll"]) is { AcceptUnattested: false } && CommandLine.TryParse(["enroll", "--replace"]) is { AcceptUnattested: false }, "off by default");
            string[][] rejected = [["enroll", "--show", "--accept-unattested"], ["enroll", "--accept-unattested", "--show"], ["enroll", "--check", "--accept-unattested"], ["enroll", "--accept-unattested", "--check"],
                ["enroll", "--check", "--expect", "hello-0123456789abcdef", "--accept-unattested"], ["enroll", "--accept-unattested", "--replace"], ["enroll", "--accept-unattested", "--accept-unattested"], ["enroll", "--replace", "--accept-unattested", "--accept-unattested"],
                ["enroll", "--accept-unattested", "x"], ["enroll", "--Accept-Unattested"], ["enroll", "--accept-unattested=true"], ["--accept-unattested"], ["list", "--accept-unattested"], ["approve", Id1, "--accept-unattested"], ["deny", Id1, "--accept-unattested"],
                ["policy", "--accept-unattested"], ["policy", "show", "--accept-unattested"], ["policy", "set", "standard", "--accept-unattested"]];
            foreach (string[] bad in rejected) Assert(CommandLine.TryParse(bad) is null, string.Join(' ', bad));
        });
    }
}
