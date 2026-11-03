using Albera.Setup;

internal static partial class Harness
{
    private static readonly string Sha = new('a', 64);

    private static Dictionary<string, string?> GoodCertificate(string commit = Scenario.DefaultCommit, ulong run = Scenario.DefaultRun) => new()
    {
        ["subjectAlternativeName"] = SetupLayout.CertificateIdentity,
        ["issuer"] = SetupLayout.OidcIssuer,
        ["sourceRepositoryURI"] = SetupLayout.RepositoryUrl,
        ["sourceRepositoryRef"] = SetupLayout.SourceRef,
        ["githubWorkflowRepository"] = SetupLayout.Repository,
        ["githubWorkflowRef"] = SetupLayout.SourceRef,
        ["buildSignerURI"] = SetupLayout.CertificateIdentity,
        ["runnerEnvironment"] = SetupLayout.HostedRunner,
        ["sourceRepositoryDigest"] = commit,
        ["buildSignerDigest"] = commit,
        ["runInvocationURI"] = $"{SetupLayout.RepositoryUrl}/actions/runs/{run}/attempts/2",
    };

    private static string Output(params string[] entries) => "[" + string.Join(",", entries) + "]";

    private static void RefusedPolicy(string json, string mentions) =>
        Assert(Refused("attestation_policy", () => AttestationPolicy.Evaluate(json, Sha)).Message.Contains(mentions, StringComparison.Ordinal), $"the refusal does not mention '{mentions}'");

