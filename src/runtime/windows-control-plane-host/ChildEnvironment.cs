// The environment of the node child, built from an ALLOWLIST (docs/architecture/control-plane-service.md section 6.2 states the rule for Claude Code's child; the
// same rule applies one level up): nothing is inherited from the service's own environment. Paths come from Windows (SHGetKnownFolderPath through
// Environment.GetFolderPath), not from variables, so a variable cannot steer them. Exactly these names, nothing else:
//   SystemRoot, windir            the Windows folder
//   USERPROFILE, HOME             the service profile (C:\WINDOWS\ServiceProfiles\AlberaControlPlane for NT SERVICE\AlberaControlPlane)
//   APPDATA, LOCALAPPDATA         under that profile
//   TEMP, TMP                     <LOCALAPPDATA>\Temp (created when missing)
//   PATH                          <SystemRoot>\System32 only
// Absent by rule, whatever the service's own environment holds: NODE_OPTIONS and NODE_* (they can load code), ANTHROPIC_*, CLAUDE_*, proxy variables, and every
// secret. The credential for Claude Code is never in this environment; the room-service sets it on one spawn call only (section 6.2).
internal static class ChildEnvironment
{
    private static Func<Environment.SpecialFolder, string> folderSource = Environment.GetFolderPath;

#if ALBERA_CPHOST_TEST_SEAMS
    /// <summary>Test-only: where the folders come from (a host test cannot make Windows return an empty or relative folder).</summary>
    public static void UseFolderSource(Func<Environment.SpecialFolder, string> source) => folderSource = source;
#endif

    /// <summary>The allowlisted variables for the current process's profile. Creates the temp folder under the profile when it does not exist.
    /// Throws InvalidOperationException when Windows gives an empty or relative folder: the child would get a variable that points nowhere, or into its current directory.</summary>
    public static IReadOnlyDictionary<string, string> Create()
    {
        string windows = Absolute(Environment.SpecialFolder.Windows), userProfile = Absolute(Environment.SpecialFolder.UserProfile);
        string appData = Absolute(Environment.SpecialFolder.ApplicationData), localAppData = Absolute(Environment.SpecialFolder.LocalApplicationData);
        string temp = Path.Combine(localAppData, "Temp");
        Directory.CreateDirectory(temp);
        return From(windows, userProfile, appData, localAppData, temp);
    }

    private static string Absolute(Environment.SpecialFolder kind)
    {
        string path = folderSource(kind);
        if (string.IsNullOrEmpty(path) || !Path.IsPathFullyQualified(path)) throw new InvalidOperationException($"known folder {kind} is empty or not absolute");
        return path;
    }

    internal static IReadOnlyDictionary<string, string> From(string windows, string userProfile, string appData, string localAppData, string temp) =>
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = windows, ["windir"] = windows,
            ["USERPROFILE"] = userProfile, ["HOME"] = userProfile,
            ["APPDATA"] = appData, ["LOCALAPPDATA"] = localAppData,
            ["TEMP"] = temp, ["TMP"] = temp,
            ["PATH"] = Path.Combine(windows, "System32"),
        };

    /// <summary>The block CreateProcess wants: NAME=value, a NUL after each, sorted by name (case-insensitive), a final extra NUL.</summary>
    public static string ToBlock(IReadOnlyDictionary<string, string> variables) =>
        string.Concat(variables.OrderBy(v => v.Key, StringComparer.OrdinalIgnoreCase).Select(v => $"{v.Key}={v.Value}\0")) + "\0";
}
