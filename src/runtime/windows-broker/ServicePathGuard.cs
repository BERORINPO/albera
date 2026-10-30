using System.Security.AccessControl;
using System.Security.Principal;

// Who may change the files the service trusts (ADR-002, Proposed / NOT VERIFIED). The config file names the authority key and the journal path; the
// journal and its -wal / -shm / -journal files are the replay protection. Under the usual inherited C:\ProgramData ACL, BUILTIN\Users can create files
// in a new sub-folder, so they could pre-create the config, journal.sqlite or a fake -wal. The service therefore refuses to start (exit 73) unless,
// for the config file, the database folder and any journal file that already exists:
//   - the owner is LocalSystem, BUILTIN\Administrators or the SID this process runs as,
//   - no other principal has an Allow ACE with write-data, append-data (add-file / add-subdirectory), delete-child, delete, write-DAC or write-owner
//     (or the generic write / all bits), inherit-only ACEs included, because they decide who owns the next file created there,
//   - the DACL is not NULL (a NULL DACL grants everyone everything), and
//   - neither the path nor any of its parents is a reparse point (junction, symlink, mount point).
// "The SID this process runs as" is the process token's user SID: the virtual service account when run by the SCM, the signed-in user when a
// host test runs the same code. There is no separate test rule, so a folder that is clean for a same-user test is clean for the same reason in
// production (owner and writers are the process itself plus SYSTEM / Administrators). CREATOR OWNER (S-1-3-0) counts as trusted because it only
// ever resolves to whoever creates the object, and creating objects here is itself covered by the write rights above.
// Not checked: the ACLs of the parent folders (C:\ProgramData itself lets Users create sub-folders by default). A parent that is a reparse point is
// refused, but a parent that a non-trusted user can rename is the installer's job to avoid. BCL only; nothing here changes any ACL.
internal static class ServicePathGuard
{
    private const int WriteData = 0x2, AppendData = 0x4, DeleteChild = 0x40, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000,
        GenericAll = 0x10000000, GenericWrite = 0x40000000;
    private const int WriteRights = WriteData | AppendData | DeleteChild | Delete | WriteDac | WriteOwner | GenericAll | GenericWrite;
    private static readonly SecurityIdentifier LocalSystem = new("S-1-5-18"), Administrators = new("S-1-5-32-544"), CreatorOwner = new("S-1-3-0");
    private static readonly string[] JournalSuffixes = ["", "-wal", "-shm", "-journal"];

    // The config file, already open (FileShare.Read, so it cannot be replaced or written while it is read): the ACL is read from that handle.
    public static bool IsTrustedConfigFile(string path, FileStream file) =>
        Guarded(() => !HasReparsePoint(path) && IsTrusted(file.GetAccessControl()));

    // The folder that holds the journal and every journal-related file that exists already. A journal file that does not exist yet is created by the
    // service inside the checked folder.
    public static bool IsTrustedDatabaseLocation(string database)
    {
        string folder = Path.GetDirectoryName(database)!;
        if (!IsTrustedObject(folder)) return false;
        foreach (string suffix in JournalSuffixes)
            if (Exists(database + suffix) && !IsTrustedObject(database + suffix)) return false;
        return true;
    }

    private static bool IsTrustedObject(string path) => Guarded(() =>
    {
        if (HasReparsePoint(path)) return false;
        return IsTrusted((File.GetAttributes(path) & FileAttributes.Directory) != 0 ? new DirectoryInfo(path).GetAccessControl() : new FileInfo(path).GetAccessControl());
    });

    // Anything that stops the check from finishing (access denied, file vanished, odd path) means "not trusted": fail closed.
    private static bool Guarded(Func<bool> check)
    {
        try { return check(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or NotSupportedException) { return false; }
    }

    // Existence without following links: a dangling symlink still "exists" and is then refused as a reparse point.
    private static bool Exists(string path)
    {
        try { _ = File.GetAttributes(path); return true; }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { return false; }
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
