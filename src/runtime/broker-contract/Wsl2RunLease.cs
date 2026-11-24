// WSL2 run lease v1 (ADR-012, decision 4). C# twin of wsl2-run-lease.mjs (digest, canonical bytes, envelope check, verify); wsl2-run-lease-vectors.json pins both. BCL only, net10.0.
// The WSL bridge runs a job only under a lease the Broker signed for one approved task.start.
//
// It is its own kind next to the two attestations: its own domain and its own eleven body keys, so a lease is never read as an attestation or the other way round. Same signature scheme
// (ECDSA P-256 / SHA-256, r || s, checked by the injected verify). An attestation is evidence at one moment (at most 300 s); a lease covers a run (at most 3600 s).
//
//   body     11 keys: v (1), operationId, actionDigest ("sha256:" + 64 lowercase hex: the approved action, for the record), leaseGeneration (the Broker's fence value at the claim), computerId, isolation (only ever "wsl2"), repositoryId, baseOid (40 or 64 lowercase hex), maxCalls (1..10000),
//            issuedAt, expiresAt (Unix seconds from the BROKER's clock)
//   preimage UTF8("albera.wsl2-run-lease.v1") 0x00 enc(map)   (enc as in ActionDigest.cs)
//   digest   "sha256:" + lowercase hex of SHA-256(preimage); the signature covers the preimage bytes; keyId and signature are not part of the digest
//   signed   { digest, keyId, lease, signature }  signature = unpadded base64url of the signer's bytes
//
// Two steps, so that nothing unauthenticated is ever acted on. Authenticate: shape, TTL and digest, signature, not yet valid, expired (the clock is read AFTER the signature check). RequireBinding: every binding
// (baseOid, computerId, operationId, repositoryId), then the generation floor. Both are stateless: the bridge must keep each operationId and its call count on disk, across its restarts, until expiresAt + 30 s, and
// refuse when it cannot. The key for reuse is operationId, never the signature: ECDSA signatures are malleable.
using System;
using System.Buffers.Text;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Albera.BrokerContract;

public sealed record Wsl2RunLeaseBody(long V, string OperationId, string ActionDigest, long LeaseGeneration, string ComputerId, string Isolation, string RepositoryId, string BaseOid, long MaxCalls, long IssuedAt, long ExpiresAt);

/// <summary>The signed form <c>{ digest, keyId, lease, signature }</c> that <see cref="Wsl2RunLease.Sign"/> returns. <see cref="ToJson"/> is the wire text (alphabetical keys; every value is a validated id, digest, hex or integer, so nothing needs escaping).</summary>
public sealed record Wsl2SignedLease(string Digest, string KeyId, Wsl2RunLeaseBody Lease, string Signature)
{
    public string ToJson() => string.Create(System.Globalization.CultureInfo.InvariantCulture,
        $"{{\"digest\":\"{Digest}\",\"keyId\":\"{KeyId}\",\"lease\":{{\"actionDigest\":\"{Lease.ActionDigest}\",\"baseOid\":\"{Lease.BaseOid}\",\"computerId\":\"{Lease.ComputerId}\",\"expiresAt\":{Lease.ExpiresAt},\"isolation\":\"{Lease.Isolation}\",\"issuedAt\":{Lease.IssuedAt},\"leaseGeneration\":{Lease.LeaseGeneration},\"maxCalls\":{Lease.MaxCalls},\"operationId\":\"{Lease.OperationId}\",\"repositoryId\":\"{Lease.RepositoryId}\",\"v\":{Lease.V}}},\"signature\":\"{Signature}\"}}");
}

/// <summary>Signing refused. Code: malformed ttl (the body; Field names the rule) signer_invalid signer_failed (as the Node twin).</summary>
public sealed class Wsl2RunLeaseException(string code, string? field = null) : Exception(code)
{
    public string Code { get; } = code;
    public string? Field { get; } = field;
}

