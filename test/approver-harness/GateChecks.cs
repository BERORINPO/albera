using System.Security.Cryptography;
using Albera.Approver;

// Issue #101. (1) The packaged-only gate (PackageIdentity.cs): every command that reaches Windows Hello refuses to run unless the process comes from the approver's own, installed
// package, and refuses BEFORE it opens the pipe, asks for a typed word or touches the key store / signer. (2) The attestation rule at enroll (HelloKeyStore.cs, AttestationPolicy):
// only Success with non-empty buffers keeps the key. (3) The action details are shown, and the typed yes is taken, before Hello is asked. Fakes only: no Hello, no key, no package.
internal static partial class Harness
{
    private static readonly (string Name, PackageIdentity? Identity, string Code)[] Refused =
    [
        ("unpackaged", null, "not_packaged"),
        ("another package", PackageIdentity.Expected with { Name = "Other.App" }, "wrong_package"),
        ("another publisher", PackageIdentity.Expected with { Publisher = "CN=Someone Else" }, "wrong_package"),
        ("the same name in other case", PackageIdentity.Expected with { Name = PackageIdentity.Expected.Name.ToUpperInvariant() }, "wrong_package"),
        ("development mode (loose files)", PackageIdentity.Expected with { IsDevelopmentMode = true }, "development_mode_package"),
    ];

    /// <summary>Counts how often the key store is reached, so a refused command can be shown to have not touched it.</summary>
    private sealed class CountingStore(IHelloKeyStore inner) : IHelloKeyStore
    {
        public int Calls;
        public KeyLookup Open() { Calls++; return inner.Open(); }
        public KeyLookup Create(bool replace) { Calls++; return inner.Create(replace); }
    }

    /// <summary>Records what had been printed at the moment Hello was asked.</summary>
    private sealed class OrderRecordingSigner(Func<string> printed, SignResult result) : IPresenceSigner
    {
        public string? PrintedBeforeHello;
        public SignResult Sign(byte[] message) { PrintedBeforeHello = printed(); return result; }
    }

