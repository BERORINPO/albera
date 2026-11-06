using System.Text.Json;

// A newly claimed wsl2 task.start answers with the run lease the Broker signed (BrokerRequests.cs): "lease": { digest, keyId, lease, signature }. The helper passes it on unchanged and only
// checks its outline (three strings and the body object); what is inside is the verifier's to judge (src/runtime/broker-contract/wsl2-run-lease.mjs), never the helper's.
internal static partial class Program
{
    /// <summary>"" when the reply has no lease, `,"lease":<raw>` when it has a well-outlined one, null when the key is there but is not exactly that.</summary>
    private static string? LeaseText(JsonElement root)
    {
        if (!root.TryGetProperty("lease", out JsonElement lease)) return "";
        if (lease.ValueKind != JsonValueKind.Object) return null;
        string[] names = ["digest", "keyId", "lease", "signature"];
        bool outline = lease.EnumerateObject().Count() == names.Length && names.All(name => lease.TryGetProperty(name, out JsonElement v) && v.ValueKind == (name == "lease" ? JsonValueKind.Object : JsonValueKind.String));
        return outline ? ",\"lease\":" + lease.GetRawText() : null;
    }
}
