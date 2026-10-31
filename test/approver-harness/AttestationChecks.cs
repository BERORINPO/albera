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

    private static void AttestationChecks()
    {
        Check("attestation policy: exactly Success with a non-empty chain and a non-empty statement passes; every other status, an empty buffer, other spelling and an unknown value are refused", () =>
        {
            Assert(AttestationPolicy.Accepts("Success", 1, 1) && AttestationPolicy.Accepts("Success", 3000, 700), "Success passes");
            foreach ((string status, int chain, int statement) in new[] { ("Success", 0, 100), ("Success", 100, 0), ("Success", 0, 0), ("NotSupported", 100, 100), ("TemporaryFailure", 100, 100), ("UnknownError", 100, 100),
                ("success", 100, 100), ("SUCCESS", 100, 100), ("Success ", 100, 100), ("Exception", 0, 0), ("", 100, 100), ("0", 100, 100), ("4", 100, 100), ("FutureValue", 100, 100) })
                Assert(!AttestationPolicy.Accepts(status, chain, statement), $"{status} {chain} {statement}");
            Assert(AttestationPolicy.AcceptedStatus == "Success", "the one accepted status");
            Assert(AttestationPolicy.Summary("Success", 10, 20).Contains("NOT verified"), "a pass says what it does not prove");
        });
        Check("enroll: a key that Windows cannot attest (NotSupported / TemporaryFailure / UnknownError / empty buffers) is refused with 69 attestation_refused, the key is removed and no config value is printed", () =>
        {
            foreach (string attestation in new[] { "NotSupported", "TemporaryFailure", "UnknownError", "Empty" })
            {
                Enrolling run = new(null, attestation: attestation);
                Assert(run.Run(null) == ExitCodes.SignerUnavailable && run.Err.ToString().StartsWith("error: attestation_refused\nhint: Windows Hello did not attest the new key") && run.Out.ToString() == "", $"{attestation}: {run.Err}");
                Assert(run.Err.ToString().Contains(attestation == "Empty" ? "Success (certificate chain 0 bytes" : $"{attestation} (certificate chain"), $"{attestation}: the status is named: {run.Err}");
                Assert(run.Store.Open().State == KeyState.Missing, $"{attestation}: no key is left behind");
                Assert(!run.Err.ToString().Contains("approverPublicKey") && !run.Out.ToString().Contains("approverPublicKey"), "no config value");
            }
        });
        Check("enroll --replace with a key Windows cannot attest: the typed word is still required, the result is 69 attestation_refused and no key is left (the replaced one is gone, as for any replace)", () =>
        {
            Enrolling run = new(Hello, attestation: "NotSupported");
            Assert(run.Run("replace", "replace\n") == ExitCodes.SignerUnavailable && run.Err.ToString().StartsWith("error: attestation_refused\n"), run.Err.ToString());
            Assert(!run.Out.ToString().Contains("approverPublicKey") && run.Store.Open().State == KeyState.Missing, "nothing printed, no key");
            Enrolling declined = new(Hello, attestation: "NotSupported");
            Assert(declined.Run("replace", "no\n") == ExitCodes.Refused && declined.Store.Open().State == KeyState.Present, "declining keeps the existing key");
        });
        Check("enroll: an attested key is kept and printed with one attestation line (status, buffer sizes, and the statement that the chain is not verified); --show opens the key without any attestation line", () =>
        {
            Enrolling run = new(null);
            Assert(run.Run(null) == ExitCodes.Ok && run.Err.ToString() == "", run.Err.ToString());
            string[] attestationLines = run.Out.ToString().Split('\n').Where(l => l.StartsWith("attestation: ", StringComparison.Ordinal)).ToArray();
            Assert(attestationLines.Length == 1 && attestationLines[0].StartsWith("attestation: Success (") && attestationLines[0].Contains("NOT verified by this program"), run.Out.ToString());
            Assert(run.Out.ToString().Split('\n').Count(l => l.StartsWith("  \"", StringComparison.Ordinal)) == 3, "still exactly three config values");
            Enrolling shown = new(Hello);
            Assert(shown.Run("show", interactive: false) == ExitCodes.Ok && !shown.Out.ToString().Contains("attestation:"), "--show claims nothing about attestation");
        });
    }
}
