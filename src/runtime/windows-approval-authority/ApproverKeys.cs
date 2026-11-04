using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal enum ApproverKeyKind { HelloRsa, WebAuthn }

/// <summary>The public data of one registered approver key (never a private half). Hello keys are RSA-2048 and sign the presence message as a raw PKCS#1 v1.5 signature; webauthn keys sign through WebAuthn. Alg is the COSE number: -7 ES256, -257 RS256.</summary>
internal sealed record ApproverKey(string KeyId, ApproverKeyKind Kind, int Alg, byte[] PublicKey, byte[]? CredentialId)
{
    public string KindName => Kind == ApproverKeyKind.WebAuthn ? ApproverKeyRules.WebAuthnKind : ApproverKeyRules.HelloRsaKind;
}

// The key record of docs/architecture/approver-webauthn.md ("Wire contract"), in config, store, key_add and the messages:
//   {"keyId":"webauthn-0123456789abcdef","kind":"webauthn","alg":-7,"publicKey":"<base64 SPKI>","credentialId":"<base64url, no padding>"}
//   {"keyId":"hello-951a135537287eae","kind":"hello-rsa","alg":-257,"publicKey":"<base64 SPKI>"}
// keyId is "webauthn-" or "hello-" plus the first 8 bytes of SHA-256 over the SPKI, lower-case hex, and a record whose id is not that is refused; the one exception is the Hello key of an older config's
// approverKeyId + approverPublicKey pair, which keeps the id the installer gave it (AuthorityConfig.LegacyKey). alg is -7 (a P-256 key) or -257 (RSA; 2048 to 4096 bits for webauthn, exactly 2048 for hello-rsa).
// credentialId is webauthn only, 1 to 1023 bytes.
internal static class ApproverKeyRules
{
    public const string HelloRsaKind = "hello-rsa", WebAuthnKind = "webauthn";
    public const int HelloRsaAlg = -257, MaxKeys = 16;

    /// <summary>The `keys` reply must fit one frame beside its envelope, so the metadata of the whole list is capped. With the usual 32-byte credential ids all 16 keys fit; longer ids lower the number of keys that do.</summary>
    public const int MaxMetadataBytes = 1900;

    private static readonly Regex IdRegex = ActionDigest.FromEcma(ActionDigest.IdPattern);

    public static bool IsId(string text) => IdRegex.IsMatch(text);

    public static string DerivedId(ApproverKeyKind kind, byte[] spki) =>
        (kind == ApproverKeyKind.WebAuthn ? "webauthn-" : "hello-") + Convert.ToHexStringLower(SHA256.HashData(spki).AsSpan(0, 8));

    /// <param name="requireDerivedId">false only for the Hello key of an older config's pair</param>
    /// <returns>null unless every field is acceptable for the kind</returns>
    public static ApproverKey? TryCreate(string keyId, string kind, long alg, byte[] spki, byte[]? credentialId, bool requireDerivedId)
    {
        if (!IsId(keyId)) return null;
        ApproverKey? key = kind switch
        {
            HelloRsaKind when alg == HelloRsaAlg && credentialId is null && IsHelloKey(spki) => new(keyId, ApproverKeyKind.HelloRsa, HelloRsaAlg, spki, null),
            WebAuthnKind when credentialId is { Length: >= 1 and <= WebAuthn.MaxCredentialIdBytes } && WebAuthnAlgorithms.Accepts(alg, spki) => new(keyId, ApproverKeyKind.WebAuthn, (int)alg, spki, credentialId),
            _ => null,
        };
        return key is not null && (!requireDerivedId || keyId == DerivedId(key.Kind, spki)) ? key : null;
    }

    private static bool IsHelloKey(byte[] spki)
    {
        using RsaPresenceVerifier? verifier = RsaPresenceVerifier.TryCreate(spki);
        return verifier is not null;
    }

