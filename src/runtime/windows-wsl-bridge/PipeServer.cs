using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Albera.WslBridge;

// The bridge's pipe (ADR-012, "The WSL bridge"). Created with LocalPipe (CreateNamedPipeW): the first instance carries FILE_FLAG_FIRST_PIPE_INSTANCE, so a squatter on the name fails the start; every instance
// rejects remote clients. The owner is this process's own user SID, so the Control Plane can compare it with the SID it expects before it sends anything. The DACL is the owner (full control) and the
// Control Plane SID with exactly FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE (never FILE_APPEND_DATA, which is FILE_CREATE_PIPE_INSTANCE on a pipe).
// A few instances serve at the same time, so `stop` can arrive while an `exec` is running. One connection is one request and one reply. The caller's SID is read from the connection itself, after the
// frame, and has to be the configured Control Plane SID; anything else gets the fixed word peer_denied. The bridge does not elevate and starts no service.
// One connection's failure never costs an instance: whatever it did, the instance is reset for the next client (a dead instance would leave `stop` no way in). An instance that cannot be reset ends the
// bridge: Failed completes, and the caller stops every run (fail closed) instead of serving on with fewer ways to reach them.
internal sealed class PipeServer : IAsyncDisposable
{
    public const uint Instances = 4;
    private const PipeAccessRights ControlPlaneAccess = (PipeAccessRights)0x00120083;
    private static readonly TimeSpan ReplyBudget = TimeSpan.FromSeconds(60), ReplyDrainGrace = TimeSpan.FromSeconds(1);
    private readonly List<NamedPipeServerStream> _pipes;
    private readonly Bridge _bridge;
    private readonly string _controlPlaneSid;
    private readonly Limits _limits;
    private readonly Action<string> _log;
    private readonly List<Task> _slots = [];
    private readonly TaskCompletionSource _failed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private CancellationTokenSource? _stop;

    private PipeServer(List<NamedPipeServerStream> pipes, Bridge bridge, string controlPlaneSid, Limits limits, Action<string> log)
    {
        _pipes = pipes; _bridge = bridge; _controlPlaneSid = controlPlaneSid; _limits = limits; _log = log;
    }

    /// <summary>Completes when an instance could not be reset for its next client.</summary>
    public Task Failed => _failed.Task;

    /// <summary>All instances made, or null with a fixed exit code in <paramref name="failure"/> (70 the name is taken, 72 the pipe cannot be owned by this process's SID).</summary>
    public static PipeServer? Create(string pipeName, string controlPlaneSid, Bridge bridge, Limits limits, Action<string> log, out int failure)
    {
        failure = 0;
        List<NamedPipeServerStream> pipes = [];
        for (uint i = 0; i < Instances; i++)
        {
            NamedPipeServerStream? pipe = CreateInstance(pipeName, controlPlaneSid, i == 0, out failure);
            if (pipe is null) { foreach (NamedPipeServerStream made in pipes) made.Dispose(); return null; }
            pipes.Add(pipe);
        }
        return new PipeServer(pipes, bridge, controlPlaneSid, limits, log);
    }

