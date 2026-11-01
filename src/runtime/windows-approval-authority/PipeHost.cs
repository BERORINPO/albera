using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Albera.ApprovalAuthority;

// One named pipe of the Authority and the loop that serves it (patterns copied from the Broker's CreateBrokerPipe / ReadPeerSid / serve loop; the
// Broker is not referenced). The pipe is created ONCE as the first and only instance (max 1, so FILE_FLAG_FIRST_PIPE_INSTANCE: a squatter or a second
// Authority fails creation with exit 70), owned by this process's own SID, with a DACL of exactly: this SID (full control) and the ONE configured
// principal for this pipe with 0x00120083 (FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE; never
// FILE_APPEND_DATA, which is FILE_CREATE_PIPE_INSTANCE on a pipe, and never a generic right). The Control Plane SID is on the submit pipe only and the
// approver SID on the approver pipe only. Each connection: read one frame (2 KiB max), impersonate the client for one SID lookup and revert at once
// (a revert that fails or leaves a token ends the process with 71), compare the SID with the configured one, answer, wait (bounded) for the client
// to read, disconnect, wait for the next client on the same instance.
internal static class PipeHost
{
    public const int MaxFrameLength = AuthorityProtocol.MaxFrameBytes;
    private const PipeAccessRights ClientAccess = (PipeAccessRights)0x00120083;
    private const int ErrorInvalidOwner = 1307;
    private static readonly TimeSpan ConnectionDeadline = TimeSpan.FromSeconds(15), ReplyDrainGrace = TimeSpan.FromSeconds(1), ReplyWriteTimeout = TimeSpan.FromSeconds(2);

    // Set by ServiceHost: report STOPPED with the given service-specific exit code. Called, best effort, just before the process is terminated.
    internal static Action<int>? ServiceTerminationNotice;