    /// <summary>One record as parsed fields (the strict wire reader, or ToFields for config and store): exactly the documented keys, canonical base64, TryCreate's rules and the derived id.</summary>
    /// <param name="legacy">the one Hello record allowed to keep an id that is not derived (AuthorityConfig.LegacyKey); null for a record that came over the pipe</param>
    public static ApproverKey? TryRead(IReadOnlyDictionary<string, object> fields, ApproverKey? legacy = null)
    {
        bool webAuthn = fields.GetValueOrDefault("kind") as string == WebAuthnKind;
        if (fields.Count != (webAuthn ? 5 : 4) || fields.GetValueOrDefault("keyId") is not string keyId || fields.GetValueOrDefault("kind") is not string kind || fields.GetValueOrDefault("alg") is not long alg ||
            fields.GetValueOrDefault("publicKey") is not string keyText || !Base64Text.TryDecode(keyText, WebAuthnAlgorithms.MaxPublicKeyBytes, out byte[] spki)) return null;
        byte[]? credentialId = null;
        if (webAuthn && (fields.GetValueOrDefault("credentialId") is not string credentialText || !Base64Text.TryDecodeUrl(credentialText, WebAuthn.MaxCredentialIdBytes, out credentialId))) return null;
        if (TryCreate(keyId, kind, alg, spki, credentialId, requireDerivedId: false) is not { } key) return null;
        bool keepsGivenId = legacy is not null && key.Kind == ApproverKeyKind.HelloRsa && key.KeyId == legacy.KeyId && key.PublicKey.AsSpan().SequenceEqual(legacy.PublicKey);
        return keepsGivenId || keyId == DerivedId(key.Kind, spki) ? key : null;
    }

    /// <summary>A JSON object of strings and integers as parsed fields; null for any other value or a repeated name.</summary>
    public static IReadOnlyDictionary<string, object>? ToFields(JsonElement record)
    {
        if (record.ValueKind != JsonValueKind.Object) return null;
        Dictionary<string, object> fields = new(StringComparer.Ordinal);
        foreach (JsonProperty property in record.EnumerateObject())
        {
            object? value = property.Value.ValueKind switch
            {
                JsonValueKind.String => property.Value.GetString(),
                JsonValueKind.Number => property.Value.TryGetInt64(out long number) ? number : null,
                _ => null,
            };
            if (value is null || !fields.TryAdd(property.Name, value)) return null;
        }
        return fields;
    }

