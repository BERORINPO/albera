namespace Albera.Setup;

/// <summary>
/// How setup starts the installer script (scripts/host/albera-host.ps1, owned by PR7): the verified COPY of the script, Windows PowerShell 5.1 by full path, the rebuilt
/// environment, the repo folder made of the verified copies, the tree hash that came from the attested build-hashes.json (nothing is typed) and the run id of the attestation.
/// <c>-SetupRunId</c> is new in this PR: PR7 adds the parameter, records it as <c>setupRunId</c> in the install record and refuses an older run id. Until then the current script
/// rejects the unknown parameter, which is the safe failure.
/// </summary>
internal static class EngineLaunch
{
    public static ProcessSpec Build(string copyRoot, string treeHash, ulong runId, EngineOptions options, IReadOnlyDictionary<string, string> environment)
    {
        var repo = Path.Combine(copyRoot, SetupLayout.RepoDirectory);
        var script = Path.Combine(copyRoot, SetupLayout.HostScript.Replace('/', '\\'));
        var arguments = new List<string>
        {
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
            "-RepoRoot", repo, "-Mode", "install", "-ExpectedTreeHash", treeHash, "-SetupRunId", runId.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
        Add(arguments, "-ApproverKeyId", options.ApproverKeyId);
        Add(arguments, "-ApproverPublicKey", options.ApproverPublicKey);
        Add(arguments, "-ApproverSid", options.ApproverSid);
        if (options.GrantHyperVToBroker) arguments.Add("-GrantHyperVToBroker");
        Add(arguments, "-VmName", options.VmName);
        Add(arguments, "-ComputerId", options.ComputerId);
        return new ProcessSpec(SetupLayout.PowerShellExecutable, arguments, environment, SetupLayout.SystemDirectory, Capture: false, TimeSpan.FromHours(2));
    }

    private static void Add(List<string> arguments, string name, string? value)
    {
        if (value is null) return;
        arguments.Add(name);
        arguments.Add(value);
    }
}
