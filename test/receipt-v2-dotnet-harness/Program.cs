// Usage: dotnet ReceiptV2Harness.dll <test-vectors.json> <receipt-v2.schema.json>
// Prints one JSON document: the C# verdict for every digest and receipt vector, plus any difference between ReceiptV2.Fields and the schema file.
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

var receiptResults = new List<Dictionary<string, object?>>();
foreach (JsonElement v in vectors.RootElement.GetProperty("receiptVectors").EnumerateArray())
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
    ReceiptVerdict verdict = ReceiptV2.Validate(bytes, new ReceiptContext(() => now, c.GetProperty("environment").GetString()!, expected, action));
    var result = new Dictionary<string, object?> { ["name"] = v.GetProperty("name").GetString(), ["ok"] = verdict.Ok };
    if (!verdict.Ok) { result["code"] = verdict.Code; if (verdict.Field is not null) result["field"] = verdict.Field; }
    receiptResults.Add(result);
}

var mismatches = new List<string>();
JsonElement root = schema.RootElement, props = root.GetProperty("properties");
if (!root.GetProperty("required").EnumerateArray().Select(x => x.GetString()).SequenceEqual(ReceiptV2.Fields.Select(f => f.Name))) mismatches.Add("required");
if (root.GetProperty("additionalProperties").ValueKind != JsonValueKind.False) mismatches.Add("additionalProperties");
if (props.EnumerateObject().Count() != ReceiptV2.Fields.Count) mismatches.Add("property count");
foreach (FieldSpec f in ReceiptV2.Fields)
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

Console.Out.Write(JsonSerializer.Serialize(new Dictionary<string, object> { ["digest"] = digestResults, ["receipt"] = receiptResults, ["schemaMismatches"] = mismatches }));
