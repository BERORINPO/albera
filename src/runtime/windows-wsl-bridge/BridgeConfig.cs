using System.Text.Json;

namespace Albera.WslBridge;

internal sealed record RepositoryEntry(string RepositoryId, string Path);

// The bridge's configuration: one small JSON file written by the installer (admin-writable only, PathGuard), read once at start. Exactly these keys:
//   { "pipeName": "ALBERA_WslBridge", "controlPlaneSid": "S-1-5-21-...", "computerId": "pc-wsl",
//     "brokerKeyId": "broker-2026-a", "brokerSpki": "<base64 SubjectPublicKeyInfo, ECDSA P-256>", "minLeaseGeneration": 1,
//     "imagePath": "C:\\...\\albera-wsl2.tar", "imageSha256": "<64 lowercase hex>", "distributionsFolder": "C:\\...", "stateFolder": "C:\\...", "gitPath": "C:\\...\\git.exe",
//     "minWslVersion": "2.4.0", "minKernelVersion": "6.6.87", "floorExpiresAt": 1800000000,
//     "repositories": [ { "repositoryId": "repo-alpha", "path": "C:\\...\\repo" } ] }
// `computerId` is this bridge's own: a lease for another computer is refused. `repositories` maps the lease's repositoryId to the folder the bridge reads (1 to 8 entries, each id and path once);
// the Control Plane never names a path. `minLeaseGeneration` is the oldest lease generation the bridge accepts (raising it revokes older leases). The floor has an expiry (ADR-012, decision 12).
// Every rejected value maps to one fixed reason word (never the value itself), so a log line cannot be steered by file content.
internal sealed record BridgeConfig(string PipeName, string ControlPlaneSid, string ComputerId, string BrokerKeyId, byte[] BrokerSpki, long MinLeaseGeneration, string ImagePath, string ImageSha256,
    string DistributionsFolder, string StateFolder, string GitPath, Floor Floor, IReadOnlyDictionary<string, string> Repositories)
{
    private const int MaxFileBytes = 8192, MaxPipeNameLength = 128, MaxPathLength = 240, MaxRepositories = 8;
    private static readonly string[] Keys = ["pipeName", "controlPlaneSid", "computerId", "brokerKeyId", "brokerSpki", "minLeaseGeneration", "imagePath", "imageSha256",
        "distributionsFolder", "stateFolder", "gitPath", "minWslVersion", "minKernelVersion", "floorExpiresAt", "repositories"];
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    /// <summary>The only reason words ever printed (BRIDGE_CONFIG=invalid:word).</summary>
    internal static class Why
    {
        public const string ConfigPath = "config_path", Unreadable = "config_unreadable", TooLarge = "config_too_large", Syntax = "config_syntax", Keys = "config_keys", PipeName = "pipe_name",
            ControlPlaneSid = "control_plane_sid", ComputerId = "computer_id", BrokerKey = "broker_key", Generation = "lease_generation", Image = "image", ImageHash = "image_hash_format",
            Folder = "folder", GitPath = "git_path", Floor = "floor", Repositories = "repositories", ConfigUntrusted = "config_untrusted", ImageUntrusted = "image_untrusted",
            GitUntrusted = "git_untrusted", StateUntrusted = "state_untrusted", FolderUntrusted = "folder_untrusted";
    }

    public static BridgeConfig? TryLoad(string configPath, PathGuard adminGuard, out string reason)
    {
        reason = Why.ConfigPath;
        if (!IsPlainAbsolutePath(configPath)) return null;
        byte[] bytes;
        try
        {
            using FileStream file = new(configPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!adminGuard.IsTrusted(configPath)) { reason = Why.ConfigUntrusted; return null; }
            if (file.Length > MaxFileBytes) { reason = Why.TooLarge; return null; }
            bytes = new byte[file.Length];
            file.ReadExactly(bytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { reason = Why.Unreadable; return null; }
        return TryParse(bytes, out reason);
    }

    /// <summary>The image, git and the two folders must exist and be trusted (adminGuard for what the bridge only reads, ownerGuard for what it writes). Null when all are; otherwise a reason word.</summary>
    public string? CheckPaths(PathGuard adminGuard, PathGuard ownerGuard)
    {
        if (!File.Exists(ImagePath) || !adminGuard.IsTrusted(ImagePath) || !adminGuard.IsTrusted(Path.GetDirectoryName(ImagePath)!)) return Why.ImageUntrusted;
        if (!File.Exists(GitPath) || !adminGuard.IsTrusted(GitPath)) return Why.GitUntrusted;
        if (!Directory.Exists(StateFolder) || !ownerGuard.IsTrusted(StateFolder)) return Why.StateUntrusted;
        return Directory.Exists(DistributionsFolder) && ownerGuard.IsTrusted(DistributionsFolder) ? null : Why.FolderUntrusted;
    }

    internal static BridgeConfig? TryParse(byte[] json, out string reason)
    {
        reason = Why.Syntax;
        ReadOnlyMemory<byte> text = json.AsSpan().StartsWith(Utf8Bom) ? json.AsMemory(Utf8Bom.Length) : json;
        JsonDocument document;
        try { document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 4 }); }
        catch (JsonException) { return null; }
        using (document)
        {
            JsonElement root = document.RootElement;
            reason = Why.Keys;
            if (root.ValueKind != JsonValueKind.Object) return null;
            HashSet<string> seen = new(StringComparer.Ordinal);
            foreach (JsonProperty property in root.EnumerateObject()) if (!seen.Add(property.Name)) return null; // a repeated key is ambiguous
            if (!seen.SetEquals(Keys)) return null;
            return Build(root, out reason);
        }
    }

    private static string? Text(JsonElement root, string name) => root.GetProperty(name).ValueKind == JsonValueKind.String ? root.GetProperty(name).GetString() : null;

    private static BridgeConfig? Build(JsonElement root, out string reason)
    {
        string? pipe = Text(root, "pipeName"), sid = Text(root, "controlPlaneSid"), computer = Text(root, "computerId"), keyId = Text(root, "brokerKeyId"), spki = Text(root, "brokerSpki");
        string? image = Text(root, "imagePath"), hash = Text(root, "imageSha256"), distributions = Text(root, "distributionsFolder"), state = Text(root, "stateFolder"), git = Text(root, "gitPath");
        reason = Why.PipeName;
        if (pipe is null || !IsPlainPipeName(pipe)) return null;
        reason = Why.ControlPlaneSid;
        if (sid is null || SidRules.TryParseSid(sid) is null) return null;
        reason = Why.ComputerId;
        if (computer is null || !Wire.IsId(computer)) return null;
        reason = Why.BrokerKey;
        byte[]? spkiBytes = TryBase64(spki);
        if (keyId is null || !Wire.IsId(keyId) || spkiBytes is null) return null;
        using (BrokerKey? probe = BrokerKey.TryCreate(keyId, spkiBytes)) if (probe is null) return null;
        reason = Why.Generation;
        if (!TryCounter(root, "minLeaseGeneration", out long generation)) return null;
        reason = Why.Image;
        if (image is null || !IsPlainAbsolutePath(image)) return null;
        reason = Why.ImageHash;
        if (hash is null || hash.Length != 64 || !hash.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')) return null;
        reason = Why.Folder;
        if (distributions is null || state is null || !IsPlainAbsolutePath(distributions) || !IsPlainAbsolutePath(state)) return null;
        reason = Why.GitPath;
        if (git is null || !IsPlainAbsolutePath(git)) return null;
        reason = Why.Floor;
        if (Text(root, "minWslVersion") is not { } wslText || Text(root, "minKernelVersion") is not { } kernelText || !Version.TryParse(wslText, out Version? wsl) || !Version.TryParse(kernelText, out Version? kernel)
            || !TryCounter(root, "floorExpiresAt", out long expires)) return null;
        reason = Why.Repositories;
        if (ReadRepositories(root.GetProperty("repositories")) is not { } repositories) return null;
        reason = "";
        return new BridgeConfig(pipe, sid, computer, keyId, spkiBytes, generation, image, hash, distributions, state, git, new Floor(wsl, kernel, expires), repositories);
    }

    private static bool TryCounter(JsonElement root, string name, out long value)
    {
        value = 0;
        JsonElement element = root.GetProperty(name);
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out value) && value is >= 1 and <= Albera.BrokerContract.StrictJson.MaxSafeInteger;
    }

    private static byte[]? TryBase64(string? text)
    {
        if (text is null) return null;
        try { return Convert.FromBase64String(text); }
        catch (FormatException) { return null; }
    }

    private static IReadOnlyDictionary<string, string>? ReadRepositories(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() is < 1 or > MaxRepositories) return null;
        Dictionary<string, string> map = new(StringComparer.Ordinal);
        foreach (JsonElement entry in element.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object) return null;
            HashSet<string> names = new(StringComparer.Ordinal);
            foreach (JsonProperty property in entry.EnumerateObject()) if (!names.Add(property.Name)) return null;
            if (!names.SetEquals(["repositoryId", "path"]) || Text(entry, "repositoryId") is not { } id || Text(entry, "path") is not { } path) return null;
            if (!Wire.IsId(id) || !IsPlainAbsolutePath(path) || !map.TryAdd(id, path) || map.Values.Count(value => value == path) > 1) return null;
        }
        return map;
    }

    internal static bool IsPlainPipeName(string name) =>
        name.Length is >= 1 and <= MaxPipeNameLength && char.IsAsciiLetterOrDigit(name[0]) && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.');

    // "C:\dir\file": a local drive path, already in the form GetFullPath would return. That rules out relative and drive-relative paths, UNC and \\?\ \\.\ device prefixes, '..' and '.' segments,
    // '/' separators, doubled separators, trailing dots or spaces, alternate data streams and device names, without trying to canonicalise a hostile string.
    internal static bool IsPlainAbsolutePath(string path)
    {
        if (path.Length is < 4 or > MaxPathLength || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
        if (path[^1] == '\\' || path.IndexOf(':', 2) >= 0 || path.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || path.IndexOfAny(['*', '?']) >= 0) return false;
        try { return string.Equals(Path.GetFullPath(path), path, StringComparison.Ordinal); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException) { return false; }
    }
}