    private static NamedPipeServerStream? CreateInstance(string pipeName, string controlPlaneSid, bool first, out int failure)
    {
        failure = 0;
        try
        {
            PipeSecurity security = OwnedBySelf(out SecurityIdentifier self, controlPlaneSid);
            NamedPipeServerStream pipe = LocalPipe.Create(pipeName, security, Instances, first);
            if (self.Equals(pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)))) return pipe;
            pipe.Dispose();
            failure = 72;
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or InvalidOperationException) { failure = ex is IOException io && (io.HResult & 0xffff) == 1307 ? 72 : 70; }
        return null;
    }

    private static PipeSecurity OwnedBySelf(out SecurityIdentifier self, string controlPlaneSid)
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        self = identity.User ?? throw new InvalidOperationException();
        PipeSecurity security = new();
        security.SetOwner(self);
        security.AddAccessRule(new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow));
        // The Control Plane is never this process's own SID in production (BridgeConfig.RefuseIdentity stops that start); only the test seam gets here with the two equal.
        if (SidRules.TryParseSid(controlPlaneSid) is { } controlPlane && !controlPlane.Equals(self))
            security.AddAccessRule(new PipeAccessRule(controlPlane, ControlPlaneAccess, AccessControlType.Allow));
        return security;
    }

    public void Start(CancellationToken stop)
    {
        _stop = CancellationTokenSource.CreateLinkedTokenSource(stop);
        foreach (NamedPipeServerStream pipe in _pipes) _slots.Add(Task.Run(() => RunGuardedSlotAsync(pipe, _stop.Token)));
    }

    public async ValueTask DisposeAsync()
    {
        _stop?.Cancel();
        foreach (NamedPipeServerStream pipe in _pipes) pipe.Dispose();
        try { await Task.WhenAll(_slots).WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException or ObjectDisposedException or IOException) { }
    }

    // A slot that ends for any reason but the stop, even one the slot's own catch lets through, is a failed slot: the bridge must not go on with fewer than it says.
    private async Task RunGuardedSlotAsync(NamedPipeServerStream pipe, CancellationToken stop)
    {
        try { await RunSlotAsync(pipe, stop); }
        finally { if (!stop.IsCancellationRequested) _failed.TrySetResult(); }
    }

    private async Task RunSlotAsync(NamedPipeServerStream pipe, CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await pipe.WaitForConnectionAsync(stop);
                await ServeAsync(pipe, stop);
                await WaitForClientToReadAsync(pipe);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                if (stop.IsCancellationRequested) return;
                _log("PIPE=aborted"); // the client vanished or ran out of time; what it asked for has been decided by the bridge either way
            }
            if (stop.IsCancellationRequested) return;
            try { DisconnectForNextClient(pipe); }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                if (stop.IsCancellationRequested) return;
                _log("PIPE=slot_failed");
                _failed.TrySetResult();
                return;
            }
        }
    }

    // FlushFileBuffers on a pipe returns once the client has read everything written. A client that does not read, or has already gone, ends the wait after the grace period / at once
    // (as ServiceLoop.cs in the Broker and PipeHost.cs in the Authority).
    private static async Task WaitForClientToReadAsync(NamedPipeServerStream pipe)
    {
        try { await Task.Run(pipe.WaitForPipeDrain).WaitAsync(ReplyDrainGrace); }
        catch (Exception ex) when (ex is TimeoutException or IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    // .NET only lets Disconnect() run on a pipe it believes is connected. A client that connected and left before WaitForConnection finished leaves the instance waiting in .NET's eyes but half-closed
    // in the system's: the system call resets it. A client that left during a read leaves it Broken, where IsConnected is false but Disconnect() is exactly what it needs.
    private static void DisconnectForNextClient(NamedPipeServerStream pipe)
    {
        try { pipe.Disconnect(); }
        catch (InvalidOperationException)
        {
            if (!DisconnectNamedPipe(pipe.SafePipeHandle)) throw new IOException("DisconnectNamedPipe failed", Marshal.GetLastWin32Error());
        }
    }

    private async Task ServeAsync(NamedPipeServerStream pipe, CancellationToken stop)
    {
        Reply reply;
        using (CancellationTokenSource readBudget = CancellationTokenSource.CreateLinkedTokenSource(stop))
        {
            readBudget.CancelAfter(_limits.ReadFrame);
            byte[]? frame = await Wire.ReadFrameAsync(pipe, _limits.MaxRequestFrame, readBudget.Token);
            reply = frame is null ? Reply.Refuse(Reason.BadFrame) : await Decide(pipe, frame);
        }
        using CancellationTokenSource replyBudget = new(ReplyBudget);
        await pipe.WriteAsync(Wire.Frame(Wire.Encode(reply)), replyBudget.Token);
        await pipe.FlushAsync(replyBudget.Token);
    }

    private async Task<Reply> Decide(NamedPipeServerStream pipe, byte[] frame)
    {
        if (ReadPeerSid(pipe) != _controlPlaneSid) { _log("PEER=denied"); return Reply.Refuse(Reason.PeerDenied); }
        Request? request = Wire.Parse(frame);
        return request is null ? Reply.Refuse(Reason.BadFrame) : await _bridge.HandleAsync(request);
    }

    // Impersonate, read the SID and revert on this thread (no await in between). RunAsClient reverts in a finally; if the thread still carries a token afterwards the process ends (fail closed).
    private static string? ReadPeerSid(NamedPipeServerStream pipe)
    {
        string? sid = null;
        try { pipe.RunAsClient(() => { using WindowsIdentity identity = WindowsIdentity.GetCurrent(ifImpersonating: true) ?? throw new UnauthorizedAccessException(); sid = identity.User?.Value; }); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException) { sid = null; }
        using WindowsIdentity? leaked = WindowsIdentity.GetCurrent(ifImpersonating: true);
        if (leaked is not null) Environment.FailFast("impersonation was not reverted");
        return sid;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DisconnectNamedPipe(SafePipeHandle pipe);
}
