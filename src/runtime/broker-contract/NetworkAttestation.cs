// Network attestation v1. C# twin of network-attestation.mjs (digest, canonical bytes, envelope check, verify); network-attestation-vectors.json pins both. BCL only, net10.0.
// The Broker reads an environment's effective network configuration and signs a short statement about it; the Approval Authority checks the statement before it signs a no-person
// receipt for environment.start / environment.create (docs/architecture/approval-tiers.md, "Egress is decided by the Broker, not the request"; issue #115 step 3b).
//
//   body     10 keys: v (1), network ("none" | "present" | "unknown"), computerId, vmId (the VM's own Hyper-V id), generation, projectId, leaseId, leaseGeneration, observedAt, expiresAt
//            (Unix seconds from the BROKER's clock; at most 300 s apart). Classification happens Broker-side and is not part of this twin.
//   preimage UTF8("albera.network-attestation.v1") 0x00 enc(map)   (enc as in ActionDigest.cs)
//   digest   "sha256:" + lowercase hex of SHA-256(preimage); the signature covers the preimage bytes; keyId and signature are not part of the digest
//   signed   { attestation, digest, keyId, signature }  signature = unpadded base64url of the signer's bytes (ECDSA P-256 / SHA-256, r || s, 64 bytes, checked by the injected verify)
//
// Verify checks, in this order: shape, TTL and digest, signature (the injected `verify(keyId, bytes, signature)` must return exactly true), not yet valid, expired (the clock is read
// AFTER the signature check), then every binding in the caller's own trusted state. It says nothing about whether "none" is enough for an action; and a statement is evidence at
// observedAt only. A null expected VmId means the caller has no VM id to compare (the Authority's action DTO does not carry one).
using System;
using System.Buffers.Text;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Albera.BrokerContract;

public sealed record NetworkAttestationBody(long V, string Network, string ComputerId, string VmId, long Generation, string ProjectId, string LeaseId, long LeaseGeneration, long ObservedAt, long ExpiresAt);

/// <summary>What the caller itself knows about the environment it is acting on. <see cref="VmId"/> may be null (nothing to compare).</summary>
public sealed record AttestationExpected(string ComputerId, string? VmId, long Generation, string ProjectId, string LeaseId, long LeaseGeneration);

/// <summary>Code null = ok. Codes: invalid_context invalid_expected malformed digest signature ttl not_yet_valid expired binding; Field is only ever a fixed field name or "$extra".</summary>
public sealed record AttestationVerdict(bool Ok, string? Code = null, string? Field = null, NetworkAttestationBody? Value = null, string? Digest = null, string? KeyId = null);

public static class NetworkAttestation
{
    public const long Version = 1;
    public const string Domain = "albera.network-attestation.v1";
    public const string None = "none";
    public const long MaxTtlSeconds = 300, MaxObservedSkewSeconds = 30;
    private const int MaxSignatureBytes = 128;

