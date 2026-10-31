// Usage: dotnet ReceiptV2Harness.dll <test-vectors.json> <receipt-v2.schema.json> [<test-vectors-v3.json> <receipt-v3.schema.json> [<network-attestation-vectors.json>]]
// Prints one JSON document: the C# verdict for every digest and receipt vector, plus any difference between ReceiptV2.Fields and the schema file.
// With the two v3 files it also prints "v2ViaDispatcher" (the v2 receipt vectors through Receipts.Validate), "v3" (the v3 receipt vectors through Receipts.Validate and, for
// bytes that claim v3, ReceiptV3.Validate), "v3SchemaMismatches", "policy" (every tier policy vector), "loosen" and "policyMessageHex".
// With the fifth file it also prints "attestationDigest" (every digest vector of the network attestation) and "attestationVerify" (every signed verify vector, checked with the
// vector file's ephemeral public key). The harness reads a vector body with System.Text.Json, so a number that is not a safe integer reaches the contract as a double and is
// refused by its field (the Node twin's behaviour); the Authority's own wire reader is stricter and refuses the whole frame.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Albera.BrokerContract;

using JsonDocument vectors = JsonDocument.Parse(File.ReadAllText(args[0]));
using JsonDocument schema = JsonDocument.Parse(File.ReadAllText(args[1]));

var digestResults = new List<Dictionary<string, object?>>();
foreach (JsonElement v in vectors.RootElement.GetProperty("digestVectors").EnumerateArray())
{
    var result = new Dictionary<string, object?> { ["name"] = v.GetProperty("name").GetString() };
    string purpose = v.GetProperty("purpose").GetString()!;
    try
    {
        Dictionary<string, object> dto = StrictJson.Parse(Encoding.UTF8.GetBytes(v.GetProperty("dtoJson").GetString()!), 3);
        byte[] preimage = ActionDigest.Canonicalize(purpose, dto);
        result["ok"] = true;
        result["digest"] = ActionDigest.Compute(purpose, dto);
        result["preimageHex"] = Convert.ToHexStringLower(preimage);
    }
    catch (StrictJsonException) { result["ok"] = false; result["code"] = "malformed"; }
    catch (ActionDigestException e) { result["ok"] = false; result["code"] = e.Code; result["field"] = e.Field; }
    digestResults.Add(result);
}

List<Dictionary<string, object?>> RunReceiptVectors(JsonElement receiptVectors, Func<byte[], ReceiptContext, ReceiptVerdict> validate)
{
    var results = new List<Dictionary<string, object?>>();
    foreach (JsonElement v in receiptVectors.EnumerateArray())
    {
        byte[] bytes = v.TryGetProperty("receiptBase64", out JsonElement b64) ? Convert.FromBase64String(b64.GetString()!) : Encoding.UTF8.GetBytes(v.GetProperty("receiptJson").GetString()!);
        JsonElement c = v.GetProperty("context");
        long now = c.GetProperty("now").GetInt64();
        var expected = new Dictionary<string, object>();
        foreach (JsonProperty p in c.GetProperty("expected").EnumerateObject())
            expected[p.Name] = p.Value.ValueKind == JsonValueKind.Number ? p.Value.GetInt64() : p.Value.GetString()!;
        Dictionary<string, object>? action = null;
        try { action = StrictJson.Parse(Encoding.UTF8.GetBytes(c.GetProperty("actionJson").GetString()!), 3); }
        catch (StrictJsonException) { /* the context then carries no usable action DTO: invalid_context */ }
        ReceiptVerdict verdict = validate(bytes, new ReceiptContext(() => now, c.GetProperty("environment").GetString()!, expected, action));
        var result = new Dictionary<string, object?> { ["name"] = v.GetProperty("name").GetString(), ["ok"] = verdict.Ok };
        if (!verdict.Ok) { result["code"] = verdict.Code; if (verdict.Field is not null) result["field"] = verdict.Field; }
        results.Add(result);
    }
    return results;
}

