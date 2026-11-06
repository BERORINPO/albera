// WSL2 run lease v1 (ADR-012, decision 4). C# twin of wsl2-run-lease.mjs (digest, canonical bytes, envelope check, verify); wsl2-run-lease-vectors.json pins both. BCL only, net10.0.
// The WSL bridge runs a job only under a lease the Broker signed for one approved task.start.
//
// It is its own kind next to the two attestations: its own domain and its own nine body keys, so a lease is never read as an attestation or the other way round. Same signature scheme
// (ECDSA P-256 / SHA-256, r || s, checked by the injected verify). An attestation is evidence at one moment (at most 300 s); a lease covers a run (at most 3600 s).
//
//   body     9 keys: v (1), operationId, computerId, isolation (only ever "wsl2"), repositoryId, baseOid (40 or 64 lowercase hex), maxCalls (1..10000),
//            issuedAt, expiresAt (Unix seconds from the BROKER's clock)
//   preimage UTF8("albera.wsl2-run-lease.v1") 0x00 enc(map)   (enc as in ActionDigest.cs)
//   digest   "sha256:" + lowercase hex of SHA-256(preimage); the signature covers the preimage bytes; keyId and signature are not part of the digest
//   signed   { digest, keyId, lease, signature }  signature = unpadded base64url of the signer's bytes
//
// Verify checks, in this order: expected values, shape, TTL and digest, signature, not yet valid, expired (the clock is read AFTER the signature check), then every binding (baseOid,
// computerId, operationId, repositoryId). It is stateless: refusing a reused lease and counting calls is the bridge's job.
using System;
using System.Buffers.Text;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Albera.BrokerContract;

public sealed record Wsl2RunLeaseBody(long V, string OperationId, string ComputerId, string Isolation, string RepositoryId, string BaseOid, long MaxCalls, long IssuedAt, long ExpiresAt);

/// <summary>What the caller itself knows about the run it is deciding. Every part is required.</summary>
public sealed record Wsl2RunLeaseExpected(string BaseOid, string ComputerId, string OperationId, string RepositoryId);

/// <summary>Code null = ok. Codes: invalid_context invalid_expected malformed ttl digest signature not_yet_valid expired binding; Field is only ever a fixed field name or "$extra".</summary>
public sealed record Wsl2RunLeaseVerdict(bool Ok, string? Code = null, string? Field = null, Wsl2RunLeaseBody? Value = null, string? Digest = null, string? KeyId = null);

public static class Wsl2RunLease
{
    public const long Version = 1;
    public const string Domain = "albera.wsl2-run-lease.v1";
    public const string Isolation = "wsl2";
    public const long MaxTtlSeconds = 3600, MaxCalls = 10_000;
    private const int MaxSignatureBytes = 128;

    private static readonly string[] BodyKeys = ["baseOid", "computerId", "expiresAt", "isolation", "issuedAt", "maxCalls", "operationId", "repositoryId", "v"];
    private static readonly string[] SignedKeys = ["digest", "keyId", "lease", "signature"];
    private static readonly Regex IdRegex = ActionDigest.FromEcma(ActionDigest.IdPattern);
    private static readonly Regex OidRegex = ActionDigest.FromEcma("^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
    private static readonly Regex DigestRegex = ActionDigest.FromEcma("^sha256:[0-9a-f]{64}$");
    private static readonly Regex Base64UrlRegex = ActionDigest.FromEcma("^[A-Za-z0-9_-]+$");

    private static Wsl2RunLeaseVerdict Fail(string code, string? field = null) => new(false, code, field);
    private static bool IsCounter(object? v) => v is long n && n >= 1 && n <= StrictJson.MaxSafeInteger;
    private static bool IsId(object? v) => v is string s && IdRegex.IsMatch(s);
    private static bool SameKeys(IReadOnlyDictionary<string, object> map, string[] keys) => map.Count == keys.Length && keys.All(map.ContainsKey);

    /// <summary>True for a full lowercase git object id, SHA-1 or SHA-256.</summary>
    public static bool IsGitOid(object? v) => v is string s && OidRegex.IsMatch(s);

    /// <summary>Shape and TTL of a body that the strict reader has parsed. The first failing field in the table's order wins, as in the Node twin.</summary>
    public static Wsl2RunLeaseVerdict ValidateBody(object? body)
    {
        if (body is not IReadOnlyDictionary<string, object> b) return Fail("malformed");
        if (!SameKeys(b, BodyKeys)) return Fail("malformed", "$extra");
        (string Field, bool Good)[] checks =
        [
            ("v", b["v"] is long v && v == Version),
            ("operationId", IsId(b["operationId"])),
            ("computerId", IsId(b["computerId"])),
            ("isolation", b["isolation"] is string isolation && isolation == Isolation),
            ("repositoryId", IsId(b["repositoryId"])),
            ("baseOid", IsGitOid(b["baseOid"])),
            ("maxCalls", IsCounter(b["maxCalls"]) && (long)b["maxCalls"] <= MaxCalls),
            ("issuedAt", IsCounter(b["issuedAt"])),
            ("expiresAt", IsCounter(b["expiresAt"])),
        ];
        foreach ((string field, bool good) in checks) if (!good) return Fail("malformed", field);
        long issuedAt = (long)b["issuedAt"], expiresAt = (long)b["expiresAt"];
        if (expiresAt <= issuedAt || expiresAt - issuedAt > MaxTtlSeconds) return Fail("ttl", "expiresAt");
        Wsl2RunLeaseBody value = new((long)b["v"], (string)b["operationId"], (string)b["computerId"], (string)b["isolation"], (string)b["repositoryId"], (string)b["baseOid"], (long)b["maxCalls"], issuedAt, expiresAt);
        return new Wsl2RunLeaseVerdict(true, Value: value);
    }

    /// <summary>The exact bytes that are hashed and signed. The body must already have passed <see cref="ValidateBody"/>.</summary>
    public static byte[] Canonicalize(Wsl2RunLeaseBody body)
    {
        Dictionary<string, object> map = new(StringComparer.Ordinal)
        {
            ["v"] = body.V, ["operationId"] = body.OperationId, ["computerId"] = body.ComputerId, ["isolation"] = body.Isolation, ["repositoryId"] = body.RepositoryId,
            ["baseOid"] = body.BaseOid, ["maxCalls"] = body.MaxCalls, ["issuedAt"] = body.IssuedAt, ["expiresAt"] = body.ExpiresAt,
        };
        using MemoryStream buffer = new();
        buffer.Write(Encoding.UTF8.GetBytes(Domain));
        buffer.WriteByte(0);
        ActionDigest.Write(buffer, map);
        return buffer.ToArray();
    }

    /// <returns>"sha256:" + 64 lowercase hex characters</returns>
    public static string DigestOf(ReadOnlySpan<byte> canonical) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(canonical));

