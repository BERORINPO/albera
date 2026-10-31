// Task-start attestation v1. C# twin of task-start-attestation.mjs (digest, canonical bytes, envelope check, verify); task-start-attestation-vectors.json pins both. BCL only, net10.0.
// Before a guest.command / task.start is submitted for approval, the Hyper-V Broker side takes a Production checkpoint of the VM and signs ONE statement that says "this environment has no
// network" and "this checkpoint was taken" for one environment incarnation, lease and operation. At the standard tier the Approval Authority signs task.start without a person only when it
// verifies this statement (docs/architecture/approval-tiers.md, "Step 4 as built"; issue #115 step 4).
//
// It is its own kind next to NetworkAttestation: its own domain and its own 13 body keys, so a network attestation is never read as this one (the keys differ, the signature covers another
// domain) and this one is never read as a network attestation. Same key, same signature scheme (ECDSA P-256 / SHA-256, r || s, checked by the injected verify), same TTL rule.
//
//   body     13 keys: v (1), network ("none" | "present" | "unknown"), computerId, vmId (the VM's own Hyper-V id), generation, projectId, leaseId, leaseGeneration, operationId,
//            checkpointId (the Hyper-V snapshot id, a lowercase GUID), checkpointType ("production" | "standard"), observedAt, expiresAt (Unix seconds from the BROKER's clock; at most 300 s apart)
//   preimage UTF8("albera.task-start-attestation.v1") 0x00 enc(map)   (enc as in ActionDigest.cs)
//   digest   "sha256:" + lowercase hex of SHA-256(preimage); the signature covers the preimage bytes; keyId and signature are not part of the digest
//   signed   { attestation, digest, keyId, signature }  signature = unpadded base64url of the signer's bytes
//
// Verify checks, in this order: shape, TTL and digest, signature, not yet valid, expired (the clock is read AFTER the signature check), then every binding in the caller's own trusted state
// (computerId, generation, leaseGeneration, leaseId, operationId, projectId, vmId). It says nothing about whether the statement is ENOUGH: that is ProvesCheckpointedNoNetwork (network none AND
// checkpointType production), decided by the caller. A statement is evidence at observedAt only.
using System;
using System.Buffers.Text;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Albera.BrokerContract;

public sealed record TaskStartAttestationBody(long V, string Network, string ComputerId, string VmId, long Generation, string ProjectId, string LeaseId, long LeaseGeneration, string OperationId,
    string CheckpointId, string CheckpointType, long ObservedAt, long ExpiresAt);

/// <summary>What the caller itself knows about the task start it is deciding. Every part is required.</summary>
public sealed record TaskStartExpected(string ComputerId, string VmId, long Generation, string ProjectId, string LeaseId, long LeaseGeneration, string OperationId);

/// <summary>Code null = ok. Codes: invalid_context invalid_expected malformed ttl digest signature not_yet_valid expired binding; Field is only ever a fixed field name or "$extra".</summary>
public sealed record TaskStartVerdict(bool Ok, string? Code = null, string? Field = null, TaskStartAttestationBody? Value = null, string? Digest = null, string? KeyId = null);

public static class TaskStartAttestation
{
    public const long Version = 1;
    public const string Domain = "albera.task-start-attestation.v1";
    public const string None = "none", Production = "production";
    private const int MaxSignatureBytes = 128;

    private static readonly string[] Networks = ["none", "present", "unknown"];
    private static readonly string[] CheckpointTypes = ["production", "standard"];
    private static readonly string[] BodyKeys = ["checkpointId", "checkpointType", "computerId", "expiresAt", "generation", "leaseGeneration", "leaseId", "network", "observedAt", "operationId", "projectId", "v", "vmId"];
    private static readonly string[] SignedKeys = ["attestation", "digest", "keyId", "signature"];
    private static readonly Regex IdRegex = ActionDigest.FromEcma(ActionDigest.IdPattern);
    private static readonly Regex DigestRegex = ActionDigest.FromEcma("^sha256:[0-9a-f]{64}$");
    private static readonly Regex Base64UrlRegex = ActionDigest.FromEcma("^[A-Za-z0-9_-]+$");