    /// <summary>A JSON array of records (the config's approverKeys, the store's keys): 1 to MaxKeys, each a valid record, no key twice, metadata that fits a reply. Null otherwise.</summary>
    public static IReadOnlyList<ApproverKey>? TryReadList(JsonElement array, ApproverKey? legacy = null)
    {
        if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() is 0 or > MaxKeys) return null;
        List<ApproverKey> keys = [];
        foreach (JsonElement record in array.EnumerateArray())
        {
            if (ToFields(record) is not { } fields || TryRead(fields, legacy) is not { } key) return null;
            keys.Add(key);
        }
        return Fits(keys) ? keys : null;
    }

    /// <summary>True when two records name the same key id, the same public key or the same credential: a key is registered once.</summary>
    public static bool Overlap(ApproverKey a, ApproverKey b) =>
        a.KeyId == b.KeyId || a.PublicKey.AsSpan().SequenceEqual(b.PublicKey) || (a.CredentialId is not null && b.CredentialId is not null && a.CredentialId.AsSpan().SequenceEqual(b.CredentialId));

    /// <summary>A list the Authority can hold: 1 to MaxKeys keys, none twice, and the `keys` reply for it fits a frame.</summary>
    public static bool Fits(IReadOnlyList<ApproverKey> keys) =>
        keys.Count is >= 1 and <= MaxKeys && keys.Select((key, i) => keys.Skip(i + 1).Any(other => Overlap(key, other))).All(twice => !twice) && Encoding.UTF8.GetByteCount(MetadataJson(keys)) <= MaxMetadataBytes;

    /// <summary>The canonical bytes of a record: the JSON above with the keys in exactly that order, no spaces, UTF-8, credentialId left out for hello-rsa. Every value is from the id / base64 / base64url alphabets, so nothing is escaped.</summary>
    public static byte[] Canonical(ApproverKey key) =>
        Encoding.UTF8.GetBytes($"{{\"keyId\":\"{key.KeyId}\",\"kind\":\"{key.KindName}\",\"alg\":{key.Alg},\"publicKey\":\"{Convert.ToBase64String(key.PublicKey)}\"" +
            (key.CredentialId is null ? "}" : $",\"credentialId\":\"{Base64Text.EncodeUrl(key.CredentialId)}\"}}"));

    /// <summary>hex(SHA-256(canonical record)), lower case, 64 characters.</summary>
    public static string Digest(ApproverKey key) => Convert.ToHexStringLower(SHA256.HashData(Canonical(key)));

    /// <summary>The record as the store writes it (same key order as the canonical bytes).</summary>
    public static void WriteRecord(Utf8JsonWriter writer, ApproverKey key)
    {
        writer.WriteStartObject();
        writer.WriteString("keyId", key.KeyId);
        writer.WriteString("kind", key.KindName);
        writer.WriteNumber("alg", key.Alg);
        writer.WriteString("publicKey", Convert.ToBase64String(key.PublicKey));
        if (key.CredentialId is not null) writer.WriteString("credentialId", Base64Text.EncodeUrl(key.CredentialId));
        writer.WriteEndObject();
    }

    /// <summary>What `keys` and the key verbs reply with: a JSON array of {"keyId","kind"} plus "credentialId" for a webauthn key. Public data only, and no public key.</summary>
    public static string MetadataJson(IEnumerable<ApproverKey> keys)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartArray();
            foreach (ApproverKey key in keys)
            {
                writer.WriteStartObject();
                writer.WriteString("keyId", key.KeyId);
                writer.WriteString("kind", key.KindName);
                if (key.CredentialId is not null) writer.WriteString("credentialId", Base64Text.EncodeUrl(key.CredentialId));
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }
}

// What a registered key signs to add or remove a key (UTF-8, 0x00 between the parts, all ASCII, ending in the single-use Authority challenge):
//   "albera.keyadd.v1"    0x00 newKeyId 0x00 hex(SHA-256(canonical record of the new key))     0x00 challenge
//   "albera.keyremove.v1" 0x00 keyId    0x00 hex(SHA-256(canonical record of the removed key)) 0x00 challenge
// The Authority builds them from the record it parsed itself (or already holds), so a signature only verifies for exactly that key.
internal static class KeyMessages
{
    public const string AddDomain = "albera.keyadd.v1", RemoveDomain = "albera.keyremove.v1";

    public static byte[] Add(ApproverKey key, string challenge) => Encoding.UTF8.GetBytes($"{AddDomain}\0{key.KeyId}\0{ApproverKeyRules.Digest(key)}\0{challenge}");

    public static byte[] Remove(ApproverKey key, string challenge) => Encoding.UTF8.GetBytes($"{RemoveDomain}\0{key.KeyId}\0{ApproverKeyRules.Digest(key)}\0{challenge}");
}

/// <summary>Checks one proof against one key. Either form: a webauthn assertion (packed by WebAuthnProof) for a webauthn key, or a raw RSA signature for a Hello key. Never throws.</summary>
internal static class ApproverKeyVerifier
{
    public static PresenceResult Verify(ApproverKey key, ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof, out uint signCount)
    {
        signCount = 0;
        if (WebAuthnProof.IsWebAuthn(proof))
            return WebAuthnProof.TryDecode(proof, out WebAuthnAssertion assertion) ? WebAuthn.Verify(key, assertion, message, out signCount) : PresenceResult.Mismatch;
        if (key.Kind != ApproverKeyKind.HelloRsa) return PresenceResult.Mismatch;
        using RsaPresenceVerifier? hello = RsaPresenceVerifier.TryCreate(key.PublicKey);
        return hello?.Verify(message, proof) ?? PresenceResult.Mismatch;
    }
}

