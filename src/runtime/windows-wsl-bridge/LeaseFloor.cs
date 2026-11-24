using System.Globalization;
using System.Text;

namespace Albera.WslBridge;

// The oldest lease generation the bridge accepts (ADR-012, decision 4). It lives in a file of its own, written by an administrator and read again at every `begin` and every reaper tick: a lease is a bearer
// statement that a restart of the Broker does not revoke, so revoking a Control Plane has to work on a running bridge, by rewriting this one file. One number in ASCII, nothing else but line ends after it.
// The file and its folder must pass the admin guard on every read. Anything else (missing, in use, loose ACL, not a number) reads as null, and `begin` refuses on null: no floor is never read as "no limit".
internal sealed class LeaseFloorFile(string path, PathGuard guard)
{
    private const int MaxFileBytes = 32;

    /// <summary>The floor, or null when it cannot be trusted or read.</summary>
    public long? Read()
    {
        try
        {
            using FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!guard.IsTrusted(path) || !guard.IsTrusted(Path.GetDirectoryName(path)!) || file.Length is 0 or > MaxFileBytes) return null;
            byte[] bytes = new byte[file.Length];
            file.ReadExactly(bytes);
            return Parse(bytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    private static long? Parse(byte[] bytes)
    {
        string text = Encoding.ASCII.GetString(bytes).TrimEnd('\r', '\n');
        return long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out long floor) && floor is >= 1 and <= Albera.BrokerContract.StrictJson.MaxSafeInteger ? floor : null;
    }
}
