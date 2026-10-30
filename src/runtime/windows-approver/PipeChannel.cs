using System.Buffers.Binary;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Albera.Approver;

// The approver's side of <pipeRoot>\approver\v1 (frames: 4-byte little-endian length 1..2048, then UTF-8 JSON; one request, one reply, then the connection ends).
// Order, copied from the Broker's trusted pipe client: open with SQOS IDENTIFICATION (the server can learn who we are but cannot act as us) -> verify the server on
// the CONNECTED handle (owner SID, server PID, session 0 in service mode) -> only then write a single byte. Everything before the write is a pre-send code.
internal sealed class PipeChannel(ServerExpectation expectation, int timeoutMs) : IApproverChannel
{
    public const int DefaultTimeoutMs = 10_000, MaxFrameBytes = 2048;
    private const int BusyRetryMs = 50;
    // Specific rights, never GENERIC_WRITE (its FILE_APPEND_DATA bit is FILE_CREATE_PIPE_INSTANCE on a pipe): the approver ACE is 0x00120083.
    private const uint ClientAccess = 0x1 /*FILE_READ_DATA*/ | 0x2 /*FILE_WRITE_DATA*/ | 0x80 /*FILE_READ_ATTRIBUTES*/ | 0x20000 /*READ_CONTROL*/ | 0x100000 /*SYNCHRONIZE*/;
    private const uint OpenExisting = 3, FlagOverlapped = 0x40000000, SecuritySqosPresent = 0x00100000, SecurityIdentification = 0x00010000;
    private const int ErrorAccessDenied = 5, ErrorPipeBusy = 231;

    public async Task<string> CallAsync(string requestJson)
    {
        byte[] body = Encoding.UTF8.GetBytes(requestJson);
        if (body.Length is < 1 or > MaxFrameBytes) throw new ChannelException(ChannelCodes.RequestTooLarge, sent: false);
        using CancellationTokenSource limit = new(timeoutMs);
        using NamedPipeClientStream pipe = await ConnectAsync(limit.Token);
        VerifyServer(pipe);
        return await ExchangeAsync(pipe, body, limit.Token);
    }

    private async Task<NamedPipeClientStream> ConnectAsync(CancellationToken token)
    {
        while (true)
        {
            IntPtr raw = CreateFileW(@"\\.\pipe\" + expectation.ApproverPipe, ClientAccess, 0, IntPtr.Zero, OpenExisting, FlagOverlapped | SecuritySqosPresent | SecurityIdentification, IntPtr.Zero);
            if (raw != new IntPtr(-1)) return new NamedPipeClientStream(PipeDirection.InOut, isAsync: true, isConnected: true, new SafePipeHandle(raw, true));
            int error = Marshal.GetLastWin32Error();
            if (error == ErrorAccessDenied) throw new ChannelException(ChannelCodes.AccessDenied, sent: false);
            if (error != ErrorPipeBusy) throw new ChannelException(ChannelCodes.AuthorityUnreachable, sent: false);
            try { await Task.Delay(BusyRetryMs, token); } // the Authority serves one connection at a time: wait for our turn
            catch (OperationCanceledException) { throw new ChannelException(ChannelCodes.AuthorityUnreachable, sent: false); }
        }
    }

    // Identity of the server, on the connected handle, BEFORE a single byte is written.
    private void VerifyServer(NamedPipeClientStream pipe)
    {
        try
        {
            ResolvedServer expected = expectation.Resolve();
            if (pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || !owner.Equals(expected.Owner)) throw Mismatch();
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint serverPid)) throw new Win32Exception();
            if (serverPid != expected.Pid) throw Mismatch();
            if (expected.RequireSessionZero && (!GetNamedPipeServerSessionId(pipe.SafePipeHandle, out uint session) || session != 0)) throw Mismatch();
        }
        catch (Exception ex) when (ex is not ChannelException)
        {
            throw new ChannelException(ChannelCodes.ServerIdentityUnavailable, sent: false);
        }
    }

    private static ChannelException Mismatch() => new(ChannelCodes.ServerIdentityMismatch, sent: false);

    private static async Task<string> ExchangeAsync(NamedPipeClientStream pipe, byte[] body, CancellationToken token)
    {
        try
        {
            byte[] frame = new byte[4 + body.Length];
            BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
            body.CopyTo(frame, 4);
            await pipe.WriteAsync(frame, token); // from the first write on, the outcome is unknown even if it throws
            await pipe.FlushAsync(token);

            byte[] header = new byte[4];
            if (!await ReadFullAsync(pipe, header, token)) throw new ChannelException(ChannelCodes.InvalidResponse, sent: true);
            int length = BinaryPrimitives.ReadInt32LittleEndian(header);
            if (length > MaxFrameBytes) throw new ChannelException(ChannelCodes.ResponseTooLarge, sent: true);
            byte[] reply = new byte[Math.Max(length, 0)];
            if (length < 1 || !await ReadFullAsync(pipe, reply, token) || await pipe.ReadAsync(new byte[1], token) != 0) throw new ChannelException(ChannelCodes.InvalidResponse, sent: true);
            return new UTF8Encoding(false, true).GetString(reply);
        }
        catch (OperationCanceledException) { throw new ChannelException(ChannelCodes.Timeout, sent: true); }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or DecoderFallbackException) { throw new ChannelException(ChannelCodes.TransportError, sent: true); }
    }

    private static async Task<bool> ReadFullAsync(Stream stream, byte[] buffer, CancellationToken token)
    {
        for (int used = 0; used < buffer.Length;)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(used), token);
            if (read == 0) return false;
            used += read;
        }
        return true;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint session);
}
