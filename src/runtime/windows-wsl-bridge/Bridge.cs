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
    /// <summary>What the one teardown of this run came to: true when the distribution is gone.</summary>
    public TaskCompletionSource<bool> TornDown { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}

// The six verbs (ADR-012, "The WSL bridge"). Every decision lives here, on the Windows side: the lease, the call count, the sizes and the deadline are the bridge's own, and nothing the agent says about
// its limits is trusted (a job can take the agent over). A run that breaks a limit, or whose agent misbehaves, is ended: terminate, then unregister.
// begin is in BridgeBegin.cs. Every reply carries a Reason word and nothing else about the request (no path, no repository, no output). Log lines are fixed words, each with the run id it is about (`run=<id>`):
// an id has passed Wire.IsId, so it cannot carry a space or a line end, and on a refused `begin` it is the id the caller named, not one a lease has proved.
internal sealed partial class Bridge(BridgeConfig config, IWslHost host, IRepositories repositories, OperationLedger ledger, BrokerKey key, Func<long> clock, Limits limits, Func<long?> readLeaseFloor, Action<string> log)
{
    /// <summary>A distribution or folder that could not be removed yet. The reaper tries again; a distribution already unregistered is not unregistered twice.</summary>
    private sealed record PendingDiscard(string Folder, bool Unregistered);

