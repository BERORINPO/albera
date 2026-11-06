using System.Security.Cryptography;
using System.Text;
using Albera.BrokerContract;

namespace Albera.WslBridge;

// begin (ADR-012, decisions 4, 6, 12). The order is the design:
//   1 the lease: shape, digest, signature and time are proved BEFORE anything in it is acted on (Authenticate); only then is its repositoryId looked up in the config and the head read by the bridge itself,
//     and the bindings checked against what the bridge knows (RequireBinding: base head, own computer, operation, repository, generation floor)
//   2 the operation id is written to the ledger (on disk, flushed); if that fails, the run is refused
//   3 the image's SHA-256, taken now, with the file held open so that nobody can change it before the import
//   4 the WSL version and the kernel floor and its expiry
//   5 `wsl --import` as albera-run-<id>, 6 the agent, 7 the input bundle, made by the bridge from its own reading of the repository, and cloned inside the sandbox as the job user
internal sealed partial class Bridge
{
    private const int MaxLeaseBytes = 4096;

    private async Task<Reply> BeginAsync(Request request)
    {
        if (request.Body.Length == 0) return Reply.Refuse(Reason.LeaseMissing);
        if (_runs.ContainsKey(request.RunId)) return Reply.Refuse(Reason.RunExists);
        (Wsl2RunLeaseBody? lease, string? repositoryPath, Reply? refused) = CheckLease(request);
        if (refused is not null) return refused;
        string? name = RunName.For(request.RunId);
        if (name is null) return Reply.Refuse(Reason.RunName);
        if (Interlocked.Increment(ref _starting) + _runs.Count > limits.MaxRuns) { Interlocked.Decrement(ref _starting); return Reply.Refuse(Reason.TooManyRuns); }
        try
        {
            if (ledger.TryReserve(request.RunId, lease!.ExpiresAt) is { } used) return Reply.Refuse(used);
            return await StartRunAsync(request.RunId, name, lease, repositoryPath!);
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
        Wsl2RunLeaseBody lease = auth.Value!; // proved by the Broker's key and still in its time: only now is any of it used
        if (!config.Repositories.TryGetValue(lease.RepositoryId, out string? repositoryPath)) return (null, null, Reply.Refuse(Reason.RepositoryUnknown));
        string? head = repositories.ReadHead(repositoryPath);
        if (head is null) return (null, null, Reply.Refuse(Reason.HeadUnreadable));
        Wsl2RunLeaseVerdict bound = Wsl2RunLease.RequireBinding(lease, new Wsl2RunLeaseExpected(head, config.ComputerId, config.MinLeaseGeneration, request.RunId, lease.RepositoryId));
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

    private async Task<Reply> StartRunAsync(string id, string name, Wsl2RunLeaseBody lease, string repositoryPath)
    {
        string folder = Path.Combine(config.DistributionsFolder, name);
        bool made = false;
        try
        {
            using FileStream? image = OpenPinnedImage();
            if (image is null) return Reply.Refuse(Reason.ImageMissing);
            if (!string.Equals(Convert.ToHexStringLower(SHA256.HashData(image)), config.ImageSha256, StringComparison.Ordinal)) return Reply.Refuse(Reason.ImageHash); // hashed now, held open until the import ends
            if (config.Floor.Check(host.ReadVersions(), clock()) is { } tooOld) return Reply.Refuse(tooOld);
            if (Directory.Exists(folder)) return Reply.Refuse(Reason.RunExists);
            Directory.CreateDirectory(folder);
            made = true;
            if (!await Task.Run(() => host.Import(name, folder, config.ImagePath))) return Discarded(name, folder, Reason.ImportFailed);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return made ? Discarded(name, folder, Reason.ImportFailed) : Reply.Refuse(Reason.ImageMissing); }
        IAgentProcess? process = host.StartAgent(name);
        if (process is null) return Discarded(name, folder, Reason.AgentStart);
        Run run = new(id, name, folder, lease, process);
        try
        {
            if (await FeedBundleAsync(run, repositoryPath) is { } failure) return Discarded(name, folder, failure, process);
        }
        catch (AgentFailure failure) { return Discarded(name, folder, failure.Reason, process); }
        _runs[id] = run;
        return Reply.Success();
    }

    private FileStream? OpenPinnedImage()
    {
        try { return new FileStream(config.ImagePath, FileMode.Open, FileAccess.Read, FileShare.Read); } // FileShare.Read: nobody can write or replace it while it is held
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    private Reply Discarded(string name, string folder, string reason, IAgentProcess? process = null)
    {
        process?.Kill();
        Discard(name, folder);
        process?.Dispose();
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
        AgentReply cloned = await run.Link.CallAsync(AgentLink.RunRequest(120, "cd /work && git clone -q input.bundle repo && git -C repo rev-parse HEAD"), 5 + limits.MaxOutputBytes, limits.BeginCall);
        if (cloned.Status != 0 || cloned.Body.Length < 5 || System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(cloned.Body) != 0) return Reason.BundleFailed;
        return Encoding.ASCII.GetString(cloned.Body, 5, cloned.Body.Length - 5).Trim() == run.Lease.BaseOid ? null : Reason.BundleFailed;
    }
}