List<string> SchemaMismatches(JsonDocument schemaDocument, IReadOnlyList<FieldSpec> required, IReadOnlyList<FieldSpec>? optional = null)
{
    IReadOnlyList<FieldSpec> fields = [.. required, .. optional ?? []];
    var mismatches = new List<string>();
    JsonElement root = schemaDocument.RootElement, props = root.GetProperty("properties");
    if (!root.GetProperty("required").EnumerateArray().Select(x => x.GetString()).SequenceEqual(required.Select(f => f.Name))) mismatches.Add("required");
    if (root.GetProperty("additionalProperties").ValueKind != JsonValueKind.False) mismatches.Add("additionalProperties");
    if (props.EnumerateObject().Count() != fields.Count) mismatches.Add("property count");
    foreach (FieldSpec f in fields)
    {
        if (!props.TryGetProperty(f.Name, out JsonElement p)) { mismatches.Add($"{f.Name}: missing"); continue; }
        string? Str(string k) => p.TryGetProperty(k, out JsonElement e) ? e.GetString() : null;
        long? Num(string k) => p.TryGetProperty(k, out JsonElement e) ? e.GetInt64() : null;
        if (Str("type") != (f.IsInteger ? "integer" : "string")) mismatches.Add($"{f.Name}: type");
        if (Str("pattern") != f.Pattern) mismatches.Add($"{f.Name}: pattern");
        if (Num("maxLength") != f.MaxLength) mismatches.Add($"{f.Name}: maxLength");
        if (Num("minimum") != f.Minimum) mismatches.Add($"{f.Name}: minimum");
        if (Num("const") != f.Const) mismatches.Add($"{f.Name}: const");
        string[]? schemaEnum = p.TryGetProperty("enum", out JsonElement en) ? en.EnumerateArray().Select(x => x.GetString()!).ToArray() : null;
        if (!(schemaEnum is null ? f.Enum is null : f.Enum is not null && schemaEnum.SequenceEqual(f.Enum))) mismatches.Add($"{f.Name}: enum");
    }
    return mismatches;
}

JsonElement v2Receipts = vectors.RootElement.GetProperty("receiptVectors");
var output = new Dictionary<string, object>
{
    ["digest"] = digestResults,
    ["receipt"] = RunReceiptVectors(v2Receipts, (b, c) => ReceiptV2.Validate(b, c)),
    ["schemaMismatches"] = SchemaMismatches(schema, ReceiptV2.Fields),
};

if (args.Length >= 4)
{
    using JsonDocument v3Vectors = JsonDocument.Parse(File.ReadAllText(args[2]));
    using JsonDocument v3Schema = JsonDocument.Parse(File.ReadAllText(args[3]));
    JsonElement v3Root = v3Vectors.RootElement;
    output["v2ViaDispatcher"] = RunReceiptVectors(v2Receipts, (b, c) => Receipts.Validate(b, c));
    output["v3"] = RunReceiptVectors(v3Root.GetProperty("receiptVectors"), (b, c) => Receipts.Validate(b, c));
    // The same bytes straight through ReceiptV3 (only those that claim v3: anything else is a v2 question).
    output["v3Direct"] = RunReceiptVectors(v3Root.GetProperty("receiptVectors"), (b, c) => Encoding.UTF8.GetString(b).Contains("\"v\":3", StringComparison.Ordinal) ? ReceiptV3.Validate(b, c) : Receipts.Validate(b, c));
    output["v3SchemaMismatches"] = SchemaMismatches(v3Schema, ReceiptV3.Fields, ReceiptV3.OptionalFields);
    output["policyBasisActions"] = ReceiptV3.PolicyBasisActions;
    output["attestedPolicyBasisActions"] = ReceiptV3.AttestedPolicyBasisActions;

    TierPolicy? Read(string json) => TierPolicy.TryParse(Encoding.UTF8.GetBytes(json));
    var policyResults = new List<Dictionary<string, object?>>();
    foreach (JsonElement v in v3Root.GetProperty("policyVectors").EnumerateArray())
    {
        TierPolicy? policy = Read(v.GetProperty("json").GetString()!);
        var result = new Dictionary<string, object?> { ["name"] = v.GetProperty("name").GetString(), ["ok"] = policy is not null };
        if (policy is not null)
        {
            string canonical = Encoding.UTF8.GetString(policy.ToJson());
            result["revision"] = policy.Revision;
            result["tier"] = policy.Tier;
            result["prompts"] = policy.Prompts;
            result["noPrompt"] = policy.NoPromptActions().Order(StringComparer.Ordinal).ToArray();
            result["attestedNoPrompt"] = policy.AttestedNoPromptActions().Order(StringComparer.Ordinal).ToArray();
            result["hash"] = policy.Hash();
            result["canonicalJson"] = canonical;
            result["canonicalRoundTrips"] = Read(canonical)?.Hash() == policy.Hash();
        }
        policyResults.Add(result);
    }
    output["policy"] = policyResults;
    output["loosen"] = v3Root.GetProperty("loosenVectors").EnumerateArray().Select(v => new Dictionary<string, object?>
    {
        ["name"] = v.GetProperty("name").GetString(),
        ["loosens"] = Read(v.GetProperty("to").GetString()!)!.Loosens(Read(v.GetProperty("from").GetString()!)!),
    }).ToList();
    TierPolicy messagePolicy = Read(v3Root.GetProperty("policyMessage").GetProperty("policyJson").GetString()!)!;
    output["policyMessageHex"] = v3Root.GetProperty("policyMessage").GetProperty("cases").EnumerateArray()
        .Select(c => Convert.ToHexStringLower(PolicyChange.Message(messagePolicy, c.GetProperty("kid").GetString()!, c.GetProperty("audience").GetString()!))).ToList();
}

