using System.Security.Cryptography;
using System.Text.Json;

// The Broker's service configuration (ADR-002, Proposed / NOT VERIFIED): one small JSON file written by the installer, read once when the
// service starts. The installer controls who can write the file; the Broker never writes it. Exactly these keys, nothing else:
//   { "pipeName": "ALBERA_HostBroker", "database": "C:\\ProgramData\\Albera\\broker\\journal.sqlite",
//     "authorityKeys": [ { "kid": "authority-2026-a", "spki": "<base64 SubjectPublicKeyInfo, ECDSA P-256>" }, { "kid": "authority-2026-b", "spki": "..." } ],
//     "controlPlaneSid": "S-1-5-80-...", "generation": 7 }
// `authorityKeys` pins one or two Approval Authority keys (two = rotation overlap); a receipt names its key by `kid`. `generation` is the lease generation the operator requires: the first value of a new journal, and at every start
// a higher value advances the journal's generation (this is how generation N is revoked: configure N+1 and restart), a lower one refuses the start (76, JOURNAL_GENERATION_REGRESSED). The v1 shape (`publicKey`) is refused (config_keys).
// Every rejected value maps to one fixed reason word (never the value itself), so a log line cannot be steered by file content.
// The config file and the database folder (plus an existing journal / -wal / -shm) must also be owned and writable only by trusted principals and
// free of reparse points (ServicePathGuard.cs): otherwise a local user could pre-create them, and the service refuses to start. Once the loop runs it
// holds the database folder open without FILE_SHARE_DELETE (DatabaseFolderPin.cs); a folder that cannot be pinned ends the start with `database_pin`.
internal sealed record ServiceConfig(string PipeName, string Database, IReadOnlyList<AuthorityKey> AuthorityKeys, string ControlPlaneSid, long Generation)
{
    private const int MaxFileBytes = 4096;
    private const int MaxPipeNameLength = 128;
    private const int MaxPathLength = 240; // well below MAX_PATH: the journal also needs its -wal and -shm names
    private const int MaxPublicKeyBytes = 512;
    private const int MaxAuthorityKeys = 2;
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];
    private static readonly string[] Keys = ["pipeName", "database", "authorityKeys", "controlPlaneSid", "generation"];
    private static readonly string[] AuthorityKeyFields = ["kid", "spki"];

    // The only reason words ever printed (SERVICE_CONFIG=invalid:<reason>).
    internal static class Reason
    {
        public const string ConfigPath = "config_path", Unreadable = "config_unreadable", TooLarge = "config_too_large", Syntax = "config_syntax",
            Keys = "config_keys", PipeName = "pipe_name", Database = "database", DatabaseDirectory = "database_directory",
            AuthorityKeys = "authority_keys", ControlPlaneSid = "control_plane_sid", Generation = "generation",
            ConfigUntrusted = "config_untrusted", DatabaseUntrusted = "database_untrusted", DatabasePin = "database_pin";
    }

    public static ServiceConfig? TryLoad(string configPath, out string reason)
    {
        reason = Reason.ConfigPath;
        if (!IsPlainAbsolutePath(configPath)) return null;
        byte[] bytes;
        try
        {
            using FileStream file = new(configPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!ServicePathGuard.IsTrustedConfigFile(configPath, file)) { reason = Reason.ConfigUntrusted; return null; }
            if (file.Length > MaxFileBytes) { reason = Reason.TooLarge; return null; }
            bytes = new byte[file.Length];
            file.ReadExactly(bytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            reason = Reason.Unreadable;
            return null;
        }
        return TryParse(bytes, out reason);
    }

    internal static ServiceConfig? TryParse(byte[] json, out string reason)
    {
        reason = Reason.Syntax;
        ReadOnlyMemory<byte> text = json.AsSpan().StartsWith(Utf8Bom) ? json.AsMemory(Utf8Bom.Length) : json; // Windows PowerShell 5.1 writes a BOM with -Encoding UTF8
        JsonDocument document;
        try { document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 3 }); } // object -> authorityKeys array -> key object
        catch (JsonException) { return null; }
        using (document)
        {
            JsonElement root = document.RootElement;
            reason = Reason.Keys;
            if (root.ValueKind != JsonValueKind.Object) return null;
            HashSet<string> seen = new(StringComparer.Ordinal);
            foreach (JsonProperty property in root.EnumerateObject())
                if (!seen.Add(property.Name)) return null; // a repeated key is ambiguous: refuse rather than pick one
            if (!seen.SetEquals(Keys)) return null;

            string? pipeName = AsString(root, "pipeName"), database = AsString(root, "database"), sid = AsString(root, "controlPlaneSid");
            if (pipeName is null || database is null || sid is null) return null;

            reason = Reason.PipeName;
            if (!IsPlainPipeName(pipeName)) return null;
            reason = Reason.Database;
            if (!IsPlainAbsolutePath(database)) return null;
            reason = Reason.DatabaseDirectory;
            if (!Directory.Exists(Path.GetDirectoryName(database))) return null;
            reason = Reason.DatabaseUntrusted;
            if (!ServicePathGuard.IsTrustedDatabaseLocation(database)) return null;
            reason = Reason.AuthorityKeys;
            if (ReadAuthorityKeys(root.GetProperty("authorityKeys")) is not { } authorityKeys) return null;
            reason = Reason.ControlPlaneSid;
            if (Program.TryParseSid(sid) is null) return null; // aliases and group SIDs such as S-1-1-0 would let anyone take the Broker's one connection
            reason = Reason.Generation;
            JsonElement generationElement = root.GetProperty("generation");
            if (generationElement.ValueKind != JsonValueKind.Number || !generationElement.TryGetInt64(out long generation) || generation is < 1 or > Albera.BrokerContract.StrictJson.MaxSafeInteger) return null;

            reason = "";
            return new ServiceConfig(pipeName, database, authorityKeys, sid, generation);
        }
    }

    private static string? AsString(JsonElement root, string name) =>
        root.GetProperty(name).ValueKind == JsonValueKind.String ? root.GetProperty(name).GetString() : null;

    // A pipe name is one path segment: no separators, no device prefixes. Letters, digits, '_', '-', '.' only, starting with a letter or digit.
    internal static bool IsPlainPipeName(string name) =>
        name.Length is >= 1 and <= MaxPipeNameLength && char.IsAsciiLetterOrDigit(name[0]) &&
        name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.');

    // "C:\dir\file": a local drive path, already in the form GetFullPath would return. That rules out relative and drive-relative paths, UNC and
    // \\?\ \\.\ device prefixes, '..' and '.' segments, '/' separators, doubled separators, trailing dots or spaces, alternate data streams and
    // device names, without trying to canonicalise a hostile string (the file is then opened exactly as written).
    internal static bool IsPlainAbsolutePath(string path)
    {
        if (path.Length is < 4 or > MaxPathLength || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
        if (path[^1] == '\\' || path.IndexOf(':', 2) >= 0 || path.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || path.IndexOfAny(['*', '?']) >= 0) return false;
        try { return string.Equals(Path.GetFullPath(path), path, StringComparison.Ordinal); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException) { return false; }
    }

    // 1..2 entries, each exactly { kid, spki }: a kid that is a contract id, an SPKI that is one P-256 ECDSA public key and nothing else. A repeated kid or
    // a repeated key is refused (two names for one key, or one name for two keys, would make the pinned set ambiguous).
    private static IReadOnlyList<AuthorityKey>? ReadAuthorityKeys(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() is < 1 or > MaxAuthorityKeys) return null;
        List<AuthorityKey> keys = [];
        foreach (JsonElement entry in element.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object) return null;
            HashSet<string> seen = new(StringComparer.Ordinal);
            foreach (JsonProperty property in entry.EnumerateObject())
                if (!seen.Add(property.Name)) return null;
            if (!seen.SetEquals(AuthorityKeyFields)) return null;
            string? kid = AsString(entry, "kid"), spki = AsString(entry, "spki");
            if (kid is null || spki is null || !AuthorityKey.IsKeyId(kid) || DecodePublicKey(spki) is not { } key) return null;
            keys.Add(new AuthorityKey(kid, key));
        }
        bool distinct = keys.Select(k => k.Kid).Distinct(StringComparer.Ordinal).Count() == keys.Count &&
            keys.Select(k => Convert.ToBase64String(k.Spki)).Distinct(StringComparer.Ordinal).Count() == keys.Count;
        return distinct ? keys : null;
    }

    private static byte[]? DecodePublicKey(string text)
    {
        try
        {
            byte[] key = Convert.FromBase64String(text);
            if (key.Length is 0 or > MaxPublicKeyBytes) return null;
            using ECDsa authority = ECDsa.Create();
            authority.ImportSubjectPublicKeyInfo(key, out int used);
            return used == key.Length && authority.KeySize == 256 ? key : null; // P-256 only: the signature is a 64-byte IEEE P1363 pair
        }
        catch (Exception ex) when (ex is FormatException or CryptographicException or ArgumentException) { return null; }
    }
}

