// Approval receipt v2 validator. C# twin of receipt-v2.mjs; test-vectors.json pins both. BCL only, net10.0. Contract only: the Host Broker and
// the Approval Authority are not wired to it yet (ADR-002 "Receipt v2", Proposed).
// Verify the ECDSA signature over exactly the receipt bytes FIRST (outside this file), then call Validate with the verified bytes. The receipt's
// own actionDigest is never trusted: it is compared with a digest recomputed from the trusted DTO in ReceiptContext.Action. Everything in
// ReceiptContext.Expected comes from Broker-trusted state, never from the request.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Albera.BrokerContract;

/// <summary>One receipt field, in the same terms as receipt-v2.schema.json (the harness compares the two).</summary>
public sealed record FieldSpec(string Name, bool IsInteger, string? Pattern = null, int? MaxLength = null, long? Minimum = null, long? Const = null, string[]? Enum = null);

/// <param name="Clock">Unix seconds</param>
/// <param name="Environment">"production" or "test"</param>
/// <param name="Expected">audience, purpose, operationId, idempotencyKey, leaseId, leaseGeneration, brokerEpoch, brokerChallenge, policyVersion</param>
/// <param name="Action">the trusted action DTO (projectId, computerId, action and the digest derive from it)</param>
public sealed record ReceiptContext(Func<long> Clock, string Environment, IReadOnlyDictionary<string, object> Expected, IReadOnlyDictionary<string, object>? Action);

/// <summary>Codes: invalid_context malformed schema version issuer action_pair ttl not_yet_valid expired binding action_digest. Field is a fixed name or "$extra".</summary>
public sealed record ReceiptVerdict(bool Ok, string? Code = null, string? Field = null, IReadOnlyDictionary<string, object>? Receipt = null);

public static class ReceiptV2
{
    public const int Version = 2;
    public const string Issuer = "albera-approval-authority";
    public const long MaxTtlSeconds = 300;
    public const long DefaultTtlSeconds = 120;
    public const long MaxIatSkewSeconds = 30;
    public const int MaxReceiptBytes = 1280;

    private static readonly FieldSpec Id = new("", false, ActionDigest.IdPattern, 64);
    private static readonly string[] AllActions = ActionDigest.Purposes.SelectMany(ActionDigest.ActionsFor).Distinct().ToArray();
    private const string Uuid = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
    private const string Bits128 = "^[A-Za-z0-9_-]{21}[AQgw]$";

    /// <summary>Same order and content as RECEIPT_V2_FIELDS in receipt-v2.mjs.</summary>
    public static IReadOnlyList<FieldSpec> Fields { get; } =
    [
        new("v", true, Const: Version),
        Id with { Name = "kid" },
        new("issuer", false, "^albera-(approval-authority|test-[a-z0-9-]{1,32})$", 44),
        new("audience", false, "^[a-z][a-z0-9-]{0,63}$", 64),
        new("purpose", false, Enum: ActionDigest.Purposes.ToArray()),
        new("approvalId", false, Uuid, 36),
        new("receiptId", false, Uuid, 36),
        new("nonce", false, Bits128, 22),
        Id with { Name = "operationId" },
        Id with { Name = "idempotencyKey" },
        new("action", false, Enum: AllActions),
        new("actionDigest", false, "^sha256:[0-9a-f]{64}$", 71),
        Id with { Name = "projectId" },
        Id with { Name = "computerId" },
        Id with { Name = "leaseId" },
        new("leaseGeneration", true, Minimum: 1),
        new("brokerEpoch", true, Minimum: 1),
        new("brokerChallenge", false, Bits128, 22),
        Id with { Name = "policyVersion" },
        Id with { Name = "approverKeyId" },
        new("iat", true, Minimum: 1),
        new("exp", true, Minimum: 1),
    ];

    private static readonly string[] ExpectedFields = ["audience", "purpose", "operationId", "idempotencyKey", "leaseId", "leaseGeneration", "brokerEpoch", "brokerChallenge", "policyVersion"];
    private static readonly string[] BindingOrder = [.. ExpectedFields, "projectId", "computerId", "action"];
    private static readonly Dictionary<string, FieldSpec> Spec = Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
    private static readonly Dictionary<string, Regex> Patterns = Fields.Where(f => f.Pattern is not null).ToDictionary(f => f.Name, f => ActionDigest.FromEcma(f.Pattern!), StringComparer.Ordinal);

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

    private static ReceiptVerdict ParseBytes(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0 || bytes.Length > MaxReceiptBytes) return Fail("malformed");
        Dictionary<string, object> data;
        try { data = StrictJson.Parse(bytes, 1); } // a receipt is flat: nested objects are malformed
        catch (StrictJsonException) { return Fail("malformed"); }
        if (data.Keys.Any(k => !Spec.ContainsKey(k))) return Fail("schema", "$extra");
        foreach (FieldSpec f in Fields)
        {
            if (!data.TryGetValue(f.Name, out object? value)) return Fail("schema", f.Name);
            if (f.Name == "v" ? value is not long : !Fits(f.Name, value)) return Fail("schema", f.Name);
        }
        if ((long)data["v"] != Version) return Fail("version", "v");
        return new ReceiptVerdict(true, Receipt: data);
    }

    /// <summary>Structure only (grammar, exact keys, types, formats, version). Says nothing about trust; use Validate before acting on a receipt.</summary>
    public static ReceiptVerdict Parse(ReadOnlySpan<byte> bytes) => ParseBytes(bytes);

    public static ReceiptVerdict Validate(ReadOnlySpan<byte> bytes, ReceiptContext? ctx)
    {
        if (!TryReadContext(ctx, out long now, out ValidatedAction? dto)) return Fail("invalid_context");
        ReceiptVerdict parsed = ParseBytes(bytes);
        if (!parsed.Ok) return parsed;
        IReadOnlyDictionary<string, object> r = parsed.Receipt!;
        string issuer = (string)r["issuer"], purpose = (string)r["purpose"], action = (string)r["action"];
        long iat = (long)r["iat"], exp = (long)r["exp"];
        if (issuer != Issuer && !(ctx!.Environment == "test" && issuer.StartsWith("albera-test-", StringComparison.Ordinal))) return Fail("issuer", "issuer");
        if (!ActionDigest.ActionsFor(purpose).Contains(action)) return Fail("action_pair", "action");
        if (exp <= iat || exp - iat > MaxTtlSeconds) return Fail("ttl", "exp");
        if (iat > now + MaxIatSkewSeconds) return Fail("not_yet_valid", "iat");
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