    private static void GateChecks()
    {
        Check("gate: only the approver's own installed package passes; no package, another name or publisher (case matters) and a development-mode registration are each refused with their own code", () =>
        {
            Assert(Packaged().Check() is null, "the approver package passes");
            foreach ((string name, PackageIdentity? identity, string code) in Refused)
            {
                GateRefusal? refusal = GateFor(identity).Check();
                Assert(refusal is not null && refusal.Code == code && refusal.Hint.StartsWith("hint: ") && !refusal.Hint.Contains('\n'), $"{name}: {refusal?.Code}");
            }
        });
        Check("approve: not running from the package -> 65 with the gate code; nothing is listed, sent, asked or signed", () =>
        {
            foreach ((string name, PackageIdentity? identity, string code) in Refused)
            {
                RecordingSigner signer = Signing();
                FakeChannel channel = Listing(Entry());
                Run run = new(channel, signer, gate: GateFor(identity));
                Assert(RunApprove(run) == ExitCodes.Refused && run.Err.ToString().StartsWith($"error: {code}\nhint: "), $"{name}: {run.Err}");
                Assert(channel.Requests.Count == 0 && signer.Messages.Count == 0 && run.Out.ToString() == "", $"{name}: pipe, console and Hello untouched");
            }
        });
        Check("approve: the console rule still comes first (redirected stdin is not_interactive even when unpackaged), and the typed yes is never reached when refused", () =>
        {
            Run redirected = new(Listing(Entry()), Signing(), interactive: false, gate: GateFor(null));
            Assert(RunApprove(redirected) == ExitCodes.Refused && redirected.Err.ToString().StartsWith("error: not_interactive\n"), redirected.Err.ToString());
            Run unpackaged = new(Listing(Entry()), Signing(), "yes\n", gate: GateFor(null));
            RunApprove(unpackaged);
            Assert(!unpackaged.Out.ToString().Contains("Type yes"), "no prompt for a typed yes");
        });
        Check("list and deny never reach Hello, so they still work unpackaged (a deny can only make a request fail)", () =>
        {
            Run listing = new(Listing(Entry()), Signing(), gate: GateFor(null));
            listing.Exit = listing.Commands.ListAsync().GetAwaiter().GetResult();
            Assert(listing.Exit == ExitCodes.Ok && listing.Out.ToString().StartsWith("pending: 1\n"), listing.Err.ToString());
            Run denying = new(new FakeChannel(r => "{\"ok\":true,\"state\":\"denied\"}"), new NotReadyPresenceSigner(), gate: GateFor(null));
            Assert(denying.Commands.DenyAsync(Id1).GetAwaiter().GetResult() == ExitCodes.Ok && denying.Out.ToString().Trim() == "result: denied", denying.Err.ToString());
        });
        Check("enroll (every form): not running from the package -> 65 with the gate code, the key store is never reached, nothing is created / replaced / printed", () =>
        {
            foreach ((string name, PackageIdentity? identity, string code) in Refused)
                foreach (string? option in new string?[] { null, "show", "replace" })
                {
                    Enrolling run = new(option is null ? null : Hello, gate: GateFor(identity));
                    CountingStore counting = new(run.Store);
                    KeyState before = run.Store.Open().State;
                    int exit = new EnrollCommand(counting, () => "S-1-5-21-1-2-3-1001", run.Out, run.Err, new StringReader("replace\n"), true, GateFor(identity)).Run(option);
                    Assert(exit == ExitCodes.Refused && run.Err.ToString().StartsWith($"error: {code}\nhint: ") && run.Out.ToString() == "", $"{name} {option}: {run.Err}");
                    Assert(counting.Calls == 0 && run.Store.Open().State == before, $"{name} {option}: key store untouched");
                }
        });
        Check("enroll --check: not running from the package -> 65 with the gate code; the key is not opened and Hello is not asked", () =>
        {
            foreach ((string name, PackageIdentity? identity, string code) in Refused)
            {
                Recording signer = new(Hello);
                SelfChecking run = new(Hello, signer, gate: GateFor(identity));
                Assert(run.Run() == ExitCodes.Refused && run.Err.ToString().StartsWith($"error: {code}\nhint: ") && run.Out.ToString() == "" && signer.Messages.Count == 0, $"{name}: {run.Err}");
            }
        });
        Check("policy set: a change that lets actions skip a person needs the package (65, no signature, nothing sent); one that only adds prompts and policy show never reach Hello and work unpackaged", () =>
        {
            foreach ((string name, PackageIdentity? identity, string code) in Refused)
            {
                RecordingSigner signer = SigningPolicy(PolicyJson(1, "standard", "task.cancel"));
                FakeChannel channel = PolicyChannel(PolicyJson(0, "careful"));
                int exit = RunPolicy(channel, signer, c => c.SetAsync("standard", ["task.cancel"]), out string stdout, out string stderr, gate: GateFor(identity));
                Assert(exit == ExitCodes.Refused && stderr.StartsWith($"error: {code}\nhint: ") && signer.Messages.Count == 0 && !SentSetRequest(channel), $"{name}: {stderr}");
                Assert(!stdout.Contains("Type yes"), $"{name}: no typed yes was asked for a change that cannot be signed");
            }
            FakeChannel tightening = PolicyChannel(PolicyJson(3, "standard"));
            RecordingSigner none = Signing();
            Assert(RunPolicy(tightening, none, c => c.SetAsync("careful", []), out _, out string tighteningErr, gate: GateFor(null)) == ExitCodes.Ok && none.Messages.Count == 0 && SentSetRequest(tightening), tighteningErr);
            Assert(RunPolicy(PolicyChannel(PolicyJson(0, "careful")), none, c => c.ShowAsync(), out _, out _, gate: GateFor(null)) == ExitCodes.Ok, "policy show works unpackaged");
        });
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
