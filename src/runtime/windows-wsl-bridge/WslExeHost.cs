using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace Albera.WslBridge;

// The only code that starts wsl.exe (ADR-012, decisions 3 and 11). It runs the program by its fixed System32 path, with argument lists from WslArgs, and an environment of its own:
// no WSLENV (so no variable and no Windows path is handed to the guest), no PATH beyond System32, and WSL_UTF8=1 so the text is UTF-8 (measured in scripts/wsl2-gates.mjs).
internal sealed class WslExeHost : IWslHost
{
    private static readonly TimeSpan ShortCommand = TimeSpan.FromSeconds(30), ImportTime = TimeSpan.FromMinutes(3);
    private static readonly Regex VersionAtEnd = new(@"(\d+(?:\.\d+){1,3})(?:-[\w.]+)?\s*$", RegexOptions.CultureInvariant);
    private const int MaxText = 64 * 1024;
    private readonly string _wsl = Path.Combine(Environment.SystemDirectory, "wsl.exe");

    internal static IReadOnlyDictionary<string, string> ChildEnvironment()
    {
        Dictionary<string, string> env = new(StringComparer.OrdinalIgnoreCase) { ["SystemRoot"] = System.Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", ["WSL_UTF8"] = "1" };
        env["windir"] = env["SystemRoot"];
        env["PATH"] = System.Environment.SystemDirectory;
        foreach (string name in new[] { "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP" })
            if (System.Environment.GetEnvironmentVariable(name) is { Length: > 0 } value) env[name] = value;
        return env;
    }

    private ChildResult Run(string[] args, TimeSpan? timeout = null) => ChildProcess.Run(_wsl, args, ChildEnvironment(), MaxText, timeout ?? ShortCommand);

    /// <summary>The first line is WSL and the second the kernel. The label is in the user's language, so only the version number at the end of the line is read.</summary>
    internal static WslVersions? ParseVersions(string text)
    {
        string[] lines = text.Replace("\0", "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length < 2) return null;
        Match wsl = VersionAtEnd.Match(lines[0]), kernel = VersionAtEnd.Match(lines[1]);
        return wsl.Success && kernel.Success && Version.TryParse(wsl.Groups[1].Value, out Version? w) && Version.TryParse(kernel.Groups[1].Value, out Version? k) ? new WslVersions(w, k) : null;
    }

    public WslVersions? ReadVersions()
    {
        ChildResult result = Run(WslArgs.Version());
        return result.ExitCode == 0 && !result.Truncated ? ParseVersions(Encoding.UTF8.GetString(result.Output)) : null;
    }

    public IReadOnlyList<string>? ListDistributions()
    {
        ChildResult result = Run(WslArgs.List());
        if (result.ExitCode != 0 || result.Truncated) return null;
        return Encoding.UTF8.GetString(result.Output).Replace("\0", "").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => line.TrimStart('\uFEFF').Replace(" (Default)", "")).Where(line => line.Length > 0).ToList();
    }

    public bool Import(string name, string folder, string imagePath) => Run(WslArgs.Import(name, folder, imagePath), ImportTime).ExitCode == 0;

    public void Terminate(string name) => Run(WslArgs.Terminate(name));

    public bool Unregister(string name) => Run(WslArgs.Unregister(name)).ExitCode == 0;

    public IAgentProcess? StartAgent(string name)
    {
        Process process = new() { StartInfo = ChildProcess.Start(_wsl, WslArgs.Agent(name), ChildEnvironment(), pipeInput: true) };
        try { process.Start(); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { process.Dispose(); return null; }
        _ = Task.Run(() => process.StandardError.BaseStream.CopyTo(Stream.Null)); // dropped: a full pipe must not stop the agent, and nothing it says on stderr is logged
        return new AgentProcess(process);
    }

    private sealed class AgentProcess(Process process) : IAgentProcess
    {
        public Stream ToAgent => process.StandardInput.BaseStream;
        public Stream FromAgent => process.StandardOutput.BaseStream;
        public bool HasExited => process.HasExited;
        public void Kill() => ChildProcess.Kill(process);
        public void Dispose() { Kill(); process.Dispose(); }
    }
}
