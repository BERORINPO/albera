namespace Albera.Setup;

/// <summary>The three folders Windows reports (SHGetKnownFolderPath / GetSystemDirectory), never an environment variable.</summary>
internal sealed record KnownFolders(string SystemDirectory, string ProgramFiles, string ProgramData);

/// <summary>
/// The environment of every child process is BUILT from this list, never filtered from setup's own: the owner's account can set values in HKCU\Environment that reach an
/// elevated process (COR_PROFILER, CORECLR_ENABLE_PROFILING, DOTNET_STARTUP_HOOKS, __COMPAT_LAYER, GH_* and so on). Nothing that is not named here is passed on. PSModulePath is named, with the system module folder as its only value, because when it is unset PowerShell fills it in from the owner's profile and registry.
/// Every value is a constant or a path inside setup's own administrator-only work folder.
/// </summary>
internal static class SetupEnvironment
{
    /// <summary>Refuses unless Windows reports the standard places (the same rule as Test-FixedFolders in scripts/host/albera-host-lib.ps1).</summary>
    public static void RequireStandardFolders(KnownFolders folders)
    {
        var problems = new List<string>();
        if (!Same(folders.SystemDirectory, SetupLayout.SystemDirectory)) problems.Add("system_directory_not_C:\\Windows\\System32");
        if (!Same(folders.ProgramFiles, SetupLayout.ProgramFilesDirectory)) problems.Add("program_files_not_C:\\Program Files");
        if (!Same(folders.ProgramData, SetupLayout.ProgramDataDirectory)) problems.Add("program_data_not_C:\\ProgramData");
        if (problems.Count > 0) throw new SetupRefusal("folders_not_standard", string.Join(", ", problems));
    }

    /// <summary>The module folder of Windows PowerShell 5.1. Without a value, 5.1 adds the user's own Documents\WindowsPowerShell\Modules and the user-scope PSModulePath from the registry.</summary>
    public const string PowerShellModulePath = @"C:\Windows\System32\WindowsPowerShell\v1.0\Modules";

    /// <summary>SystemRoot, windir, ProgramFiles, ProgramData, a fresh administrator-only TEMP (and TMP, which Windows looks at first), PATH = System32 and PSModulePath = the system module folder only.</summary>
    public static IReadOnlyDictionary<string, string> ForEngine(string tempDirectory) => Base(tempDirectory);

    private static SortedDictionary<string, string> Base(string tempDirectory)
    {
        RequireInside(tempDirectory);
        return new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = SetupLayout.SystemRoot,
            ["windir"] = SetupLayout.SystemRoot,
            ["ProgramFiles"] = SetupLayout.ProgramFilesDirectory,
            ["ProgramData"] = SetupLayout.ProgramDataDirectory,
            ["TEMP"] = tempDirectory,
            ["TMP"] = tempDirectory,
            ["PATH"] = SetupLayout.SystemDirectory,
            ["PSModulePath"] = PowerShellModulePath,
        };
    }

    /// <summary>The same base for gh.exe plus its own home, config, cache folders (all inside setup's work folder, so gh reads nothing of the owner's profile) and switches that stop an update check, prompts, colour and telemetry. No token, no GH_HOST.</summary>
    public static IReadOnlyDictionary<string, string> ForGh(string tempDirectory, string ghHomeDirectory)
    {
        RequireInside(ghHomeDirectory);
        var environment = Base(tempDirectory);
        environment["GH_CONFIG_DIR"] = Path.Combine(ghHomeDirectory, "config");
        environment["USERPROFILE"] = Path.Combine(ghHomeDirectory, "home");
        environment["LOCALAPPDATA"] = Path.Combine(ghHomeDirectory, "local");
        environment["APPDATA"] = Path.Combine(ghHomeDirectory, "roaming");
        environment["GH_NO_UPDATE_NOTIFIER"] = "1";
        environment["GH_PROMPT_DISABLED"] = "1";
        environment["NO_COLOR"] = "1";
        environment["DO_NOT_TRACK"] = "1";
        return environment;
    }

    private static bool Same(string actual, string expected) =>
        !string.IsNullOrEmpty(actual) && string.Equals(actual.TrimEnd('\\'), expected, StringComparison.OrdinalIgnoreCase);

    private static void RequireInside(string folder)
    {
        if (string.IsNullOrEmpty(folder) || !Path.IsPathFullyQualified(folder) || folder.Contains('\0') || folder.Contains(".."))
            throw new SetupRefusal("environment_path", "a child-process folder must be a plain absolute path");
    }
}