    private static TaskStartVerdict Fail(string code, string? field = null) => new(false, code, field);
    private static bool IsCounter(object? v) => v is long n && n >= 1 && n <= StrictJson.MaxSafeInteger;
    private static bool IsId(object? v) => v is string s && IdRegex.IsMatch(s);
    private static bool IsGuid(object? v) => v is string s && NetworkAttestation.IsVmId(s);
    private static bool SameKeys(IReadOnlyDictionary<string, object> map, string[] keys) => map.Count == keys.Length && keys.All(map.ContainsKey);

    /// <summary>True when the statement says what the Authority needs to skip a person: no network AND a Production checkpoint. Says nothing about bindings, signature or time.</summary>
    public static bool ProvesCheckpointedNoNetwork(TaskStartAttestationBody body) => body.Network == None && body.CheckpointType == Production;

    /// <summary>Shape and TTL of a body that the strict reader has parsed. The first failing field in the table's order wins, as in the Node twin.</summary>
    public static TaskStartVerdict ValidateBody(object? body)
    {
        if (body is not IReadOnlyDictionary<string, object> b) return Fail("malformed");
        if (!SameKeys(b, BodyKeys)) return Fail("malformed", "$extra");
        (string Field, bool Good)[] checks =
        [
            ("v", b["v"] is long v && v == Version),
            ("network", b["network"] is string network && Networks.Contains(network)),
            ("computerId", IsId(b["computerId"])),
            ("vmId", IsGuid(b["vmId"])),
            ("generation", IsCounter(b["generation"])),
            ("projectId", IsId(b["projectId"])),
            ("leaseId", IsId(b["leaseId"])),
            ("leaseGeneration", IsCounter(b["leaseGeneration"])),
            ("operationId", IsId(b["operationId"])),
            ("checkpointId", IsGuid(b["checkpointId"])),
            ("checkpointType", b["checkpointType"] is string type && CheckpointTypes.Contains(type)),
            ("observedAt", IsCounter(b["observedAt"])),
            ("expiresAt", IsCounter(b["expiresAt"])),
        ];
        foreach ((string field, bool good) in checks) if (!good) return Fail("malformed", field);
        long observedAt = (long)b["observedAt"], expiresAt = (long)b["expiresAt"];
        if (expiresAt <= observedAt || expiresAt - observedAt > NetworkAttestation.MaxTtlSeconds) return Fail("ttl", "expiresAt");
        TaskStartAttestationBody value = new((long)b["v"], (string)b["network"], (string)b["computerId"], (string)b["vmId"], (long)b["generation"], (string)b["projectId"], (string)b["leaseId"],
            (long)b["leaseGeneration"], (string)b["operationId"], (string)b["checkpointId"], (string)b["checkpointType"], observedAt, expiresAt);
        return new TaskStartVerdict(true, Value: value);
    }

