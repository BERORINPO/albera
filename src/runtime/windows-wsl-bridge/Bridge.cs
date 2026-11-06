using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text;
using Albera.BrokerContract;

namespace Albera.WslBridge;

/// <summary>One run in progress: its lease, its agent, and the gate that lets one call at a time through.</summary>
internal sealed class Run(string id, string name, string folder, Wsl2RunLeaseBody lease, IAgentProcess process)
{
    public string Id { get; } = id;
    public string Name { get; } = name;
    public string Folder { get; } = folder;
    public Wsl2RunLeaseBody Lease { get; } = lease;
    public IAgentProcess Process { get; } = process;
    public AgentLink Link { get; } = new(process);
    public SemaphoreSlim Gate { get; } = new(1, 1);
    public int Ended;
}

// The six verbs (ADR-012, "The WSL bridge"). Every decision lives here, on the Windows side: the lease, the call count, the sizes and the deadline are the bridge's own, and nothing the agent says about
// its limits is trusted (a job can take the agent over). A run that breaks a limit, or whose agent misbehaves, is ended: terminate, then unregister.
// begin is in BridgeBegin.cs. Every reply carries a Reason word and nothing else about the request (no path, no repository, no output); log lines are fixed words as well.
internal sealed partial class Bridge(BridgeConfig config, IWslHost host, IRepositories repositories, OperationLedger ledger, BrokerKey key, Func<long> clock, Limits limits, Action<string> log)
{
    private readonly ConcurrentDictionary<string, Run> _runs = new(StringComparer.Ordinal);
    private int _starting;

    public int ActiveRuns => _runs.Count;

    public async Task<Reply> HandleAsync(Request request)
    {
        Reply reply;
        try
        {
            reply = request.Verb switch
            {
                Verb.Begin => await BeginAsync(request),
                Verb.Exec => await CallAsync(request, ExecAsync),
                Verb.Put => await CallAsync(request, PutAsync),
                Verb.Get => await CallAsync(request, GetAsync),
                Verb.End => await EndAsync(request, abort: false),
                Verb.Stop => await EndAsync(request, abort: true),
                _ => Reply.Refuse(Reason.BadVerb),
            };
        }
        catch (Exception ex) when (ex is not OutOfMemoryException) { reply = Reply.Refuse(Reason.Internal); } // the text of an exception can hold a path: only the word is kept
        log($"{request.Verb.ToString().ToUpperInvariant()}={(reply.Ok ? "ok" : "refused:" + reply.Reason)}");
        return reply;
    }

    // ---- exec, put, get ---------------------------------------------------------------------------------------------------------------------------------------------------------

    private async Task<Reply> CallAsync(Request request, Func<Run, byte[], long, Task<Reply>> action)
    {
        if (!_runs.TryGetValue(request.RunId, out Run? run)) return Reply.Refuse(Reason.NoRun);
        if (!run.Gate.Wait(0)) return Reply.Refuse(Reason.RunBusy);
        try
        {
            long now = clock();
            if (now >= run.Lease.ExpiresAt) { await TeardownAsync(run); return Reply.Refuse(Reason.LeaseExpired); } // the bridge reads the lease's end itself, on every call
            if (ledger.TryCountCall(run.Id, run.Lease.MaxCalls) is { } refusal) return Reply.Refuse(refusal);
            return await action(run, request.Body, now);
        }
        catch (AgentFailure failure)
        {
            await TeardownAsync(run); // a limit broken or an agent that stopped answering: the job may hold the agent, so the run ends
            return Reply.Refuse(failure.Reason);
        }
        finally { run.Gate.Release(); }
    }

    private async Task<Reply> ExecAsync(Run run, byte[] body, long now)
    {
        if (body.Length < 4 || body.Length - 4 > limits.MaxCommandBytes) return Reply.Refuse(Reason.BadArgs);
        string command;
        try { command = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(body.AsSpan(4)); }
        catch (ArgumentException) { return Reply.Refuse(Reason.BadArgs); }
        if (command.Contains('\0')) return Reply.Refuse(Reason.BadArgs);
        long remaining = run.Lease.ExpiresAt - now;
        uint asked = BinaryPrimitives.ReadUInt32BigEndian(body);
        long seconds = Math.Min(asked == 0 ? limits.MaxExecSeconds : asked, Math.Min(limits.MaxExecSeconds, remaining)); // a command never outlives the lease
        TimeSpan wait = TimeSpan.FromSeconds(seconds) + limits.AgentGrace;
        TimeSpan untilExpiry = TimeSpan.FromSeconds(remaining) + limits.ExpiryGrace;
        AgentReply reply = await run.Link.CallAsync(AgentLink.RunRequest((uint)seconds, command), 5 + limits.MaxOutputBytes, wait < untilExpiry ? wait : untilExpiry);
        if (reply.Status != 0) return Reply.Refuse(Reason.ForAgentStatus(reply.Status) ?? throw new AgentFailure(Reason.AgentLimit));
        return reply.Body.Length >= 5 ? Reply.Success(reply.Body) : throw new AgentFailure(Reason.AgentLimit);
    }

