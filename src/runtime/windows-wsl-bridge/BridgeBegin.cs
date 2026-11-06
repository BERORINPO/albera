using System.Security.Cryptography;
using System.Text;
using Albera.BrokerContract;

namespace Albera.WslBridge;

// begin (ADR-012, decisions 4, 6, 12). The order is the design:
//   1 the lease: shape, digest, signature and time are proved BEFORE anything in it is acted on (Authenticate); only then is its repositoryId looked up in the config and the head read by the bridge itself,
//     and the bindings checked against what the bridge knows (RequireBinding: base head, own computer, operation, repository, and the generation floor, read now from its admin-only file)
//   2 the operation id is written to the ledger (on disk, flushed); if that fails, the run is refused
//   3 the image's SHA-256, taken now, with the file held open so that nobody can change it before the import
//   4 the WSL version and the kernel floor and its expiry
//   5 `wsl --import` as albera-run-<id>, 6 the agent, 7 the input bundle, made by the bridge from its own reading of the repository, and cloned inside the sandbox as the job user
// The end of the lease is looked at again before the import and before the answer: hashing, importing and cloning all take time. From the import on, every way out that is not a registered run discards the
// distribution and the agent. A `stop` or `end` for an id still here takes the BeginTicket: the agent is killed and the run is never registered.
internal sealed partial class Bridge
{
    private const int MaxLeaseBytes = 4096;
    /// <summary>Where the clone of the input bundle lives under /work (the agent's working folder). `bundle` reads this folder and no other.</summary>
    internal const string CloneFolder = "repo";

    /// <summary>One `begin` in flight. Stopping it and registering its run exclude each other, so a `stop` that was answered ok can never leave a run behind.</summary>
    private sealed class BeginTicket
    {
        private readonly object _lock = new();
        private IAgentProcess? _agent;
        private bool _stopped, _committed;

        public TaskCompletionSource Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Stopped { get { lock (_lock) return _stopped; } }

        public void Watch(IAgentProcess agent) { lock (_lock) { _agent = agent; if (_stopped) agent.Kill(); } }

        /// <summary>False when the run has been registered already.</summary>
        public bool TryStop() { lock (_lock) { if (_committed) return false; _stopped = true; _agent?.Kill(); return true; } }

        /// <summary>Runs <paramref name="register"/> unless the begin was stopped.</summary>
        public bool TryCommit(Action register) { lock (_lock) { if (_stopped) return false; register(); _committed = true; return true; } }
    }

    private async Task<Reply> BeginAsync(Request request)
    {
        if (request.Body.Length == 0) return Reply.Refuse(Reason.LeaseMissing);
        if (_runs.ContainsKey(request.RunId)) return Reply.Refuse(Reason.RunExists);
        BeginTicket ticket = new();
        if (!_beginning.TryAdd(request.RunId, ticket)) return Reply.Refuse(Reason.RunExists);
        try
        {
            if (Volatile.Read(ref _stopping) != 0) return Reply.Refuse(Reason.BridgeStopping);
            Reply reply = await CheckAndStartAsync(request, ticket);
            return !reply.Ok && ticket.Stopped ? Reply.Refuse(Reason.RunStopped) : reply; // whatever a cut-off begin tripped over, the cause is the stop
        }
        finally
        {
            _beginning.TryRemove(request.RunId, out _);
            ticket.Done.TrySetResult();
        }
    }

    private async Task<Reply> CheckAndStartAsync(Request request, BeginTicket ticket)
    {
        (Wsl2RunLeaseBody? lease, string? repositoryPath, Reply? refused) = CheckLease(request);
        if (refused is not null) return refused;
        string? name = RunName.For(request.RunId);
        if (name is null) return Reply.Refuse(Reason.RunName);
        if (Interlocked.Increment(ref _starting) + _runs.Count > limits.MaxRuns) { Interlocked.Decrement(ref _starting); return Reply.Refuse(Reason.TooManyRuns); }
        try
        {
            if (ledger.TryReserve(request.RunId, lease!.ExpiresAt) is { } used) return Reply.Refuse(used);
            return await StartRunAsync(request.RunId, name, lease, repositoryPath!, ticket);
        }
        finally { Interlocked.Decrement(ref _starting); }
    }