internal enum KeyOp { Add, Remove }

/// <summary>The codes only the key verbs (key_challenge / key_add / key_remove) answer with, on the approver pipe. They are not in AuthorityCodes: the Control Plane can never see them, and the pipe client helper's allow-list for the submit pipe stays what it was.</summary>
internal static class ApproverKeyCodes
{
    public const string ChallengeUnknown = "challenge_unknown", ChallengeExpired = "challenge_expired", KeyExists = "key_exists", KeyUnknown = "key_unknown", LastKey = "last_key", TooManyKeys = "too_many_keys";
}

internal enum KeyListSource { Config, File }

/// <summary>Code null = success. A challenge: Challenge and ExpiresAt (unix seconds). An add or remove: Keys is the list as registered now (what the reply shows); PolicyReset says a remove also reset the tier policy to careful.</summary>
internal readonly record struct KeyOutcome(string? Code, string Challenge = "", long ExpiresAt = 0, IReadOnlyList<ApproverKey>? Keys = null, bool PolicyReset = false);

// The registered approver keys: who may approve. It is the presence verifier of the Authority (any one registered key may sign) and the only place the list changes.
//   source      the keys the config names, copied into approver-keys.json when that file is missing (at the service's start); from then on the file is the list (ApproverKeyStore.cs).
//   verifying   Verify(message, proof, out keyId): a webauthn proof is looked up by its credential id (rule 1); a raw signature is tried against each Hello key. The key that verified is reported, so the
//               receipt can name it. Sign count (rule 4), kept per key AND in the file (signCounts): when the stored and the new count are both non-zero the new one must be larger; a count of 0 is
//               never refused and never lowers the stored one. An invalid signature never moves a count. A count that moves is written before the approval counts: if the file cannot be written the
//               proof is Unavailable (memory and file stay the same), because the Authority no longer knows what a clone would look like.
//   changing    key_challenge -> key_add / key_remove. ONE challenge is outstanding (a new one replaces it): 128 random bits, bound to the operation and the key id, valid 120 s, used up by the first
//               key_add / key_remove that presents it whatever the outcome. key_add needs a proof by a registered key (`by`) AND one by the new key (`newKey`, the person holds it) over KeyMessages.Add;
//               key_remove needs a proof by any registered key over KeyMessages.Remove and never removes the last key. One lock covers the checks, the file write and the swap, so two changes cannot
//               interleave. A file that was written but cannot be read back faults the set: nothing verifies (Unavailable) and nothing changes until the Authority restarts, because what is on disk
//               is no longer known.
internal sealed class ApproverKeySet : IHumanPresenceVerifier
{
    public const int ChallengeTtlSeconds = 120;

    private sealed record Challenge(KeyOp Op, string KeyId, string Value, long ExpiresAt);

    private static readonly IReadOnlyDictionary<string, uint> NoCounts = new Dictionary<string, uint>();

    private readonly object gate = new();
    private readonly Func<long> clock;
    private readonly string? file;
    private readonly ApproverKey? legacy;
    private IReadOnlyList<ApproverKey> keys;
    private IReadOnlyDictionary<string, uint> signCounts;
    private long revision;
    private Challenge? outstanding;
    private bool faulted;

    private ApproverKeySet(string? file, ApproverKey? legacy, IReadOnlyList<ApproverKey> keys, IReadOnlyDictionary<string, uint> signCounts, long revision, Func<long> clock)
    {
        this.file = file;
        this.legacy = legacy;
        this.keys = keys;
        this.signCounts = signCounts;
        this.revision = revision;
        this.clock = clock;
    }

