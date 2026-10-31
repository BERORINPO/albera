using System.Text;
using System.Text.Json;
using Albera.BrokerContract;

namespace Albera.Approver;

// `policy` and `policy set`: read the Authority's tier policy and ask it to change (docs/architecture/approval-tiers.md, issue #115 step 3).
//   policy [show]                                      print the policy in force in plain words (read only)
//   policy set <careful|standard> [--prompt <action>]...   ask the Authority for this COMPLETE new policy (revision + 1)
// A change is described before anything is sent: which actions will no longer need a person, which will start needing one. Whether Windows Hello is needed is decided by the
// effect, never by the tier names: if the new policy lets any action skip a person that could not before (TierPolicy.Loosens), this app needs a console, a typed "yes" and
// one Hello signature over PolicyChange.Message(new policy, kid, audience) (albera.policy.v1 + the Authority's kid and audience from its reply + the hash this app computed itself from the policy it showed). A change that only adds prompts is
// sent as it is. The Authority decides again on its own; this app's description is for the person, not a promise to the Authority.
// The policy and its hash are read from the Authority's reply with the contract's strict reader and hashed here; a reply whose hash differs from the policy it carries is refused.
internal sealed class PolicyCommand(IApproverChannel channel, IPresenceSigner signer, TextWriter output, TextWriter errors, TextReader input, bool interactive)
{
    private static readonly string[] AuthorityCodes = ["authority_unavailable", "request_invalid", "request_expired", "human_denied", "presence_unavailable", "presence_mismatch", "queue_full"];

    private sealed class Stop(int exitCode, string code, string? hint = null) : Exception(code) { public int ExitCode { get; } = exitCode; public string? Hint { get; } = hint; }

    public Task<int> ShowAsync() => GuardAsync(async () =>
    {
        TierPolicy current = (await ReadCurrentAsync()).Policy;
        output.Write(Describe(current));
        return ExitCodes.Ok;
    });

