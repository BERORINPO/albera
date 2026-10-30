namespace Albera.Approver;

/// <summary>The whole command-line grammar: `list` | `approve &lt;approvalId&gt;` | `deny &lt;approvalId&gt;` | `enroll [--show|--replace]`. Anything else is not a command.</summary>
internal sealed record CommandLine(string Verb, string? ApprovalId, string? Option)
{
    public const string Usage = "usage: AlberaApprover list | approve <approvalId> | deny <approvalId> | enroll [--show | --replace]";

    public static CommandLine? TryParse(string[] args)
    {
        if (args is ["list"]) return new CommandLine("list", null, null);
        if (args is ["deny", { } denied] && PendingParser.IsApprovalId(denied)) return new CommandLine("deny", denied, null);
        if (args is ["approve", { } approved] && PendingParser.IsApprovalId(approved)) return new CommandLine("approve", approved, null);
        if (args is ["enroll"]) return new CommandLine("enroll", null, null);
        if (args is ["enroll", "--show"]) return new CommandLine("enroll", null, "show");
        if (args is ["enroll", "--replace"]) return new CommandLine("enroll", null, "replace");
        return null;
    }
}