    private static readonly string[] Networks = ["none", "present", "unknown"];
    private static readonly string[] BodyKeys = ["computerId", "expiresAt", "generation", "leaseGeneration", "leaseId", "network", "observedAt", "projectId", "v", "vmId"];
    private static readonly string[] SignedKeys = ["attestation", "digest", "keyId", "signature"];
    private static readonly Regex IdRegex = ActionDigest.FromEcma(ActionDigest.IdPattern);
    private static readonly Regex VmIdRegex = ActionDigest.FromEcma("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static readonly Regex DigestRegex = ActionDigest.FromEcma("^sha256:[0-9a-f]{64}$");
    private static readonly Regex Base64UrlRegex = ActionDigest.FromEcma("^[A-Za-z0-9_-]+$");

    private static AttestationVerdict Fail(string code, string? field = null) => new(false, code, field);
    private static bool IsCounter(object? v) => v is long n && n >= 1 && n <= StrictJson.MaxSafeInteger;
    private static bool IsId(object? v) => v is string s && IdRegex.IsMatch(s);

    private static bool SameKeys(IReadOnlyDictionary<string, object> map, string[] keys) => map.Count == keys.Length && keys.All(map.ContainsKey);

    /// <summary>Shape and TTL of a body that the strict reader has parsed. The first failing field in the table's order wins, as in the Node twin.</summary>
    public static AttestationVerdict ValidateBody(object? body)
    {
        if (body is not IReadOnlyDictionary<string, object> b) return Fail("malformed");
        if (!SameKeys(b, BodyKeys)) return Fail("malformed", "$extra");
        (string Field, bool Good)[] checks =
        [
            ("v", b["v"] is long v && v == Version),
            ("network", b["network"] is string network && Networks.Contains(network)),
            ("computerId", IsId(b["computerId"])),
            ("vmId", b["vmId"] is string vmId && VmIdRegex.IsMatch(vmId)),
            ("generation", IsCounter(b["generation"])),
            ("projectId", IsId(b["projectId"])),
            ("leaseId", IsId(b["leaseId"])),
            ("leaseGeneration", IsCounter(b["leaseGeneration"])),
            ("observedAt", IsCounter(b["observedAt"])),
            ("expiresAt", IsCounter(b["expiresAt"])),
        ];
        foreach ((string field, bool good) in checks) if (!good) return Fail("malformed", field);
        long observedAt = (long)b["observedAt"], expiresAt = (long)b["expiresAt"];
        if (expiresAt <= observedAt || expiresAt - observedAt > MaxTtlSeconds) return Fail("ttl", "expiresAt");
        NetworkAttestationBody value = new((long)b["v"], (string)b["network"], (string)b["computerId"], (string)b["vmId"], (long)b["generation"], (string)b["projectId"], (string)b["leaseId"],
            (long)b["leaseGeneration"], observedAt, expiresAt);
        return new AttestationVerdict(true, Value: value);
    }

    /// <summary>The exact bytes that are hashed and signed. The body must already have passed <see cref="ValidateBody"/>.</summary>
    public static byte[] Canonicalize(NetworkAttestationBody body)
    {
        Dictionary<string, object> map = new(StringComparer.Ordinal)
        {
            ["v"] = body.V, ["network"] = body.Network, ["computerId"] = body.ComputerId, ["vmId"] = body.VmId, ["generation"] = body.Generation, ["projectId"] = body.ProjectId,
            ["leaseId"] = body.LeaseId, ["leaseGeneration"] = body.LeaseGeneration, ["observedAt"] = body.ObservedAt, ["expiresAt"] = body.ExpiresAt,
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
    public static (AttestationVerdict Verdict, string? Digest, byte[]? Preimage) Compute(object? body)
    {
        AttestationVerdict verdict = ValidateBody(body);
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

    /// <summary>Shape and digest only (no signature, no clock). Code malformed | ttl | digest. On success Value, Digest and KeyId are set.</summary>
    public static (AttestationVerdict Verdict, byte[] Preimage, byte[] Signature) ReadSigned(object? signed)
    {
        if (signed is not IReadOnlyDictionary<string, object> s) return (Fail("malformed"), [], []);
        if (!SameKeys(s, SignedKeys)) return (Fail("malformed", "$extra"), [], []);
        if (!IsId(s["keyId"])) return (Fail("malformed", "keyId"), [], []);
        if (s["digest"] is not string digest || !DigestRegex.IsMatch(digest)) return (Fail("malformed", "digest"), [], []);
        if (!TryDecodeSignature(s["signature"], out byte[] signature)) return (Fail("malformed", "signature"), [], []);
        (AttestationVerdict body, string? computed, byte[]? preimage) = Compute(s["attestation"]);
        if (!body.Ok) return (body, [], []);
        if (computed != digest) return (Fail("digest", "digest"), [], []);
        return (new AttestationVerdict(true, Value: body.Value, Digest: digest, KeyId: (string)s["keyId"]), preimage!, signature);
    }

    /// <summary>Full check (see the header). <paramref name="verify"/> gets (keyId, preimage bytes, signature bytes). <paramref name="clock"/> returns Unix seconds and is read after the signature check.</summary>
    public static AttestationVerdict Verify(object? signed, Func<long> clock, Func<string, byte[], byte[], bool> verify, AttestationExpected expected)
    {
        if (clock is null || verify is null) return Fail("invalid_context");
        if (!IsId(expected.ComputerId) || !IsId(expected.ProjectId) || !IsId(expected.LeaseId)) return Fail("invalid_expected");
        if (expected.VmId is not null && !VmIdRegex.IsMatch(expected.VmId)) return Fail("invalid_expected", "vmId");
        if (expected.Generation < 1 || expected.LeaseGeneration < 1) return Fail("invalid_expected");
        (AttestationVerdict read, byte[] preimage, byte[] signature) = ReadSigned(signed);
        if (!read.Ok) return read;
        bool genuine;
        try { genuine = verify(read.KeyId!, preimage, signature); }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException or InvalidOperationException) { genuine = false; }
        if (!genuine) return Fail("signature", "signature");
        long now;
        try { now = clock(); }
        catch (Exception) { return Fail("invalid_context", "clock"); } // an injected clock that throws is an unusable context (fail closed)
        if (now < 0 || now > StrictJson.MaxSafeInteger) return Fail("invalid_context", "clock");
        NetworkAttestationBody a = read.Value!;
        if (a.ObservedAt > now + MaxObservedSkewSeconds) return Fail("not_yet_valid", "observedAt");
        if (now >= a.ExpiresAt) return Fail("expired", "expiresAt");
        // Same order as the Node twin: computerId, generation, leaseGeneration, leaseId, projectId, vmId.
        if (a.ComputerId != expected.ComputerId) return Fail("binding", "computerId");
        if (a.Generation != expected.Generation) return Fail("binding", "generation");
        if (a.LeaseGeneration != expected.LeaseGeneration) return Fail("binding", "leaseGeneration");
        if (a.LeaseId != expected.LeaseId) return Fail("binding", "leaseId");
        if (a.ProjectId != expected.ProjectId) return Fail("binding", "projectId");
        if (expected.VmId is not null && a.VmId != expected.VmId) return Fail("binding", "vmId");
        return read;
    }
}
