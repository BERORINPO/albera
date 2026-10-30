using System.Globalization;
using System.Text;

namespace Albera.Approver;

// The text a human reads before approving. Every input of the action digest is shown (purpose, action, projectId, computerId, every arg), then operationId and
// the expiry, then the digest line saying whether the fields above hash to the digest the Authority sent. All strings go through SafeText (ASCII only).
// Output format (one `key: value` per line, two-space indent for the fields; the Authority's own strings are never printed raw):
//   request <approvalId>
//     purpose: "broker.operation"
//     action: "environment.start"
//     projectId: "proj-alpha"
//     computerId: "pc-01"
//     args: 3
//       "cpu" = 2 (int)
//       "fast" = true (bool)
//       "vmName" = "alpha" (string)
//     operationId: "op-1"
//     expiresAt: 1800000120 (2027-01-15T08:01:57Z, in 117 s)
//     actionDigest: sha256:...
//     digest check: OK (recomputed from the fields above)        |  digest check: MISMATCH (...) DO NOT APPROVE
//     note: N character(s) are shown as \u{hex}                   (only when something was escaped)
internal static class Renderer
{
    private const string Indent = "  ";

    public static string Render(ListedRequest item, DateTimeOffset now)
    {
        if (item.View is not { } view) return $"request {item.ApprovalId ?? "(unreadable id)"}\n{Indent}REFUSED: {item.Problem ?? "invalid_entry"}; this entry cannot be shown or approved\n";
        int escaped = 0;
        string Show(string value) { string quoted = SafeText.Quote(value, out int n); escaped += n; return quoted; }

        StringBuilder text = new();
        text.Append("request ").Append(view.ApprovalId).Append('\n');
        text.Append(Indent).Append("purpose: ").Append(Show(view.Purpose)).Append('\n');
        text.Append(Indent).Append("action: ").Append(Show(view.Action.Action)).Append('\n');
        text.Append(Indent).Append("projectId: ").Append(Show(view.Action.ProjectId)).Append('\n');
        text.Append(Indent).Append("computerId: ").Append(Show(view.Action.ComputerId)).Append('\n');
        text.Append(Indent).Append("args: ").Append(view.Action.Args.Count.ToString(CultureInfo.InvariantCulture)).Append('\n');
        foreach ((string name, object value) in view.Action.Args.OrderBy(a => a.Key, StringComparer.Ordinal))
        {
            string shown = value switch
            {
                string s => $"{Show(s)} (string)",
                long n => $"{n.ToString(CultureInfo.InvariantCulture)} (int)",
                bool b => $"{(b ? "true" : "false")} (bool)",
                _ => "(unsupported)",
            };
            text.Append(Indent).Append(Indent).Append(Show(name)).Append(" = ").Append(shown).Append('\n');
        }
        text.Append(Indent).Append("operationId: ").Append(Show(view.OperationId)).Append('\n');
        text.Append(Indent).Append("expiresAt: ").Append(Expiry(view.ExpiresAt, now)).Append('\n');
        text.Append(Indent).Append("actionDigest: ").Append(view.AuthorityDigest).Append('\n');
        text.Append(Indent).Append(view.DigestMatches
            ? "digest check: OK (recomputed from the fields above)"
            : $"digest check: MISMATCH (the fields above hash to {view.RecomputedDigest}) DO NOT APPROVE").Append('\n');
        if (escaped > 0) text.Append(Indent).Append("note: ").Append(escaped.ToString(CultureInfo.InvariantCulture)).Append(@" character(s) are shown as \u{hex}; the text is exact, not normalized").Append('\n');
        return text.ToString();
    }

    private static string Expiry(long expiresAt, DateTimeOffset now)
    {
        string when = DateTimeOffset.FromUnixTimeSeconds(Math.Min(expiresAt, 253_402_300_799)).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        long left = expiresAt - now.ToUnixTimeSeconds();
        return $"{expiresAt.ToString(CultureInfo.InvariantCulture)} ({when}, {(left >= 0 ? $"in {left.ToString(CultureInfo.InvariantCulture)} s" : "expired")})";
    }
}
