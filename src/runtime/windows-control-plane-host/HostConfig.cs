using System.Text.Json;

// The host's configuration (docs/architecture/control-plane-service.md section 2 and 3): `control-plane-config\AlberaControlPlane.service.json`, written by
// setup, read once when the service starts. The file is also read by the room (the `claude` block and the credential choice, later PRs), so the host reads
// only its own top-level key `host` and ignores every other top-level key. Inside `host` the keys are EXACTLY these, nothing else, each once:
//   { "host": {
//       "nodePath":      "C:\\Program Files\\nodejs\\node.exe",              file name node.exe
//       "nodeSha256":    "<64 lowercase hex>",                               the host refuses to start node when the file differs (LaunchGate.cs)
//       "appPath":       "C:\\Program Files\\Albera\\bin\\control-plane\\app", the app tree; the entry is <appPath>\src\runtime\entry.mjs
//       "dataRoot":      "C:\\ProgramData\\Albera",                          passed to the child as `--data-root`; the child derives its folders from it
//       "logDirectory":  "C:\\ProgramData\\Albera\\control-plane\\logs",     must exist (setup creates it with its final ACL)
//       "logMaxBytes":   1048576,                                            cap of each log file; at the cap a file moves to <name>.1 (one backup)
//       "maxRestarts":   5,                                                  restarts after an ending child before the host gives up (exit 77)
//       "restartDelayMs": 5000,                                              wait before each restart
//       "stableRunMs":   60000 } }                                           a run at least this long resets the restart count
// The file must be owned and writable only by SYSTEM, Administrators (or TrustedInstaller): the Control Plane identity has READ only (PathGuard.cs).
// Every rejected value maps to one fixed reason word (never the value itself), so a log line cannot be steered by file content.
internal sealed record HostConfig(string NodePath, string NodeSha256, string AppPath, string DataRoot, string LogDirectory, int LogMaxBytes, int MaxRestarts, TimeSpan RestartDelay, TimeSpan StableRun)
{
    internal const string HostKey = "host";
    private const int MaxFileBytes = 16 * 1024;
    private const int MaxPathLength = 240;
    private const int MinLogMaxBytes = 8 * 1024, MaxLogMaxBytes = 64 * 1024 * 1024;
    private const int MaxMaxRestarts = 20;
    private const int MinRestartDelayMs = 100, MaxRestartDelayMs = 10_000; // below the SCM's start wait hint, so a failing first start still reports progress
    private const int MinStableRunMs = 500, MaxStableRunMs = 3_600_000;
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];
    private static readonly string[] Keys = ["nodePath", "nodeSha256", "appPath", "dataRoot", "logDirectory", "logMaxBytes", "maxRestarts", "restartDelayMs", "stableRunMs"];

    /// <summary>The path of the entry script inside the app tree. The room-service command lives behind it; the arguments are fixed in ChildLauncher.</summary>
    internal string EntryPath => Path.Combine(AppPath, "src", "runtime", "entry.mjs");

    internal static class Reason
    {
        public const string ConfigPath = "config_path", Unreadable = "config_unreadable", TooLarge = "config_too_large", Syntax = "config_syntax", Keys = "config_keys",
            NodePath = "node_path", NodeSha256 = "node_sha256", AppPath = "app_path", DataRoot = "data_root", LogDirectory = "log_directory",
            LogMaxBytes = "log_max_bytes", MaxRestarts = "max_restarts", RestartDelay = "restart_delay", StableRun = "stable_run", ConfigUntrusted = "config_untrusted";
    }

    public static HostConfig? TryLoad(string configPath, out string reason)
    {
        reason = Reason.ConfigPath;
        if (!IsPlainAbsolutePath(configPath)) return null;
        byte[] bytes;
        try
        {
            using FileStream file = new(configPath, FileMode.Open, FileAccess.Read, FileShare.Read); // not replaceable or writable while it is read
            if (!PathGuard.IsTrustedConfigFile(configPath, file)) { reason = Reason.ConfigUntrusted; return null; }
            if (file.Length > MaxFileBytes) { reason = Reason.TooLarge; return null; }
            bytes = new byte[file.Length];
            file.ReadExactly(bytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            reason = Reason.Unreadable;
            return null;
        }
        return TryParse(bytes, out reason);
    }

    internal static HostConfig? TryParse(byte[] json, out string reason)
    {
        reason = Reason.Syntax;
        ReadOnlyMemory<byte> text = json.AsSpan().StartsWith(Utf8Bom) ? json.AsMemory(Utf8Bom.Length) : json; // Windows PowerShell 5.1 writes a BOM with -Encoding UTF8
        JsonDocument document;
        try { document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 16 }); }
        catch (JsonException) { return null; }
        using (document)
        {
            reason = Reason.Keys;
            if (document.RootElement.ValueKind != JsonValueKind.Object || !HasUniqueNames(document.RootElement)) return null;
            if (!document.RootElement.TryGetProperty(HostKey, out JsonElement host) || host.ValueKind != JsonValueKind.Object || !HasUniqueNames(host)) return null;
            if (!host.EnumerateObject().Select(p => p.Name).ToHashSet(StringComparer.Ordinal).SetEquals(Keys)) return null;
            return Build(host, out reason);
        }
    }

    private static HostConfig? Build(JsonElement host, out string reason)
    {
        string? node = Text(host, "nodePath"), sha = Text(host, "nodeSha256"), app = Text(host, "appPath"), data = Text(host, "dataRoot"), logs = Text(host, "logDirectory");
        reason = Reason.NodePath;
        if (node is null || !IsPlainAbsolutePath(node) || !string.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase)) return null;
        reason = Reason.NodeSha256;
        if (sha is null || !IsLowerHex64(sha)) return null;
        reason = Reason.AppPath;
        if (app is null || !IsPlainAbsolutePath(app) || !Directory.Exists(app)) return null;
        reason = Reason.DataRoot;
        if (data is null || !IsPlainAbsolutePath(data) || !Directory.Exists(data)) return null;
        reason = Reason.LogDirectory;
        if (logs is null || !IsPlainAbsolutePath(logs) || !Directory.Exists(logs)) return null;
        reason = Reason.LogMaxBytes;
        if (!InRange(host, "logMaxBytes", MinLogMaxBytes, MaxLogMaxBytes, out int logMax)) return null;
        reason = Reason.MaxRestarts;
        if (!InRange(host, "maxRestarts", 0, MaxMaxRestarts, out int maxRestarts)) return null;
        reason = Reason.RestartDelay;
        if (!InRange(host, "restartDelayMs", MinRestartDelayMs, MaxRestartDelayMs, out int delayMs)) return null;
        reason = Reason.StableRun;
        if (!InRange(host, "stableRunMs", MinStableRunMs, MaxStableRunMs, out int stableMs)) return null;
        reason = "";
        return new HostConfig(node, sha, app, data, logs, logMax, maxRestarts, TimeSpan.FromMilliseconds(delayMs), TimeSpan.FromMilliseconds(stableMs));
    }

    // A repeated name is ambiguous (a parser would pick one silently): refuse it.
    private static bool HasUniqueNames(JsonElement element)
    {
        HashSet<string> seen = new(StringComparer.Ordinal);
        return element.EnumerateObject().All(p => seen.Add(p.Name));
    }

    private static string? Text(JsonElement host, string name) => host.GetProperty(name).ValueKind == JsonValueKind.String ? host.GetProperty(name).GetString() : null;

    private static bool InRange(JsonElement host, string name, int min, int max, out int value)
    {
        value = 0;
        JsonElement element = host.GetProperty(name);
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out value) && value >= min && value <= max;
    }

    internal static bool IsLowerHex64(string text) => text.Length == 64 && text.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    // "C:\dir\file": a local drive path, already in the form GetFullPath would return. That rules out relative and drive-relative paths, UNC and
    // \\?\ \\.\ device prefixes, '..' and '.' segments, '/' separators, doubled separators, trailing dots or spaces, alternate data streams and
    // device names, without trying to canonicalise a hostile string (the file is then opened exactly as written).
    internal static bool IsPlainAbsolutePath(string path)
    {
        if (path.Length is < 4 or > MaxPathLength || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
        if (path[^1] == '\\' || path.IndexOf(':', 2) >= 0 || path.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || path.IndexOfAny(['*', '?']) >= 0) return false;
        try { return string.Equals(Path.GetFullPath(path), path, StringComparison.Ordinal); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException) { return false; }
    }
}