    private async Task<Reply> PutAsync(Run run, byte[] body, long now)
    {
        if (body.Length < 4) return Reply.Refuse(Reason.BadArgs);
        uint pathLength = BinaryPrimitives.ReadUInt32BigEndian(body);
        if (pathLength == 0 || pathLength > (uint)limits.MaxPathBytes || pathLength > body.Length - 4) return Reply.Refuse(Reason.BadPath);
        string? path = SafePath(body.AsSpan(4, (int)pathLength));
        if (path is null) return Reply.Refuse(Reason.BadPath);
        ReadOnlySpan<byte> data = body.AsSpan(4 + (int)pathLength);
        if (data.Length > limits.MaxPutBytes) return Reply.Refuse(Reason.TooLarge);
        return await RelayAsync(run, AgentLink.WriteRequest(path, data), 0, now);
    }

    private async Task<Reply> GetAsync(Run run, byte[] body, long now)
    {
        string? path = body.Length <= limits.MaxPathBytes ? SafePath(body) : null;
        return path is null ? Reply.Refuse(Reason.BadPath) : await RelayAsync(run, AgentLink.ReadRequest(path), limits.MaxGetBytes, now);
    }

    private async Task<Reply> RelayAsync(Run run, byte[] agentRequest, int maxBody, long now)
    {
        TimeSpan wait = TimeSpan.FromSeconds(run.Lease.ExpiresAt - now) + limits.ExpiryGrace;
        AgentReply reply = await run.Link.CallAsync(agentRequest, maxBody, wait < limits.AgentGrace ? wait : limits.AgentGrace);
        return reply.Status == 0 ? Reply.Success(reply.Body) : Reply.Refuse(Reason.ForAgentStatus(reply.Status) ?? throw new AgentFailure(Reason.AgentLimit));
    }

    /// <summary>A relative UTF-8 path with no NUL, control character, backslash, drive colon, absolute start or `..` step. The agent checks again, and the job can reach all of /work anyway: this keeps an honest caller honest.</summary>
    internal static string? SafePath(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0) return null;
        string path;
        try { path = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes); }
        catch (ArgumentException) { return null; }
        if (path[0] == '/' || path.Any(c => c < ' ' || c == '\\' || c == '\u007f') || path.Split('/').Any(step => step == ".." || step.Length == 0)) return null;
        return path;
    }

    // ---- end, stop, expiry ------------------------------------------------------------------------------------------------------------------------------------------------

    private async Task<Reply> EndAsync(Request request, bool abort)
    {
        if (!_runs.TryGetValue(request.RunId, out Run? run)) return Reply.Refuse(Reason.NoRun);
        bool holdsGate = !abort && await run.Gate.WaitAsync(limits.EndWait); // end waits for a call in flight; stop (and an end that waited too long) cuts it off
        bool unregistered = await TeardownAsync(run);
        if (holdsGate) run.Gate.Release();
        return unregistered ? Reply.Success() : Reply.Refuse(Reason.UnregisterFailed);
    }

    /// <summary>Ends every run whose lease has run out, including one that is in the middle of a command. Called on a timer.</summary>
    public async Task ReapExpiredAsync()
    {
        foreach (Run run in _runs.Values.Where(run => clock() >= run.Lease.ExpiresAt).ToList())
        {
            await TeardownAsync(run);
            log("REAP=expired");
        }
    }

    public async Task StopAllAsync()
    {
        foreach (Run run in _runs.Values.ToList()) await TeardownAsync(run);
    }

    /// <summary>The distribution of every run, whatever ended it: stop the agent, `wsl --terminate`, then `--unregister`, then the folder. Once only. True when the distribution is gone.</summary>
    private Task<bool> TeardownAsync(Run run)
    {
        if (Interlocked.Exchange(ref run.Ended, 1) == 1) return Task.FromResult(true);
        _runs.TryRemove(run.Id, out _);
        run.Process.Kill();
        return Task.Run(() => { bool gone = Discard(run.Name, run.Folder); run.Process.Dispose(); return gone; });
    }

    /// <summary>terminate, unregister, delete the folder we made. The name is checked again here (RunName.Require in WslArgs): nothing but an `albera-run-` name gets this far.</summary>
    private bool Discard(string name, string folder)
    {
        host.Terminate(name);
        bool gone = host.Unregister(name);
        try { if (Directory.Exists(folder) && string.Equals(folder, Path.Combine(config.DistributionsFolder, name), StringComparison.Ordinal)) Directory.Delete(folder, recursive: true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* the disk image may be held a moment longer; the folder is ours and is checked again at the next begin */ }
        return gone;
    }

    /// <summary>At start: remove every leftover `albera-run-` distribution (a bridge that was killed leaves them). Names that are not strictly ours are never touched. Returns how many were removed.</summary>
    public async Task<int> SweepLeftoversAsync()
    {
        IReadOnlyList<string>? names = host.ListDistributions();
        if (names is null) { log("SWEEP=unreadable"); return 0; }
        List<string> ours = names.Where(RunName.IsRunName).ToList();
        foreach (string name in ours) await Task.Run(() => Discard(name, Path.Combine(config.DistributionsFolder, name)));
        log($"SWEEP={ours.Count}");
        return ours.Count;
    }
}
