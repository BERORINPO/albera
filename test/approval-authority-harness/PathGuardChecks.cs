using System.Security.AccessControl;
using System.Security.Principal;
using Albera.ApprovalAuthority;

// Config-file guard checks (ServicePathGuard.cs): who counts as "the service" (the derived per-service SID, never the token user), on synthetic descriptors and
// on a real temp file. Reuses Descriptor() and the SID constants of KeyGuardChecks.cs. Touches only a temp file this process creates; no ACL outside it.
internal static partial class Harness
{
    private const int WriteData = 0x2;

    private static void PathGuardChecks()
    {
        SecurityIdentifier derived = SigningKeyGuard.DeriveServiceSid(SigningKeyGuard.ServiceName);
        SecurityIdentifier self = WindowsIdentity.GetCurrent().User!;
        SecurityIdentifier[] sharedAccounts = [new("S-1-5-19"), new("S-1-5-20"), self, UsersSid, EveryoneSid];

        Check("path guard: owner and writers limited to the per-service SID / SYSTEM / Administrators / CREATOR OWNER are trusted", () =>
        {
            foreach (SecurityIdentifier owner in new[] { derived, SystemSid, AdminsSid })
                Assert(ServicePathGuard.IsTrustedDescriptor(Descriptor(owner, [derived, SystemSid, AdminsSid, new("S-1-3-0")]), derived), $"owner {owner.Value} refused");
            Assert(ServicePathGuard.IsTrustedDescriptor(Descriptor(AdminsSid, [derived]), derived), "service-only DACL refused");
        });
        Check("path guard: the token user, LocalService, NetworkService, Users and Everyone are not trusted as owner or writer against the per-service SID, whatever the file looks like", () =>
        {
            foreach (SecurityIdentifier account in sharedAccounts)
            {
                Assert(!ServicePathGuard.IsTrustedDescriptor(Descriptor(account, [derived, SystemSid, AdminsSid]), derived), $"owner {account.Value} accepted");
                Assert(!ServicePathGuard.IsTrustedDescriptor(Descriptor(AdminsSid, [derived, SystemSid, AdminsSid, account], allowMask: WriteData), derived), $"write ACE for {account.Value} accepted");
                Assert(!ServicePathGuard.IsTrustedDescriptor(Descriptor(AdminsSid, [account], allowMask: GenericAll), derived), $"{account.Value} alone accepted");
            }
        });
        Check("path guard: a read-only ACE for another principal is not a write right, but a NULL DACL or no owner is untrusted", () =>
        {
            Assert(ServicePathGuard.IsTrustedDescriptor(Descriptor(AdminsSid, [UsersSid, self], allowMask: ReadData | ReadControl), derived), "read-only ACEs were counted as write rights");
            Assert(!ServicePathGuard.IsTrustedDescriptor(Descriptor(AdminsSid, null, dacl: false), derived), "NULL DACL accepted");
            Assert(!ServicePathGuard.IsTrustedDescriptor(Descriptor(null, [derived, SystemSid]), derived), "no owner accepted");
        });
        Check("path guard: another service's SID is not the service (a stand-in SID is the only way to trust a different one)", () =>
        {
            Assert(!ServicePathGuard.IsTrustedDescriptor(Descriptor(OtherServiceSid, [OtherServiceSid, SystemSid]), derived), "another service's owner accepted");
            Assert(ServicePathGuard.IsTrustedDescriptor(Descriptor(OtherServiceSid, [OtherServiceSid, SystemSid]), OtherServiceSid), "explicit SID refused");
        });

        Check("path guard (real temp file): the production entry refuses a perfect same-user file because this token carries no service SID; the stand-in accepts it; a stand-in that is not its owner or writer refuses it", () =>
        {
            string path = Path.Combine(Path.GetTempPath(), "AlberaPathGuard-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                File.WriteAllText(path, "{}");
                FileSecurity security = new();
                security.SetAccessRuleProtection(true, false); // no inherited ACEs: exactly {user, SYSTEM}
                security.AddAccessRule(new FileSystemAccessRule(self, FileSystemRights.FullControl, AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, AccessControlType.Allow));
                new FileInfo(path).SetAccessControl(security);
                bool Trusted() { using FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read); return ServicePathGuard.IsTrustedConfigFile(path, file); }
                try
                {
                    ServicePathGuard.ServiceSidForTest = null;
                    Assert(!Trusted(), "the token user alone was trusted");
                    ServicePathGuard.ServiceSidForTest = self;
                    Assert(Trusted(), "the stand-in (the file's owner and only writer) was refused");
                    ServicePathGuard.ServiceSidForTest = derived;
                    Assert(!Trusted(), "a stand-in that does not own or write the file was accepted");
                }
                finally { ServicePathGuard.ServiceSidForTest = null; }
            }
            finally { File.Delete(path); }
        });
    }
}
