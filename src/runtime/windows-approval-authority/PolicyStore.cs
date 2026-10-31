using System.Runtime.InteropServices;
using System.Text.Json;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

// The tier policy in force (docs/architecture/approval-tiers.md, issue #115 step 3) and the one file the Authority ever writes: policy.json, next to the config file.
//   no file          careful, revision 0 (today's behaviour: every action needs a person). The service starts.
//   a file           { "v":1, "rev":N, "tier":..., "overrides":{...}, "authorized": { "v":1, "rev":M, "tier":..., "overrides":{...}, "presence":"<base64 signature>" } }
//                    `authorized` is the policy the approver's Hello key signed (PolicyChange.Message: albera.policy.v1 + kid + audience + hash of THAT policy, kid and audience being this
//                    Authority's trusted config). It is required whenever the policy lets any action skip a person, and the policy must not skip more than it does (the skippable set of the
//                    policy is a subset of the authorized one; the policy is the authorized one itself, or a later change that only added prompts). A careful-equivalent policy needs none.
//                    At start the file must pass the config's trust check (ServicePathGuard: owner and writers limited to the service, SYSTEM and Administrators, no reparse point), the
//                    strict shape, and the signature check against the pinned approver key. Anything else (untrusted, unreadable, too large, malformed, unsigned or wrongly signed) is a
//                    refusal to start (exit 79), never a fall back to a looser tier. The folder is checked first, at the config load (exit 73), so a file squatted by a low-privilege user in
//                    a badly set up folder never gets this far.
//   a change         under one lock: the revision must be the current one + 1; a change that lets any action skip a person that could not before (TierPolicy.Loosens) needs the approver's
//                    presence signature over PolicyChange.Message(new policy, kid, audience), one that only adds prompts needs none; then the new file is written next to the old one
//                    (create-new temp file, write-through, flushed to disk, trust-checked like the config), moved over policy.json with MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
//                    and read back (signature included). The in-memory policy changes only after all of that. A failure before the move leaves both as they were; a file that cannot be
//                    read back afterwards makes the store "faulted": every action needs a person and no change is accepted until the Authority restarts (the restart reads the file).
// Out of scope, on purpose: putting an OLDER file back (or deleting it) is something only a principal that can already write the trusted config folder can do (the service, SYSTEM,
// Administrators). They own the machine and can equally replace the config, the pinned approver key or the signing key. Restoring an older signed file is accepted if its signature
// is valid; no TPM or external counter is used to prevent that. What the signature does prevent: a file nobody authorized, a file edited by hand, a signature copied from another
// policy, from another Authority (kid, audience) or onto a bigger policy.
internal sealed class PolicyStore
{
    public const string FileName = "policy.json";
    public const int MaxFileBytes = 2048; // two overrides maps and a 256-byte RSA signature in base64

    // The only reason words ever printed (SERVICE_POLICY=invalid:<reason>).
    internal static class Reason
    {
        public const string Unreadable = "policy_unreadable", Untrusted = "policy_untrusted", TooLarge = "policy_too_large", Invalid = "policy_invalid", Unsigned = "policy_unsigned";
    }

    private const uint MoveReplaceExisting = 0x1, MoveWriteThrough = 0x8;
    private const int SignatureTextLimit = 512;

    private sealed record Loaded(TierPolicy Policy, TierPolicy? Authorized, byte[]? Presence);

    private readonly object gate = new();
    private readonly string? file;
    private readonly AuthorityIdentity? identity;
    private readonly IHumanPresenceVerifier? verifier;
    private TierPolicy current;
    private TierPolicy? authorized;
    private byte[]? authorizedProof;
    private bool faulted;

    private PolicyStore(string? file, AuthorityIdentity? identity, IHumanPresenceVerifier? verifier, TierPolicy current, TierPolicy? authorized, byte[]? authorizedProof)
    {
        this.file = file;
        this.identity = identity;
        this.verifier = verifier;
        this.current = current;
        this.authorized = authorized;
        this.authorizedProof = authorizedProof;
    }

    /// <summary>A store with no file: the policy lives in memory only (unit tests of the core; the default is careful).</summary>
    public static PolicyStore InMemory(TierPolicy? initial = null) => new(null, null, null, initial ?? TierPolicy.Default, null, null);

    /// <summary>policy.json in the folder of the config file (the Authority's own config directory).</summary>
    public static string PathFor(string configPath) => Path.Combine(Path.GetDirectoryName(configPath)!, FileName);

    /// <param name="identity">kid and audience the signature must be bound to (trusted config)</param>
    /// <param name="verifier">checks the approver's signature (the pinned key); kept for the read-back after a change</param>
    /// <returns>null with a fixed reason word when the file exists but cannot be trusted or read; otherwise the store (careful when there is no file, <paramref name="fromFile"/> says which)</returns>
    public static PolicyStore? TryLoad(string configPath, AuthorityIdentity identity, IHumanPresenceVerifier verifier, out string reason, out bool fromFile)
    {
        string path = PathFor(configPath);
        Loaded? loaded = ReadFile(path, identity, verifier, out reason, out fromFile);
        if (!fromFile) return new PolicyStore(path, identity, verifier, TierPolicy.Default, null, null);
        return loaded is null ? null : new PolicyStore(path, identity, verifier, loaded.Policy, loaded.Authorized, loaded.Presence);
    }