    /// <returns>null with a fixed exit code in <paramref name="failure"/> (70 name taken, 72 owner not settable) when the pipe cannot be served</returns>
    public static NamedPipeServerStream? CreatePipe(string pipeName, string allowedSid, out int failure)
    {
        failure = 0;
        NamedPipeServerStream pipe;
        try
        {
            pipe = LocalPipe.Create(pipeName, OwnedBySelf(out SecurityIdentifier self, allowedSid));   // first instance, max 1, PIPE_REJECT_REMOTE_CLIENTS
            if (!self.Equals(pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)))) { pipe.Dispose(); failure = OwnerUnavailable(); return null; }
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or InvalidOperationException)
        {
            if (ex is IOException io && (io.HResult & 0xffff) == ErrorInvalidOwner || ex is InvalidOperationException) failure = OwnerUnavailable();
            else
            {
                Console.WriteLine("AUTHORITY_FATAL=PIPE_UNAVAILABLE");
                failure = ExitCodes.PipeUnavailable;
            }
            return null;
        }
        return pipe;
    }

    private static int OwnerUnavailable()
    {
        Console.WriteLine("AUTHORITY_FATAL=PIPE_OWNER_UNAVAILABLE");
        return ExitCodes.PipeOwnerUnavailable;
    }

    // The owner is this process's own user SID (not the token's default owner, Administrators for an elevated token), so a client can compare the
    // pipe's owner with the SID it expects. A configured SID that is this process's own SID, or one that is not a single principal, adds nothing.
    private static PipeSecurity OwnedBySelf(out SecurityIdentifier self, string allowedSid)
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        self = identity.User ?? throw new InvalidOperationException();
        PipeSecurity security = new();
        security.SetOwner(self);
        security.AddAccessRule(new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow));
        if (SidRules.TryParse(allowedSid, allowVirtualAccount: true) is { } principal && !principal.Equals(self))
            security.AddAccessRule(new PipeAccessRule(principal, ClientAccess, AccessControlType.Allow));
        return security;
    }

    /// <returns>0 once <paramref name="stop"/> is cancelled; a connection's own I/O failure or deadline is the only thing swallowed</returns>
    public static async Task<int> ServeAsync(NamedPipeServerStream pipe, PipeRole role, string allowedSid, Func<PipeRole, byte[], byte[]> handler, CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await pipe.WaitForConnectionAsync(stop);
                using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
                deadline.CancelAfter(ConnectionDeadline);
                await HandleConnectionAsync(pipe, role, allowedSid, handler, deadline.Token);
                await WaitForClientToReadAsync(pipe);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return 0; }
            catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException)
            {
                Console.WriteLine("REQUEST=ABORTED"); // the client vanished mid-request or hit the deadline
            }
            if (stop.IsCancellationRequested) return 0;
            DisconnectForNextClient(pipe);
        }
        return 0;
    }

    private static async Task HandleConnectionAsync(NamedPipeServerStream pipe, PipeRole role, string allowedSid, Func<PipeRole, byte[], byte[]> handler, CancellationToken ioToken)
    {
        byte[] response;
        try
        {
            byte[] frame = await ReadFrameAsync(pipe, ioToken);
            string? peerSid = ReadPeerSid(pipe);
            bool allowed = string.Equals(peerSid, allowedSid, StringComparison.Ordinal);
            Console.WriteLine(allowed ? $"PEER={role}:authenticated" : $"PEER={role}:denied");
            response = allowed ? handler(role, frame) : AuthorityProtocol.Error(AuthorityCodes.RequestInvalid);
        }
        catch (Exception ex) when (ex is InvalidDataException or UnauthorizedAccessException)
        {
            response = AuthorityProtocol.Error(AuthorityCodes.RequestInvalid);
            Console.WriteLine("REQUEST=DENIED");
        }
        if (response.Length > MaxFrameLength) response = AuthorityProtocol.Error(AuthorityCodes.AuthorityUnavailable);
        using CancellationTokenSource replyBudget = new(ReplyWriteTimeout);
        await WriteFrameAsync(pipe, response, replyBudget.Token);
    }

    // FlushFileBuffers on a pipe returns once the client has read everything written. A client that does not read, or has already gone, ends the
    // wait after the grace period / at once.
    private static async Task WaitForClientToReadAsync(NamedPipeServerStream pipe)
    {
        try { await Task.Run(pipe.WaitForPipeDrain).WaitAsync(ReplyDrainGrace); }
        catch (Exception ex) when (ex is TimeoutException or IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    // .NET only lets Disconnect() run on a pipe it believes is connected. A client that connected and left before WaitForConnection finished leaves
    // the instance waiting in .NET's eyes but half-closed in the system's: the system call resets it. Either way the instance (and the name) stays ours.
    private static void DisconnectForNextClient(NamedPipeServerStream pipe)
    {
        try { pipe.Disconnect(); }
        catch (InvalidOperationException)
        {
            if (!DisconnectNamedPipe(pipe.SafePipeHandle)) throw new IOException("DisconnectNamedPipe failed", Marshal.GetLastWin32Error());
        }
    }

    // Impersonate, read the peer SID and revert on the same thread (no await in between: a continuation could resume on another thread and leave
    // this one carrying the client token).
    private static string? ReadPeerSid(NamedPipeServerStream pipe)
    {
        if (!ImpersonateNamedPipeClient(pipe.SafePipeHandle)) throw new UnauthorizedAccessException();
        try
        {
            using WindowsIdentity identity = WindowsIdentity.GetCurrent(ifImpersonating: true) ?? throw new UnauthorizedAccessException();
            return identity.User?.Value;
        }
        // An anonymous-level client token makes GetCurrent throw SecurityException; treat it as an unknown peer, not a crash.
        catch (System.Security.SecurityException) { throw new UnauthorizedAccessException(); }
        finally { RevertOrTerminate(); }
    }

    // Fail closed: if the revert fails, throws, or the thread still carries a token afterwards, the process dies here with 71. The caller never
    // sees a return, so no response is written and no decision is made.
    private static void RevertOrTerminate()
    {
        bool reverted;
        try
        {
            reverted = RevertToSelf();
            if (reverted)
            {
                using WindowsIdentity? leaked = WindowsIdentity.GetCurrent(ifImpersonating: true);
                reverted = leaked is null;
            }
        }
        catch (Exception) { reverted = false; }
        if (reverted) return;
        Console.WriteLine("AUTHORITY_FATAL=IMPERSONATION_REVERT_FAILED");
        NotifyServiceTermination(ExitCodes.ImpersonationRevertFailed);
        _ = TerminateProcess(GetCurrentProcess(), ExitCodes.ImpersonationRevertFailed);
        Environment.Exit(ExitCodes.ImpersonationRevertFailed); // only reached if TerminateProcess itself failed
    }

    // The thread that detected the revert failure may still carry the client's token, and SetServiceStatus must run as the service: a new thread
    // starts with the process token. Bounded wait, then the caller terminates the process regardless.
    private static void NotifyServiceTermination(int code)
    {
        Action<int>? notice = ServiceTerminationNotice;
        if (notice is null) return;
        Thread reporter = new(() =>
        {
            try { notice(code); }
            catch (Exception) { /* best effort on the way to TerminateProcess; exit code 71 is the authoritative signal */ }
        }) { IsBackground = true };
        reporter.Start();
        _ = reporter.Join(TimeSpan.FromSeconds(2));
    }

    private static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken token)
    {
        byte[] size = new byte[4];
        await stream.ReadExactlyAsync(size, token);
        int length = BitConverter.ToInt32(size);
        if (length < 1 || length > MaxFrameLength) throw new InvalidDataException();
        byte[] frame = new byte[length];
        await stream.ReadExactlyAsync(frame, token);
        return frame;
    }

    private static async Task WriteFrameAsync(Stream stream, byte[] frame, CancellationToken token)
    {
        await stream.WriteAsync(BitConverter.GetBytes(frame.Length), token);
        await stream.WriteAsync(frame, token);
        await stream.FlushAsync(token);
    }

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DisconnectNamedPipe(SafePipeHandle pipe);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ImpersonateNamedPipeClient(SafePipeHandle pipe);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool RevertToSelf();
}
