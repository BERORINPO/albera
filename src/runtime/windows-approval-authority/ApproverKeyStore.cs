using System.Runtime.InteropServices;
using System.Text.Json;

namespace Albera.ApprovalAuthority;

internal enum PersistResult { Written, NotWritten, Faulted }

// The approver key list the Authority keeps for itself: approver-keys.json, next to the config file and policy.json, with the same trust checks. The second (and last) file the Authority writes.
//   { "v":1, "revision":N, "keys":[ <key record>, ... ], "signCounts":{ "<keyId>":N, ... } }        (docs/architecture/approver-webauthn.md, "Wire contract"; records: ApproverKeyRules)
//   no file          at the service's start (not in service-check) the file is created from the keys the config names, revision 1. If it cannot be created the service refuses to start.
//   a file           the list from then on; the config's keys are not looked at again. `-Mode set-approver` writes the config AND deletes this file, so the next start seeds it from the new config.
//                    At start the file must pass the config's trust check (ServicePathGuard: owner and writers limited to the service, SYSTEM and Administrators, no reparse point), the strict shape
//                    (exactly v, revision, keys, signCounts; every record through ApproverKeyRules.TryRead; 1 to 16 keys, none twice; a sign count only for a registered key; at most MaxFileBytes) and
//                    is otherwise a refusal to start (exit 80, SERVICE_APPROVER_KEYS=invalid:<reason>), never a fall back to the config's keys.
//   a change         ApproverKeySet decides under its lock; this class only writes: the new file next to the old one (create-new temp file, write-through, flushed to disk, trust-checked like the config),
//                    moved over approver-keys.json with MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH and read back (revision, every key, every count). A failure before the move leaves both as
//                    they were (NotWritten); a file that cannot be read back is Faulted: the set refuses everything until the Authority restarts and reads the file. A change is a key removed, or a
//                    sign count that moved (every approval by a webauthn key whose authenticator counts).
// Out of scope, as for policy.json: putting an OLDER file back is something only a principal that can already write the trusted config folder can do, and they can equally replace the config.
// Nothing private is ever stored.
internal static class ApproverKeyStore
{
    public const string FileName = "approver-keys.json";
    public const int MaxFileBytes = 32768;

    // The only reason words ever printed (SERVICE_APPROVER_KEYS=invalid:<reason>).
    internal static class Reason
    {
        public const string Unreadable = "approver_keys_unreadable", Untrusted = "approver_keys_untrusted", TooLarge = "approver_keys_too_large", Invalid = "approver_keys_invalid", Unwritable = "approver_keys_unwritable";
    }

    internal sealed record Loaded(long Revision, IReadOnlyList<ApproverKey> Keys, IReadOnlyDictionary<string, uint> SignCounts);

    private const uint MoveReplaceExisting = 0x1, MoveWriteThrough = 0x8;
    private static readonly string[] TopLevelNames = ["v", "revision", "keys", "signCounts"];

    /// <summary>approver-keys.json in the folder of the config file.</summary>
    public static string PathFor(string configPath) => Path.Combine(Path.GetDirectoryName(configPath)!, FileName);

    /// <param name="legacy">the one Hello record that may keep an id that is not derived (AuthorityConfig.LegacyKey)</param>
    /// <returns>null with a reason word when the file exists but cannot be trusted or read, and also (exists false, reason empty) when there is no file</returns>
    public static Loaded? Read(string path, ApproverKey? legacy, out string reason, out bool exists)
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
            Loaded? loaded = Parse(bytes, legacy);
            if (loaded is null) reason = Reason.Invalid;
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

    private static Loaded? Parse(byte[] bytes, ApproverKey? legacy)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 4 });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            HashSet<string> names = new(StringComparer.Ordinal);
            foreach (JsonProperty property in root.EnumerateObject())
                if (!names.Add(property.Name)) return null; // a repeated name is ambiguous
            if (!names.SetEquals(TopLevelNames) || !IsNumber(root.GetProperty("v"), out long version) || version != 1 || !IsNumber(root.GetProperty("revision"), out long revision) || revision < 1) return null;
            if (ApproverKeyRules.TryReadList(root.GetProperty("keys"), legacy) is not { } keys) return null;
            JsonElement counts = root.GetProperty("signCounts");
            if (counts.ValueKind != JsonValueKind.Object) return null;
            Dictionary<string, uint> signCounts = new(StringComparer.Ordinal);
            foreach (JsonProperty count in counts.EnumerateObject())
                if (!IsNumber(count.Value, out long value) || value is < 0 or > uint.MaxValue || keys.All(k => k.KeyId != count.Name) || !signCounts.TryAdd(count.Name, (uint)value)) return null;
            return new Loaded(revision, keys, signCounts);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException) { return null; }
    }

    private static bool IsNumber(JsonElement element, out long value)
    {
        value = 0;
        return element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out value);
    }

    private static byte[] Envelope(long revision, IReadOnlyList<ApproverKey> keys, IReadOnlyDictionary<string, uint> counts)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping })) // base64 keeps its + as it is
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", 1);
            writer.WriteNumber("revision", revision);
            writer.WriteStartArray("keys");
            foreach (ApproverKey key in keys) ApproverKeyRules.WriteRecord(writer, key);
            writer.WriteEndArray();
            writer.WriteStartObject("signCounts");
            foreach (ApproverKey key in keys)
                if (counts.TryGetValue(key.KeyId, out uint count)) writer.WriteNumber(key.KeyId, count);
            writer.WriteEndObject();
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }

    /// <summary>Replace the file with this state (see the header). Never throws.</summary>
    public static PersistResult Write(string path, long revision, IReadOnlyList<ApproverKey> keys, IReadOnlyDictionary<string, uint> counts, ApproverKey? legacy)
    {
        byte[] content = Envelope(revision, keys, counts);
        if (content.Length > MaxFileBytes) return PersistResult.NotWritten; // never write a file the next start would refuse
        string temp = Path.Combine(Path.GetDirectoryName(path)!, $"approver-keys.{Guid.NewGuid():N}.tmp");
        try
        {
            bool trusted;
            using (FileStream stream = new(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(content);
                stream.Flush(flushToDisk: true);
                trusted = ServicePathGuard.IsTrustedConfigFile(temp, stream); // the new file must pass the check that the next start will apply
            }
            if (!trusted || !MoveFileExW(temp, path, MoveReplaceExisting | MoveWriteThrough)) { Remove(temp); return PersistResult.NotWritten; }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Remove(temp);
            return PersistResult.NotWritten;
        }
        Loaded? stored = Read(path, legacy, out _, out _);
        return stored is not null && stored.Revision == revision && SameKeys(stored.Keys, keys) && SameCounts(stored.SignCounts, keys, counts) ? PersistResult.Written : PersistResult.Faulted;
    }

    private static bool SameKeys(IReadOnlyList<ApproverKey> stored, IReadOnlyList<ApproverKey> expected) =>
        stored.Count == expected.Count && stored.Zip(expected).All(pair => pair.First.KeyId == pair.Second.KeyId && ApproverKeyRules.Digest(pair.First) == ApproverKeyRules.Digest(pair.Second));

    // Only the counts of registered keys are written, so only those are compared.
    private static bool SameCounts(IReadOnlyDictionary<string, uint> stored, IReadOnlyList<ApproverKey> keys, IReadOnlyDictionary<string, uint> expected) =>
        keys.All(key => stored.GetValueOrDefault(key.KeyId) == expected.GetValueOrDefault(key.KeyId));

    private static void Remove(string temp)
    {
        try { File.Delete(temp); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { } // a leftover temp file is never read
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileExW(string from, string to, uint flags);
}
