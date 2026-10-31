using System.Text.RegularExpressions;
using Albera.BrokerContract;

namespace Albera.Approver;

/// <summary>The whole command-line grammar: `list` | `approve &lt;approvalId&gt;` | `deny &lt;approvalId&gt;` | `enroll [--show|--replace|--check [--expect &lt;approverKeyId&gt;]]` | `enroll [--replace] --accept-unattested` | `policy [show]` | `policy set &lt;tier&gt; [--prompt &lt;action&gt;]...`. Anything else is not a command.</summary>
internal sealed record CommandLine(string Verb, string? ApprovalId, string? Option, string? Expect = null, string? Tier = null, IReadOnlyList<string>? Prompts = null, bool AcceptUnattested = false)
{
    public const string Usage = "usage: AlberaApprover list | approve <approvalId> | deny <approvalId> | enroll [--show | --replace | --check [--expect <approverKeyId>]] | enroll [--replace] --accept-unattested | policy [show] | policy set <careful|standard> [--prompt <action>]...";

    public static CommandLine? TryParse(string[] args)
    {
        if (args is ["list"]) return new CommandLine("list", null, null);
        if (args is ["deny", { } denied] && PendingParser.IsApprovalId(denied)) return new CommandLine("deny", denied, null);
        if (args is ["approve", { } approved] && PendingParser.IsApprovalId(approved)) return new CommandLine("approve", approved, null);
        if (args is ["enroll"]) return new CommandLine("enroll", null, null);
        if (args is ["enroll", "--show"]) return new CommandLine("enroll", null, "show");
        if (args is ["enroll", "--replace"]) return new CommandLine("enroll", null, "replace");
        if (args is ["enroll", "--accept-unattested"]) return new CommandLine("enroll", null, null, AcceptUnattested: true);
        if (args is ["enroll", "--replace", "--accept-unattested"]) return new CommandLine("enroll", null, "replace", AcceptUnattested: true);
        if (args is ["enroll", "--check"]) return new CommandLine("enroll", null, "check");
        if (args is ["enroll", "--check", "--expect", { } expected] && IsKeyId(expected)) return new CommandLine("enroll", null, "check", expected);
        if (args is ["policy"] or ["policy", "show"]) return new CommandLine("policy", null, "show");
        if (args is ["policy", "set", { } tier, .. { } flags]) return TryParsePolicySet(tier, flags);
        return null;
    }

    // policy set <tier> [--prompt <action>]...: the tier and every action must be ones the contract knows, so nothing else is ever pasted into a request.
    private static CommandLine? TryParsePolicySet(string tier, string[] flags)
    {
        List<string> prompts = [];
        for (int i = 0; i < flags.Length; i += 2)
        {
            if (flags[i] != "--prompt" || i + 1 >= flags.Length) return null;
            prompts.Add(flags[i + 1]);
        }
        return TierPolicy.TryCreate(0, tier, prompts) is { } policy ? new CommandLine("policy", null, "set", null, policy.Tier, policy.Prompts) : null;
    }

    // The Authority's id grammar (the same pattern as approverKeyId in its config); the trailing-newline case of .NET's `$` is excluded by hand.
    private static bool IsKeyId(string value) => !value.Contains('\n') && Regex.IsMatch(value, ActionDigest.IdPattern, RegexOptions.CultureInvariant);
}
