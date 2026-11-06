using System.Security.AccessControl;
using System.Security.Principal;

namespace Albera.WslBridge;

// Who may change a file or folder the bridge trusts (ADR-012: "its program, its config and the image are writable by administrators only, so the file it checked is the file it imports").
// A path passes only when
//   - neither it nor any parent is a reparse point (junction, symlink, mount point),
//   - its owner is a trusted principal, and its DACL is not NULL, and
//   - no Allow ACE (inherit-only ones included) gives write-data, append-data, delete-child, delete, write-DAC, write-owner (or generic write / all) to anyone else.
// Two guards are made: AdminOnly (SYSTEM, Administrators, TrustedInstaller, CREATOR OWNER) for the program, config, image and git, and OwnerToo for the folders the bridge itself writes
// (state and distributions), where the signed-in owner may write but the Control Plane's account may not. Anything that stops the check from finishing means "not trusted".
// Not checked: the ACLs of the parent folders. BCL only; nothing here changes any ACL.
internal sealed class PathGuard
{
    private const int WriteData = 0x2, AppendData = 0x4, DeleteChild = 0x40, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000, GenericAll = 0x10000000, GenericWrite = 0x40000000;
    private const int WriteRights = WriteData | AppendData | DeleteChild | Delete | WriteDac | WriteOwner | GenericAll | GenericWrite;
    private static readonly string[] Fixed = ["S-1-5-18", "S-1-5-32-544", "S-1-3-0", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"];
    private readonly HashSet<SecurityIdentifier> _trusted;

    private PathGuard(IEnumerable<SecurityIdentifier> trusted) => _trusted = trusted.ToHashSet();

    private static IEnumerable<SecurityIdentifier> FixedSids() => Fixed.Select(sid => new SecurityIdentifier(sid));

    public static PathGuard AdminOnly(IEnumerable<SecurityIdentifier>? extra = null) => new(FixedSids().Concat(extra ?? []));

    public static PathGuard OwnerToo(SecurityIdentifier owner, IEnumerable<SecurityIdentifier>? extra = null) => new(FixedSids().Append(owner).Concat(extra ?? []));

    public bool IsTrusted(string path)
    {
        try
        {
            if (HasReparsePoint(path)) return false;
            FileSystemSecurity security = (File.GetAttributes(path) & FileAttributes.Directory) != 0 ? new DirectoryInfo(path).GetAccessControl() : new FileInfo(path).GetAccessControl();
            return Allows(security);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or NotSupportedException) { return false; }
    }

    private static bool HasReparsePoint(string path)
    {
        for (string? current = path; current is not null; current = Path.GetDirectoryName(current))
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
        return false;
    }

    private bool Allows(FileSystemSecurity security)
    {
        RawSecurityDescriptor descriptor = new(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.Owner is not { } owner || !_trusted.Contains(owner) || descriptor.DiscretionaryAcl is not { } dacl) return false;
        foreach (GenericAce ace in dacl)
        {
            bool allows = ace.AceType is AceType.AccessAllowed or AceType.AccessAllowedCallback or AceType.AccessAllowedCompound or AceType.AccessAllowedObject or AceType.AccessAllowedCallbackObject;
            if (!allows) continue;
            if (ace is not KnownAce known) return false; // an allow ACE this check cannot read
            if ((known.AccessMask & WriteRights) != 0 && !_trusted.Contains(known.SecurityIdentifier)) return false;
        }
        return true;
    }
}
