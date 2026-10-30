using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace Albera.ApprovalAuthority;

// Start-up check of the signing key's protection (docs/architecture/approval-authority.md, "Preconditions before production"). Opening the key is
// not enough: a key that can be exported, or that other accounts may use, would let anyone with that access mint receipts. Before any pipe exists the
// service therefore reads two things off the OPENED key and refuses to start (exit 78, `SigningKeyUnprotected`) unless both hold:
//   - Export Policy is exactly None (non-exportable: no export, no archiving, plaintext or not), and
//   - the key's security descriptor (NCRYPT_SECURITY_DESCR_PROPERTY, owner + DACL) names only the Authority's own SID, LocalSystem and
//     BUILTIN\Administrators: as owner and in every allow ACE (any access mask). A NULL DACL (everybody) or an allow ACE this check cannot read
//     fails too. Deny ACEs grant nothing and are ignored. Everyone, Users, Authenticated Users and the interactive user are not on the list, so an
//     ACE for any of them is refused no matter what rights it carries.
// The check only READS the key. Anything that stops it from finishing (property missing, malformed descriptor) is a refusal: fail closed. The returned
// reason is one fixed word, never a SID or a name. Administrators and SYSTEM are on the list because they can always take the key file (and are
// documented as inside the trust boundary); the TPM Platform Crypto Provider may not expose these properties, in which case it is refused until verified.
internal static class SigningKeyGuard
{
    internal static class Reason
    {
        public const string Exportable = "key_exportable", ExportPolicyUnreadable = "export_policy_unreadable", DescriptorUnreadable = "descriptor_unreadable",
            DaclMissing = "dacl_missing", OwnerUntrusted = "owner_untrusted", AceUntrusted = "ace_untrusted";
    }

    private const string SecurityDescriptorProperty = "Security Descr"; // NCRYPT_SECURITY_DESCR_PROPERTY
    private const int OwnerSecurityInformation = 0x1, DaclSecurityInformation = 0x4;
    private static readonly SecurityIdentifier LocalSystem = new("S-1-5-18"), Administrators = new("S-1-5-32-544");

    /// <summary>Null when the key is protected as required; otherwise one fixed reason word.</summary>
    public static string? Check(CngKey key, SecurityIdentifier service)
    {
        CngExportPolicies policy;
        try { policy = key.ExportPolicy; }
        catch (CryptographicException) { return Reason.ExportPolicyUnreadable; }
        byte[]? descriptor;
        try { descriptor = key.GetProperty(SecurityDescriptorProperty, (CngPropertyOptions)(OwnerSecurityInformation | DaclSecurityInformation)).GetValue(); }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException) { return Reason.DescriptorUnreadable; }
        return Evaluate(policy, descriptor, service);
    }

    /// <summary>The decision on its own (no key needed): `policy` as read from the key, `descriptor` the self-relative security descriptor bytes.</summary>
    public static string? Evaluate(CngExportPolicies policy, byte[]? descriptor, SecurityIdentifier service)
    {
        if (policy != CngExportPolicies.None) return Reason.Exportable;
        RawSecurityDescriptor parsed;
        try
        {
            if (descriptor is not { Length: > 0 }) return Reason.DescriptorUnreadable;
            parsed = new RawSecurityDescriptor(descriptor, 0);
        }
        catch (ArgumentException) { return Reason.DescriptorUnreadable; }
        if (parsed.Owner is not { } owner || !IsTrusted(owner, service)) return Reason.OwnerUntrusted;
        if (parsed.DiscretionaryAcl is not { } dacl) return Reason.DaclMissing;
        foreach (GenericAce ace in dacl)
        {
            bool allows = ace.AceType is AceType.AccessAllowed or AceType.AccessAllowedCallback or AceType.AccessAllowedCompound or AceType.AccessAllowedObject or AceType.AccessAllowedCallbackObject;
            if (!allows) continue;
            if (ace is not KnownAce known || !IsTrusted(known.SecurityIdentifier, service)) return Reason.AceUntrusted;
        }
        return null;
    }

    private static bool IsTrusted(SecurityIdentifier sid, SecurityIdentifier service) => sid.Equals(service) || sid.Equals(LocalSystem) || sid.Equals(Administrators);
}
