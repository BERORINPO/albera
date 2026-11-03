// Usage: dotnet MatchCodeHarness.dll <match-code-vectors.json>
// Prints one JSON array: the C# result for every vector, in the shape of the vector file's "expected" objects plus "name".
// A vector input that is not a JSON string reaches MatchCode as null (the Node twin refuses it by type).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Albera.Approver;

using JsonDocument vectors = JsonDocument.Parse(File.ReadAllText(args[0]));

static string? AsString(JsonElement v, string name) => v.GetProperty(name).ValueKind == JsonValueKind.String ? v.GetProperty(name).GetString() : null;

var results = new List<Dictionary<string, object?>>();
foreach (JsonElement v in vectors.RootElement.GetProperty("vectors").EnumerateArray())
{
    var result = new Dictionary<string, object?> { ["name"] = v.GetProperty("name").GetString() };
    string? approvalId = AsString(v, "approvalId"), actionDigest = AsString(v, "actionDigest");
    try
    {
        MatchChoices choices = MatchCode.Choices(approvalId, actionDigest);
        result["ok"] = true;
        string code = MatchCode.Compute(approvalId, actionDigest);
        result["matchCode"] = code;
        result["choices"] = choices.Choices;
        result["correctIndex"] = choices.CorrectIndex;
        result["preimageHex"] = Convert.ToHexStringLower(MatchCode.Preimage(approvalId, actionDigest));
        result["hashHex"] = Convert.ToHexStringLower(MatchCode.Hash(approvalId, actionDigest));
        if (choices.Code != code) throw new InvalidOperationException("Choices.Code differs from Compute");
    }
    catch (MatchCodeException e) { result["ok"] = false; result["code"] = e.Code; result["field"] = e.Field; }
    results.Add(result);
}
Console.WriteLine(JsonSerializer.Serialize(results));
