using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

// Who may change the files the service trusts (ADR-002, Proposed / NOT VERIFIED). The config file names the authority key and the journal path; the
// journal and its -wal / -shm / -journal files are the replay protection. Under the usual inherited C:\ProgramData ACL, BUILTIN\Users can create files
// in a new sub-folder, so they could pre-create the config, journal.sqlite or a fake -wal. The service therefore refuses to start (exit 73) unless,
// for the config file, the database folder and any journal file that already exists:
//   - the owner is LocalSystem, BUILTIN\Administrators or the service's own per-service SID (below),
//   - no other principal has an Allow ACE with write-data, append-data (add-file / add-subdirectory), delete-child, delete, write-DAC or write-owner
//     (or the generic write / all bits), inherit-only ACEs included, because they decide who owns the next file created there,
//   - the DACL is not NULL (a NULL DACL grants everyone everything), and
//   - neither the path nor any of its parents is a reparse point (junction, symlink, mount point).
// "The service's own SID" is NOT the process token's user SID: under LocalService, NetworkService or an ordinary account the user SID is shared with
// every other process of that account, so a config or journal that account can write could be changed by any of them. It is the per-service SID of the
// fixed service name (NT SERVICE\AlberaHostBroker, a S-1-5-80-... SID the SCM adds to the token's groups), derived here and required to be present and
// ENABLED in the process token (same rule as the Authority's signing-key guard). If it is not, nothing is trusted and the service refuses to start
// (exit 73): the token user is never trusted on its own. A host test runs as the signed-in user, which has no service SID, so the test-faults build
// (ALBERA_BROKER_TEST_FAULTS, never the published one) can be told which SID to stand in for the service (a start-up option, see Program.cs); a test
// build started without it applies the production rule. CREATOR OWNER (S-1-3-0) counts as trusted because it only ever resolves to whoever creates
// the object, and creating objects here is itself covered by the write rights above.
// Not checked: the ACLs of the parent folders (C:\ProgramData itself lets Users create sub-folders by default). A parent that is a reparse point is
// refused, but a parent that a non-trusted user can rename is the installer's job to avoid. BCL only; nothing here changes any ACL.
internal static class ServicePathGuard
{
    private const int WriteData = 0x2, AppendData = 0x4, DeleteChild = 0x40, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000,
        GenericAll = 0x10000000, GenericWrite = 0x40000000;
    private const int WriteRights = WriteData | AppendData | DeleteChild | Delete | WriteDac | WriteOwner | GenericAll | GenericWrite;
    private static readonly SecurityIdentifier LocalSystem = new("S-1-5-18"), Administrators = new("S-1-5-32-544"), CreatorOwner = new("S-1-3-0");
    private static readonly string[] JournalSuffixes = ["", "-wal", "-shm", "-journal"];

    // The fixed name of the Broker service (registered as NT SERVICE\AlberaHostBroker, see test/windows-service-lab/lab-guest.ps1); its per-service SID is derived from it.
    public const string ServiceName = "AlberaHostBroker";

    /// <summary>The per-service SID for a service name: S-1-5-80 plus the SHA-1 of the upper-cased UTF-16LE name, as five little-endian DWORDs.</summary>
    public static SecurityIdentifier DeriveServiceSid(string serviceName)
    {
        byte[] hash = SHA1.HashData(System.Text.Encoding.Unicode.GetBytes(serviceName.ToUpperInvariant()));
        string subAuthorities = string.Join('-', Enumerable.Range(0, 5).Select(i => BitConverter.ToUInt32(hash, i * 4)));
        return new SecurityIdentifier("S-1-5-80-" + subAuthorities);
    }

    /// <summary>The SID this guard trusts as the service, or null when the token does not carry it as an enabled group. `hasEnabledGroup` is the token test.</summary>
    public static SecurityIdentifier? ResolveServiceSid(Func<SecurityIdentifier, bool> hasEnabledGroup)
    {
        SecurityIdentifier sid = DeriveServiceSid(ServiceName);
        return hasEnabledGroup(sid) ? sid : null;
    }

    private static SecurityIdentifier? CurrentServiceSid()
    {
#if ALBERA_BROKER_TEST_FAULTS
        if (ServiceSidForTest is { } standIn) return standIn;
#endif
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        return ResolveServiceSid(new WindowsPrincipal(identity).IsInRole); // IsInRole = CheckTokenMembership: enabled groups only (a deny-only or disabled group does not count)
    }

#if ALBERA_BROKER_TEST_FAULTS
    // Test-only: the SID a host test stands in for "the service" (its token has no service SID; the temp folders it makes are granted to the signed-in user).
    // Set once at start-up by `--trust-sid <sid>`; unset = the production rule.
    public static SecurityIdentifier? ServiceSidForTest { get; set; }
#endif

    // The config file, already open (FileShare.Read, so it cannot be replaced or written while it is read): the ACL is read from that handle.
    public static bool IsTrustedConfigFile(string path, FileStream file) =>
        Guarded(() => !HasReparsePoint(path) && CurrentServiceSid() is { } service && IsTrusted(file.GetAccessControl(), service));

    // The folder that holds the journal and every journal-related file that exists already. A journal file that does not exist yet is created by the
    // service inside the checked folder.
    public static bool IsTrustedDatabaseLocation(string database) => Guarded(() =>
    {
        if (CurrentServiceSid() is not { } service) return false;
        string folder = Path.GetDirectoryName(database)!;
        if (!IsTrustedObject(folder, service)) return false;
        foreach (string suffix in JournalSuffixes)
            if (Exists(database + suffix) && !IsTrustedObject(database + suffix, service)) return false;
        return true;
    });

    private static bool IsTrustedObject(string path, SecurityIdentifier service) => Guarded(() =>
    {
        if (HasReparsePoint(path)) return false;
        return IsTrusted((File.GetAttributes(path) & FileAttributes.Directory) != 0 ? new DirectoryInfo(path).GetAccessControl() : new FileInfo(path).GetAccessControl(), service);
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

    private static bool IsTrusted(FileSystemSecurity security, SecurityIdentifier service)
    {
        RawSecurityDescriptor descriptor = new(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.Owner is not { } owner || !IsTrustedPrincipal(owner, service) || descriptor.DiscretionaryAcl is not { } dacl) return false;
        foreach (GenericAce ace in dacl)
        {
            bool allows = ace.AceType is AceType.AccessAllowed or AceType.AccessAllowedCallback or AceType.AccessAllowedCompound or AceType.AccessAllowedObject or AceType.AccessAllowedCallbackObject;
            if (!allows) continue;
            if (ace is not KnownAce known) return false; // an allow ACE this check cannot read
            if ((known.AccessMask & WriteRights) != 0 && !IsTrustedPrincipal(known.SecurityIdentifier, service)) return false;
        }
        return true;
    }

    private static bool IsTrustedPrincipal(SecurityIdentifier sid, SecurityIdentifier service) =>
        sid.Equals(service) || sid.Equals(LocalSystem) || sid.Equals(Administrators) || sid.Equals(CreatorOwner);
}