    private static void PolicyChecks()
    {
        Check("policy: a certificate from this repository's workflow on main, a hosted runner and a 40-hex commit is accepted, with its commit and run id", () =>
        {
            var facts = AttestationPolicy.Evaluate(Output(Scenario.GhEntry(Sha, GoodCertificate())), Sha);
            Equal(1, facts.Count, "entries");
            Equal(Scenario.DefaultCommit, facts[0].Commit, "commit");
            Equal(Scenario.DefaultRun, facts[0].RunId, "run id");
        });

        (string Name, string Field, string? Value, string Mentions)[] pinned =
        [
            ("another repository", "sourceRepositoryURI", "https://github.com/someone-else/albera", "sourceRepositoryURI"),
            ("another workflow file", "subjectAlternativeName", "https://github.com/BERORINPO/albera/.github/workflows/other.yml@refs/heads/main", "subjectAlternativeName"),
            ("a branch other than main", "subjectAlternativeName", "https://github.com/BERORINPO/albera/.github/workflows/host-build-hashes.yml@refs/heads/feature/x", "subjectAlternativeName"),
            ("a source ref other than main", "sourceRepositoryRef", "refs/heads/feature/x", "sourceRepositoryRef"),
            ("a tag instead of main", "sourceRepositoryRef", "refs/tags/v1", "sourceRepositoryRef"),
            ("a workflow ref other than main", "githubWorkflowRef", "refs/heads/feature/x", "githubWorkflowRef"),
            ("a workflow repository other than this one", "githubWorkflowRepository", "someone-else/albera", "githubWorkflowRepository"),
            ("a build signer other than host-build-hashes.yml on main", "buildSignerURI", "https://github.com/BERORINPO/albera/.github/workflows/other.yml@refs/heads/main", "buildSignerURI"),
            ("a self-hosted runner", "runnerEnvironment", "self-hosted", "runnerEnvironment"),
            ("no runner environment", "runnerEnvironment", null, "runnerEnvironment"),
            ("another OIDC issuer", "issuer", "https://evil.example/oidc", "issuer"),
            ("no OIDC issuer", "issuer", null, "issuer"),
            ("no commit", "sourceRepositoryDigest", null, "sourceRepositoryDigest"),
            ("a short commit", "sourceRepositoryDigest", "0123abc", "sourceRepositoryDigest"),
            ("an upper-case commit", "sourceRepositoryDigest", Scenario.DefaultCommit.ToUpperInvariant(), "sourceRepositoryDigest"),
            ("a workflow file read at another commit", "buildSignerDigest", "ffffffffffffffffffffffffffffffffffffffff", "buildSignerDigest"),
            ("no run URI", "runInvocationURI", null, "runInvocationURI"),
            ("a run of another repository", "runInvocationURI", "https://github.com/someone-else/albera/actions/runs/5/attempts/1", "runInvocationURI"),
            ("a run id with a leading zero", "runInvocationURI", $"{SetupLayout.RepositoryUrl}/actions/runs/0123/attempts/1", "runInvocationURI"),
            ("a run id that is not a number", "runInvocationURI", $"{SetupLayout.RepositoryUrl}/actions/runs/abc/attempts/1", "runInvocationURI"),
            ("a run URI with a path after the attempt", "runInvocationURI", $"{SetupLayout.RepositoryUrl}/actions/runs/5/attempts/1/extra", "runInvocationURI"),
        ];
        foreach (var (name, field, value, mentions) in pinned)
        {
            Check($"policy: refused when the certificate names {name}", () =>
            {
                var certificate = GoodCertificate();
                certificate[field] = value;
                RefusedPolicy(Output(Scenario.GhEntry(Sha, certificate)), mentions);
            });
        }

        Check("policy: refused when the attestation is not for this file's SHA-256", () => RefusedPolicy(Output(Scenario.GhEntry(Sha, GoodCertificate(), subjectSha: new string('b', 64))), "SHA-256"));
        Check("policy: refused when the predicate type is not SLSA provenance v1", () => RefusedPolicy(Output(Scenario.GhEntry(Sha, GoodCertificate(), predicate: "https://example.com/other")), "provenance"));
        Check("policy: refused without a verified timestamp (no transparency log or timestamp authority proof)", () => RefusedPolicy(Output(Scenario.GhEntry(Sha, GoodCertificate(), timestamps: false)), "timestamp"));
        Check("policy: refused for an empty list, an object, text that is not JSON, and trailing text after the JSON", () =>
        {
            RefusedPolicy("[]", "no verified attestation");
            RefusedPolicy("{}", "no verified attestation");
            RefusedPolicy("Verification succeeded!", "JSON");
            RefusedPolicy(Output(Scenario.GhEntry(Sha, GoodCertificate())) + "\nLoaded digest", "JSON");
            RefusedPolicy("", "JSON");
        });
        Check("policy: one bad entry among good ones refuses the whole answer", () =>
        {
            var bad = GoodCertificate();
            bad["runnerEnvironment"] = "self-hosted";
            RefusedPolicy(Output(Scenario.GhEntry(Sha, GoodCertificate()), Scenario.GhEntry(Sha, bad)), "runnerEnvironment");
        });
        Check("policy: more than 64 entries are refused", () => RefusedPolicy(Output(Enumerable.Range(0, 65).Select(_ => Scenario.GhEntry(Sha, GoodCertificate())).ToArray()), "more than"));
        Check("policy: the run id comes from the certificate URI with or without an attempt", () =>
        {
            Equal(42UL, AttestationPolicy.ParseRunId($"{SetupLayout.RepositoryUrl}/actions/runs/42"), "no attempt");
            Equal(42UL, AttestationPolicy.ParseRunId($"{SetupLayout.RepositoryUrl}/actions/runs/42/attempts/7"), "attempt 7");
            Equal(123456789012345678UL, AttestationPolicy.ParseRunId($"{SetupLayout.RepositoryUrl}/actions/runs/123456789012345678/attempts/1"), "18 digits");
        });

        Check("gh arguments: offline bundle and trusted root, this repository, the exact certificate identity, hosted runners only, JSON output; no token, no network flag", () =>
        {
            var expected = new[]
            {
                "attestation", "verify", @"C:\w\file.exe", "--bundle", @"C:\w\b.jsonl", "--custom-trusted-root", @"C:\setup\trusted_root.jsonl", "--repo", "BERORINPO/albera",
                "--cert-identity", "https://github.com/BERORINPO/albera/.github/workflows/host-build-hashes.yml@refs/heads/main", "--deny-self-hosted-runners", "--format", "json",
            };
            Assert(GhVerifier.BuildArguments(@"C:\w\file.exe", @"C:\w\b.jsonl", @"C:\setup\trusted_root.jsonl").SequenceEqual(expected), "argument list differs");
        });

        Check("gh: a non-zero exit, a timeout and an oversized answer are each refused with their own code, and gh's complaint is shown as one clean line", () =>
        {
            var spec = new Func<ProcessResult, GhVerifier>(result =>
                new GhVerifier(new FakeRunner { Gh = _ => result }, @"C:\s\gh.exe", @"C:\s\r.jsonl", new Dictionary<string, string>(), @"C:\w"));
            var failed = Refused("gh_verify_failed", () => spec(new ProcessResult(1, "", "\u001b[31mfailed to verify\u001b[0m certificate\r\nnext line", false, false)).Verify(@"C:\w\f.exe", Sha, @"C:\w\b.jsonl"));
            Assert(failed.Message.Contains("f.exe: ", StringComparison.Ordinal) && !failed.Message.Contains('\u001b') && !failed.Message.Contains("next line", StringComparison.Ordinal), "message not clean: " + failed.Message);
            Refused("gh_timeout", () => spec(new ProcessResult(-1, "", "", true, false)).Verify(@"C:\w\f.exe", Sha, @"C:\w\b.jsonl"));
            Refused("gh_output", () => spec(new ProcessResult(0, "", "", false, true)).Verify(@"C:\w\f.exe", Sha, @"C:\w\b.jsonl"));
        });
    }
}
