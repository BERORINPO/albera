using System.Diagnostics;
using Albera.Setup;

internal static partial class Harness
{
    /// <summary>The variables the owner's account (HKCU\Environment) or an agent in its session could set, plus the ones a PowerShell or gh start reads.</summary>
    private static readonly string[] Poison =
    [
        "COR_ENABLE_PROFILING", "COR_PROFILER", "COR_PROFILER_PATH", "CORECLR_ENABLE_PROFILING", "CORECLR_PROFILER", "CORECLR_PROFILER_PATH", "COMPlus_ReadyToRun",
        "DOTNET_STARTUP_HOOKS", "DOTNET_gcServer", "__COMPAT_LAYER", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_REPO", "GH_PATH", "GH_DEBUG", "GIT_SSH_COMMAND",
        "PATHEXT", "ComSpec", "HTTPS_PROXY", "SSL_CERT_FILE", "ALBERA_LAB_VM", "ALBERA_HOST_ASSUME_NOT_ELEVATED",
    ];

    private static readonly string[] EngineKeys = ["PATH", "ProgramData", "ProgramFiles", "PSModulePath", "SystemRoot", "TEMP", "TMP", "windir"];

    private static void EnvironmentChecks()
    {
        Check("environment: the installer gets exactly SystemRoot, windir, ProgramFiles, ProgramData, TEMP, TMP, PATH = System32 and PSModulePath = the system module folder, and nothing else", () =>
        {
            var environment = SetupEnvironment.ForEngine(@"C:\Program Files\Albera\setup-work\x\tmp");
            Equal(string.Join(",", EngineKeys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase)), string.Join(",", environment.Keys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase)), "keys");
            Equal(@"C:\Windows", environment["SystemRoot"], "SystemRoot");
            Equal(@"C:\Windows", environment["windir"], "windir");
            Equal(@"C:\Windows\System32", environment["PATH"], "PATH");
            Equal(@"C:\Windows\System32\WindowsPowerShell\v1.0\Modules", environment["PSModulePath"], "PSModulePath");
            Equal(@"C:\Program Files", environment["ProgramFiles"], "ProgramFiles");
            Equal(@"C:\ProgramData", environment["ProgramData"], "ProgramData");
            Equal(@"C:\Program Files\Albera\setup-work\x\tmp", environment["TEMP"], "TEMP");
            Equal(environment["TEMP"], environment["TMP"], "TMP");
        });

        Check("environment: nothing from the calling process is passed on, whatever it holds (profiler, startup hook, compat layer, module path, tokens, proxies)", () =>
        {
            var saved = Poison.Append("PSModulePath").ToDictionary(n => n, Environment.GetEnvironmentVariable);
            try
            {
                foreach (var name in Poison.Append("PSModulePath")) Environment.SetEnvironmentVariable(name, @"C:\evil\planted");
                var engine = SetupEnvironment.ForEngine(@"C:\Program Files\Albera\setup-work\x\tmp");
                var gh = SetupEnvironment.ForGh(@"C:\Program Files\Albera\setup-work\x\tmp", @"C:\Program Files\Albera\setup-work\x\gh");
                foreach (var name in Poison)
                {
                    Assert(!engine.ContainsKey(name), $"engine environment carries {name}");
                    Assert(!gh.ContainsKey(name), $"gh environment carries {name}");
                }
                Assert(!engine.Values.Concat(gh.Values).Any(v => v.Contains("evil", StringComparison.Ordinal)), "a planted value reached a child");
            }
            finally { foreach (var (name, value) in saved) Environment.SetEnvironmentVariable(name, value); }
        });

        Check("environment: gh gets its own home, config and cache folders inside the work folder, no token, no host, and update check, prompts, colour and telemetry off", () =>
        {
            var gh = SetupEnvironment.ForGh(@"C:\Program Files\Albera\setup-work\x\tmp", @"C:\Program Files\Albera\setup-work\x\gh");
            foreach (var name in new[] { "GH_CONFIG_DIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA" })
                Assert(gh[name].StartsWith(@"C:\Program Files\Albera\setup-work\x\gh\", StringComparison.Ordinal), $"{name} is outside the work folder: {gh[name]}");
            foreach (var name in new[] { "GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED", "NO_COLOR", "DO_NOT_TRACK" }) Equal("1", gh[name], name);
            Assert(!gh.ContainsKey("GH_TOKEN") && !gh.ContainsKey("GITHUB_TOKEN") && !gh.ContainsKey("GH_HOST"), "token or host present");
        });

        Check("environment: a real child started with the built block does not see COR_PROFILER, CORECLR_*, DOTNET_STARTUP_HOOKS, __COMPAT_LAYER or the caller's PATH", RealChildCheck);

        Check("environment: only the standard Windows, Program Files and ProgramData folders are accepted", () =>
        {
            SetupEnvironment.RequireStandardFolders(new KnownFolders(@"C:\Windows\System32", @"C:\Program Files", @"C:\ProgramData"));
            SetupEnvironment.RequireStandardFolders(new KnownFolders(@"c:\windows\system32\", @"c:\program files", @"C:\ProgramData\"));
            foreach (var bad in new[]
            {
                new KnownFolders(@"D:\Windows\System32", @"C:\Program Files", @"C:\ProgramData"),
                new KnownFolders(@"C:\Windows\System32", @"C:\Users\x\Program Files", @"C:\ProgramData"),
                new KnownFolders(@"C:\Windows\System32", @"C:\Program Files", @"C:\Users\x\AppData"),
                new KnownFolders("", @"C:\Program Files", @"C:\ProgramData"),
            }) Refused("folders_not_standard", () => SetupEnvironment.RequireStandardFolders(bad));
        });

        Check("environment: a relative or dotted temp folder is refused", () =>
        {
            Refused("environment_path", () => SetupEnvironment.ForEngine("tmp"));
            Refused("environment_path", () => SetupEnvironment.ForEngine(@"C:\Program Files\Albera\..\tmp"));
            Refused("environment_path", () => SetupEnvironment.ForEngine(""));
        });

        Check("process runner: a timeout ends the one process it started (by handle) and says so", () =>
        {
            var ping = Path.Combine(SetupLayout.SystemDirectory, "ping.exe");
            if (!File.Exists(ping)) return;
            var clock = Stopwatch.StartNew();
            var result = new RealProcessRunner().Run(new ProcessSpec(ping, ["-n", "30", "127.0.0.1"], SetupEnvironment.ForEngine(Path.GetTempPath()), SetupLayout.SystemDirectory, Capture: true, TimeSpan.FromMilliseconds(700)));
            Assert(result.TimedOut, "not reported as timed out");
            Assert(clock.Elapsed < TimeSpan.FromSeconds(10), $"took {clock.Elapsed}");
        });

        Check("process runner: a program path that is not a full path is refused (no PATH lookup)", () =>
            Refused("process_path", () => new RealProcessRunner().Run(new ProcessSpec("gh.exe", [], new Dictionary<string, string>(), SetupLayout.SystemDirectory, true, TimeSpan.FromSeconds(1)))));
    }

    private static void RealChildCheck()
    {
        var cmd = Path.Combine(SetupLayout.SystemDirectory, "cmd.exe");
        if (!File.Exists(cmd)) return;
        var saved = Poison.Append("PSModulePath").ToDictionary(n => n, Environment.GetEnvironmentVariable);
        try
        {
            foreach (var name in Poison.Append("PSModulePath")) Environment.SetEnvironmentVariable(name, @"C:\evil\planted");
            Environment.SetEnvironmentVariable("COMPlus_Marker", "evil-marker");
            var temp = Path.GetTempPath().TrimEnd('\\');
            var result = new RealProcessRunner().Run(new ProcessSpec(cmd, ["/d", "/c", "set"], SetupEnvironment.ForEngine(temp), SetupLayout.SystemDirectory, Capture: true, TimeSpan.FromSeconds(30)));
            Equal(0, result.ExitCode, "cmd exit code");
            var lines = result.StandardOutput.Replace("\r", "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
            var names = lines.Select(l => l.Split('=')[0]).ToList();
            foreach (var name in Poison.Where(n => n is not ("PATHEXT" or "ComSpec")).Append("COMPlus_Marker")) Assert(!names.Contains(name, StringComparer.OrdinalIgnoreCase), $"the child sees {name}");
            Assert(!result.StandardOutput.Contains("evil", StringComparison.Ordinal), "a planted value reached the child");
            Assert(lines.Contains(@"PATH=C:\Windows\System32"), "PATH is not System32 only");
            Assert(lines.Contains(@"SystemRoot=C:\Windows"), "SystemRoot missing");
            foreach (var name in names)
                Assert(EngineKeys.Contains(name, StringComparer.OrdinalIgnoreCase) || name is "COMSPEC" or "PATHEXT" or "PROMPT" or "CMDCMDLINE" or "CMDEXTVERSION" or "ERRORLEVEL" or "HIGHESTNUMBERNODENUMBER" or "RANDOM" or "CD" or "DATE" or "TIME" or "=C:" or "=ExitCode",
                    $"unexpected variable in the child: {name}");
        }
        finally
        {
            foreach (var (name, value) in saved) Environment.SetEnvironmentVariable(name, value);
            Environment.SetEnvironmentVariable("COMPlus_Marker", null);
        }
    }
}