    /// <summary>A set that never touches a file (unit tests of the core).</summary>
    public static ApproverKeySet InMemory(IEnumerable<ApproverKey> keys, Func<long> clock) => new(null, null, [.. keys], NoCounts, 0, clock);

    /// <summary>The list for this config. With <paramref name="seed"/> (the service, never service-check) a missing approver-keys.json is created from the config's keys first.</summary>
    /// <returns>null with a fixed reason word when approver-keys.json exists and cannot be trusted, read or understood, or cannot be created; never the config's keys alone in place of a bad file</returns>
    public static ApproverKeySet? Open(AuthorityConfig config, Func<long> clock, bool seed, out string reason, out KeyListSource source)
    {
        reason = "";
        source = KeyListSource.Config;
        IReadOnlyList<ApproverKey> fromConfig = config.ApproverKeys ?? throw new InvalidOperationException(); // TryParse always sets it
        if (config.ConfigPath is null) return new(null, null, fromConfig, NoCounts, 0, clock);
        string path = ApproverKeyStore.PathFor(config.ConfigPath);
        ApproverKeyStore.Loaded? loaded = ApproverKeyStore.Read(path, config.LegacyKey, out reason, out bool exists);
        if (exists)
        {
            if (loaded is null) return null;
            source = KeyListSource.File;
            return new(path, config.LegacyKey, loaded.Keys, loaded.SignCounts, loaded.Revision, clock);
        }
        if (!seed) return new(path, config.LegacyKey, fromConfig, NoCounts, 0, clock);
        if (ApproverKeyStore.Write(path, 1, fromConfig, NoCounts, config.LegacyKey) != PersistResult.Written)
        {
            reason = ApproverKeyStore.Reason.Unwritable;
            return null;
        }
        source = KeyListSource.File;
        return new(path, config.LegacyKey, fromConfig, NoCounts, 1, clock);
    }

    /// <summary>The registered keys (a snapshot).</summary>
    public IReadOnlyList<ApproverKey> Keys
    {
        get { lock (gate) { return keys; } }
    }

    /// <summary>The same keys for checking a proof that was stored earlier (the one that authorized policy.json): the signature is checked, sign counts are neither enforced nor moved.</summary>
    public IHumanPresenceVerifier ForStoredProofs => new StoredProofs(this);

