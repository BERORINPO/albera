using System.Security.AccessControl;
using System.Security.Principal;

// Who may change the files the host trusts (docs/architecture/control-plane-service.md section 3: the CP identity has READ only on control-plane-config and
// on the program folders). The config names the node to run and the app tree to run it on, so a host that took them from a file the CP itself (or any
// ordinary user) could write would be a path to run anything as the service identity. The host therefore refuses (config_untrusted at start, child_untrusted
// before every launch) unless, for the config file, node.exe, and every folder and file of the app tree:
//   - the owner is LocalSystem, BUILTIN\Administrators or TrustedInstaller,
//   - no other principal has an Allow ACE with write-data, append-data (add-file / add-subdirectory), delete-child, delete, write-DAC or write-owner
//     (or the generic write / all bits), inherit-only ACEs included, because they decide who owns the next object created there,
//   - the DACL is not NULL, and
//   - neither the path nor any of its parents is a reparse point (junction, symlink, mount point).
// The CP's own service SID is deliberately NOT trusted (unlike the Broker's guard): it must not be able to rewrite what it is started from.
// CREATOR OWNER (S-1-3-0) counts as trusted because it only ever resolves to whoever creates the object, and creating objects here is itself covered by the
// write rights above. Not checked: the ACLs of the parent folders (a parent that a non-trusted user can rename is the installer's job to avoid; a parent that is a
// reparse point is refused). BCL only; nothing here changes any ACL.
internal static class PathGuard
{
    private const int WriteData = 0x2, AppendData = 0x4, DeleteChild = 0x40, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000,
        GenericAll = 0x10000000, GenericWrite = 0x40000000;
    private const int WriteRights = WriteData | AppendData | DeleteChild | Delete | WriteDac | WriteOwner | GenericAll | GenericWrite;
    private const int MaxTreeEntries = 20_000; // a runaway or hostile tree ends the check as "not trusted" instead of walking forever
    private static readonly SecurityIdentifier LocalSystem = new("S-1-5-18"), Administrators = new("S-1-5-32-544"), CreatorOwner = new("S-1-3-0"),
        TrustedInstaller = new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");

#if ALBERA_CPHOST_TEST_SEAMS
    // Test-only: the SID a host test stands in for the administrators (its folders are owned by the signed-in user). Set once at start-up by `--trust-sid`.
    public static SecurityIdentifier? StandInForAdministrators { get; set; }

    // Test-only: where the parent walk of IsParentChainSafe stops (inclusive). A developer's temp folder sits below folders other accounts can modify, which the production
    // rule rightly refuses; the test folder is made safe from this one down. Set once at start-up by `--ancestor-floor`.
    public static string? AncestorFloor { get; set; }
#endif

    // The config file, already open: the ACL is read from that handle.
    public static bool IsTrustedConfigFile(string path, FileStream file) => Guarded(() => !HasReparsePoint(path) && IsTrusted(file.GetAccessControl()));

    public static bool IsTrustedFile(string path) => Guarded(() => !HasReparsePoint(path) && IsTrusted(new FileInfo(path).GetAccessControl()));

    /// <summary>
    /// `folder` and every folder above it up to the drive root. A rename or delete of a folder here moves what the host trusts, so for each: the owner is trusted (an owner can always
    /// rewrite the DACL) and no other principal may hold DELETE (the folder itself, so a rename or removal of it), DELETE_CHILD, WRITE_DAC or WRITE_OWNER. With `denyAddFile` the first folder (node.exe's own) also refuses ADD_FILE, because
    /// a file added next to node.exe is what a DLL search would find. ACEs that only apply to children (inherit-only) are skipped: each child is checked itself, in its turn.
    /// </summary>
    public static bool IsParentChainSafe(string folder, bool denyAddFile) => Guarded(() =>
    {
        for (string? current = folder; current is not null; current = Path.GetDirectoryName(current))
        {
            if (!IsSafeAncestor(new DirectoryInfo(current).GetAccessControl(), denyAddFile && current == folder)) return false;
#if ALBERA_CPHOST_TEST_SEAMS
            if (AncestorFloor is { } floor && string.Equals(current.TrimEnd('\\'), floor.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) break;
#endif
        }
        return true;
    });

    /// <summary>The folder, every folder below it and every file in them. A reparse point anywhere inside is refused.</summary>
    public static bool IsTrustedTree(string folder) => Guarded(() =>
    {
        if (HasReparsePoint(folder) || !IsTrusted(new DirectoryInfo(folder).GetAccessControl())) return false;
        EnumerationOptions options = new() { RecurseSubdirectories = true, AttributesToSkip = 0, IgnoreInaccessible = false, ReturnSpecialDirectories = false };
        int seen = 0;
        foreach (FileSystemInfo entry in new DirectoryInfo(folder).EnumerateFileSystemInfos("*", options))
        {
            if (++seen > MaxTreeEntries || (entry.Attributes & FileAttributes.ReparsePoint) != 0) return false;
            FileSystemSecurity security = entry is DirectoryInfo directory ? directory.GetAccessControl() : ((FileInfo)entry).GetAccessControl();
            if (!IsTrusted(security)) return false;
        }
        return true;
    });

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
        RawSecurityDescriptor descriptor = new(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.Owner is not { } owner || !IsTrustedPrincipal(owner) || descriptor.DiscretionaryAcl is not { } dacl) return false;
        foreach (GenericAce ace in dacl)
        {
            bool allows = ace.AceType is AceType.AccessAllowed or AceType.AccessAllowedCallback or AceType.AccessAllowedCompound or AceType.AccessAllowedObject or AceType.AccessAllowedCallbackObject;
            if (!allows) continue;
            if (ace is not KnownAce known) return false; // an allow ACE this check cannot read
            if ((known.AccessMask & WriteRights) != 0 && !IsTrustedPrincipal(known.SecurityIdentifier)) return false;
        }
        return true;
    }

    private static bool IsSafeAncestor(FileSystemSecurity security, bool denyAddFile)
    {
        int forbidden = Delete | DeleteChild | WriteDac | WriteOwner | GenericAll | GenericWrite | (denyAddFile ? WriteData : 0);
        RawSecurityDescriptor descriptor = new(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.Owner is not { } owner || !IsTrustedPrincipal(owner) || descriptor.DiscretionaryAcl is not { } dacl) return false;
        foreach (GenericAce ace in dacl)
        {
            bool allows = ace.AceType is AceType.AccessAllowed or AceType.AccessAllowedCallback or AceType.AccessAllowedCompound or AceType.AccessAllowedObject or AceType.AccessAllowedCallbackObject;
            if (!allows || (ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
            if (ace is not KnownAce known) return false; // an allow ACE this check cannot read
            if ((known.AccessMask & forbidden) != 0 && !IsTrustedPrincipal(known.SecurityIdentifier)) return false;
        }
        return true;
    }

    private static bool IsTrustedPrincipal(SecurityIdentifier sid)
    {
#if ALBERA_CPHOST_TEST_SEAMS
        if (StandInForAdministrators is { } standIn && sid.Equals(standIn)) return true;
#endif
        return sid.Equals(LocalSystem) || sid.Equals(Administrators) || sid.Equals(TrustedInstaller) || sid.Equals(CreatorOwner);
    }
}
