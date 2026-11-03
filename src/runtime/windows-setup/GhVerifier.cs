namespace Albera.Setup;

/// <summary>
/// Runs <c>gh attestation verify</c> offline (a bundle file and a trusted root on disk; no token, no network) and applies <see cref="AttestationPolicy"/> to what it prints.
/// Flags used, all listed by <c>gh attestation verify --help</c> (checked against gh 2.67.0 here and the manual of gh 2.103.x; the workflow checks them again with the pinned gh.exe
/// before it builds setup): --bundle, --custom-trusted-root, --repo, --cert-identity, --deny-self-hosted-runners, --format.
/// </summary>
internal sealed class GhVerifier(IProcessRunner runner, string ghExecutable, string trustedRoot, IReadOnlyDictionary<string, string> environment, string workingDirectory)
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(120);

    public static IReadOnlyList<string> BuildArguments(string file, string bundle, string trustedRootFile) =>
    [
        "attestation", "verify", file,
        "--bundle", bundle,
        "--custom-trusted-root", trustedRootFile,
        "--repo", SetupLayout.Repository,
        "--cert-identity", SetupLayout.CertificateIdentity,
        "--deny-self-hosted-runners",
        "--format", "json",
    ];

    public IReadOnlyList<AttestationFacts> Verify(string file, string fileSha256, string bundle)
    {
        var spec = new ProcessSpec(ghExecutable, BuildArguments(file, bundle, trustedRoot), environment, workingDirectory, Capture: true, Timeout);
        var result = runner.Run(spec);
        var name = Path.GetFileName(file);
        if (result.TimedOut) throw new SetupRefusal("gh_timeout", $"gh attestation verify did not finish for {name}");
        if (result.OutputTooLarge) throw new SetupRefusal("gh_output", $"gh printed too much for {name}");
        if (result.ExitCode != 0) throw new SetupRefusal("gh_verify_failed", $"{name}: {FirstLine(result.StandardError)}");
        try
        {
            return AttestationPolicy.Evaluate(result.StandardOutput, fileSha256);
        }
        catch (SetupRefusal refusal)
        {
            throw new SetupRefusal(refusal.Code, $"{name}: {refusal.Message}");
        }
    }

    /// <summary>One printable line of gh's complaint (control characters dropped, 300 characters at most).</summary>
    public static string FirstLine(string text)
    {
        var line = text.Replace("\r", "").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? "(no message)";
        return new string(line.Where(c => c >= ' ' && c != '\u007f').Take(300).ToArray());
    }
}