/// <summary>What the caller itself knows about the run it is deciding. Every part is required.</summary>
public sealed record Wsl2RunLeaseExpected(string BaseOid, string ComputerId, long MinLeaseGeneration, string OperationId, string RepositoryId);

/// <summary>Code null = ok. Codes: invalid_context invalid_expected malformed ttl digest signature not_yet_valid expired binding generation unauthenticated; Field is only ever a fixed field name or "$extra". Proof is set only by step 1.</summary>
public sealed record Wsl2RunLeaseVerdict(bool Ok, string? Code = null, string? Field = null, Wsl2RunLeaseBody? Value = null, string? Digest = null, string? KeyId = null, Wsl2RunLease.Authenticated? Proof = null);

public static class Wsl2RunLease
{
    public const long Version = 1;
    public const string Domain = "albera.wsl2-run-lease.v1";
    public const string Isolation = "wsl2";
    public const long MaxTtlSeconds = 3600, MaxCalls = 10_000;
    private const int MaxSignatureBytes = 128;

    private static readonly string[] BodyKeys = ["actionDigest", "baseOid", "computerId", "expiresAt", "isolation", "issuedAt", "leaseGeneration", "maxCalls", "operationId", "repositoryId", "v"];
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
            ("actionDigest", b["actionDigest"] is string action && DigestRegex.IsMatch(action)),
            ("leaseGeneration", IsCounter(b["leaseGeneration"])),
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
        Wsl2RunLeaseBody value = new((long)b["v"], (string)b["operationId"], (string)b["actionDigest"], (long)b["leaseGeneration"], (string)b["computerId"], (string)b["isolation"], (string)b["repositoryId"], (string)b["baseOid"], (long)b["maxCalls"], issuedAt, expiresAt);
        return new Wsl2RunLeaseVerdict(true, Value: value);
    }

    /// <summary>The exact bytes that are hashed and signed. The body must already have passed <see cref="ValidateBody"/>.</summary>
    public static byte[] Canonicalize(Wsl2RunLeaseBody body)
    {
        Dictionary<string, object> map = new(StringComparer.Ordinal)
        {
            ["v"] = body.V, ["operationId"] = body.OperationId, ["actionDigest"] = body.ActionDigest, ["leaseGeneration"] = body.LeaseGeneration, ["computerId"] = body.ComputerId, ["isolation"] = body.Isolation, ["repositoryId"] = body.RepositoryId,
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

    /// <summary>Sign a body: the Node twin's signWsl2RunLease. <paramref name="signer"/> gets the preimage bytes and returns the signature (ECDSA P-256 / SHA-256, r || s, 1..128 bytes); it is written unpadded base64url.</summary>
    /// <exception cref="Wsl2RunLeaseException">malformed or ttl (the body), signer_invalid (keyId or signer), signer_failed (the signer threw or returned a bad length)</exception>
    public static Wsl2SignedLease Sign(Wsl2RunLeaseBody body, string keyId, Func<byte[], byte[]> signer)
    {
        (Wsl2RunLeaseVerdict verdict, string? digest, byte[]? preimage) = Compute(ToMap(body));
        if (!verdict.Ok) throw new Wsl2RunLeaseException(verdict.Code!, verdict.Field);
        if (signer is null || !IsId(keyId)) throw new Wsl2RunLeaseException("signer_invalid");
        byte[] signature;
        try { signature = signer(preimage!); }
        catch (Exception) { throw new Wsl2RunLeaseException("signer_failed"); }
        if (signature is null || signature.Length is < 1 or > MaxSignatureBytes) throw new Wsl2RunLeaseException("signer_failed");
        return new Wsl2SignedLease(digest!, keyId, verdict.Value!, Base64Url.EncodeToString(signature));
    }

    private static Dictionary<string, object> ToMap(Wsl2RunLeaseBody b) => new(StringComparer.Ordinal)
    {
        ["v"] = b.V, ["operationId"] = b.OperationId, ["actionDigest"] = b.ActionDigest, ["leaseGeneration"] = b.LeaseGeneration, ["computerId"] = b.ComputerId, ["isolation"] = b.Isolation,
        ["repositoryId"] = b.RepositoryId, ["baseOid"] = b.BaseOid, ["maxCalls"] = b.MaxCalls, ["issuedAt"] = b.IssuedAt, ["expiresAt"] = b.ExpiresAt,
    };

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

    /// <summary>A lease that passed step 1. Its constructor is private, so nothing else can make one, and step 2 takes nothing else: a body from anywhere else, however well formed, never reaches it.</summary>
    public sealed class Authenticated
    {
        private Authenticated(Wsl2RunLeaseBody body) => Body = body;

        public Wsl2RunLeaseBody Body { get; }

        internal static Wsl2RunLeaseVerdict From(object? signed, Func<long> clock, Func<string, byte[], byte[], bool> verify)
        {
            if (clock is null || verify is null) return Fail("invalid_context");
            (Wsl2RunLeaseVerdict read, byte[] preimage, byte[] signature) = ReadSigned(signed);
            if (!read.Ok) return read;
            bool genuine;
            try { genuine = verify(read.KeyId!, preimage, signature); }
            catch (Exception) { genuine = false; } // whatever an injected verifier throws, the lease is not proved (fail closed, as the Node twin)
            if (!genuine) return Fail("signature", "signature");
            long now;
            try { now = clock(); }
            catch (Exception) { return Fail("invalid_context", "clock"); } // an injected clock that throws is an unusable context (fail closed)
            if (now < 0 || now > StrictJson.MaxSafeInteger) return Fail("invalid_context", "clock");
            Wsl2RunLeaseBody a = read.Value!;
            if (a.IssuedAt > now + NetworkAttestation.MaxObservedSkewSeconds) return Fail("not_yet_valid", "issuedAt");
            if (now >= a.ExpiresAt) return Fail("expired", "expiresAt");
            return read with { Proof = new Authenticated(a) };
        }
    }

    /// <summary>Step 1 (see the header). <paramref name="verify"/> gets (keyId, preimage bytes, signature bytes). <paramref name="clock"/> returns Unix seconds and is read after the signature check. On success Proof is what step 2 takes.</summary>
    public static Wsl2RunLeaseVerdict Authenticate(object? signed, Func<long> clock, Func<string, byte[], byte[], bool> verify) => Authenticated.From(signed, clock, verify);

    /// <summary>Step 2: the authenticated lease against the bridge's own state (where each value comes from: see the Node twin). Codes: unauthenticated invalid_expected binding generation.</summary>
    public static Wsl2RunLeaseVerdict RequireBinding(Authenticated? proof, Wsl2RunLeaseExpected expected)
    {
        if (proof is null) return Fail("unauthenticated");
        if (expected is null) return Fail("invalid_expected");
        if (!IsId(expected.ComputerId)) return Fail("invalid_expected", "computerId");
        if (!IsId(expected.OperationId)) return Fail("invalid_expected", "operationId");
        if (!IsId(expected.RepositoryId)) return Fail("invalid_expected", "repositoryId");
        if (!IsGitOid(expected.BaseOid)) return Fail("invalid_expected", "baseOid");
        if (!IsCounter(expected.MinLeaseGeneration)) return Fail("invalid_expected", "minLeaseGeneration");
        Wsl2RunLeaseBody lease = proof.Body;
        // Same order as the Node twin: baseOid, computerId, operationId, repositoryId.
        if (lease.BaseOid != expected.BaseOid) return Fail("binding", "baseOid");
        if (lease.ComputerId != expected.ComputerId) return Fail("binding", "computerId");
        if (lease.OperationId != expected.OperationId) return Fail("binding", "operationId");
        if (lease.RepositoryId != expected.RepositoryId) return Fail("binding", "repositoryId");
        if (lease.LeaseGeneration < expected.MinLeaseGeneration) return Fail("generation", "leaseGeneration");
        return new Wsl2RunLeaseVerdict(true, Value: lease);
    }
}
