using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// The Broker's pipe, created with CreateNamedPipeW so that it carries PIPE_REJECT_REMOTE_CLIENTS (ADR-002, "Pipe creation").
// NamedPipeServerStreamAcl.Create cannot set that flag: .NET builds the pipe mode from the transmission mode only. The VM lab measured the gap on
// 2026-11-01 (issue #23, check u6): a client whose account was on the DACL opened the Broker pipe through \\127.0.0.1 (SMB). With the flag the
// kernel refuses every client that comes through the network redirector, whatever the DACL says.
// Everything else is what the .NET call did: duplex, overlapped, FILE_FLAG_FIRST_PIPE_INSTANCE with at most one instance (an existing pipe of the
// name fails creation), byte mode, default buffer sizes, and the security descriptor of `security` (owner and DACL) applied at creation.
// The same file is copied into src/runtime/windows-approval-authority/ (with a namespace); test/local-pipe-copies.test.mjs keeps the two equal.
internal static class LocalPipe
{
    private const uint PipeAccessDuplex = 0x00000003, FileFlagFirstPipeInstance = 0x00080000, FileFlagOverlapped = 0x40000000;
    private const uint PipeTypeByte = 0x0, PipeReadModeByte = 0x0, PipeWait = 0x0, PipeRejectRemoteClients = 0x00000008;
    internal const uint PipeMode = PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients;
    private const int ErrorAccessDenied = 5;

    /// <summary>Creates the first and only instance of \\.\pipe\<paramref name="pipeName"/>. Throws UnauthorizedAccessException when the name is
    /// taken (or creation is otherwise denied) and IOException carrying the Win32 error in its HResult for every other failure, like the .NET call.</summary>
    internal static NamedPipeServerStream Create(string pipeName, PipeSecurity security)
    {
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try
        {
            SecurityAttributes attributes = new() { Length = Marshal.SizeOf<SecurityAttributes>(), SecurityDescriptor = pinned.AddrOfPinnedObject(), InheritHandle = 0 };
            SafePipeHandle handle = CreateNamedPipeW(@"\\.\pipe\" + pipeName, PipeAccessDuplex | FileFlagFirstPipeInstance | FileFlagOverlapped, PipeMode, 1, 0, 0, 0, ref attributes);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastPInvokeError();
                handle.Dispose();
                if (error == ErrorAccessDenied) throw new UnauthorizedAccessException();
                throw new IOException("pipe creation failed", unchecked((int)0x80070000) | error);
            }
            try { return new NamedPipeServerStream(PipeDirection.InOut, isAsync: true, isConnected: false, handle); }
            catch { handle.Dispose(); throw; }
        }
        finally { pinned.Free(); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Length; public IntPtr SecurityDescriptor; public int InheritHandle; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SecurityAttributes securityAttributes);
}
