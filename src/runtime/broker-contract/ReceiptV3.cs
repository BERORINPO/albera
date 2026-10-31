// Approval receipt v3 validator. C# twin of receipt-v3.mjs; test-vectors-v3.json pins both. BCL only, net10.0.
// v3 is receipt v2 plus `basis` and a `policyVersion` that is the hash of the tier policy in force (docs/architecture/approval-tiers.md, issue #115 step 3). v2 rejects
// unknown fields, so it stays as it is (always presence-based) and v3 sits next to it. Same rules as ReceiptV2.cs: verify the ECDSA signature over exactly the receipt
// bytes FIRST (outside this file), the receipt's own actionDigest is never trusted, and everything in ReceiptContext.Expected comes from Broker-trusted state.
//   basis "presence"  a person approved this exact action (as in v2)
//   basis "policy"    the Authority's own tier policy said this action needs no person. Only PolicyBasisActions can carry it: the contract caps what a policy may ever
//                     skip, so a receipt for any other action with this basis is refused even if the Authority signed it.
//   a "grant:<id>" basis is reserved for a later step; today it is a schema failure on `basis`.
// attestationDigest (optional, step 3b): the digest of the Broker's network attestation (NetworkAttestation.cs) that the Authority's rule relied on. Present exactly when basis is
//   "policy" and the action is in AttestedPolicyBasisActions (environment.start / environment.create: a no-person receipt that is only valid with a Broker statement that the environment
//   has no network); absent for every other receipt. Like policyVersion it is checked for its shape and for being there or not as the rule requires; the Authority's signature covers it.
// policyVersion is checked for its shape only (the Broker has no copy of the policy to compare it with); a `policyVersion` in ReceiptContext.Expected is ignored.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Albera.BrokerContract;

public static class ReceiptV3
{
    public const int Version = 3;
    public const string BasisPresence = "presence", BasisPolicy = "policy";
    public const string PolicyHashPattern = "^sha256:[0-9a-f]{64}$";

    /// <summary>What a tier policy may let the Authority sign without a person and without any attestation: reads and risk-reducing actions only.</summary>
    public static IReadOnlyList<string> PolicyBasisActions { get; } = ["environment.inspect", "environment.stop", "workspace.inspect", "task.cancel"];

    /// <summary>What a tier policy may let the Authority sign without a person ONLY with a Broker network attestation that says "none" (the receipt then carries its digest).</summary>
    public static IReadOnlyList<string> AttestedPolicyBasisActions { get; } = ["environment.create", "environment.start"];

    /// <summary>True for an action that can carry basis policy at all (with or without an attestation). Nothing else can, whatever the Authority signed.</summary>
    public static bool IsPolicyBasisAction(string action) => PolicyBasisActions.Contains(action) || AttestedPolicyBasisActions.Contains(action);

    public const string AttestationDigestField = "attestationDigest";

    /// <summary>Fields a receipt MAY carry (all of <see cref="Fields"/> are required): the digest of the network attestation a no-person rule relied on.</summary>
    public static IReadOnlyList<FieldSpec> OptionalFields { get; } = [new FieldSpec(AttestationDigestField, false, PolicyHashPattern, 71)];

    /// <summary>Same order and content as RECEIPT_V3_FIELDS in receipt-v3.mjs: the v2 table with `v` = 3 and `basis` right after a hash-shaped `policyVersion`.</summary>
    public static IReadOnlyList<FieldSpec> Fields { get; } = BuildFields();

    private static readonly string[] ExpectedFields = ["audience", "purpose", "operationId", "idempotencyKey", "leaseId", "leaseGeneration", "brokerEpoch", "brokerChallenge"];
    private static readonly string[] BindingOrder = [.. ExpectedFields, "projectId", "computerId", "action"];
    private static readonly Dictionary<string, FieldSpec> Spec = Fields.Concat(OptionalFields).ToDictionary(f => f.Name, StringComparer.Ordinal);
    private static readonly Dictionary<string, Regex> Patterns = Fields.Concat(OptionalFields).Where(f => f.Pattern is not null).ToDictionary(f => f.Name, f => ActionDigest.FromEcma(f.Pattern!), StringComparer.Ordinal);

    private static List<FieldSpec> BuildFields()
    {
        List<FieldSpec> fields = [];
        foreach (FieldSpec f in ReceiptV2.Fields)
        {
            if (f.Name == "v") fields.Add(f with { Const = Version });
            else if (f.Name == "policyVersion")
            {
                fields.Add(new FieldSpec("policyVersion", false, PolicyHashPattern, 71));
                fields.Add(new FieldSpec("basis", false, Enum: [BasisPresence, BasisPolicy]));
            }
            else fields.Add(f);
        }
        return fields;
    }

    private static ReceiptVerdict Fail(string code, string? field = null) => new(false, code, field);

    private static bool Fits(string name, object? value)
    {
        FieldSpec spec = Spec[name];
        if (spec.IsInteger)
            return value is long n && n <= StrictJson.MaxSafeInteger && (spec.Const is null || n == spec.Const) && (spec.Minimum is null || n >= spec.Minimum);
        if (value is not string s) return false;
        if (spec.Enum is not null) return spec.Enum.Contains(s);
        return s.Length <= spec.MaxLength && Patterns[name].IsMatch(s);
    }

