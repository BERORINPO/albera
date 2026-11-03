namespace Albera.Setup;

/// <summary>
/// Copies the parts of the update folder setup knows about into the administrator-only work folder. Only the main data stream of a regular file is copied (a stream copy, not
/// CopyFile, so alternate data streams stay behind); a link or junction anywhere in the source is refused. Everything is verified on the copies, never on the source.
/// </summary>
internal sealed class UpdateCopy(string sourceRoot, string destinationRoot, int maxFiles = UpdateCopy.DefaultMaxFiles, long maxBytes = UpdateCopy.DefaultMaxBytes)
{
    public const int DefaultMaxFiles = 20_000;
    public const long DefaultMaxBytes = 4L * 1024 * 1024 * 1024;

    private readonly HashSet<string> _copied = new(StringComparer.Ordinal);
    private int _files;
    private long _bytes;

    public int FilesCopied => _files;
    public long BytesCopied => _bytes;

    /// <summary>Copies one file; a file that was already copied (an attested exe is also inside its publish folder) is left as it is.</summary>
    public void CopyFile(string relative)
    {
        var source = Resolve(sourceRoot, relative);
        if (_copied.Contains(relative)) return;
        RequireRegularChain(sourceRoot, relative);
        if (!File.Exists(source)) throw new SetupRefusal("update_file_missing", relative);
        var destination = Resolve(destinationRoot, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        using var input = File.OpenRead(source);
        Count(relative, input.Length);
        using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        input.CopyTo(output);
        _copied.Add(relative);
    }

    public void CopyTree(string relativeDirectory)
    {
        var source = Resolve(sourceRoot, relativeDirectory);
        RequireRegularChain(sourceRoot, relativeDirectory);
        if (!Directory.Exists(source)) throw new SetupRefusal("update_folder_missing", relativeDirectory);
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
        {
            var relative = relativeDirectory.TrimEnd('/') + "/" + Path.GetRelativePath(source, file).Replace('\\', '/');
            CopyFile(relative);
        }
        RequireNoLinksBelow(source, relativeDirectory);
    }

    /// <summary>`relative` uses '/', has no empty, '.', '..' or drive parts and no characters Windows treats specially in a name.</summary>
    public static string Resolve(string root, string relative)
    {
        if (string.IsNullOrEmpty(relative) || relative.StartsWith('/') || relative.EndsWith('/') || relative.Contains('\\') || relative.Contains(':'))
            throw new SetupRefusal("update_path", $"not a plain relative path: {relative}");
        foreach (var part in relative.Split('/'))
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith('.') || part.EndsWith(' ') || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new SetupRefusal("update_path", $"not a plain relative path: {relative}");
        return Path.Combine(root, relative.Replace('/', '\\'));
    }

    private void Count(string relative, long length)
    {
        if (++_files > maxFiles) throw new SetupRefusal("update_too_many_files", $"more than {maxFiles} files (at {relative})");
        _bytes += length;
        if (_bytes > maxBytes) throw new SetupRefusal("update_too_large", $"more than {maxBytes} bytes (at {relative})");
    }

    /// <summary>No folder or file on the way from the update root to `relative` is a link or junction.</summary>
    private static void RequireRegularChain(string root, string relative)
    {
        var current = root;
        foreach (var part in relative.Split('/'))
        {
            current = Path.Combine(current, part);
            if ((File.Exists(current) || Directory.Exists(current)) && FileSystemChecks.IsReparsePoint(current))
                throw new SetupRefusal("update_link", $"{relative} passes through a link or junction");
        }
    }

    private static void RequireNoLinksBelow(string source, string relativeDirectory)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(source, "*", SearchOption.AllDirectories))
            if (FileSystemChecks.IsReparsePoint(entry))
                throw new SetupRefusal("update_link", $"{relativeDirectory}/{Path.GetRelativePath(source, entry).Replace('\\', '/')} is a link or junction");
    }
}