    public Task<int> SetAsync(string tier, IReadOnlyList<string> prompts) => GuardAsync(async () =>
    {
        (TierPolicy current, string kid, string audience) = await ReadCurrentAsync();
        TierPolicy next = TierPolicy.TryCreate(current.Revision + 1, tier, prompts) ?? throw new Stop(ExitCodes.BadUsage, "bad_policy");
        if (next.Tier == current.Tier && next.Prompts.SequenceEqual(current.Prompts))
        {
            output.Write("policy: no change; this is already the policy in force\n");
            return ExitCodes.Ok;
        }
        bool loosens = next.Loosens(current);
        output.Write(Describe(current));
        output.Write(Change(current, next, loosens));
        if (loosens && !interactive) throw new Stop(ExitCodes.Refused, "not_interactive", "hint: this change needs a console you type in and Windows Hello; stdin is redirected, so nothing was read or sent");
        string request = $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{Encoding.UTF8.GetString(next.ToJson())}}}";
        if (loosens)
        {
            if (!Confirmed()) throw new Stop(ExitCodes.Refused, "not_confirmed");
            output.Write("Windows Hello will ask you to verify now. It shows only the app name: the change above is what you approve.\n");
            SignResult signed = signer.Sign(PolicyChange.Message(next, kid, audience));
            request = signed.Status switch
            {
                SignStatus.Signed => $"{{\"v\":1,\"verb\":\"policy_set\",\"policy\":{Encoding.UTF8.GetString(next.ToJson())},\"presence\":\"{Convert.ToBase64String(signed.Signature!)}\"}}",
                SignStatus.Unavailable => throw new Stop(ExitCodes.SignerUnavailable, "hello_no_proof", "hint: Windows Hello did not verify you (cancelled or locked); run the command again. Nothing was sent"),
                _ => throw new Stop(ExitCodes.SignerUnavailable, "presence_signer_unavailable", "hint: run AlberaApprover.exe enroll (Windows Hello key missing or Hello not set up); nothing was sent"),
            };
        }
        JsonElement reply = await CallAsync(request);
        if (reply.EnumerateObject().Count() == 2 && reply.TryGetProperty("policyVersion", out JsonElement version) && version.ValueKind == JsonValueKind.String && version.GetString() == next.Hash())
        {
            output.Write($"result: policy applied (revision {next.Revision})\n");
            return ExitCodes.Ok;
        }
        throw new Stop(ExitCodes.TransportUnknown, ChannelCodes.InvalidResponse);
    });

    // The policy in force, read from the Authority and checked: the strict reader, the contract's own hash, and the hash the Authority reported. The reply must also name the
    // Authority's kid and audience (in the contract's grammar): the signature is bound to them, so a reply without them is refused.
    private async Task<(TierPolicy Policy, string Kid, string Audience)> ReadCurrentAsync()
    {
        JsonElement reply = await CallAsync("{\"v\":1,\"verb\":\"policy\"}");
        if (reply.EnumerateObject().Count() == 5 && reply.TryGetProperty("policy", out JsonElement policy) && policy.ValueKind == JsonValueKind.Object
            && reply.TryGetProperty("policyVersion", out JsonElement version) && version.ValueKind == JsonValueKind.String
            && TierPolicy.TryParse(Encoding.UTF8.GetBytes(policy.GetRawText())) is { } parsed && version.GetString() == parsed.Hash()
            && Grammar(reply, "kid", ActionDigest.IdPattern) is { } kid && Grammar(reply, "audience", "^[a-z][a-z0-9-]{0,63}$") is { } audience) return (parsed, kid, audience);
        throw new Stop(ExitCodes.TransportUnknown, ChannelCodes.InvalidResponse);
    }

    // A string property of the reply that fits the contract's grammar (the trailing-newline case of .NET's `$` is excluded by hand), or null.
    private static string? Grammar(JsonElement reply, string name, string pattern) =>
        reply.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String && value.GetString() is { } text && !text.Contains('\n')
            && System.Text.RegularExpressions.Regex.IsMatch(text, pattern, System.Text.RegularExpressions.RegexOptions.CultureInvariant) ? text : null;

    private static string Describe(TierPolicy policy)
    {
        IReadOnlySet<string> skipped = policy.NoPromptActions();
        StringBuilder text = new();
        text.Append("policy in force (revision ").Append(policy.Revision).Append(")\n");
        text.Append("  tier: ").Append(policy.Tier).Append('\n');
        text.Append("  needs no person: ").Append(skipped.Count == 0 ? "(nothing; every action needs a person)" : string.Join(", ", skipped.Order(StringComparer.Ordinal))).Append('\n');
        if (policy.AttestedNoPromptActions().Count > 0)
            text.Append("  needs no person only when the Broker attests the environment has no network: ").Append(string.Join(", ", policy.AttestedNoPromptActions().Order(StringComparer.Ordinal))).Append('\n');
        if (policy.Prompts.Count > 0) text.Append("  always asks you: ").Append(string.Join(", ", policy.Prompts)).Append('\n');
        text.Append("  policyVersion: ").Append(policy.Hash()).Append('\n');
        return text.ToString();
    }

    private static string Change(TierPolicy current, TierPolicy next, bool loosens)
    {
        // Two lists, because "no longer asks you" means two different things: always, or only when the Broker attests the environment has no network (start / create).
        string[] Gained(IReadOnlySet<string> before, IReadOnlySet<string> after) => [.. after.Where(a => !before.Contains(a)).Order(StringComparer.Ordinal)];
        string[] newlySkipped = Gained(current.NoPromptActions(), next.NoPromptActions());
        string[] newlySkippedWithAttestation = Gained(current.AttestedNoPromptActions(), next.AttestedNoPromptActions());
        string[] newlyAsked = [.. Gained(next.SkippableActions(), current.SkippableActions()).Select(a => ReceiptV3.AttestedPolicyBasisActions.Contains(a) ? a + " (only when the Broker attests no network)" : a)];
        StringBuilder text = new();
        text.Append("change to revision ").Append(next.Revision).Append(": tier ").Append(current.Tier).Append(" -> ").Append(next.Tier).Append('\n');
        text.Append("  will no longer ask you: ").Append(newlySkipped.Length == 0 ? "(none)" : string.Join(", ", newlySkipped)).Append('\n');
        if (newlySkippedWithAttestation.Length > 0)
            text.Append("  will no longer ask you, only when the Broker attests the environment has no network: ").Append(string.Join(", ", newlySkippedWithAttestation)).Append('\n');
        text.Append("  will start asking you: ").Append(newlyAsked.Length == 0 ? "(none)" : string.Join(", ", newlyAsked)).Append('\n');
        text.Append("  new policyVersion: ").Append(next.Hash()).Append('\n');
        text.Append(loosens ? "  windows hello: needed (this lets actions run without asking you)\n" : "  windows hello: not needed (this only adds questions)\n");
        return text.ToString();
    }

    private bool Confirmed()
    {
        output.Write("Type yes to apply exactly this change: ");
        output.Flush();
        return input.ReadLine() == "yes";
    }

    /// <summary>One call; returns the reply object of an {"ok":true,...} and throws Stop for {"ok":false,"code"} with a known code and for anything unparseable.</summary>
    private async Task<JsonElement> CallAsync(string request)
    {
        string text = await channel.CallAsync(request);
        try
        {
            using JsonDocument document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
            JsonElement root = document.RootElement.Clone();
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ok", out JsonElement ok))
            {
                if (ok.ValueKind == JsonValueKind.True) return root;
                if (ok.ValueKind == JsonValueKind.False && root.TryGetProperty("code", out JsonElement code) && code.ValueKind == JsonValueKind.String
                    && AuthorityCodes.Contains(code.GetString()) && root.EnumerateObject().Count() == 2) throw new Stop(ExitCodes.AuthorityRejected, $"authority:{code.GetString()}");
            }
        }
        catch (JsonException) { }
        throw new Stop(ExitCodes.TransportUnknown, ChannelCodes.InvalidResponse);
    }

    private async Task<int> GuardAsync(Func<Task<int>> body)
    {
        try { return await body(); }
        catch (Stop stop)
        {
            errors.Write($"error: {stop.Message}\n");
            if (stop.Hint is not null) errors.Write(stop.Hint + "\n");
            return stop.ExitCode;
        }
        catch (ChannelException ex) { errors.Write($"error: {ex.Code}\n"); return ex.Sent ? ExitCodes.TransportUnknown : ExitCodes.ServerRefused; }
    }
}