    /// <summary>Structure only (grammar, exact keys, types, formats, version). Says nothing about trust; use Validate before acting on a receipt.</summary>
    public static ReceiptVerdict Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0 || bytes.Length > ReceiptV2.MaxReceiptBytes) return Fail("malformed");
        Dictionary<string, object> data;
        try { data = StrictJson.Parse(bytes, 1); } // a receipt is flat: nested objects are malformed
        catch (StrictJsonException) { return Fail("malformed"); }
        if (data.Keys.Any(k => !Spec.ContainsKey(k))) return Fail("schema", "$extra");
        foreach (FieldSpec f in Fields)
        {
            if (!data.TryGetValue(f.Name, out object? value)) return Fail("schema", f.Name);
            if (f.Name == "v" ? value is not long : !Fits(f.Name, value)) return Fail("schema", f.Name);
        }
        foreach (FieldSpec f in OptionalFields) if (data.TryGetValue(f.Name, out object? value) && !Fits(f.Name, value)) return Fail("schema", f.Name);
        if ((long)data["v"] != Version) return Fail("version", "v");
        return new ReceiptVerdict(true, Receipt: data);
    }

    /// <summary>Codes: invalid_context malformed schema version issuer action_pair basis_action attestation ttl not_yet_valid expired binding action_digest.</summary>
    public static ReceiptVerdict Validate(ReadOnlySpan<byte> bytes, ReceiptContext? ctx)
    {
        if (!TryReadContext(ctx, out long now, out ValidatedAction? dto)) return Fail("invalid_context");
        ReceiptVerdict parsed = Parse(bytes);
        if (!parsed.Ok) return parsed;
        IReadOnlyDictionary<string, object> r = parsed.Receipt!;
        string issuer = (string)r["issuer"], purpose = (string)r["purpose"], action = (string)r["action"], basis = (string)r["basis"];
        long iat = (long)r["iat"], exp = (long)r["exp"];
        if (issuer != ReceiptV2.Issuer && !(ctx!.Environment == "test" && issuer.StartsWith("albera-test-", StringComparison.Ordinal))) return Fail("issuer", "issuer");
        if (!ActionDigest.ActionsFor(purpose).Contains(action)) return Fail("action_pair", "action");
        if (basis == BasisPolicy && !IsPolicyBasisAction(action)) return Fail("basis_action", "basis");
        // The digest is there exactly when a no-person receipt for an attested action needs it: never for a person's approval, never for an action that needs no attestation.
        if (r.ContainsKey(AttestationDigestField) != (basis == BasisPolicy && AttestedPolicyBasisActions.Contains(action))) return Fail("attestation", AttestationDigestField);
        if (exp <= iat || exp - iat > ReceiptV2.MaxTtlSeconds) return Fail("ttl", "exp");
        if (iat > now + ReceiptV2.MaxIatSkewSeconds) return Fail("not_yet_valid", "iat");
        if (now >= exp) return Fail("expired", "exp");
        foreach (string name in BindingOrder)
        {
            object trusted = name switch { "projectId" => dto!.ProjectId, "computerId" => dto!.ComputerId, "action" => dto!.Action, _ => ctx!.Expected[name] };
            if (!r[name].Equals(trusted)) return Fail("binding", name);
        }
        if ((string)r["actionDigest"] != ActionDigest.Compute(purpose, ctx!.Action)) return Fail("action_digest", "actionDigest");
        return parsed;
    }

    private static bool TryReadContext(ReceiptContext? ctx, out long now, out ValidatedAction? dto)
    {
        now = 0;
        dto = null;
        if (ctx is null || ctx.Clock is null || ctx.Expected is null || (ctx.Environment != "production" && ctx.Environment != "test")) return false;
        try { now = ctx.Clock(); }
        catch (Exception) { return false; } // an injected clock that throws is an unusable context (fail closed)
        if (now < 0 || now > StrictJson.MaxSafeInteger) return false;
        foreach (string name in ExpectedFields) if (!ctx.Expected.TryGetValue(name, out object? v) || !Fits(name, v)) return false;
        try { dto = ActionDigest.Validate((string)ctx.Expected["purpose"], ctx.Action); }
        catch (ActionDigestException) { return false; }
        return true;
    }
}

/// <summary>Either version. Anything that does not claim `"v":3` is read as v2, so every v2 verdict is exactly what ReceiptV2 says.</summary>
public static class Receipts
{
    private static bool ClaimsV3(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0 || bytes.Length > ReceiptV2.MaxReceiptBytes) return false;
        try { return StrictJson.Parse(bytes, 1).TryGetValue("v", out object? v) && v is long n && n == ReceiptV3.Version; }
        catch (StrictJsonException) { return false; }
    }

    public static ReceiptVerdict Parse(ReadOnlySpan<byte> bytes) => ClaimsV3(bytes) ? ReceiptV3.Parse(bytes) : ReceiptV2.Parse(bytes);

    public static ReceiptVerdict Validate(ReadOnlySpan<byte> bytes, ReceiptContext? ctx) => ClaimsV3(bytes) ? ReceiptV3.Validate(bytes, ctx) : ReceiptV2.Validate(bytes, ctx);
}
