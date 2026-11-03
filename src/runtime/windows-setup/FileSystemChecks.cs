using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Albera.Setup;

/// <summary>File hashing, link detection and the "only administrators can write here" check that every folder setup trusts has to pass.</summary>
internal static class FileSystemChecks
{
    private static readonly HashSet<string> TrustedWriters = new(StringComparer.Ordinal)
    {
        "S-1-5-18",   // LocalSystem
        "S-1-5-32-544",   // BUILTIN\Administrators
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",   // NT SERVICE\TrustedInstaller
        "S-1-3-0",   // CREATOR OWNER (a placeholder that only applies to children)
    };

    private const FileSystemRights WriteLike =
        FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes
        | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    public static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    public static bool IsReparsePoint(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;

    /// <summary>A link or junction at `path` or on any folder of its path (drive root excluded).</summary>
    public static bool PathHasReparsePoint(string path)
    {
        var current = Path.GetFullPath(path).TrimEnd('\\');
        while (!string.IsNullOrEmpty(current) && Path.GetPathRoot(current)?.TrimEnd('\\') != current)
        {
            if ((File.Exists(current) || Directory.Exists(current)) && IsReparsePoint(current)) return true;
            current = Path.GetDirectoryName(current) ?? string.Empty;
        }
        return false;
    }

    /// <summary>
    /// What is wrong with a folder that setup would trust: its owner is not SYSTEM, Administrators or TrustedInstaller, or an allow rule that applies to the folder itself
    /// lets anyone else write, delete, change permissions or take ownership. Empty = only administrators can change it.
    /// </summary>
    public static IReadOnlyList<string> AdministratorOnlyProblems(string folder)
    {
        var problems = new List<string>();
        var security = new DirectoryInfo(folder).GetAccessControl();
        var owner = security.GetOwner(typeof(SecurityIdentifier))?.Value ?? "(none)";
        if (!TrustedWriters.Contains(owner)) problems.Add($"owner {owner} is not SYSTEM, Administrators or TrustedInstaller");
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
            var sid = rule.IdentityReference.Value;
            if (TrustedWriters.Contains(sid)) continue;
            var rights = rule.FileSystemRights & WriteLike;
            if (rights != 0) problems.Add($"{sid} may {rights}");
        }
        return problems;
    }
}