    private readonly ConcurrentDictionary<string, Run> _runs = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, BeginTicket> _beginning = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PendingDiscard> _pending = new(StringComparer.Ordinal);
    private int _starting, _stopping;

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
        log($"{request.Verb.ToString().ToUpperInvariant()}={(reply.Ok ? "ok" : "refused:" + reply.Reason)} run={(Wire.IsId(request.RunId) ? request.RunId : "-")}");
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
        if (!_runs.TryGetValue(request.RunId, out Run? run))
        {
            if (_beginning.TryGetValue(request.RunId, out BeginTicket? ticket) && ticket.TryStop()) return Reply.Success(); // still in `begin`: it will discard the distribution instead of registering the run
            if (!_runs.TryGetValue(request.RunId, out run)) return Reply.Refuse(Reason.NoRun); // TryStop said no because the run had just been registered
        }
        bool holdsGate = !abort && await run.Gate.WaitAsync(limits.EndWait); // end waits for a call in flight; stop (and an end that waited too long) cuts it off
        bool unregistered = await TeardownAsync(run);
        if (holdsGate) run.Gate.Release();
        return unregistered ? Reply.Success() : Reply.Refuse(Reason.UnregisterFailed);
    }

    /// <summary>Ends every run whose lease has run out or whose generation is now below the floor, including one that is in the middle of a command, then tries again what could not be removed earlier.
    /// Called on a timer. A floor that cannot be read ends nothing: `begin` refuses meanwhile, and a run in progress still has its lease's end.</summary>
    public async Task ReapExpiredAsync()
    {
        long? floor = readLeaseFloor();
        if (floor is null) log("REAP=floor_unreadable");
        long now = clock();
        foreach (Run run in _runs.Values.ToList())
        {
            string? why = now >= run.Lease.ExpiresAt ? "expired" : run.Lease.LeaseGeneration < floor ? "generation" : null;
            if (why is null) continue;
            bool gone = await TeardownAsync(run);
            log($"REAP={(gone ? why : "failed")} run={run.Id}");
        }
        await RetryPendingAsync();
    }

    /// <summary>The end of the process: no `begin` starts from here on, the ones in flight are cut off and waited for (each ends in a run or in a discard), then every run is torn down.</summary>
    public async Task StopAllAsync()
    {
        Interlocked.Exchange(ref _stopping, 1);
        BeginTicket[] inFlight = _beginning.Values.ToArray();
        foreach (BeginTicket ticket in inFlight) ticket.TryStop();
        await Task.WhenAll(inFlight.Select(ticket => ticket.Done.Task));
        foreach (Run run in _runs.Values.ToList()) await TeardownAsync(run);
        await RetryPendingAsync();
    }

    /// <summary>The distribution of every run, whatever ended it: stop the agent, `wsl --terminate`, then `--unregister`, then the folder. Once only; a second caller gets the first one's answer. True when the distribution is gone.</summary>
    private async Task<bool> TeardownAsync(Run run)
    {
        if (Interlocked.Exchange(ref run.Ended, 1) == 1) return await run.TornDown.Task;
        _runs.TryRemove(run.Id, out _);
        StopAgent(run.Process, run.Process.Kill, run.Id);
        bool gone = await Task.Run(() => Discard(run.Name, run.Folder));
        StopAgent(run.Process, run.Process.Dispose, run.Id);
        run.TornDown.TrySetResult(gone);
        return gone;
    }

    // A failure here must not keep the distribution from being discarded.
    private void StopAgent(IAgentProcess process, Action step, string id)
    {
        try { step(); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { log($"TEARDOWN=agent_failed run={id}"); }
    }

    /// <summary>terminate, unregister, delete the folder we made; never throws. What fails is logged as a fixed word and kept in the pending list for the reaper. True when the distribution is unregistered.
    /// The name is checked again here (RunName.Require in WslArgs): nothing but an `albera-run-` name gets this far.</summary>
    private bool Discard(string name, string folder, bool unregistered = false)
    {
        string id = name[RunName.Prefix.Length..];
        if (!unregistered)
        {
            try { host.Terminate(name); unregistered = host.Unregister(name); }
            catch (Exception ex) when (ex is not OutOfMemoryException) { unregistered = false; }
        }
        if (!unregistered)
        {
            _pending[name] = new PendingDiscard(folder, false);
            log($"TEARDOWN=unregister_failed run={id}");
            return false;
        }
        if (!RemoveFolder(name, folder))
        {
            _pending[name] = new PendingDiscard(folder, true); // the disk image may be held a moment longer
            log($"TEARDOWN=folder_failed run={id}");
        }
        else if (_pending.TryRemove(name, out _)) log($"TEARDOWN=recovered run={id}");
        return true;
    }

    private bool RemoveFolder(string name, string folder)
    {
        try
        {
            if (Directory.Exists(folder) && string.Equals(folder, Path.Combine(config.DistributionsFolder, name), StringComparison.Ordinal)) Directory.Delete(folder, recursive: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return false; }
    }

    private Task RetryPendingAsync() => _pending.IsEmpty ? Task.CompletedTask : Task.Run(() =>
    {
        IReadOnlyList<string>? registered = ListOrNull(); // an unregister can fail and still have worked: a name that is not listed any more only needs its folder removed
        foreach ((string name, PendingDiscard item) in _pending.ToArray()) Discard(name, item.Folder, item.Unregistered || registered?.Contains(name) == false);
    });

    private IReadOnlyList<string>? ListOrNull()
    {
        try { return host.ListDistributions(); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return null; }
    }

    /// <summary>At start: remove every leftover `albera-run-` distribution (a bridge that was killed leaves them), and a run folder whose distribution is already gone. Names that are not strictly ours are never touched. Returns how many distributions were removed.</summary>
    public async Task<int> SweepLeftoversAsync()
    {
        IReadOnlyList<string>? names = ListOrNull();
        if (names is null) { log("SWEEP=unreadable"); return 0; }
        List<string> ours = names.Where(RunName.IsRunName).ToList();
        foreach (string name in ours) await Task.Run(() => Discard(name, Path.Combine(config.DistributionsFolder, name)));
        foreach (string folder in Directory.EnumerateDirectories(config.DistributionsFolder, RunName.Prefix + "*"))
            if (Path.GetFileName(folder) is { } name && RunName.IsRunName(name) && !ours.Contains(name)) _pending.TryAdd(name, new PendingDiscard(folder, true));
        await RetryPendingAsync();
        log($"SWEEP={ours.Count}");
        return ours.Count;
    }
}