    private (Wsl2RunLeaseBody?, string?, Reply?) CheckLease(Request request)
    {
        Dictionary<string, object> signed;
        try { signed = request.Body.Length <= MaxLeaseBytes ? StrictJson.Parse(request.Body, 4) : throw new StrictJsonException(); }
        catch (StrictJsonException) { return (null, null, Reply.Refuse(Reason.LeaseMalformed)); }
        Wsl2RunLeaseVerdict auth = Wsl2RunLease.Authenticate(signed, clock, key.Verify);
        if (!auth.Ok) return (null, null, Reply.Refuse(AuthReason(auth.Code)));
        Wsl2RunLeaseBody lease = auth.Proof!.Body; // proved by the Broker's key and still in its time: only now is any of it used
        if (!config.Repositories.TryGetValue(lease.RepositoryId, out string? repositoryPath)) return (null, null, Reply.Refuse(Reason.RepositoryUnknown));
        string? head = repositories.ReadHead(repositoryPath);
        if (head is null) return (null, null, Reply.Refuse(Reason.HeadUnreadable));
        if (clock() >= lease.ExpiresAt) return (null, null, Reply.Refuse(Reason.LeaseExpired)); // reading a repository takes time: the end of the lease is looked at again after it
        if (readLeaseFloor() is not { } floor) return (null, null, Reply.Refuse(Reason.LeaseFloorUnreadable)); // read at every begin: this is how a Control Plane is revoked on a running bridge
        Wsl2RunLeaseVerdict bound = Wsl2RunLease.RequireBinding(auth.Proof, new Wsl2RunLeaseExpected(head, config.ComputerId, floor, request.RunId, lease.RepositoryId));
        return bound.Ok ? (lease, repositoryPath, null) : (null, null, Reply.Refuse(BindingReason(bound)));
    }

    internal static string AuthReason(string? code) => code switch
    {
        "malformed" or "ttl" or "digest" => Reason.LeaseMalformed, "signature" => Reason.LeaseSignature, "not_yet_valid" => Reason.LeaseNotYetValid, "expired" => Reason.LeaseExpired, _ => Reason.Internal,
    };

    internal static string BindingReason(Wsl2RunLeaseVerdict verdict) => verdict.Code switch
    {
        "binding" when verdict.Field == "baseOid" => Reason.BaseMoved, "binding" => Reason.LeaseTarget, "generation" => Reason.LeaseGeneration, _ => Reason.Internal,
    };

    private async Task<Reply> StartRunAsync(string id, string name, Wsl2RunLeaseBody lease, string repositoryPath, BeginTicket ticket)
    {
        string folder = Path.Combine(config.DistributionsFolder, name);
        if (await ImportAsync(name, folder, lease, ticket) is { } refused) return refused;
        IAgentProcess? process = null;
        try
        {
            process = host.StartAgent(name);
            if (process is null) return Discarded(name, folder, Reason.AgentStart);
            ticket.Watch(process);
            Run run = new(id, name, folder, lease, process);
            if (await FeedBundleAsync(run, repositoryPath) is { } failure) return Discarded(name, folder, failure, process);
            if (clock() >= lease.ExpiresAt) return Discarded(name, folder, Reason.LeaseExpired, process);
            return ticket.TryCommit(() => _runs[id] = run) ? Reply.Success() : Discarded(name, folder, Reason.RunStopped, process);
        }
        catch (AgentFailure failure) { return Discarded(name, folder, failure.Reason, process); }
        catch (Exception) { return Discarded(name, folder, Reason.Internal, process); } // anything at all: the distribution is there, and nothing will ever end it if this run is not registered
    }

