using System.Text;

namespace Albera.WslBridge;

/// <summary>What the bridge reads from the repository a lease names. The bridge reads it itself: the Control Plane's account may not be able to, and its word about a head is not the check.</summary>
internal interface IRepositories
{
    /// <summary>The full lowercase object id of HEAD, or null when it cannot be read.</summary>
    string? ReadHead(string repositoryPath);
    /// <summary>A bundle of HEAD (git bundle create - HEAD), or null when git failed or the bundle would be over <paramref name="maxBytes"/>.</summary>
    byte[]? MakeBundle(string repositoryPath, int maxBytes);
}

// The real thing: git run by argument list with the hardening of src/runtime/git-process.mjs (ADR-007): no hooks (core.hooksPath names a folder that is never created), no fsmonitor, no transport at
// all (it reads one local repository: not even file, and no lazy fetch for a partial clone), no credential helper, no pager, no replace refs, no system or global config, no upward search for a repository (GIT_CEILING_DIRECTORIES), a fixed environment, a deadline.
internal sealed class GitRepositories(string gitPath, string scratchFolder) : IRepositories
{
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(60);
    private const int MaxHeadOutput = 256;

    internal string[] Hardening() =>
    [
        "-c", $"core.hooksPath={Path.Combine(scratchFolder, "no-hooks")}", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=never", "-c", "transfer.fsckObjects=true",
        "-c", "fetch.fsckObjects=true", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.useReplaceRefs=false", "-c", "credential.helper=", "-c", "core.pager=cat",
    ];

    internal Dictionary<string, string> Environment(string repositoryPath)
    {
        string empty = Path.Combine(scratchFolder, "empty.gitconfig");
        if (!File.Exists(empty)) File.WriteAllBytes(empty, []);
        Dictionary<string, string> env = new(StringComparer.OrdinalIgnoreCase)
        {
            ["GIT_CONFIG_NOSYSTEM"] = "1", ["GIT_CONFIG_GLOBAL"] = empty, ["GIT_TERMINAL_PROMPT"] = "0", ["GIT_ASKPASS"] = "", ["SSH_ASKPASS"] = "", ["GIT_EDITOR"] = ":", ["GIT_PAGER"] = "cat",
            ["LC_ALL"] = "C", ["LANG"] = "C", ["HOME"] = scratchFolder, ["GIT_OPTIONAL_LOCKS"] = "0", ["GIT_NO_LAZY_FETCH"] = "1", ["GIT_CEILING_DIRECTORIES"] = Path.GetDirectoryName(repositoryPath) ?? scratchFolder,
            ["PATH"] = System.Environment.SystemDirectory + ";" + Path.GetDirectoryName(gitPath),
        };
        foreach (string name in new[] { "SYSTEMROOT", "WINDIR", "TEMP", "TMP" })
            if (System.Environment.GetEnvironmentVariable(name) is { Length: > 0 } value) env[name] = value;
        return env;
    }

    private ChildResult Git(string repositoryPath, int maxOutput, params string[] command) =>
        ChildProcess.Run(gitPath, Hardening().Concat(["-C", repositoryPath]).Concat(command), Environment(repositoryPath), maxOutput, Deadline);

    public string? ReadHead(string repositoryPath)
    {
        ChildResult result = Git(repositoryPath, MaxHeadOutput, "rev-parse", "--verify", "HEAD^{commit}");
        string text = Encoding.ASCII.GetString(result.Output).Trim();
        return result.ExitCode == 0 && !result.Truncated && Albera.BrokerContract.Wsl2RunLease.IsGitOid(text) ? text : null;
    }

    public byte[]? MakeBundle(string repositoryPath, int maxBytes)
    {
        ChildResult result = Git(repositoryPath, maxBytes, "bundle", "create", "-", "HEAD");
        return result.ExitCode == 0 && !result.Truncated && !result.TimedOut ? result.Output : null;
    }
}

internal static class BundleHeader
{
    /// <summary>The object id that `HEAD` points to in a bundle's header, or null when the header does not name exactly one ref, `HEAD`. v2 and v3 (capability lines start with '@').</summary>
    public static string? HeadOf(byte[] bundle)
    {
        int end = 0;
        List<string> refs = [];
        bool first = true;
        while (end < bundle.Length && end < 4096)
        {
            int newline = Array.IndexOf(bundle, (byte)'\n', end);
            if (newline < 0) return null;
            string line = Encoding.ASCII.GetString(bundle, end, newline - end);
            end = newline + 1;
            if (first) { first = false; if (line is not ("# v2 git bundle" or "# v3 git bundle")) return null; continue; }
            if (line.Length == 0) break;
            if (line.StartsWith('-')) return null; // a prerequisite: not a full bundle
            if (line.StartsWith('@')) continue; // a capability
            refs.Add(line);
        }
        if (refs.Count != 1) return null;
        string[] parts = refs[0].Split(' ');
        return parts.Length == 2 && parts[1] == "HEAD" && Albera.BrokerContract.Wsl2RunLease.IsGitOid(parts[0]) ? parts[0] : null;
    }
}
