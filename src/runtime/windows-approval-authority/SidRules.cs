using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Albera.ApprovalAuthority;

// Which SIDs may get a pipe ACE (copied from the Broker's TryParseSid; the Broker is not referenced). Only a single principal, written out in full:
// a virtual service account S-1-5-80-<5 sub-authorities> (so not S-1-5-80-0, ALL SERVICES), or an S-1-5-21-... SID that the system itself resolves
// to a USER (not a group, an alias or an unknown SID: the lookup failing means no). SDDL aliases (WD, AU, BU, BA) and group SIDs such as S-1-1-0 or
// ...-513 would let anyone take a pipe. The approver must be a person, so a virtual account is refused for it.
internal static class SidRules
{
    private const int SidTypeUser = 1;

    public static SecurityIdentifier? TryParse(string value, bool allowVirtualAccount)
    {
        try
        {
            SecurityIdentifier sid = new(value);
            if (sid.Value != value) return null;
            string[] parts = value.Split('-');
            bool virtualAccount = allowVirtualAccount && value.StartsWith("S-1-5-80-", StringComparison.Ordinal) && parts.Length == 9 && sid.BinaryLength == 32;
            bool account = value.StartsWith("S-1-5-21-", StringComparison.Ordinal) && parts.Length == 8 && sid.IsAccountSid() && IsUserSid(sid);
            return virtualAccount || account ? sid : null;
        }
        catch (ArgumentException) { return null; }
    }

    private static bool IsUserSid(SecurityIdentifier sid)
    {
        byte[] binary = new byte[sid.BinaryLength];
        sid.GetBinaryForm(binary, 0);
        uint nameLength = 256, domainLength = 256;
        return LookupAccountSidW(null, binary, new StringBuilder((int)nameLength), ref nameLength, new StringBuilder((int)domainLength), ref domainLength, out int use) && use == SidTypeUser;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupAccountSidW(string? systemName, byte[] sid, StringBuilder name, ref uint nameLength, StringBuilder domain, ref uint domainLength, out int use);
}
