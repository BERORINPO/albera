using System.Globalization;
using System.Text.Json;

namespace Albera.Approver;

// The three commands. Output goes to `output` (stdout), problems to `errors` (stderr) as one `error: <code>` line, and the exit code says which kind (ExitCodes.cs).
//   list            every pending request, all pages, rendered by Renderer
//   approve <id>    needs an interactive console (stdin not redirected), else REFUSE before anything is read or sent; find the request in a fresh `list`; REFUSE (nothing sent) if the entry is invalid or the digest recomputed from its fields differs from the Authority's;
//                   show it; ask for a typed "yes" (there is no way to skip it); ask the presence signer for a signature over PresenceMessage(approvalId, RECOMPUTED digest, challenge); send `decide`
//   deny <id>       send `decide` deny (a deny needs no presence proof and can only make a request fail)
// The approval window (GUI mode, Gui*.cs) reuses the same pieces and copies none of them: ListPendingAsync (the same list, all pages, the same digest recompute), ApproveShownAsync
// (the same refusal on a digest mismatch, the same presence message from the RECOMPUTED digest, the same decide) and DenyShownAsync. They return a CommandOutcome instead of writing to the console.
internal sealed record CommandOutcome(int ExitCode, string? ErrorCode = null, string? Hint = null)
{
    public bool Ok => ExitCode == ExitCodes.Ok;
}

internal sealed class ApproverCommands(IApproverChannel channel, IPresenceSigner signer, TextWriter output, TextWriter errors, TextReader input, Func<DateTimeOffset> clock, bool interactive)
{
    private const int MaxPages = 16; // 32 pending requests at most, several per page: a server that keeps saying "more" is not honest
    private static readonly string[] AuthorityCodes = ["authority_unavailable", "request_invalid", "request_expired", "human_denied", "presence_unavailable", "presence_mismatch", "queue_full"];

    private sealed class Stop(int exitCode, string code, string? hint = null) : Exception(code) { public int ExitCode { get; } = exitCode; public string? Hint { get; } = hint; }

    public Task<int> ListAsync() => GuardAsync(async () =>
    {
        IReadOnlyList<ListedRequest> all = await FetchAllAsync();
        output.Write($"pending: {all.Count.ToString(CultureInfo.InvariantCulture)}\n"); // "\n" on every OS: the output format is fixed
        foreach (ListedRequest item in all) output.Write(Renderer.Render(item, clock()));
        return ExitCodes.Ok;
    });

    public Task<int> ApproveAsync(string approvalId) => GuardAsync(async () =>
    {
        RequireApprovalId(approvalId);
        if (!interactive) throw new Stop(ExitCodes.Refused, "not_interactive", "hint: approve needs a console you type in; stdin is redirected, so nothing was read or sent"); // before any pipe access
        ListedRequest item =(await FetchAllAsync()).FirstOrDefault(x => x.ApprovalId == approvalId) ?? throw new Stop(ExitCodes.Refused, "not_pending");
        output.Write(Renderer.Render(item, clock()));
        PendingView view = item.View ?? throw new Stop(ExitCodes.Refused, "invalid_entry");
        if (!view.DigestMatches) throw new Stop(ExitCodes.Refused, "digest_mismatch");
        if (!Confirmed()) throw new Stop(ExitCodes.Refused, "not_confirmed");

        output.Write("Windows Hello will ask you to verify now. It shows only the app name: the request above is what you approve.\n"); // the Hello prompt itself shows no details
        return await SignAndDecideAsync(view);
    });

    // The one place that asks the presence signer and sends `decide` approve. The CLI (after the typed yes) and the approval window (after the match-code click) both end here.
    private async Task<int> SignAndDecideAsync(PendingView view)
    {
        SignResult signed = signer.Sign(PresenceMessage.Build(view.ApprovalId, view.RecomputedDigest, view.Challenge));
        string decide = signed.Status switch
        {
            SignStatus.Signed => $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{view.ApprovalId}\",\"decision\":\"approve\",\"presence\":\"{Convert.ToBase64String(signed.Signature!)}\"}}",
            SignStatus.Unavailable => $"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{view.ApprovalId}\",\"decision\":\"presence_unavailable\"}}", // the Authority fails the request
            _ => throw new Stop(ExitCodes.SignerUnavailable, "presence_signer_unavailable", "hint: run AlberaApprover.exe enroll (Windows Hello key missing or Hello not set up); nothing was sent"), // the request stays pending
        };
        return await DecideAsync(decide, "approved");
    }

