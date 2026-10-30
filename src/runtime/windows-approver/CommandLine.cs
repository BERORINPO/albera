namespace Albera.Approver;

/// <summary>The whole command-line grammar: `list` | `approve &lt;approvalId&gt; [--yes]` | `deny &lt;approvalId&gt;`. Anything else is not a command.</summary>
internal sealed record CommandLine(string Verb, string? ApprovalId, bool AssumeYes)
{
    public const string Usage = "usage: AlberaApprover list | approve <approvalId> [--yes] | deny <approvalId>";

    public static CommandLine? TryParse(string[] args)
    {
        if (args is ["list"]) return new CommandLine("list", null, false);
        if (args is ["deny", { } denied] && PendingParser.IsApprovalId(denied)) return new CommandLine("deny", denied, false);
        if (args is ["approve", { } approved] && PendingParser.IsApprovalId(approved)) return new CommandLine("approve", approved, false);
        if (args is ["approve", { } approvedYes, "--yes"] && PendingParser.IsApprovalId(approvedYes)) return new CommandLine("approve", approvedYes, true);
        return null;
    }
}
