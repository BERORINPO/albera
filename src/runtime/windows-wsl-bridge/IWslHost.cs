using System.Text.RegularExpressions;

namespace Albera.WslBridge;

/// <summary>The WSL and kernel versions as `wsl --version` reports them.</summary>
internal sealed record WslVersions(Version Wsl, Version Kernel);

/// <summary>The resident agent's process: its stdin and stdout are the agent's frames (agent.c). Kill ends the process; HasExited is true once it has.</summary>
internal interface IAgentProcess : IDisposable
{
    Stream ToAgent { get; }
    Stream FromAgent { get; }
    bool HasExited { get; }
    void Kill();
}

/// <summary>Everything the bridge does with `wsl.exe`. The real one is WslExeHost; the harness has a fake. Every name given here was made by <see cref="RunName"/>.</summary>
internal interface IWslHost
{
    WslVersions? ReadVersions();
    /// <summary>Every registered distribution's name, or null when the list cannot be read.</summary>
    IReadOnlyList<string>? ListDistributions();
    bool Import(string name, string folder, string imagePath);
    IAgentProcess? StartAgent(string name);
    void Terminate(string name);
    bool Unregister(string name);
}

/// <summary>The one place a distribution name is made or accepted. Only names that start with `albera-run-` and are plain lowercase can pass, so nothing here can name the owner's Ubuntu or docker-desktop.</summary>
internal static class RunName
{
    public const string Prefix = "albera-run-";
    private static readonly Regex NameRegex = new(@"^albera-run-[a-z0-9][a-z0-9-]{0,47}\z", RegexOptions.CultureInvariant); // \z: $ would also pass a final line feed

    public static bool IsRunName(string name) => NameRegex.IsMatch(name);

    /// <summary>The distribution name for an operation id, or null when the id is not plain lowercase (then the run is refused rather than renamed).</summary>
    public static string? For(string operationId) => IsRunName(Prefix + operationId) ? Prefix + operationId : null;

    public static string Require(string name) => IsRunName(name) ? name : throw new ArgumentException("not a run distribution name", nameof(name));
}