    /// <summary>The exact bytes that are hashed and signed. The body must already have passed <see cref="ValidateBody"/>.</summary>
    public static byte[] Canonicalize(TaskStartAttestationBody body)
    {
        Dictionary<string, object> map = new(StringComparer.Ordinal)
        {
            ["v"] = body.V, ["network"] = body.Network, ["computerId"] = body.ComputerId, ["vmId"] = body.VmId, ["generation"] = body.Generation, ["projectId"] = body.ProjectId,
            ["leaseId"] = body.LeaseId, ["leaseGeneration"] = body.LeaseGeneration, ["operationId"] = body.OperationId, ["checkpointId"] = body.CheckpointId,
            ["checkpointType"] = body.CheckpointType, ["observedAt"] = body.ObservedAt, ["expiresAt"] = body.ExpiresAt,
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
    public static (TaskStartVerdict Verdict, string? Digest, byte[]? Preimage) Compute(object? body)
    {
        TaskStartVerdict verdict = ValidateBody(body);
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

    /// <summary>Shape and digest only (no signature, no clock). A network attestation is malformed here (other keys). On success Value, Digest and KeyId are set.</summary>
    public static (TaskStartVerdict Verdict, byte[] Preimage, byte[] Signature) ReadSigned(object? signed)
    {
        if (signed is not IReadOnlyDictionary<string, object> s) return (Fail("malformed"), [], []);
        if (!SameKeys(s, SignedKeys)) return (Fail("malformed", "$extra"), [], []);
        if (!IsId(s["keyId"])) return (Fail("malformed", "keyId"), [], []);
        if (s["digest"] is not string digest || !DigestRegex.IsMatch(digest)) return (Fail("malformed", "digest"), [], []);
        if (!TryDecodeSignature(s["signature"], out byte[] signature)) return (Fail("malformed", "signature"), [], []);
        (TaskStartVerdict body, string? computed, byte[]? preimage) = Compute(s["attestation"]);
        if (!body.Ok) return (body, [], []);
        if (computed != digest) return (Fail("digest", "digest"), [], []);
        return (new TaskStartVerdict(true, Value: body.Value, Digest: digest, KeyId: (string)s["keyId"]), preimage!, signature);
    }

    /// <summary>Full check (see the header). <paramref name="verify"/> gets (keyId, preimage bytes, signature bytes). <paramref name="clock"/> returns Unix seconds and is read after the signature check.</summary>
    public static TaskStartVerdict Verify(object? signed, Func<long> clock, Func<string, byte[], byte[], bool> verify, TaskStartExpected expected)
    {
        if (clock is null || verify is null) return Fail("invalid_context");
        if (!IsId(expected.ComputerId) || !IsId(expected.ProjectId) || !IsId(expected.LeaseId) || !IsId(expected.OperationId)) return Fail("invalid_expected");
        if (!NetworkAttestation.IsVmId(expected.VmId)) return Fail("invalid_expected", "vmId");
        if (expected.Generation < 1 || expected.LeaseGeneration < 1) return Fail("invalid_expected");
        (TaskStartVerdict read, byte[] preimage, byte[] signature) = ReadSigned(signed);
        if (!read.Ok) return read;
        bool genuine;
        try { genuine = verify(read.KeyId!, preimage, signature); }
        catch (Exception ex) when (ex is CryptographicException or ArgumentException or InvalidOperationException) { genuine = false; }
        if (!genuine) return Fail("signature", "signature");
        long now;
        try { now = clock(); }
        catch (Exception) { return Fail("invalid_context", "clock"); } // an injected clock that throws is an unusable context (fail closed)
        if (now < 0 || now > StrictJson.MaxSafeInteger) return Fail("invalid_context", "clock");
        TaskStartAttestationBody a = read.Value!;
        if (a.ObservedAt > now + NetworkAttestation.MaxObservedSkewSeconds) return Fail("not_yet_valid", "observedAt");
        if (now >= a.ExpiresAt) return Fail("expired", "expiresAt");
        // Same order as the Node twin: computerId, generation, leaseGeneration, leaseId, operationId, projectId, vmId.
        if (a.ComputerId != expected.ComputerId) return Fail("binding", "computerId");
        if (a.Generation != expected.Generation) return Fail("binding", "generation");
        if (a.LeaseGeneration != expected.LeaseGeneration) return Fail("binding", "leaseGeneration");
        if (a.LeaseId != expected.LeaseId) return Fail("binding", "leaseId");
        if (a.OperationId != expected.OperationId) return Fail("binding", "operationId");
        if (a.ProjectId != expected.ProjectId) return Fail("binding", "projectId");
        if (a.VmId != expected.VmId) return Fail("binding", "vmId");
        return read;
    }
}