if (args.Length >= 5)
{
    using JsonDocument attestationVectors = JsonDocument.Parse(File.ReadAllText(args[4]));
    JsonElement attestationRoot = attestationVectors.RootElement;

    object ToValue(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.String => e.GetString()!,
        JsonValueKind.Number => e.TryGetInt64(out long n) ? (object)n : e.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Object => e.EnumerateObject().ToDictionary(p => p.Name, p => ToValue(p.Value), StringComparer.Ordinal),
        _ => throw new InvalidOperationException("vector value not supported by this harness"),
    };

    var attestationDigests = new List<Dictionary<string, object?>>();
    foreach (JsonElement v in attestationRoot.GetProperty("digestVectors").EnumerateArray())
    {
        var (verdict, digest, preimage) = NetworkAttestation.Compute(ToValue(v.GetProperty("body")));
        var result = new Dictionary<string, object?> { ["name"] = v.GetProperty("name").GetString(), ["ok"] = verdict.Ok };
        if (verdict.Ok) { result["digest"] = digest; result["preimageHex"] = Convert.ToHexStringLower(preimage!); }
        else { result["code"] = verdict.Code; result["field"] = verdict.Field; }
        attestationDigests.Add(result);
    }
    output["attestationDigest"] = attestationDigests;

    JsonElement verify = attestationRoot.GetProperty("verifyVectors");
    string pinnedKeyId = verify.GetProperty("keyId").GetString()!;
    using System.Security.Cryptography.ECDsa pinned = System.Security.Cryptography.ECDsa.Create();
    pinned.ImportSubjectPublicKeyInfo(Convert.FromBase64String(verify.GetProperty("publicKeySpki").GetString()!), out _);
    bool VerifySignature(string keyId, byte[] bytes, byte[] signature) =>
        keyId == pinnedKeyId && signature.Length == 64 && pinned.VerifyData(bytes, signature, System.Security.Cryptography.HashAlgorithmName.SHA256, System.Security.Cryptography.DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    var attestationVerdicts = new List<Dictionary<string, object?>>();
    foreach (JsonElement c in verify.GetProperty("cases").EnumerateArray())
    {
        JsonElement e = c.GetProperty("expected");
        AttestationExpected expected = new(e.GetProperty("computerId").GetString()!, e.GetProperty("vmId").ValueKind == JsonValueKind.Null ? null : e.GetProperty("vmId").GetString(), e.GetProperty("generation").GetInt64(),
            e.GetProperty("projectId").GetString()!, e.GetProperty("leaseId").GetString()!, e.GetProperty("leaseGeneration").GetInt64());
        long now = c.GetProperty("now").GetInt64();
        AttestationVerdict verdict = NetworkAttestation.Verify(ToValue(c.GetProperty("signed")), () => now, VerifySignature, expected);
        var result = new Dictionary<string, object?> { ["name"] = c.GetProperty("name").GetString(), ["ok"] = verdict.Ok };
        if (!verdict.Ok) { result["code"] = verdict.Code; if (verdict.Field is not null) result["field"] = verdict.Field; }
        attestationVerdicts.Add(result);
    }
    output["attestationVerify"] = attestationVerdicts;
}

Console.Out.Write(JsonSerializer.Serialize(output));
