// Action digest v1. C# twin of action-digest.mjs; test-vectors.json pins both (including the preimage bytes). BCL only, net10.0.
//
//   preimage = UTF8("albera.action-digest.v1") 0x00 enc(purpose) enc(dto)
//   enc(string) = 0x53 u32be(byteLength) utf8        enc(int)  = 0x49 i64be        enc(bool) = 0x42 (0x00|0x01)
//   enc(map)    = 0x4D u32be(entryCount) { enc(key) enc(value) } sorted by key, ordinal (keys are ASCII)
//   digest      = "sha256:" lowercase-hex(SHA-256(preimage))
//
// The DTO is exactly { action, projectId, computerId, args }; args is a flat map of string | safe integer | boolean. Strings are never
// normalized and must be well-formed and free of control / line-separator / bidi characters. The Authority calls this with the DTO it
// resolved itself; the digest in a request or receipt is never an input.
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Albera.BrokerContract;

public sealed class ActionDigestException : Exception
{
    public string Code => "invalid_action";
    public string Field { get; }
    public ActionDigestException(string field) : base("invalid_action") { Field = field; }
}

public sealed record ValidatedAction(string Action, string ProjectId, string ComputerId, IReadOnlyDictionary<string, object> Args);

public static class ActionDigest
{
    public const string Domain = "albera.action-digest.v1";
    public const string IdPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$";
    public const int MaxArgs = 16;
    public const int MaxArgStringBytes = 256;
    public static IReadOnlyList<string> Purposes { get; } = ["broker.operation", "guest.command"];

    private static readonly Dictionary<string, string[]> ActionsByPurpose = new(StringComparer.Ordinal)
    {
        ["broker.operation"] = ["environment.create", "environment.inspect", "environment.start", "environment.stop", "environment.destroy", "synthetic.noop"],
        ["guest.command"] = ["task.start", "task.cancel", "workspace.inspect", "synthetic.noop"],
    };
    private static readonly string[] DtoKeys = ["action", "args", "computerId", "projectId"];
    private static readonly Regex IdRegex = FromEcma(IdPattern);
    private static readonly Regex ArgKeyRegex = FromEcma("^[a-z][A-Za-z0-9]{0,31}$");
    // [first, last] code points: controls, Arabic letter mark, left/right marks, line/paragraph separators, bidi embeddings/isolates.
    private static readonly (int First, int Last)[] UnsafeRanges = [(0x0, 0x1f), (0x7f, 0x9f), (0x61c, 0x61c), (0x200e, 0x200f), (0x2028, 0x2029), (0x202a, 0x202e), (0x2066, 0x2069)];

    public static IReadOnlyList<string> ActionsFor(string purpose) => ActionsByPurpose.TryGetValue(purpose, out string[]? actions) ? actions : [];

    /// <summary>Compile a JSON Schema (ECMAScript) pattern; `$` there means end of input, which in .NET is `\z`.</summary>
    internal static Regex FromEcma(string pattern) =>
        new(pattern.EndsWith('$') ? pattern[..^1] + "\\z" : pattern, RegexOptions.CultureInvariant);

    public static bool IsSafeText(string value)
    {
        if (!StrictJson.IsWellFormed(value)) return false;
        for (int i = 0; i < value.Length; i++)
        {
            int code = char.ConvertToUtf32(value, i);
            if (code > 0xffff) i++;
            if (UnsafeRanges.Any(r => code >= r.First && code <= r.Last)) return false;
        }
        return true;
    }

    public static ValidatedAction Validate(string purpose, IReadOnlyDictionary<string, object>? dto)
    {
        if (!ActionsByPurpose.ContainsKey(purpose)) throw new ActionDigestException("purpose");
        if (dto is null || dto.Count != DtoKeys.Length || DtoKeys.Any(k => !dto.ContainsKey(k))) throw new ActionDigestException("dto");
        if (dto["action"] is not string action || !ActionsByPurpose[purpose].Contains(action)) throw new ActionDigestException("action");
        string projectId = Id(dto, "projectId"), computerId = Id(dto, "computerId");
        if (dto["args"] is not IReadOnlyDictionary<string, object> args || args.Count > MaxArgs) throw new ActionDigestException("args");
        foreach ((string name, object value) in args)
        {
            bool ok = ArgKeyRegex.IsMatch(name) && value switch
            {
                string s => IsSafeText(s) && Encoding.UTF8.GetByteCount(s) <= MaxArgStringBytes,
                long n => n <= StrictJson.MaxSafeInteger && n >= -StrictJson.MaxSafeInteger,
                bool => true,
                _ => false,
            };
            if (!ok) throw new ActionDigestException("args");
        }
        return new ValidatedAction(action, projectId, computerId, args);
    }

    private static string Id(IReadOnlyDictionary<string, object> dto, string field) =>
        dto[field] is string s && IdRegex.IsMatch(s) ? s : throw new ActionDigestException(field);

    /// <summary>The exact bytes that are hashed.</summary>
    public static byte[] Canonicalize(string purpose, IReadOnlyDictionary<string, object>? dto)
    {
        ValidatedAction a = Validate(purpose, dto);
        var top = new Dictionary<string, object> { ["action"] = a.Action, ["args"] = a.Args, ["computerId"] = a.ComputerId, ["projectId"] = a.ProjectId };
        using var buffer = new MemoryStream();
        buffer.Write(Encoding.UTF8.GetBytes(Domain));
        buffer.WriteByte(0);
        Write(buffer, purpose);
        Write(buffer, top);
        return buffer.ToArray();
    }

    /// <returns>"sha256:" + 64 lowercase hex characters</returns>
    public static string Compute(string purpose, IReadOnlyDictionary<string, object>? dto) =>
        "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Canonicalize(purpose, dto)));

    /// <summary>Parse the DTO with the strict reader (depth 3), then compute. Throws StrictJsonException or ActionDigestException.</summary>
    public static string ComputeFromJson(string purpose, ReadOnlySpan<byte> dtoJson) => Compute(purpose, StrictJson.Parse(dtoJson, 3));

    private static void Write(Stream output, object value)
    {
        Span<byte> number = stackalloc byte[8];
        switch (value)
        {
            case string s:
                byte[] bytes = Encoding.UTF8.GetBytes(s);
                output.WriteByte(0x53);
                BinaryPrimitives.WriteUInt32BigEndian(number, (uint)bytes.Length);
                output.Write(number[..4]);
                output.Write(bytes);
                break;
            case long n:
                output.WriteByte(0x49);
                BinaryPrimitives.WriteInt64BigEndian(number, n);
                output.Write(number);
                break;
            case bool b:
                output.WriteByte(0x42);
                output.WriteByte(b ? (byte)1 : (byte)0);
                break;
            case IReadOnlyDictionary<string, object> map:
                output.WriteByte(0x4d);
                BinaryPrimitives.WriteUInt32BigEndian(number, (uint)map.Count);
                output.Write(number[..4]);
                foreach (string key in map.Keys.Order(StringComparer.Ordinal))
                {
                    Write(output, key);
                    Write(output, map[key]);
                }
                break;
            default:
                throw new ActionDigestException("args");
        }
    }
}