    // A list of keys as a verifier for proofs stored earlier: the keys that would REMAIN after a removal.
    private sealed class KeyList(IReadOnlyList<ApproverKey> keys) : IHumanPresenceVerifier
    {
        public PresenceResult Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof) => Match(keys, null, message, proof, out _, out _);
    }

    private sealed class StoredProofs(ApproverKeySet set) : IHumanPresenceVerifier
    {
        public PresenceResult Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof)
        {
            lock (set.gate) { return set.Check(message, proof, enforceSignCount: false, out _, out _); }
        }
    }

    public PresenceResult Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof) => Verify(message, proof, out _);

    public PresenceResult Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof, out string? keyId)
    {
        keyId = null;
        lock (gate)
        {
            PresenceResult result = Check(message, proof, enforceSignCount: true, out ApproverKey? signer, out uint count);
            if (result != PresenceResult.Verified) return result;
            IReadOnlyDictionary<string, uint> counts = WithCount(signCounts, signer!.KeyId, count);
            if (!ReferenceEquals(counts, signCounts) && Commit(keys, counts) is not null) return PresenceResult.Unavailable; // the count could not be kept: no approval
            keyId = signer.KeyId;
            return PresenceResult.Verified;
        }
    }

    // Rules 1 to 4 over the registered keys; changes nothing. Called under the lock.
    private PresenceResult Check(ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof, bool enforceSignCount, out ApproverKey? signer, out uint count)
    {
        (signer, count) = (null, 0);
        return faulted ? PresenceResult.Unavailable : Match(keys, enforceSignCount ? signCounts : null, message, proof, out signer, out count);
    }

    // The same over any list of keys. With <paramref name="counts"/> the sign count rule is enforced against it; without, only the signature is looked at.
    private static PresenceResult Match(IReadOnlyList<ApproverKey> keys, IReadOnlyDictionary<string, uint>? counts, ReadOnlySpan<byte> message, ReadOnlySpan<byte> proof, out ApproverKey? signer, out uint count)
    {
        (signer, count) = (null, 0);
        bool webAuthn = WebAuthnProof.IsWebAuthn(proof);
        WebAuthnAssertion assertion = new([], [], []);
        if (webAuthn && !WebAuthnProof.TryDecode(proof, out assertion)) return PresenceResult.Mismatch;
        foreach (ApproverKey key in keys)
        {
            // rule 1: a webauthn proof is for the key that holds its credential id; a raw signature is for a Hello key
            if (webAuthn ? key.CredentialId is null || !key.CredentialId.AsSpan().SequenceEqual(assertion.CredentialId) : key.Kind != ApproverKeyKind.HelloRsa) continue;
            if (ApproverKeyVerifier.Verify(key, message, proof, out uint signCount) != PresenceResult.Verified) continue;
            // rule 4
            if (counts is not null && counts.TryGetValue(key.KeyId, out uint stored) && stored != 0 && signCount != 0 && signCount <= stored) return PresenceResult.Mismatch;
            (signer, count) = (key, signCount);
            return PresenceResult.Verified;
        }
        return PresenceResult.Mismatch;
    }

    // The counts after a proof with this count verified: unchanged (the same object) for 0 or the count already stored.
    private static IReadOnlyDictionary<string, uint> WithCount(IReadOnlyDictionary<string, uint> counts, string keyId, uint count) =>
        count == 0 || counts.GetValueOrDefault(keyId) == count ? counts : new Dictionary<string, uint>(counts) { [keyId] = count };

    // ---- key_challenge / key_add / key_remove --------------------------------------------------------------------------------------------

    public KeyOutcome IssueChallenge(KeyOp op, string keyId)
    {
        lock (gate)
        {
            if (faulted) return new(AuthorityCodes.AuthorityUnavailable);
            if (!ApproverKeyRules.IsId(keyId)) return new(AuthorityCodes.RequestInvalid);
            bool registered = keys.Any(k => k.KeyId == keyId);
            if (op == KeyOp.Add && registered) return new(ApproverKeyCodes.KeyExists);
            if (op == KeyOp.Add && keys.Count >= ApproverKeyRules.MaxKeys) return new(ApproverKeyCodes.TooManyKeys);
            if (op == KeyOp.Remove && !registered) return new(ApproverKeyCodes.KeyUnknown);
            if (op == KeyOp.Remove && keys.Count <= 1) return new(ApproverKeyCodes.LastKey);
            long expiresAt = clock() + ChallengeTtlSeconds;
            outstanding = new(op, keyId, Ids.NewBits128(), expiresAt); // replaces the one before
            return new(null, outstanding.Value, expiresAt);
        }
    }

    /// <param name="by">a proof by an already registered key over KeyMessages.Add(candidate, challenge)</param>
    /// <param name="newKey">a proof by the candidate itself over the same message: the person holds the new key</param>
    public KeyOutcome Add(ApproverKey candidate, string challenge, byte[] by, byte[] newKey)
    {
        lock (gate)
        {
            if (faulted) return new(AuthorityCodes.AuthorityUnavailable);
            if (TakeChallenge(challenge, KeyOp.Add, candidate.KeyId) is { } refused) return new(refused);
            if (keys.Any(k => ApproverKeyRules.Overlap(k, candidate))) return new(ApproverKeyCodes.KeyExists);
            if (keys.Count >= ApproverKeyRules.MaxKeys) return new(ApproverKeyCodes.TooManyKeys);
            byte[] message = KeyMessages.Add(candidate, challenge);
            PresenceResult authorized = Check(message, by, enforceSignCount: true, out ApproverKey? signer, out uint signerCount);
            if (authorized != PresenceResult.Verified) return new(CodeOf(authorized));
            if (ApproverKeyVerifier.Verify(candidate, message, newKey, out uint candidateCount) != PresenceResult.Verified) return new(AuthorityCodes.PresenceMismatch);
            IReadOnlyList<ApproverKey> next = [.. keys, candidate];
            if (!ApproverKeyRules.Fits(next)) return new(ApproverKeyCodes.TooManyKeys); // the reply for this many keys would not fit a frame
            IReadOnlyDictionary<string, uint> counts = WithCount(WithCount(signCounts, signer!.KeyId, signerCount), candidate.KeyId, candidateCount);
            return Commit(next, counts) is { } failed ? new(failed) : new(null, Keys: next);
        }
    }

    /// <param name="by">a proof by any registered key over KeyMessages.Remove(key, challenge)</param>
    /// <param name="beforeRemoval">called once the removal is authorized and before anything is written, with the keys that would remain as a verifier; a code it returns refuses the removal. The core uses it to reset a
    /// tier policy whose authorizing proof only the removed key could vouch for, so that write comes first and a crash between the two writes leaves a state that starts.</param>
    public KeyOutcome Remove(string keyId, string challenge, byte[] by, Func<IHumanPresenceVerifier, string?>? beforeRemoval = null)
    {
        lock (gate)
        {
            if (faulted) return new(AuthorityCodes.AuthorityUnavailable);
            if (TakeChallenge(challenge, KeyOp.Remove, keyId) is { } refused) return new(refused);
            if (keys.FirstOrDefault(k => k.KeyId == keyId) is not { } doomed) return new(ApproverKeyCodes.KeyUnknown);
            if (keys.Count <= 1) return new(ApproverKeyCodes.LastKey);
            PresenceResult authorized = Check(KeyMessages.Remove(doomed, challenge), by, enforceSignCount: true, out ApproverKey? signer, out uint signerCount);
            if (authorized != PresenceResult.Verified) return new(CodeOf(authorized));
            IReadOnlyList<ApproverKey> next = [.. keys.Where(k => k.KeyId != keyId)];
            if (beforeRemoval?.Invoke(new KeyList(next)) is { } held) return new(held);
            Dictionary<string, uint> counts = new(WithCount(signCounts, signer!.KeyId, signerCount));
            counts.Remove(keyId);
            return Commit(next, counts) is { } failed ? new(failed) : new(null, Keys: next);
        }
    }

    private static string CodeOf(PresenceResult result) => result == PresenceResult.Unavailable ? AuthorityCodes.PresenceUnavailable : AuthorityCodes.PresenceMismatch;

    // Called under the lock. A presented challenge is used up whatever happens next; a value that is not the outstanding one changes nothing.
    private string? TakeChallenge(string value, KeyOp op, string keyId)
    {
        if (outstanding is not { } issued || !string.Equals(issued.Value, value, StringComparison.Ordinal)) return ApproverKeyCodes.ChallengeUnknown; // never issued, replaced, or already used
        outstanding = null;
        if (clock() >= issued.ExpiresAt) return ApproverKeyCodes.ChallengeExpired;
        return issued.Op == op && issued.KeyId == keyId ? null : ApproverKeyCodes.ChallengeUnknown;
    }

    // Called under the lock: write first (revision + 1), swap after. A write that did not happen leaves memory and file as they were.
    private string? Commit(IReadOnlyList<ApproverKey> nextKeys, IReadOnlyDictionary<string, uint> nextCounts)
    {
        if (file is not null)
        {
            PersistResult result = ApproverKeyStore.Write(file, revision + 1, nextKeys, nextCounts, legacy);
            if (result == PersistResult.Faulted) faulted = true;
            if (result != PersistResult.Written) return AuthorityCodes.AuthorityUnavailable;
        }
        (keys, signCounts, revision) = (nextKeys, nextCounts, revision + 1);
        return null;
    }
}