    /// <summary>Validate a body and return its digest and preimage, or the refusal (code and field as the Node twin).</summary>
    public static (Wsl2RunLeaseVerdict Verdict, string? Digest, byte[]? Preimage) Compute(object? body)
    {
        Wsl2RunLeaseVerdict verdict = ValidateBody(body);
        if (!verdict.Ok) return (verdict, null, null);
        byte[] bytes = Canonicalize(verdict.Value!);
        return (verdict, DigestOf(bytes), bytes);
    }

    private static bool TryDecodeSignature(object? value, out byte[] bytes)
    {
        bytes = [];
        if (value is not string text || !Base64UrlRegex.IsMatch(text)) return false;
        try { bytes = Base64Url.DecodeFromChars(text); }
        catch (FormatException) { return false; }
        return bytes.Length is >= 1 and <= MaxSignatureBytes && Base64Url.EncodeToString(bytes) == text;
    }

    /// <summary>Shape and digest only (no signature, no clock). An attestation is malformed here (other keys). On success Value, Digest and KeyId are set.</summary>
    public static (Wsl2RunLeaseVerdict Verdict, byte[] Preimage, byte[] Signature) ReadSigned(object? signed)
    {
        if (signed is not IReadOnlyDictionary<string, object> s) return (Fail("malformed"), [], []);
        if (!SameKeys(s, SignedKeys)) return (Fail("malformed", "$extra"), [], []);
        if (!IsId(s["keyId"])) return (Fail("malformed", "keyId"), [], []);
        if (s["digest"] is not string digest || !DigestRegex.IsMatch(digest)) return (Fail("malformed", "digest"), [], []);
        if (!TryDecodeSignature(s["signature"], out byte[] signature)) return (Fail("malformed", "signature"), [], []);
        (Wsl2RunLeaseVerdict body, string? computed, byte[]? preimage) = Compute(s["lease"]);
        if (!body.Ok) return (body, [], []);
        if (computed != digest) return (Fail("digest", "digest"), [], []);
        return (new Wsl2RunLeaseVerdict(true, Value: body.Value, Digest: digest, KeyId: (string)s["keyId"]), preimage!, signature);
    }

    /// <summary>Full check (see the header). <paramref name="verify"/> gets (keyId, preimage bytes, signature bytes). <paramref name="clock"/> returns Unix seconds and is read after the signature check.</summary>
    public static Wsl2RunLeaseVerdict Verify(object? signed, Func<long> clock, Func<string, byte[], byte[], bool> verify, Wsl2RunLeaseExpected expected)
    {
        if (clock is null || verify is null) return Fail("invalid_context");
        if (!IsId(expected.ComputerId)) return Fail("invalid_expected", "computerId");
        if (!IsId(expected.OperationId)) return Fail("invalid_expected", "operationId");
        if (!IsId(expected.RepositoryId)) return Fail("invalid_expected", "repositoryId");
        if (!IsGitOid(expected.BaseOid)) return Fail("invalid_expected", "baseOid");
        (Wsl2RunLeaseVerdict read, byte[] preimage, byte[] signature) = ReadSigned(signed);
        if (!read.Ok) return read;
        bool genuine;
        try { genuine = verify(read.KeyId!, preimage, signature); }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException or InvalidOperationException) { genuine = false; }
        if (!genuine) return Fail("signature", "signature");
        long now;
        try { now = clock(); }
        catch (Exception) { return Fail("invalid_context", "clock"); } // an injected clock that throws is an unusable context (fail closed)
        if (now < 0 || now > StrictJson.MaxSafeInteger) return Fail("invalid_context", "clock");
        Wsl2RunLeaseBody a = read.Value!;
        if (a.IssuedAt > now + NetworkAttestation.MaxObservedSkewSeconds) return Fail("not_yet_valid", "issuedAt");
        if (now >= a.ExpiresAt) return Fail("expired", "expiresAt");
        // Same order as the Node twin: baseOid, computerId, operationId, repositoryId.
        if (a.BaseOid != expected.BaseOid) return Fail("binding", "baseOid");
        if (a.ComputerId != expected.ComputerId) return Fail("binding", "computerId");
        if (a.OperationId != expected.OperationId) return Fail("binding", "operationId");
        if (a.RepositoryId != expected.RepositoryId) return Fail("binding", "repositoryId");
        return read;
    }
}