    /// <summary>Everything up to and including the import. Null when the distribution is there; otherwise the refusal, and nothing is left behind.</summary>
    private async Task<Reply?> ImportAsync(string name, string folder, Wsl2RunLeaseBody lease, BeginTicket ticket)
    {
        bool made = false;
        try
        {
            using FileStream? image = OpenPinnedImage();
            if (image is null) return Reply.Refuse(Reason.ImageMissing);
            if (!string.Equals(Convert.ToHexStringLower(SHA256.HashData(image)), config.ImageSha256, StringComparison.Ordinal)) return Reply.Refuse(Reason.ImageHash); // hashed now, held open until the import ends
            if (config.Floor.Check(host.ReadVersions(), clock()) is { } tooOld) return Reply.Refuse(tooOld);
            if (clock() >= lease.ExpiresAt) return Reply.Refuse(Reason.LeaseExpired); // hashing the image takes time
            if (ticket.Stopped) return Reply.Refuse(Reason.RunStopped);
            if (Directory.Exists(folder)) return Reply.Refuse(Reason.RunExists);
            Directory.CreateDirectory(folder);
            made = true;
            if (!await Task.Run(() => host.Import(name, folder, config.ImagePath))) return Discarded(name, folder, Reason.ImportFailed);
            return ticket.Stopped ? Discarded(name, folder, Reason.RunStopped) : null;
        }
        catch (Exception ex)
        {
            if (made) return Discarded(name, folder, Reason.ImportFailed);
            return Reply.Refuse(ex is IOException or UnauthorizedAccessException ? Reason.ImageMissing : Reason.Internal);
        }
    }

    private FileStream? OpenPinnedImage()
    {
        try { return new FileStream(config.ImagePath, FileMode.Open, FileAccess.Read, FileShare.Read); } // FileShare.Read: nobody can write or replace it while it is held
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    private Reply Discarded(string name, string folder, string reason, IAgentProcess? process = null)
    {
        string id = name[RunName.Prefix.Length..];
        if (process is not null) StopAgent(process, process.Kill, id);
        Discard(name, folder);
        if (process is not null) StopAgent(process, process.Dispose, id);
        return Reply.Refuse(reason);
    }

    /// <summary>Makes the bundle (the bridge's own reading of the repository, at most MaxBundleBytes), checks that its HEAD is the lease's baseOid, puts it in /work and clones it there as the job user. Null when done, otherwise the refusal word.</summary>
    private async Task<string?> FeedBundleAsync(Run run, string repositoryPath)
    {
        byte[]? bundle = await Task.Run(() => repositories.MakeBundle(repositoryPath, limits.MaxBundleBytes));
        if (bundle is null) return Reason.BundleFailed;
        if (BundleHeader.HeadOf(bundle) != run.Lease.BaseOid) return Reason.BaseMoved; // the head moved between the reading and the bundling, or the bundle is not what was asked for
        AgentReply written = await run.Link.CallAsync(AgentLink.WriteRequest("input.bundle", bundle), 0, limits.BeginCall);
        if (written.Status != 0) return Reason.BundleFailed;
        AgentReply cloned = await run.Link.CallAsync(AgentLink.RunRequest(120, $"cd /work && git -c advice.detachedHead=false clone -q input.bundle {CloneFolder} && git -C {CloneFolder} rev-parse HEAD"), 5 + limits.MaxOutputBytes, limits.BeginCall);
        if (cloned.Status != 0 || cloned.Body.Length < 5 || System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(cloned.Body) != 0) return Reason.BundleFailed;
        string last = Encoding.ASCII.GetString(cloned.Body, 5, cloned.Body.Length - 5).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault() ?? ""; // git may print notes first: the id is the last line
        return last == run.Lease.BaseOid ? null : Reason.BundleFailed;
    }
}
