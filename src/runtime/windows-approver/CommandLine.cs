using System.Text.RegularExpressions;
using Albera.BrokerContract;

namespace Albera.Approver;

/// <summary>The whole command-line grammar: `list` | `approve &lt;approvalId&gt;` | `deny &lt;approvalId&gt;` | `enroll [--show|--replace|--check [--expect &lt;approverKeyId&gt;]]`. Anything else is not a command.</summary>
internal sealed record CommandLine(string Verb, string? ApprovalId, string? Option, string? Expect = null)
{
    public const string Usage = "usage: AlberaApprover list | approve <approvalId> | deny <approvalId> | enroll [--show | --replace | --check [--expect <approverKeyId>]]";

    public static CommandLine? TryParse(string[] args)
    {
        if (args is ["list"]) return new CommandLine("list", null, null);
        if (args is ["deny", { } denied] && PendingParser.IsApprovalId(denied)) return new CommandLine("deny", denied, null);
        if (args is ["approve", { } approved] && PendingParser.IsApprovalId(approved)) return new CommandLine("approve", approved, null);
        if (args is ["enroll"]) return new CommandLine("enroll", null, null);
        if (args is ["enroll", "--show"]) return new CommandLine("enroll", null, "show");
        if (args is ["enroll", "--replace"]) return new CommandLine("enroll", null, "replace");
        if (args is ["enroll", "--check"]) return new CommandLine("enroll", null, "check");
        if (args is ["enroll", "--check", "--expect", { } expected] && IsKeyId(expected)) return new CommandLine("enroll", null, "check", expected);
        return null;
    }

    // The Authority's id grammar (the same pattern as approverKeyId in its config); the trailing-newline case of .NET's `$` is excluded by hand.
    private static bool IsKeyId(string value) => !value.Contains('\n') && Regex.IsMatch(value, ActionDigest.IdPattern, RegexOptions.CultureInvariant);
}
