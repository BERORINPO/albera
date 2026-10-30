using System.Security.AccessControl;
using System.Security.Principal;

namespace Albera.ApprovalAuthority;

// Who may change the config file the service trusts (copied from the Broker's ServicePathGuard, config-file part only: the Authority keeps no
// database, so there is no journal folder to check or pin). The config file names the pinned approver key and the two SIDs that may use the pipes.
// Under the usual inherited C:\ProgramData ACL, BUILTIN\Users can create files in a new sub-folder, so they could pre-create the config. The
// service therefore refuses to start (exit 73) unless the config file:
//   - is owned by LocalSystem, BUILTIN\Administrators or the SID this process runs as,
//   - has no Allow ACE for another principal with write-data, append-data, delete-child, delete, write-DAC or write-owner (or the generic
//     write / all bits), inherit-only ACEs included,
//   - has a DACL that is not NULL, and
//   - is not behind a reparse point (junction, symlink, mount point) at any level of its path.
// "The SID this process runs as" is the process token's user SID: the virtual service account under the SCM, the signed-in user when a host test
// runs the same code. CREATOR OWNER (S-1-3-0) counts as trusted because it only resolves to whoever creates the object.
internal static class ServicePathGuard
{
    private const int WriteData = 0x2, AppendData = 0x4, DeleteChild = 0x40, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000,
        GenericAll = 0x10000000, GenericWrite = 0x40000000;
    private const int WriteRights = WriteData | AppendData | DeleteChild | Delete | WriteDac | WriteOwner | GenericAll | GenericWrite;
    private static readonly SecurityIdentifier LocalSystem = new("S-1-5-18"), Administrators = new("S-1-5-32-544"), CreatorOwner = new("S-1-3-0");

    // The config file, already open (FileShare.Read, so it cannot be replaced or written while it is read): the ACL is read from that handle.
    public static bool IsTrustedConfigFile(string path, FileStream file) =>
        Guarded(() => !HasReparsePoint(path) && IsTrusted(file.GetAccessControl()));

    // Anything that stops the check from finishing (access denied, file vanished, odd path) means "not trusted": fail closed.
    private static bool Guarded(Func<bool> check)
    {
        try { return check(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or NotSupportedException) { return false; }
    }

    private static bool HasReparsePoint(string path)
    {
        for (string? current = path; current is not null; current = Path.GetDirectoryName(current))
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
        return false;
    }

    private static bool IsTrusted(FileSystemSecurity security)
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        if (identity.User is not { } self) return false;
        RawSecurityDescriptor descriptor = new(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.Owner is not { } owner || !IsTrustedPrincipal(owner, self) || descriptor.DiscretionaryAcl is not { } dacl) return false;
        foreach (GenericAce ace in dacl)
        {
            bool allows = ace.AceType is AceType.AccessAllowed or AceType.AccessAllowedCallback or AceType.AccessAllowedCompound or AceType.AccessAllowedObject or AceType.AccessAllowedCallbackObject;
            if (!allows) continue;
            if (ace is not KnownAce known) return false; // an allow ACE this check cannot read
            if ((known.AccessMask & WriteRights) != 0 && !IsTrustedPrincipal(known.SecurityIdentifier, self)) return false;
        }
        return true;
    }

    private static bool IsTrustedPrincipal(SecurityIdentifier sid, SecurityIdentifier self) =>
        sid.Equals(self) || sid.Equals(LocalSystem) || sid.Equals(Administrators) || sid.Equals(CreatorOwner);
}