/// <summary>One pinned Approval Authority key: the receipt's `kid` names it, the SPKI bytes verify its signature.</summary>
internal sealed record AuthorityKey(string Kid, byte[] Spki)
{
    private static readonly System.Text.RegularExpressions.Regex KeyId = Albera.BrokerContract.ActionDigest.FromEcma(Albera.BrokerContract.ActionDigest.IdPattern);
    internal static bool IsKeyId(string value) => KeyId.IsMatch(value);

    /// <summary>`kid=<base64 spki>[,kid=<base64 spki>]` (the command line of `serve`, which has no config file); null when malformed or not 1..2 distinct P-256 keys.</summary>
    internal static IReadOnlyList<AuthorityKey>? ParseList(string text)
    {
        List<AuthorityKey> keys = [];
        foreach (string part in text.Split(','))
        {
            int split = part.IndexOf('=');
            if (split < 1 || !IsKeyId(part[..split])) return null;
            try
            {
                byte[] spki = Convert.FromBase64String(part[(split + 1)..]);
                using ECDsa key = ECDsa.Create();
                key.ImportSubjectPublicKeyInfo(spki, out int used);
                if (used != spki.Length || key.KeySize != 256) return null;
                keys.Add(new AuthorityKey(part[..split], spki));
            }
            catch (Exception ex) when (ex is FormatException or CryptographicException or ArgumentException) { return null; }
        }
        return keys.Count is >= 1 and <= 2 && keys.Select(k => k.Kid).Distinct(StringComparer.Ordinal).Count() == keys.Count ? keys : null;
    }
}
