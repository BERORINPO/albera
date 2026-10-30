using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Albera.ApprovalAuthority;

// Signing key guard checks (SigningKeyGuard.cs): the DACL / export-policy decision on synthetic descriptors, then on real per-user software keys.
// The real-key checks need no admin and touch nothing machine-wide: a persisted CURRENT-USER software-KSP key with a random name, deleted at the end.
// Machine keys (the production scope) and the exit code through the SCM are lab-only (test/windows-service-lab).
internal static partial class Harness
{
    private static readonly SecurityIdentifier ServiceSid = new("S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555"),
        OtherServiceSid = new("S-1-5-80-9999999999-2222222222-3333333333-1444444444-2555555555"),
        SystemSid = new("S-1-5-18"), AdminsSid = new("S-1-5-32-544"), UsersSid = new("S-1-5-32-545"), EveryoneSid = new("S-1-1-0");
    private const int GenericAll = 0x10000000, ReadData = 0x1, ReadControl = 0x20000;

    // A self-relative descriptor: owner, deny ACEs, then allow ACEs. `dacl: false` = NULL DACL.
    private static byte[] Descriptor(SecurityIdentifier? owner, IEnumerable<SecurityIdentifier>? allow, IEnumerable<SecurityIdentifier>? deny = null, int allowMask = GenericAll, bool dacl = true)
    {
        RawAcl? acl = null;
        if (dacl)
        {
            acl = new RawAcl(2, 0);
            foreach (SecurityIdentifier sid in deny ?? []) acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessDenied, ReadData, sid, false, null));
            foreach (SecurityIdentifier sid in allow ?? []) acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, allowMask, sid, false, null));
        }
        RawSecurityDescriptor descriptor = new(ControlFlags.SelfRelative | (dacl ? ControlFlags.DiscretionaryAclPresent : ControlFlags.None), owner, null, null, acl);
        byte[] bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static byte[] GoodDescriptor(SecurityIdentifier? owner = null) => Descriptor(owner ?? AdminsSid, [SystemSid, AdminsSid, ServiceSid]);

    private static string? Evaluate(CngExportPolicies policy, byte[]? descriptor) => SigningKeyGuard.Evaluate(policy, descriptor, ServiceSid);

    private static void KeyGuardChecks()
    {
        Check("key guard: non-exportable, allow ACEs for the service / SYSTEM / Administrators only: accepted (owner Administrators, SYSTEM or the service; service-only DACL)", () =>
        {
            foreach (SecurityIdentifier owner in new[] { AdminsSid, SystemSid, ServiceSid })
                Assert(Evaluate(CngExportPolicies.None, GoodDescriptor(owner)) is null, $"owner {owner.Value} refused");
            Assert(Evaluate(CngExportPolicies.None, Descriptor(AdminsSid, [ServiceSid])) is null, "service-only DACL refused");
        });
        Check("key guard: every export policy bit is key_exportable, even with no readable descriptor", () =>
        {
            foreach (CngExportPolicies policy in new[] { CngExportPolicies.AllowExport, CngExportPolicies.AllowPlaintextExport, CngExportPolicies.AllowArchiving, CngExportPolicies.AllowPlaintextArchiving, CngExportPolicies.AllowExport | CngExportPolicies.AllowArchiving })
                Assert(Evaluate(policy, GoodDescriptor()) == SigningKeyGuard.Reason.Exportable, $"{policy} accepted");
            Assert(Evaluate(CngExportPolicies.AllowExport, null) == SigningKeyGuard.Reason.Exportable, "exportable with no descriptor is not key_exportable");
        });
        Check("key guard: an allow ACE for Everyone, Users, Authenticated Users, Interactive, ALL SERVICES, another service or the signed-in user is ace_untrusted, whatever the mask", () =>
        {
            SecurityIdentifier self = WindowsIdentity.GetCurrent().User!;
            foreach (string value in new[] { EveryoneSid.Value, UsersSid.Value, "S-1-5-11", "S-1-5-4", "S-1-5-80-0", OtherServiceSid.Value, self.Value })
                foreach (int mask in new[] { GenericAll, ReadData, ReadControl })
                    Assert(Evaluate(CngExportPolicies.None, Descriptor(AdminsSid, [SystemSid, AdminsSid, ServiceSid, new SecurityIdentifier(value)], allowMask: mask)) == SigningKeyGuard.Reason.AceUntrusted, $"{value} mask {mask:x} accepted");
        });
        Check("key guard: a broad ACE alone is refused, and deny ACEs for broad SIDs grant nothing and are ignored", () =>
        {
            Assert(Evaluate(CngExportPolicies.None, Descriptor(AdminsSid, [EveryoneSid])) == SigningKeyGuard.Reason.AceUntrusted, "Everyone-only accepted");
            Assert(Evaluate(CngExportPolicies.None, Descriptor(AdminsSid, [SystemSid, AdminsSid, ServiceSid], deny: [EveryoneSid, UsersSid])) is null, "deny ACEs were counted as grants");
        });
        Check("key guard: an owner outside the service / SYSTEM / Administrators, or none, is owner_untrusted; a NULL DACL is dacl_missing", () =>
        {
            foreach (SecurityIdentifier owner in new[] { EveryoneSid, UsersSid, OtherServiceSid })
                Assert(Evaluate(CngExportPolicies.None, GoodDescriptor(owner)) == SigningKeyGuard.Reason.OwnerUntrusted, $"owner {owner.Value} accepted");
            Assert(Evaluate(CngExportPolicies.None, Descriptor(null, [SystemSid, AdminsSid, ServiceSid])) == SigningKeyGuard.Reason.OwnerUntrusted, "no owner accepted");
            Assert(Evaluate(CngExportPolicies.None, Descriptor(AdminsSid, null, dacl: false)) == SigningKeyGuard.Reason.DaclMissing, "NULL DACL accepted");
        });
        Check("key guard: a missing, empty or malformed descriptor is descriptor_unreadable (fail closed)", () =>
        {
            foreach (byte[]? bad in new byte[]?[] { null, [], [1, 2, 3], new byte[64] })
                Assert(Evaluate(CngExportPolicies.None, bad) == SigningKeyGuard.Reason.DescriptorUnreadable, $"{bad?.Length.ToString() ?? "null"} bytes accepted");
        });
        Check("key guard: the reason words are distinct fixed lowercase words (never a SID or a name)", () =>
        {
            string[] words = [SigningKeyGuard.Reason.Exportable, SigningKeyGuard.Reason.ExportPolicyUnreadable, SigningKeyGuard.Reason.DescriptorUnreadable, SigningKeyGuard.Reason.DaclMissing, SigningKeyGuard.Reason.OwnerUntrusted, SigningKeyGuard.Reason.AceUntrusted, SigningKeyGuard.Reason.ServiceSidMissing];
            Assert(words.All(w => w.All(c => char.IsAsciiLetterLower(c) || c == '_')) && words.Distinct().Count() == words.Length, string.Join(",", words));
        });

        Check("key guard: the service SID is the derived per-service SID (SCM algorithm, checked against the well-known NT SERVICE TrustedInstaller SID), never the token user", () =>
        {
            Assert(SigningKeyGuard.DeriveServiceSid("TrustedInstaller").Value == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", SigningKeyGuard.DeriveServiceSid("TrustedInstaller").Value);
            SecurityIdentifier derived = SigningKeyGuard.DeriveServiceSid(SigningKeyGuard.ServiceName);
            Assert(derived.Value.StartsWith("S-1-5-80-", StringComparison.Ordinal) && derived.Value.Split('-').Length == 9, derived.Value);
            Assert(derived.Equals(SigningKeyGuard.DeriveServiceSid("ALBERAAPPROVALAUTHORITY")), "the name is case-insensitive, as the SCM's is");
            Assert(!derived.Equals(WindowsIdentity.GetCurrent().User!), "the derived SID is not the token user");
        });
        Check("key guard: a token without the service SID as an enabled group is service_sid_missing; with it, the derived SID is the one asked for", () =>
        {
            SecurityIdentifier derived = SigningKeyGuard.DeriveServiceSid(SigningKeyGuard.ServiceName);
            SecurityIdentifier? asked = null;
            Assert(SigningKeyGuard.ResolveServiceSid(sid => { asked = sid; return false; }, out _) == SigningKeyGuard.Reason.ServiceSidMissing && derived.Equals(asked!), "absent group accepted");
            Assert(SigningKeyGuard.ResolveServiceSid(_ => true, out SecurityIdentifier granted) is null && derived.Equals(granted), "present group refused");
            // The user SID of LocalService / NetworkService / an ordinary user is never what is asked for, so having that account does not satisfy the test.
            SecurityIdentifier[] accounts = [new("S-1-5-19"), new("S-1-5-20"), WindowsIdentity.GetCurrent().User!];
            Assert(SigningKeyGuard.ResolveServiceSid(sid => accounts.Contains(sid), out _) == SigningKeyGuard.Reason.ServiceSidMissing, "a shared account passed as the service");
        });
        Check("key guard: this test process's real token has no service SID, so the production entry point refuses even a perfect key", () =>
            WithUserKey(CngExportPolicies.None, null, (key, _) => Assert(SigningKeyGuard.CheckCurrentProcess(key) == SigningKeyGuard.Reason.ServiceSidMissing, SigningKeyGuard.CheckCurrentProcess(key) ?? "accepted")));
        Check("key guard: an allow ACE (or the owner) being LocalService, NetworkService or an ordinary user is refused against the derived service SID", () =>
        {
            SecurityIdentifier derived = SigningKeyGuard.DeriveServiceSid(SigningKeyGuard.ServiceName);
            foreach (SecurityIdentifier account in new[] { new SecurityIdentifier("S-1-5-19"), new SecurityIdentifier("S-1-5-20"), WindowsIdentity.GetCurrent().User! })
            {
                Assert(SigningKeyGuard.Evaluate(CngExportPolicies.None, Descriptor(AdminsSid, [SystemSid, AdminsSid, derived, account]), derived) == SigningKeyGuard.Reason.AceUntrusted, $"ACE {account.Value} accepted");
                Assert(SigningKeyGuard.Evaluate(CngExportPolicies.None, Descriptor(account, [SystemSid, AdminsSid, derived]), derived) == SigningKeyGuard.Reason.OwnerUntrusted, $"owner {account.Value} accepted");
            }
            Assert(SigningKeyGuard.Evaluate(CngExportPolicies.None, Descriptor(AdminsSid, [SystemSid, AdminsSid, derived]), derived) is null, "the derived SID itself was refused");
        });

        // "The service" is the signed-in user in the real-key checks below (the explicit-SID Check; production only reaches it through CheckCurrentProcess).
        Check("key guard (real per-user software key): non-exportable, DACL {user, SYSTEM, Administrators}: accepted", () =>
            WithUserKey(CngExportPolicies.None, null, (key, self) => Assert(SigningKeyGuard.CheckForTest(key, self) is null, $"refused: {SigningKeyGuard.CheckForTest(key, self)}")));
        Check("key guard (real per-user software key): an exportable key is key_exportable", () =>
            WithUserKey(CngExportPolicies.AllowExport, null, (key, self) => Assert(SigningKeyGuard.CheckForTest(key, self) == SigningKeyGuard.Reason.Exportable, SigningKeyGuard.CheckForTest(key, self) ?? "accepted")));
        Check("key guard (real per-user software key): a non-exportable key with an extra BUILTIN\\Users ACE is ace_untrusted", () =>
            WithUserKey(CngExportPolicies.None, UsersSid, (key, self) => Assert(SigningKeyGuard.CheckForTest(key, self) == SigningKeyGuard.Reason.AceUntrusted, SigningKeyGuard.CheckForTest(key, self) ?? "accepted")));
        Check("key guard (real per-user software key): the same good key is refused when the Authority is somebody else (the signed-in user is not on the list)", () =>
            WithUserKey(CngExportPolicies.None, null, (key, _) => Assert(SigningKeyGuard.CheckForTest(key, ServiceSid) is SigningKeyGuard.Reason.AceUntrusted or SigningKeyGuard.Reason.OwnerUntrusted, SigningKeyGuard.CheckForTest(key, ServiceSid) ?? "accepted")));
    }

    // Creates a persisted per-user software-KSP ECDSA P-256 key, sets its DACL to {user, SYSTEM, Administrators} (+ `extra`), runs `body`, deletes the key.
    private static void WithUserKey(CngExportPolicies export, SecurityIdentifier? extra, Action<CngKey, SecurityIdentifier> body)
    {
        SecurityIdentifier self = WindowsIdentity.GetCurrent().User!;
        CngKeyCreationParameters parameters = new() { Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider, ExportPolicy = export, KeyUsage = CngKeyUsages.Signing };
        using CngKey key = CngKey.Create(CngAlgorithm.ECDsaP256, "AlberaTestKeyGuard-" + Guid.NewGuid().ToString("N"), parameters);
        try
        {
            SecurityIdentifier[] allow = extra is null ? [SystemSid, AdminsSid, self] : [SystemSid, AdminsSid, self, extra];
            key.SetProperty(new CngProperty("Security Descr", Descriptor(self, allow), (CngPropertyOptions)0x4)); // DACL_SECURITY_INFORMATION: the owner stays the signed-in user
            body(key, self);
        }
        finally { key.Delete(); }
    }
}
