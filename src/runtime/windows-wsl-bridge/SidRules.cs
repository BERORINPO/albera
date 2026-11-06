using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Albera.WslBridge;

internal static class SidRules
{
    private const int SidTypeUser = 1;

    // Only a single principal may get the Control Plane ACE, written out in full: a virtual service account S-1-5-80-<5 sub-authorities> (so not S-1-5-80-0, ALL SERVICES), or an S-1-5-21-... SID
    // that the system itself resolves to a USER (not a group, an alias or an unknown SID: the lookup failing means no). Aliases (WD, AU, BU, BA) and group SIDs would let anyone take the pipe.
    internal static SecurityIdentifier? TryParseSid(string value)
    {
        try
        {
            SecurityIdentifier sid = new(value);
            if (sid.Value != value) return null;
            string[] parts = value.Split('-');
            bool virtualAccount = value.StartsWith("S-1-5-80-", StringComparison.Ordinal) && parts.Length == 9 && sid.BinaryLength == 32;
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
