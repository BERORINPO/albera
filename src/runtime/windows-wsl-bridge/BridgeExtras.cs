using System.Text;
using System.Text.Json;

namespace Albera.WslBridge;

// The two verbs of ADR-012 phase 4. They are in their own file because they are not exec, put or get: `bundle` is a counted call on a run, `status` needs no run, no lease and no count.
//   bundle  The input is nothing: the agent bundles the one folder `begin` cloned (CloneFolder), `git -C repo bundle create - --all`, as the job user. The reply is the bundle, at most Limits.MaxBundleBytes, or a
//           refusal; never a part of a bundle. A length over the limit is refused from the agent's four header bytes, so no body is read, and the run ends like any run whose agent breaks a limit (the
//           stream cannot be used again).
//   status  Whether a run could start on this machine's WSL and kernel (the Floor that `begin` uses), and, when a repository id is sent, the head the bridge itself reads for it (the Control Plane's account may
//           not be able to read the repository, and this head is what the owner approves as baseOid). It never touches a distribution. The WSL version is read at most once in KernelCacheSeconds; the floor's
//           expiry is judged at every call; the head is never cached.
internal sealed partial class Bridge
{
    /// <summary>How long `wsl --version` is trusted by `status`, so that polling does not start wsl.exe each time.</summary>
    internal const int KernelCacheSeconds = 60;
    internal const int BundleSeconds = 120;
    private const int MaxStatusBodyBytes = 128;

    private readonly object _kernelLock = new();
    private bool _kernelRead;
    private long _kernelReadAt;
    private WslVersions? _kernelVersions;

    private async Task<Reply> BundleAsync(Run run, byte[] body, long now)
    {
        if (body.Length != 0) return Reply.Refuse(Reason.BadArgs);
        long remaining = run.Lease.ExpiresAt - now;
        uint seconds = (uint)Math.Min(BundleSeconds, remaining); // a bundle never outlives the lease
        TimeSpan wait = TimeSpan.FromSeconds(seconds) + limits.AgentGrace;
        TimeSpan untilExpiry = TimeSpan.FromSeconds(remaining) + limits.ExpiryGrace;
        AgentReply reply = await run.Link.CallAsync(AgentLink.BundleRequest(seconds, CloneFolder), limits.MaxBundleBytes, wait < untilExpiry ? wait : untilExpiry, Reason.BundleTooLarge);
        if (reply.Status == 0) return Reply.Success(reply.Body);
        string word = reply.Status == 2 ? Reason.BundleTooLarge : Reason.ForAgentStatus(reply.Status) ?? throw new AgentFailure(Reason.AgentLimit);
        return Reply.Refuse(word);
    }

    private async Task<Reply> StatusAsync(Request request)
    {
        if (request.Body.Length > MaxStatusBodyBytes) return Reply.Refuse(Reason.BadArgs);
        string? repositoryId = null;
        if (request.Body.Length > 0)
        {
            try { repositoryId = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(request.Body); }
            catch (ArgumentException) { return Reply.Refuse(Reason.BadArgs); }
        }
        string? why = await Task.Run(KernelReason);
        string? head = repositoryId is null ? null : await Task.Run(() => HeadOf(repositoryId));
        using MemoryStream stream = new();
        using (Utf8JsonWriter json = new(stream))
        {
            json.WriteStartObject();
            json.WriteBoolean("kernelOk", why is null);
            if (why is null) json.WriteNull("reason"); else json.WriteString("reason", why);
            if (repositoryId is not null) { if (head is null) json.WriteNull("head"); else json.WriteString("head", head); }
            json.WriteEndObject();
        }
        return Reply.Success(stream.ToArray());
    }

    /// <summary>null when a run may start, otherwise the fixed word. The versions are read by the same host call `begin` uses, at most once in KernelCacheSeconds (a failed read counts as a read).</summary>
    private string? KernelReason()
    {
        long now = clock();
        lock (_kernelLock) // held across the read on purpose: polling clients wait for one wsl.exe, they do not start many
        {
            if (!_kernelRead || now < _kernelReadAt || now - _kernelReadAt >= KernelCacheSeconds)
            {
                try { _kernelVersions = host.ReadVersions(); }
                catch (Exception ex) when (ex is not OutOfMemoryException) { _kernelVersions = null; }
                _kernelRead = true;
                _kernelReadAt = now;
            }
            return config.Floor.Check(_kernelVersions, now);
        }
    }

    /// <summary>The head of the repository the config maps <paramref name="repositoryId"/> to, read by the bridge's own git as `begin` reads it; null when the id is unknown or git fails.</summary>
    private string? HeadOf(string repositoryId)
    {
        if (!config.Repositories.TryGetValue(repositoryId, out string? path)) return null;
        try { return repositories.ReadHead(path); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return null; }
    }
}
