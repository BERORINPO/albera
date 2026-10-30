using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Albera.Lab;

// What the process token looks like from the inside: user, enabled / deny-only groups, restricting SIDs, privileges, integrity level, session.
// This is the evidence for lab step 3 (service token shape). It reads this process's own token, or (token-of) the token of another process
// the caller can open with PROCESS_QUERY_LIMITED_INFORMATION + TOKEN_QUERY, e.g. the real Broker service process.
internal static class TokenReport
{
    private const int TokenUser = 1, TokenGroups = 2, TokenPrivileges = 3, TokenOwner = 4, TokenRestrictedSids = 11, TokenSessionId = 12,
                      TokenElevation = 20, TokenHasRestrictions = 21, TokenIntegrityLevel = 25;
    private const uint GroupLogonId = 0xC0000000;
    private static readonly (uint Bit, string Name)[] GroupFlags =
        [(0x1, "mandatory"), (0x2, "enabled_by_default"), (0x4, "enabled"), (0x8, "owner"), (0x10, "deny_only"), (0x20, "integrity")];

    public static Dictionary<string, object?> Capture(uint? processId = null)
    {
        IntPtr process = processId is { } other ? Native.OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, other) : Native.GetCurrentProcess();
        if (process == IntPtr.Zero) throw new Win32Exception();
        try { return CaptureToken(process, processId ?? (uint)Environment.ProcessId); }
        finally { if (processId is not null) _ = Native.CloseHandle(process); }
    }

    private static Dictionary<string, object?> CaptureToken(IntPtr process, uint processId)
    {
        if (!Native.OpenProcessToken(process, 0x8 /*TOKEN_QUERY*/, out IntPtr token)) throw new Win32Exception();
        try
        {
            string integrity = Query(token, TokenIntegrityLevel, buffer => SidString(Marshal.ReadIntPtr(buffer)));
            return new Dictionary<string, object?>
            {
                ["pid"] = processId,
                ["user"] = Query(token, TokenUser, buffer => Describe(Marshal.ReadIntPtr(buffer))),
                ["owner"] = Query(token, TokenOwner, buffer => Describe(Marshal.ReadIntPtr(buffer))),
                ["sessionId"] = Query(token, TokenSessionId, buffer => (uint)Marshal.ReadInt32(buffer)),
                ["integritySid"] = integrity,
                ["integrity"] = integrity.Split('-')[^1] switch { "4096" => "low", "8192" => "medium", "12288" => "high", "16384" => "system", var rid => $"rid_{rid}" },
                ["elevated"] = Query(token, TokenElevation, buffer => Marshal.ReadInt32(buffer) != 0),
                ["hasRestrictions"] = Query(token, TokenHasRestrictions, buffer => Marshal.ReadInt32(buffer) != 0),
                ["groups"] = Query(token, TokenGroups, ReadGroups),
                ["restrictedSids"] = Query(token, TokenRestrictedSids, ReadGroups),
                ["privileges"] = Query(token, TokenPrivileges, ReadPrivileges),
            };
        }
        finally { _ = Native.CloseHandle(token); }
    }

    private static T Query<T>(IntPtr token, int informationClass, Func<IntPtr, T> read)
    {
        _ = Native.GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out int needed); // size probe: fails with INSUFFICIENT_BUFFER by design
        IntPtr buffer = Marshal.AllocHGlobal(Math.Max(needed, 8));
        try
        {
            if (!Native.GetTokenInformation(token, informationClass, buffer, needed, out _)) throw new Win32Exception();
            return read(buffer);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // TOKEN_GROUPS: DWORD count, then (pointer-aligned) SID_AND_ATTRIBUTES[count].
    private static List<Dictionary<string, object?>> ReadGroups(IntPtr buffer)
    {
        int count = Marshal.ReadInt32(buffer), stride = IntPtr.Size * 2;
        List<Dictionary<string, object?>> groups = [];
        for (int i = 0; i < count; i++)
        {
            IntPtr entry = buffer + IntPtr.Size + i * stride;
            uint attributes = (uint)Marshal.ReadInt32(entry, IntPtr.Size);
            List<string> flags = GroupFlags.Where(f => (attributes & f.Bit) != 0).Select(f => f.Name).ToList();
            if ((attributes & GroupLogonId) == GroupLogonId) flags.Add("logon_id");
            Dictionary<string, object?> group = Describe(Marshal.ReadIntPtr(entry));
            group["attributes"] = flags;
            groups.Add(group);
        }
        return groups;
    }

    // TOKEN_PRIVILEGES: DWORD count, then LUID_AND_ATTRIBUTES[count] (12 bytes each).
    private static List<Dictionary<string, object?>> ReadPrivileges(IntPtr buffer)
    {
        int count = Marshal.ReadInt32(buffer);
        List<Dictionary<string, object?>> privileges = [];
        for (int i = 0; i < count; i++)
        {
            Native.LuidAndAttributes luid = Marshal.PtrToStructure<Native.LuidAndAttributes>(buffer + 4 + i * 12);
            StringBuilder name = new(64);
            int length = name.Capacity;
            privileges.Add(new Dictionary<string, object?>
            {
                ["name"] = Native.LookupPrivilegeNameW(null, ref luid, name, ref length) ? name.ToString() : $"luid_{luid.HighPart}_{luid.LowPart}",
                ["enabled"] = (luid.Attributes & 0x2) != 0,
            });
        }
        return privileges;
    }

    private static string SidString(IntPtr sid) => new SecurityIdentifier(sid).Value;

    public static Dictionary<string, object?> Describe(IntPtr sid)
    {
        SecurityIdentifier identifier = new(sid);
        string? name = null;
        try { name = identifier.Translate(typeof(NTAccount)).Value; }
        catch (IdentityNotMappedException) { }
        return new Dictionary<string, object?> { ["sid"] = identifier.Value, ["name"] = name };
    }
}