    public Task<int> DenyAsync(string approvalId) => GuardAsync(() => DenyCoreAsync(approvalId));

    private Task<int> DenyCoreAsync(string approvalId)
    {
        RequireApprovalId(approvalId); // the id is pasted into the request text: only the Authority's uuid grammar gets in
        return DecideAsync($"{{\"v\":1,\"verb\":\"decide\",\"approvalId\":\"{approvalId}\",\"decision\":\"deny\"}}", "denied");
    }

    /// <summary>GUI: every pending request (all pages), parsed and digest-checked exactly as `list` does. The items are empty unless the outcome is Ok.</summary>
    public async Task<(CommandOutcome Outcome, IReadOnlyList<ListedRequest> Items)> ListPendingAsync()
    {
        IReadOnlyList<ListedRequest> items = [];
        CommandOutcome outcome = await OutcomeAsync(async () => { items = await FetchAllAsync(); return ExitCodes.Ok; });
        return (outcome, items);
    }

    /// <summary>GUI: approve one listed request. Refuses (nothing signed, nothing sent) unless the digest recomputed from the shown fields equals the Authority's. The typed yes of the CLI is replaced by the window's own match-code click.</summary>
    public Task<CommandOutcome> ApproveShownAsync(PendingView view) => OutcomeAsync(() =>
    {
        if (!view.DigestMatches) throw new Stop(ExitCodes.Refused, "digest_mismatch");
        return SignAndDecideAsync(view);
    });

    /// <summary>GUI: deny one request by id (the Authority's uuid grammar only).</summary>
    public Task<CommandOutcome> DenyShownAsync(string approvalId) => OutcomeAsync(() => DenyCoreAsync(approvalId));

    private static void RequireApprovalId(string approvalId)
    {
        if (!PendingParser.IsApprovalId(approvalId)) throw new Stop(ExitCodes.BadUsage, "bad_approval_id");
    }

    private async Task<int> DecideAsync(string request, string expectedState)
    {
        JsonElement root = await CallAsync(request);
        if (root.TryGetProperty("state", out JsonElement state) && state.ValueKind == JsonValueKind.String && state.GetString() == expectedState && root.EnumerateObject().Count() == 2)
        {
            output.Write($"result: {expectedState}\n");
            return ExitCodes.Ok;
        }
        throw new Stop(ExitCodes.TransportUnknown, ChannelCodes.InvalidResponse);
    }

    private async Task<IReadOnlyList<ListedRequest>> FetchAllAsync()
    {
        List<ListedRequest> all = [];
        long after = 0;
        for (int page = 0; page < MaxPages; page++)
        {
            JsonElement root = await CallAsync($"{{\"v\":1,\"verb\":\"list\",\"afterSeq\":{after.ToString(CultureInfo.InvariantCulture)}}}");
            ListPage parsed = PendingParser.TryParsePage(root) ?? throw new Stop(ExitCodes.TransportUnknown, ChannelCodes.InvalidResponse);
            all.AddRange(parsed.Items);
            if (!parsed.More) return all;
            if (parsed.LastSeq <= after) break; // no progress: stop instead of looping
            after = parsed.LastSeq;
        }
        throw new Stop(ExitCodes.TransportUnknown, ChannelCodes.InvalidResponse);
    }

    /// <summary>One call; returns the reply object of an {"ok":true,...}, throws Stop for {"ok":false,"code"} with a known code and for anything unparseable.</summary>
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

    private bool Confirmed()
    {
        output.Write("Type yes to approve exactly this request: ");
        output.Flush();
        return input.ReadLine() == "yes";
    }

    private async Task<int> GuardAsync(Func<Task<int>> body)
    {
        CommandOutcome outcome = await OutcomeAsync(body);
        if (outcome.ErrorCode is not null) errors.Write($"error: {outcome.ErrorCode}\n");
        if (outcome.Hint is not null) errors.Write(outcome.Hint + "\n");
        return outcome.ExitCode;
    }

    private static async Task<CommandOutcome> OutcomeAsync(Func<Task<int>> body)
    {
        try { return new CommandOutcome(await body()); }
        catch (Stop stop) { return new CommandOutcome(stop.ExitCode, stop.Message, stop.Hint); }
        catch (ChannelException ex) { return new CommandOutcome(ex.Sent ? ExitCodes.TransportUnknown : ExitCodes.ServerRefused, ex.Code); }
    }
}
