using System.Security.AccessControl;
using System.Security.Principal;

namespace Albera.ApprovalAuthority;

// Who may change the config file the service trusts (the config-file part of the Broker's ServicePathGuard: the Authority keeps no database, so there
// is no journal folder to check or pin). The same check is applied to the tier policy file next to it (policy.json, PolicyStore.cs), when it is read at start and again on the
// new file the Authority writes before that file replaces the old one. The config file names the pinned approver key and the two SIDs that may use the pipes.
// Under the usual inherited C:\ProgramData ACL, BUILTIN\Users can create files in a new sub-folder, so they could pre-create the config. The
// service therefore refuses to start (exit 73) unless the config file:
//   - is owned by LocalSystem, BUILTIN\Administrators or the service's own per-service SID (below),
//   - has no Allow ACE for another principal with write-data, append-data, delete-child, delete, write-DAC or write-owner (or the generic
//     write / all bits), inherit-only ACEs included,
//   - has a DACL that is not NULL, and
//   - is not behind a reparse point (junction, symlink, mount point) at any level of its path.
// "The service's own SID" is NOT the process token's user SID: under LocalService, NetworkService or an ordinary account the user SID is shared with
// every other process of that account, so a config that account can write could be changed by any of them. It is the per-service SID of the fixed
// service name (SigningKeyGuard.ServiceName, NT SERVICE\AlberaApprovalAuthority, a S-1-5-80-... SID the SCM adds to the token's groups), required to be
// present and ENABLED in the process token, exactly as for the signing-key guard. If it is not, nothing is trusted and the service refuses to start
// (exit 73): the token user is never trusted on its own. A host test runs as the signed-in user, which has no service SID, so the test-faults build
// (ALBERA_AUTHORITY_TEST_FAULTS, never the published one) can be told which SID to stand in for the service (`--trust-sid`, see Program.cs); a test
// build started without it applies the production rule. CREATOR OWNER (S-1-3-0) counts as trusted because it only resolves to whoever creates the object.
internal static class ServicePathGuard
{
    private const int WriteData = 0x2, AppendData = 0x4, DeleteChild = 0x40, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000,
        GenericAll = 0x10000000, GenericWrite = 0x40000000;
    private const int WriteRights = WriteData | AppendData | DeleteChild | Delete | WriteDac | WriteOwner | GenericAll | GenericWrite;
    private static readonly SecurityIdentifier LocalSystem = new("S-1-5-18"), Administrators = new("S-1-5-32-544"), CreatorOwner = new("S-1-3-0");

    // The SID this guard trusts as the service, or null when the token does not carry it as an enabled group (then nothing is trusted).
    private static SecurityIdentifier? CurrentServiceSid()
    {
#if ALBERA_AUTHORITY_TEST_FAULTS
        if (ServiceSidForTest is { } standIn) return standIn;
#endif
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        // IsInRole = CheckTokenMembership: enabled groups only (a deny-only or disabled group does not count)
        return SigningKeyGuard.ResolveServiceSid(new WindowsPrincipal(identity).IsInRole, out SecurityIdentifier sid) is null ? sid : null;
    }

#if ALBERA_AUTHORITY_TEST_FAULTS
    // Test-only: the SID a host test stands in for "the service" (its token has no service SID; the temp folders it makes are granted to the signed-in user).
    // Set once at start-up by `--trust-sid <sid>`; unset = the production rule.
    public static SecurityIdentifier? ServiceSidForTest { get; set; }
#endif

    // The config file, already open (FileShare.Read, so it cannot be replaced or written while it is read): the ACL is read from that handle.
    public static bool IsTrustedConfigFile(string path, FileStream file) =>
        Guarded(() => !HasReparsePoint(path) && CurrentServiceSid() is { } service && IsTrusted(file.GetAccessControl(), service));

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

    private static bool IsTrusted(FileSystemSecurity security, SecurityIdentifier service) => IsTrustedDescriptor(security.GetSecurityDescriptorBinaryForm(), service);

    /// <summary>The decision on its own (no file needed): `descriptorBytes` is the self-relative security descriptor of the config file, `service` the SID that counts as the service.</summary>
    public static bool IsTrustedDescriptor(byte[] descriptorBytes, SecurityIdentifier service)
    {
        RawSecurityDescriptor descriptor = new(descriptorBytes, 0);
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