    private static Loaded? ReadFile(string path, AuthorityIdentity identity, IHumanPresenceVerifier verifier, out string reason, out bool exists)
    {
        reason = "";
        exists = true;
        try
        {
            using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!ServicePathGuard.IsTrustedConfigFile(path, stream)) { reason = Reason.Untrusted; return null; }
            if (stream.Length > MaxFileBytes) { reason = Reason.TooLarge; return null; }
            byte[] bytes = new byte[stream.Length];
            stream.ReadExactly(bytes);
            Loaded? loaded = Parse(bytes);
            if (loaded is null) { reason = Reason.Invalid; return null; }
            if (!IsAuthorized(loaded, identity, verifier)) { reason = Reason.Unsigned; return null; }
            return loaded;
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

    // The strict shape: the four policy keys, plus (optionally) `authorized`: the four policy keys plus `presence`.
    private static Loaded? Parse(byte[] bytes)
    {
        Dictionary<string, object> root;
        try { root = StrictJson.Parse(bytes, 3); }
        catch (StrictJsonException) { return null; }
        Dictionary<string, object> own = new(root, StringComparer.Ordinal);
        if (!own.Remove("authorized", out object? wrapped)) return TierPolicy.TryFromValues(own) is { } alone ? new Loaded(alone, null, null) : null;
        if (wrapped is not Dictionary<string, object> inner || !inner.Remove("presence", out object? text) || text is not string base64 || base64.Length > SignatureTextLimit) return null;
        byte[] proof = new byte[(base64.Length * 3 / 4) + 3];
        if (!Convert.TryFromBase64String(base64, proof, out int written)) return null;
        TierPolicy? policy = TierPolicy.TryFromValues(own), signed = TierPolicy.TryFromValues(inner);
        return policy is null || signed is null ? null : new Loaded(policy, signed, proof[..written]);
    }

    // A policy that lets an action skip a person must carry the signature that authorized it; a signature must verify for THIS Authority and never cover less than the policy skips.
    private static bool IsAuthorized(Loaded loaded, AuthorityIdentity identity, IHumanPresenceVerifier verifier)
    {
        if (loaded.Authorized is null) return loaded.Policy.SkippableActions().Count == 0;
        PresenceResult result;
        try { result = verifier.Verify(PolicyChange.Message(loaded.Authorized, identity.Kid, identity.Audience), loaded.Presence!); }
        catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or InvalidOperationException) { return false; }
        return result == PresenceResult.Verified && loaded.Authorized.Revision <= loaded.Policy.Revision && loaded.Policy.SkippableActions().IsSubsetOf(loaded.Authorized.SkippableActions());
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

    /// <param name="proof">the approver's signature over PolicyChange.Message(next, kid, audience); looked at only for a change that lets an action skip a person</param>
    /// <param name="verify">checks that signature</param>
    /// <returns>null on success, otherwise one of AuthorityCodes</returns>
    public string? Change(TierPolicy next, byte[]? proof, Func<TierPolicy, byte[], PresenceResult> verify)
    {
        lock (gate)
        {
            if (faulted) return AuthorityCodes.AuthorityUnavailable;
            if (next.Revision != current.Revision + 1) return AuthorityCodes.RequestInvalid;
            TierPolicy? nextAuthorized = authorized;
            byte[]? nextProof = authorizedProof;
            if (next.Loosens(current))
            {
                PresenceResult presence = proof is null ? PresenceResult.Mismatch : verify(next, proof);
                if (presence == PresenceResult.Unavailable) return AuthorityCodes.PresenceUnavailable;
                if (presence != PresenceResult.Verified) return AuthorityCodes.PresenceMismatch;
                (nextAuthorized, nextProof) = (next, proof);
            }
            if (next.SkippableActions().Count == 0) (nextAuthorized, nextProof) = (null, null);
            if (file is not null && !Persist(next, nextAuthorized, nextProof)) return AuthorityCodes.AuthorityUnavailable;
            (current, authorized, authorizedProof) = (next, nextAuthorized, nextProof);
            return null;
        }
    }

    private static byte[] Envelope(TierPolicy policy, TierPolicy? signed, byte[]? presence)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) // base64 keeps its + as it is
        {
            writer.WriteStartObject();
            policy.WriteFields(writer);
            if (signed is not null)
            {
                writer.WriteStartObject("authorized");
                signed.WriteFields(writer);
                writer.WriteString("presence", Convert.ToBase64String(presence!));
                writer.WriteEndObject();
            }
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }

    // Called under the lock.
    private bool Persist(TierPolicy next, TierPolicy? signed, byte[]? presence)
    {
        if (signed is null && next.SkippableActions().Count > 0) return false; // never write a file that skips a person without the signature that allows it
        string temp = Path.Combine(Path.GetDirectoryName(file)!, $"policy.{Guid.NewGuid():N}.tmp");
        try
        {
            bool trusted;
            using (FileStream stream = new(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(Envelope(next, signed, presence));
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
        Loaded? stored = ReadFile(file!, identity!, verifier!, out _, out _);
        if (stored is not null && stored.Policy.Hash() == next.Hash() && stored.Authorized?.Hash() == signed?.Hash()) return true;
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
