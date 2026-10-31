using System.Runtime.InteropServices;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

// The tier policy in force (docs/architecture/approval-tiers.md, issue #115 step 3) and the one file the Authority ever writes: policy.json, next to the config file.
//   no file          careful, revision 0 (today's behaviour: every action needs a person). The service starts.
//   a file           read once at start with the same trust check as the config file (ServicePathGuard: owner and writers limited to the service, SYSTEM and Administrators, no
//                    reparse point on the path) and the strict shape of TierPolicy.TryParse. Anything else (untrusted, unreadable, too large, not exactly the shape) is a refusal to
//                    start (exit 79), never a fall back to a looser tier. The policy of a running Authority changes only through Change below, from the approver pipe.
//   a change         under one lock: the revision must be the current one + 1; a change that lets any action skip a person that could not before (TierPolicy.Loosens) needs the
//                    approver's presence signature over PolicyChange.Message(new policy), one that only adds prompts needs none; then the new file is written next to the old one
//                    (create-new temp file, write-through, flushed to disk, trust-checked like the config), moved over policy.json with MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
//                    and read back. The in-memory policy changes only after all of that. A failure before the move leaves both as they were; a file that cannot be read back
//                    afterwards makes the store "faulted": every action needs a person and no change is accepted until the Authority restarts (the restart reads the file).
internal sealed class PolicyStore
{
    public const string FileName = "policy.json";

    // The only reason words ever printed (SERVICE_POLICY=invalid:<reason>).
    internal static class Reason
    {
        public const string Unreadable = "policy_unreadable", Untrusted = "policy_untrusted", TooLarge = "policy_too_large", Invalid = "policy_invalid";
    }

    private const uint MoveReplaceExisting = 0x1, MoveWriteThrough = 0x8;

    private readonly object gate = new();
    private readonly string? file;
    private TierPolicy current;
    private bool faulted;

    private PolicyStore(string? file, TierPolicy current)
    {
        this.file = file;
        this.current = current;
    }

    /// <summary>A store with no file: the policy lives in memory only (unit tests of the core; the default is careful).</summary>
    public static PolicyStore InMemory(TierPolicy? initial = null) => new(null, initial ?? TierPolicy.Default);

    /// <summary>policy.json in the folder of the config file (the Authority's own config directory).</summary>
    public static string PathFor(string configPath) => Path.Combine(Path.GetDirectoryName(configPath)!, FileName);

    /// <returns>null with a fixed reason word when the file exists but cannot be trusted or read; otherwise the store (careful when there is no file, <paramref name="fromFile"/> says which)</returns>
    public static PolicyStore? TryLoad(string configPath, out string reason, out bool fromFile)
    {
        string path = PathFor(configPath);
        TierPolicy? policy = ReadFile(path, out reason, out fromFile);
        if (!fromFile) return new PolicyStore(path, TierPolicy.Default);
        return policy is null ? null : new PolicyStore(path, policy);
    }

    private static TierPolicy? ReadFile(string path, out string reason, out bool exists)
    {
        reason = "";
        exists = true;
        try
        {
            using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!ServicePathGuard.IsTrustedConfigFile(path, stream)) { reason = Reason.Untrusted; return null; }
            if (stream.Length > TierPolicy.MaxFileBytes) { reason = Reason.TooLarge; return null; }
            byte[] bytes = new byte[stream.Length];
            stream.ReadExactly(bytes);
            TierPolicy? policy = TierPolicy.TryParse(bytes);
            if (policy is null) reason = Reason.Invalid;
            return policy;
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            exists = false;
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            reason = Reason.Unreadable;
            return null;
        }
    }

    /// <summary>True after a policy file that was just written could not be read back: nothing is signed without a person until the Authority restarts.</summary>
    public bool IsFaulted
    {
        get { lock (gate) { return faulted; } }
    }

    /// <summary>The policy in force.</summary>
    public TierPolicy Current
    {
        get { lock (gate) { return InForce(); } }
    }

    /// <summary>Runs <paramref name="body"/> with the policy in force while no change can happen (a faulted store shows the default, which skips nobody).</summary>
    public T With<T>(Func<TierPolicy, T> body)
    {
        lock (gate) { return body(InForce()); }
    }

    private TierPolicy InForce() => faulted ? TierPolicy.Default : current;

    /// <param name="verify">checks the approver's presence signature over PolicyChange.Message(next); called only for a change that lets an action skip a person</param>
    /// <returns>null on success, otherwise one of AuthorityCodes</returns>
    public string? Change(TierPolicy next, Func<PresenceResult> verify)
    {
        lock (gate)
        {
            if (faulted) return AuthorityCodes.AuthorityUnavailable;
            if (next.Revision != current.Revision + 1) return AuthorityCodes.RequestInvalid;
            if (next.Loosens(current))
            {
                PresenceResult presence = verify();
                if (presence == PresenceResult.Unavailable) return AuthorityCodes.PresenceUnavailable;
                if (presence != PresenceResult.Verified) return AuthorityCodes.PresenceMismatch;
            }
            if (file is not null && !Persist(next)) return AuthorityCodes.AuthorityUnavailable;
            current = next;
            return null;
        }
    }

    // Called under the lock.
    private bool Persist(TierPolicy next)
    {
        string temp = Path.Combine(Path.GetDirectoryName(file)!, $"policy.{Guid.NewGuid():N}.tmp");
        try
        {
            bool trusted;
            using (FileStream stream = new(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(next.ToJson());
                stream.Flush(flushToDisk: true);
                trusted = ServicePathGuard.IsTrustedConfigFile(temp, stream); // the new file must pass the check that the next start will apply
            }
            if (!trusted || !MoveFileExW(temp, file!, MoveReplaceExisting | MoveWriteThrough)) { Remove(temp); return false; }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Remove(temp);
            return false;
        }
        TierPolicy? stored = ReadFile(file!, out _, out _);
        if (stored is not null && stored.Hash() == next.Hash()) return true;
        faulted = true;
        return false;
    }

    private static void Remove(string temp)
    {
        try { File.Delete(temp); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { } // a leftover temp file is never read
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileExW(string from, string to, uint flags);
}
