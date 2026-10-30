// Strict JSON reader for the receipt v2 / action DTO contract. C# twin of strict-json.mjs; test-vectors.json pins both.
// Source-include this file (BCL only, net10.0). Accepts only objects, strings, booleans and safe integers (|n| <= 2^53-1) and rejects null,
// arrays, fractions, exponents, "-0", leading zeros, duplicate keys, lone surrogates, a BOM, comments, trailing commas, trailing data and
// nesting deeper than maxDepth. Values are string, long, bool or Dictionary<string, object>.
using System;
using System.Buffers;
using System.Collections.Generic;
using System.Text.Json;

namespace Albera.BrokerContract;

public sealed class StrictJsonException : Exception
{
    public StrictJsonException() : base("malformed_json") { }
}

public static class StrictJson
{
    public const long MaxSafeInteger = 9007199254740991;

    public static Dictionary<string, object> Parse(ReadOnlySpan<byte> utf8, int maxDepth)
    {
        try
        {
            var reader = new Utf8JsonReader(utf8, new JsonReaderOptions { CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) throw new StrictJsonException();
            Dictionary<string, object> root = ReadObject(ref reader, 1, maxDepth);
            if (reader.Read()) throw new StrictJsonException();
            return root;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException or FormatException)
        {
            throw new StrictJsonException();
        }
    }

    private static Dictionary<string, object> ReadObject(ref Utf8JsonReader reader, int depth, int maxDepth)
    {
        if (depth > maxDepth) throw new StrictJsonException();
        var result = new Dictionary<string, object>(StringComparer.Ordinal);
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.EndObject) return result;
            if (reader.TokenType != JsonTokenType.PropertyName) throw new StrictJsonException();
            string name = WellFormed(reader.GetString());
            if (!reader.Read()) throw new StrictJsonException();
            object value = reader.TokenType switch
            {
                JsonTokenType.String => WellFormed(reader.GetString()),
                JsonTokenType.Number => ReadInteger(ref reader),
                JsonTokenType.True => true,
                JsonTokenType.False => false,
                JsonTokenType.StartObject => ReadObject(ref reader, depth + 1, maxDepth),
                _ => throw new StrictJsonException(),
            };
            if (!result.TryAdd(name, value)) throw new StrictJsonException(); // duplicate key
        }
        throw new StrictJsonException();
    }

    private static long ReadInteger(ref Utf8JsonReader reader)
    {
        byte[] raw = reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan.ToArray();
        int start = raw.Length > 0 && raw[0] == (byte)'-' ? 1 : 0;
        bool digitsOnly = raw.Length > start;
        for (int i = start; i < raw.Length; i++) if (raw[i] < (byte)'0' || raw[i] > (byte)'9') digitsOnly = false;
        if (!digitsOnly || (raw[start] == (byte)'0' && raw.Length > start + 1) || (start == 1 && raw.Length == 2 && raw[1] == (byte)'0')) throw new StrictJsonException();
        if (!reader.TryGetInt64(out long n) || n > MaxSafeInteger || n < -MaxSafeInteger) throw new StrictJsonException();
        return n;
    }

    /// <summary>True when every UTF-16 surrogate is part of a valid pair.</summary>
    public static bool IsWellFormed(string s)
    {
        for (int i = 0; i < s.Length; i++)
        {
            if (char.IsHighSurrogate(s[i]) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) i++;
            else if (char.IsSurrogate(s[i])) return false;
        }
        return true;
    }

    private static string WellFormed(string? s) => s is not null && IsWellFormed(s) ? s : throw new StrictJsonException();
}
