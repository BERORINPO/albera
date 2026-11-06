#if ALBERA_WSL_BRIDGE_TEST_SEAMS
using System.Security.Principal;

namespace Albera.WslBridge;

// Test-only (compiled only with AlberaWslBridgeTestSeams=true, never by the publish script): `--trust-sid <sid>` first on the command line makes PathGuard trust that SID as if it were an administrator.
// A host test runs as the signed-in user and its temp folders belong to that user, not to Administrators. The production rule has no such option.
internal static class TestSeam
{
    public static (string[] Args, IEnumerable<SecurityIdentifier> Trusted) Take(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--trust-sid") return (args[2..], [new SecurityIdentifier(args[1])]);
        return (args, []);
    }
}
#endif
