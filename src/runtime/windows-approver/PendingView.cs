using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Albera.BrokerContract;

namespace Albera.Approver;

/// <summary>One pending request as the Authority listed it, with the digest this app recomputed from the shown fields.</summary>
internal sealed record PendingView(long Seq, string ApprovalId, string Purpose, string OperationId, string AuthorityDigest, string Challenge, long ExpiresAt,
    ValidatedAction Action, string RecomputedDigest)
{
    public bool DigestMatches => string.Equals(AuthorityDigest, RecomputedDigest, StringComparison.Ordinal);
}

/// <summary>Either a verified-shape view or the reason the entry cannot be shown (<see cref="View"/> is null; <see cref="ApprovalId"/> only if it is well formed).</summary>
internal sealed record ListedRequest(string? ApprovalId, PendingView? View, string? Problem);

internal sealed record ListPage(IReadOnlyList<ListedRequest> Items, bool More, long LastSeq);

// Reads the Authority's `list` reply (docs/architecture/approval-authority.md). The reply holds an array, which the contract's strict reader refuses, so the page
// is read with JsonDocument; each entry's "action" object is then re-read with the STRICT reader (no duplicate keys, no null / array / fraction) and validated and
// hashed with the contract's ActionDigest, the same code the Authority runs. A bad entry becomes a ListedRequest with a Problem, never an exception.
internal static class PendingParser
{
    public const string UuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
    private static readonly Regex Uuid = ActionDigest.FromEcma(UuidPattern);
    private static readonly Regex Id = ActionDigest.FromEcma(ActionDigest.IdPattern);
    private static readonly Regex Digest = ActionDigest.FromEcma("^sha256:[0-9a-f]{64}$");
    private static readonly Regex Challenge = ActionDigest.FromEcma("^[A-Za-z0-9_-]{22}$");
    private static readonly string[] EntryKeys = ["seq", "approvalId", "purpose", "operationId", "actionDigest", "challenge", "expiresAt", "action"];
    private const int MaxEntriesPerPage = 64;

    public static bool IsApprovalId(string value) => Uuid.IsMatch(value);

    /// <returns>null when the reply is not a well-formed list page at all</returns>
    public static ListPage? TryParsePage(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 4) return null;
        if (!root.TryGetProperty("pending", out JsonElement pending) || pending.ValueKind != JsonValueKind.Array || pending.GetArrayLength() > MaxEntriesPerPage) return null;
        if (!root.TryGetProperty("more", out JsonElement more) || more.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
        if (!root.TryGetProperty("lastSeq", out JsonElement last) || last.ValueKind != JsonValueKind.Number || !last.TryGetInt64(out long lastSeq) || lastSeq < 0) return null;
        return new ListPage([.. pending.EnumerateArray().Select(ParseEntry)], more.GetBoolean(), lastSeq);
    }

    private static ListedRequest ParseEntry(JsonElement entry)
    {
        string? approvalId = null;
        try
        {
            if (entry.ValueKind != JsonValueKind.Object) return Bad(null);
            if (entry.TryGetProperty("approvalId", out JsonElement idElement) && idElement.ValueKind == JsonValueKind.String && IsApprovalId(idElement.GetString()!)) approvalId = idElement.GetString();
            if (approvalId is null || entry.EnumerateObject().Count() != EntryKeys.Length || EntryKeys.Any(key => !entry.TryGetProperty(key, out _))) return Bad(approvalId);
            string purpose = Text(entry, "purpose"), operationId = Text(entry, "operationId"), authorityDigest = Text(entry, "actionDigest"), challenge = Text(entry, "challenge");
            if (!ActionDigest.Purposes.Contains(purpose) || !Id.IsMatch(operationId) || !Digest.IsMatch(authorityDigest) || !Challenge.IsMatch(challenge)) return Bad(approvalId);
            if (!entry.GetProperty("seq").TryGetInt64(out long seq) || !entry.GetProperty("expiresAt").TryGetInt64(out long expiresAt) || seq < 0 || expiresAt < 0) return Bad(approvalId);

            Dictionary<string, object> dto = StrictJson.Parse(Encoding.UTF8.GetBytes(entry.GetProperty("action").GetRawText()), 3);
            ValidatedAction action = ActionDigest.Validate(purpose, dto);
            string recomputed = ActionDigest.Compute(purpose, dto);
            return new ListedRequest(approvalId, new PendingView(seq, approvalId, purpose, operationId, authorityDigest, challenge, expiresAt, action, recomputed), null);
        }
        catch (Exception ex) when (ex is StrictJsonException or ActionDigestException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            return Bad(approvalId);
        }
    }

    private static string Text(JsonElement entry, string name) => entry.GetProperty(name).ValueKind == JsonValueKind.String ? entry.GetProperty(name).GetString()! : throw new InvalidOperationException(name);

    private static ListedRequest Bad(string? approvalId) => new(approvalId, null, "invalid_entry");
}
