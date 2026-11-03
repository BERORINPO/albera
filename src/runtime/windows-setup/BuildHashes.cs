using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Albera.Setup;

/// <summary>component name -> (relative path with '/' -> SHA-256, 64 lowercase hex)</summary>
internal sealed class FileHashes : Dictionary<string, Dictionary<string, string>>
{
    public FileHashes() : base(StringComparer.Ordinal) { }
}

/// <summary>The attested build-hashes.json (scripts/host/albera-host.ps1 -Mode hashes): a tree hash and the SHA-256 of every published file of the three components.</summary>
internal sealed record BuildHashesDocument(string TreeHash, FileHashes Files);

internal static class BuildHashes
{
    public static BuildHashesDocument Parse(byte[] json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw Bad("not an object");
            if (!root.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var v) || v != 1) throw Bad("version is not 1");
            var treeHash = Text(root, "treeHash");
            if (!IsHash(treeHash)) throw Bad("treeHash is not 64 lowercase hex");
            if (!root.TryGetProperty("components", out var components) || components.ValueKind != JsonValueKind.Object) throw Bad("components missing");
            var files = new FileHashes();
            foreach (var component in components.EnumerateObject())
            {
                if (SetupLayout.Components.All(c => c.Name != component.Name)) throw Bad($"unknown component {component.Name}");
                files[component.Name] = ReadFiles(component);
            }
            foreach (var expected in SetupLayout.Components)
                if (!files.ContainsKey(expected.Name)) throw Bad($"component {expected.Name} missing");
            return new BuildHashesDocument(treeHash!, files);
        }
        catch (JsonException error)
        {
            throw Bad($"not valid JSON ({error.Message})");
        }
    }

    private static Dictionary<string, string> ReadFiles(JsonProperty component)
    {
        if (component.Value.ValueKind != JsonValueKind.Object || !component.Value.TryGetProperty("files", out var list) || list.ValueKind != JsonValueKind.Object) throw Bad($"{component.Name}.files missing");
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var file in list.EnumerateObject())
        {
            var hash = file.Value.ValueKind == JsonValueKind.String ? file.Value.GetString() : null;
            if (!IsHash(hash)) throw Bad($"{component.Name}/{file.Name} has no 64 lowercase hex hash");
            if (!files.TryAdd(file.Name, hash!)) throw Bad($"{component.Name}/{file.Name} appears twice");
        }
        if (files.Count == 0) throw Bad($"{component.Name} lists no file");
        return files;
    }

    /// <summary>
    /// The canonical tree hash, the same rule as Get-CanonicalTreeHash in scripts/host/albera-host-lib.ps1 (a test runs both on the same input): for each component in the fixed order,
    /// each file sorted by ordinal comparison of its relative path, one line "component/path TAB sha256 LF"; the SHA-256 of the UTF-8 bytes of all lines, lowercase hex.
    /// </summary>
    public static string CanonicalTreeHash(FileHashes files)
    {
        if (files.Count != SetupLayout.Components.Count) throw Bad("tree hash needs exactly the three components");
        var text = new StringBuilder();
        foreach (var component in SetupLayout.Components)
        {
            if (!files.TryGetValue(component.Name, out var list) || list.Count == 0) throw Bad($"{component.Name} has no file");
            var paths = list.Keys.ToList();
            paths.Sort(StringComparer.Ordinal);
            foreach (var path in paths)
            {
                if (path.Length == 0 || path.StartsWith('/') || path.Contains("..") || path.Contains(':') || path.Contains('\t') || path.Contains('\n') || path.Contains('\\')) throw Bad($"{component.Name}: unusable path");
                if (!IsHash(list[path])) throw Bad($"{component.Name}/{path}: not a hash");
                text.Append(component.Name).Append('/').Append(path).Append('\t').Append(list[path]).Append('\n');
            }
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString()))).ToLowerInvariant();
    }

    /// <summary>The SHA-256 of every file under the three publish folders of `repoRoot` (the copies), keyed like build-hashes.json.</summary>
    public static FileHashes HashPublishFolders(string repoRoot)
    {
        var files = new FileHashes();
        foreach (var component in SetupLayout.Components)
        {
            var folder = UpdateCopy.Resolve(repoRoot, component.PublishDirectory);
            var list = new Dictionary<string, string>(StringComparer.Ordinal);
            if (Directory.Exists(folder))
                foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
                    list[Path.GetRelativePath(folder, file).Replace('\\', '/')] = FileSystemChecks.Sha256(file);
            files[component.Name] = list;
        }
        return files;
    }

    /// <summary>The first path (in a fixed order) whose hash differs between the attested list and the copies, or null when they are the same.</summary>
    public static string? FirstDifference(FileHashes attested, FileHashes actual)
    {
        foreach (var component in SetupLayout.Components)
        {
            var expected = attested[component.Name];
            var found = actual[component.Name];
            foreach (var path in expected.Keys.Union(found.Keys).OrderBy(p => p, StringComparer.Ordinal))
            {
                var inExpected = expected.TryGetValue(path, out var want);
                var inFound = found.TryGetValue(path, out var have);
                if (!inExpected) return $"{component.Name}/{path} is not in the attested list";
                if (!inFound) return $"{component.Name}/{path} is missing";
                if (!string.Equals(want, have, StringComparison.Ordinal)) return $"{component.Name}/{path} differs";
            }
        }
        return null;
    }

    public static bool IsHash(string? value) => value is { Length: 64 } && value.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static SetupRefusal Bad(string why) => new("build_hashes", $"build-hashes.json: {why}");
}
