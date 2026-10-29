using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const uint PipeAccessDuplex = 0x00000003;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint PipeTypeByte = 0x00000000;
    private const uint PipeReadModeByte = 0x00000000;
    private const uint PipeWait = 0x00000000;
    private const uint PipeRejectRemoteClients = 0x00000008;
    private const uint FileReadDataWriteDataSynchronize = 0x00100083;
    private const uint OpenExisting = 3;
    private const uint SecurityDescriptorRevision = 1;
    private const uint SddlRevision1 = 1;
    private const uint SeKernelObject = 6;
    private const uint DaclSecurityInformation = 0x00000004;
    private const ushort SeDaclProtected = 0x1000;
    private const byte AccessAllowedAceType = 0;
    private const int MaxFrameLength = 2048;
    private const uint MaxPipeInstances = 2;

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 0 || args[0] == "run")
        {
            return await RunProbeAsync();
        }

        return args[0] switch
        {
            "server" => await RunServerAsync(args),
            "client" => RunClient(args),
            "squat" => await RunSquatterAsync(args),
            _ => 64
        };
    }

    private static async Task<int> RunProbeAsync()
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        string currentSid = identity.User?.Value ?? throw new InvalidOperationException("Current Windows SID is unavailable.");
        string pipeName = $"ALBERA_Issue21_{Guid.NewGuid():N}";
        using (Process server = StartChild("server", pipeName, currentSid, "first"))
        {
            try
            {
                string prefix = await ReadUntilReadyAsync(server, TimeSpan.FromSeconds(10));
                Console.WriteLine("SERVER=READY");

                string allowed = await RunClientChildAsync(pipeName, "{\"version\":1,\"action\":\"ping\"}");
                Require(allowed == "{\"ok\":true,\"action\":\"pong\"}", $"Allowed request failed: {allowed}");
                Console.WriteLine("ALLOWED_CLIENT=" + allowed);
                string serverOutput = await FinishChildAsync(server, TimeSpan.FromSeconds(10), prefix);
                Console.Write(serverOutput);
                Require(serverOutput.Contains("AUTHENTICATED_SID_MATCH=true", StringComparison.Ordinal), "Server did not authenticate the peer from its OS impersonation token.");
                Require(serverOutput.Contains("DACL_PROTECTED=true", StringComparison.Ordinal), "OS pipe DACL was not verified as protected.");
                Require(serverOutput.Contains("DACL_ALLOW_SID_MATCH=true;MASK=0x00100083", StringComparison.Ordinal), "OS pipe DACL does not contain only the expected data/read-attributes/synchronize SID ACE.");
                Require(serverOutput.Contains("DACL_ACE_COUNT=1", StringComparison.Ordinal), "OS pipe DACL contains an unexpected ACE count.");
            }
            finally
            {
                KillChild(server);
            }
        }

        pipeName = $"ALBERA_Issue21_{Guid.NewGuid():N}";
        using (Process server = StartChild("server", pipeName, currentSid, "first"))
        {
            try
            {
                string prefix = await ReadUntilReadyAsync(server, TimeSpan.FromSeconds(10));
                string spoof = await RunClientChildAsync(pipeName, "{\"version\":1,\"action\":\"ping\",\"sid\":\"S-1-5-18\",\"pid\":4,\"error\":\"SYNTHETIC_SECRET_MARKER\"}");
                Require(spoof == "{\"ok\":false,\"code\":\"invalid_request\"}", $"Spoof/malformed request was not rejected with a fixed response: {spoof}");
                Console.WriteLine("SPOOF_RESPONSE=" + spoof);
                string serverOutput = await FinishChildAsync(server, TimeSpan.FromSeconds(10), prefix);
                Console.Write(serverOutput);
                Require(!serverOutput.Contains("SYNTHETIC_SECRET_MARKER", StringComparison.Ordinal), "Injected error marker leaked into server output.");
                Require(!serverOutput.Contains("S-1-5-18", StringComparison.Ordinal), "Claimed identity was accepted or logged.");
            }
            finally
            {
                KillChild(server);
            }
        }

        pipeName = $"ALBERA_Issue21_{Guid.NewGuid():N}";
        using (Process squatter = StartChild("squat", pipeName, currentSid))
        {
            try
            {
                string ready = await ReadLineWithTimeoutAsync(squatter, TimeSpan.FromSeconds(10));
                Require(ready == "SQUAT_READY", $"Squatter failed to create the temporary pipe: {ready}");
                using Process firstInstanceServer = StartChild("server", pipeName, currentSid, "first");
                try
                {
                    await firstInstanceServer.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                    int exitCode = firstInstanceServer.ExitCode;
                    string output = await firstInstanceServer.StandardOutput.ReadToEndAsync();
                    string error = await firstInstanceServer.StandardError.ReadToEndAsync();
                    Require(exitCode == 20, $"First-instance server should fail closed when the pipe name is occupied; exit={exitCode}, output={output}, error={error}");
                    Require(output.Contains("FIRST_INSTANCE_REJECTED=true", StringComparison.Ordinal), "Server did not report first-instance rejection.");
                    Console.Write(output);
                    Console.WriteLine("PIPE_SQUAT_FAIL_CLOSED=true");
                }
                finally
                {
                    KillChild(firstInstanceServer);
                }
            }
            finally
            {
                KillChild(squatter);
            }
        }

        using (SafePipeHandle recreated = CreatePipe(pipeName, currentSid, firstInstance: true))
        {
            Require(!recreated.IsInvalid, "The temporary pipe name was not released after disposable children exited.");
            Console.WriteLine("PIPE_CLEANUP=true");
        }

        Console.WriteLine("CROSS_ACCOUNT_TEST=BLOCKED (no separate non-privileged Windows identity is provisioned)");
        Console.WriteLine("SERVICE_SID_TEST=BLOCKED (service registration is outside the approved scope)");
        Console.WriteLine("RESULT=PASS same-user ephemeral DACL/token/spoof/pipe-squat checks; cross-account and service proofs remain blocked");
        return 0;
    }

    private static async Task<int> RunServerAsync(string[] args)
    {
        string pipeName = args[1];
        string allowedSid = args[2];
        bool firstInstance = args.Length < 4 || args[3] == "first";
        SafePipeHandle handle;
        try
        {
            handle = CreatePipe(pipeName, allowedSid, firstInstance);
        }
        catch (Win32ExceptionWithCode ex) when (firstInstance && ex.ErrorCode == 5)
        {
            Console.WriteLine("FIRST_INSTANCE_REJECTED=true");
            Console.WriteLine($"START_FAILED=pipe_name_in_use_win32_{ex.ErrorCode}");
            return 20;
        }
        catch (Win32ExceptionWithCode ex)
        {
            Console.WriteLine($"START_FAILED=win32_{ex.ErrorCode}");
            return 21;
        }

        using (handle)
        {
            PipeDaclEvidence dacl = InspectPipeDacl(handle);
            Console.WriteLine($"DACL_PROTECTED={dacl.Protected.ToString().ToLowerInvariant()}");
            Console.WriteLine($"DACL_ACE_COUNT={dacl.AceCount}");
            foreach (string ace in dacl.AllowedSids)
            {
                string[] parts = ace.Split(';', 2);
                Console.WriteLine($"DACL_ALLOW_SID_MATCH={string.Equals(parts[0], allowedSid, StringComparison.Ordinal).ToString().ToLowerInvariant()};{parts.ElementAtOrDefault(1)}");
            }

            Console.WriteLine("READY");
            if (!ConnectNamedPipe(handle, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != 535) // ERROR_PIPE_CONNECTED
                {
                    Console.Error.WriteLine($"CONNECT_FAILED=win32_{error}");
                    return 22;
                }
            }

            using var server = new NamedPipeServerStream(PipeDirection.InOut, isAsync: false, isConnected: true, handle);

            using var writer = new BinaryWriter(server, Encoding.UTF8, leaveOpen: true);
            using var reader = new BinaryReader(server, Encoding.UTF8, leaveOpen: true);
            try
            {
                int length = reader.ReadInt32();
                if (length < 1 || length > MaxFrameLength)
                {
                    throw new InvalidDataException("frame_length");
                }

                byte[] frame = reader.ReadBytes(length);
                if (frame.Length != length)
                {
                    throw new InvalidDataException("truncated_frame");
                }

                string peerSid = ReadClientSid(server);
            Console.WriteLine($"AUTHENTICATED_SID_MATCH={string.Equals(peerSid, allowedSid, StringComparison.Ordinal).ToString().ToLowerInvariant()}");
                string response = string.Equals(peerSid, allowedSid, StringComparison.Ordinal)
                    ? ParseFixedRequest(frame)
                    : "{\"ok\":false,\"code\":\"unauthorized\"}";
                byte[] responseBytes = Encoding.UTF8.GetBytes(response);
                writer.Write(responseBytes.Length);
                writer.Write(responseBytes);
                writer.Flush();
            }
            catch (Exception ex) when (ex is InvalidDataException or JsonException or FormatException or OverflowException or IOException or UnauthorizedAccessException)
            {
                byte[] responseBytes = Encoding.UTF8.GetBytes("{\"ok\":false,\"code\":\"invalid_request\"}");
                writer.Write(responseBytes.Length);
                writer.Write(responseBytes);
                writer.Flush();
                Console.WriteLine("REQUEST_REJECTED=invalid_request");
            }
        }

        return 0;
    }

    private static string ParseFixedRequest(byte[] frame)
    {
        using JsonDocument document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 4 });
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
            !root.TryGetProperty("version", out JsonElement version) || version.ValueKind != JsonValueKind.Number || version.GetInt32() != 1 ||
            !root.TryGetProperty("action", out JsonElement action) || action.ValueKind != JsonValueKind.String || action.GetString() != "ping")
        {
            return "{\"ok\":false,\"code\":\"invalid_request\"}";
        }

        return "{\"ok\":true,\"action\":\"pong\"}";
    }

    private static string ReadClientSid(NamedPipeServerStream server)
    {
        string? sid = null;
        server.RunAsClient(() =>
        {
            using WindowsIdentity client = WindowsIdentity.GetCurrent(ifImpersonating: true) ?? throw new UnauthorizedAccessException("client_token_unavailable");
            sid = client.User?.Value;
        });

        if (string.IsNullOrWhiteSpace(sid))
        {
            throw new UnauthorizedAccessException("client_token_unavailable");
        }

        return sid;
    }

    private static int RunClient(string[] args)
    {
        string pipeName = args[1];
        byte[] request = Convert.FromBase64String(args[2]);
        IntPtr rawHandle = CreateFile($"\\\\.\\pipe\\{pipeName}", FileReadDataWriteDataSynchronize, 0, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        if (rawHandle == new IntPtr(-1))
        {
            throw new Win32ExceptionWithCode(Marshal.GetLastWin32Error());
        }

        using var handle = new SafePipeHandle(rawHandle, ownsHandle: true);
        using var client = new NamedPipeClientStream(PipeDirection.InOut, isAsync: false, isConnected: true, handle);
        using var writer = new BinaryWriter(client, Encoding.UTF8, leaveOpen: true);
        using var reader = new BinaryReader(client, Encoding.UTF8, leaveOpen: true);
        writer.Write(request.Length);
        writer.Write(request);
        writer.Flush();
        int length = reader.ReadInt32();
        if (length < 1 || length > MaxFrameLength)
        {
            return 30;
        }

        byte[] response = reader.ReadBytes(length);
        Console.WriteLine(Encoding.UTF8.GetString(response));
        return 0;
    }

    private static async Task<int> RunSquatterAsync(string[] args)
    {
        SafePipeHandle handle = CreatePipe(args[1], args[2], firstInstance: false);
        using (handle)
        {
            Console.WriteLine("SQUAT_READY");
            await Task.Delay(Timeout.InfiniteTimeSpan);
            return 0;
        }
    }

    private static SafePipeHandle CreatePipe(string pipeName, string allowedSid, bool firstInstance)
    {
        if (pipeName.Length is < 1 or > 240 || pipeName.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '_'))
        {
            throw new ArgumentException("Invalid pipe name.", nameof(pipeName));
        }

        string sddl = $"D:P(A;;0x00100083;;;{allowedSid})";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, SddlRevision1, out IntPtr descriptor, out _))
        {
            throw new Win32ExceptionWithCode(Marshal.GetLastWin32Error());
        }

        try
        {
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                SecurityDescriptor = descriptor,
                InheritHandle = false
            };
            uint openMode = PipeAccessDuplex | (firstInstance ? FileFlagFirstPipeInstance : 0);
            uint pipeMode = PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients;
            IntPtr rawHandle = CreateNamedPipe($"\\\\.\\pipe\\{pipeName}", openMode, pipeMode, MaxPipeInstances, MaxFrameLength, MaxFrameLength, 0, ref attributes);
            if (rawHandle == new IntPtr(-1))
            {
                throw new Win32ExceptionWithCode(Marshal.GetLastWin32Error());
            }

            return new SafePipeHandle(rawHandle, ownsHandle: true);
        }
        finally
        {
            _ = LocalFree(descriptor);
        }
    }

    private static PipeDaclEvidence InspectPipeDacl(SafePipeHandle pipe)
    {
        uint result = GetSecurityInfo(pipe, SeKernelObject, DaclSecurityInformation, IntPtr.Zero, IntPtr.Zero, out IntPtr dacl, IntPtr.Zero, out IntPtr descriptor);
        if (result != 0)
        {
            throw new InvalidOperationException($"GetSecurityInfo failed with Win32 error {result}.");
        }

        try
        {
            var securityDescriptor = Marshal.PtrToStructure<SecurityDescriptor>(descriptor);
            var acl = Marshal.PtrToStructure<AclHeader>(dacl);
            var allowedSids = new List<string>();
            for (uint index = 0; index < acl.AceCount; index++)
            {
                if (!GetAce(dacl, index, out IntPtr ace))
                {
                    throw new InvalidOperationException("GetAce failed.");
                }

                var header = Marshal.PtrToStructure<AceHeader>(ace);
                if (header.AceType == AccessAllowedAceType)
                {
                    IntPtr sid = IntPtr.Add(ace, 8);
                    if (!ConvertSidToStringSid(sid, out IntPtr sidText))
                    {
                        throw new Win32ExceptionWithCode(Marshal.GetLastWin32Error());
                    }

                    try
                    {
                        uint mask = unchecked((uint)Marshal.ReadInt32(ace, 4));
                        allowedSids.Add($"{Marshal.PtrToStringUni(sidText) ?? ""};MASK=0x{mask:X8}");
                    }
                    finally
                    {
                        _ = LocalFree(sidText);
                    }
                }
            }

        return new PipeDaclEvidence((securityDescriptor.Control & SeDaclProtected) != 0, acl.AceCount, allowedSids);
        }
        finally
        {
            _ = LocalFree(descriptor);
        }
    }

    private static Process StartChild(params string[] args)
    {
        string assembly = Assembly.GetExecutingAssembly().Location;
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        start.ArgumentList.Add(assembly);
        foreach (string arg in args)
        {
            start.ArgumentList.Add(arg);
        }

        Process process = Process.Start(start) ?? throw new InvalidOperationException("Could not start disposable child process.");
        return process;
    }

    private static async Task<string> RunClientChildAsync(string pipeName, string request)
    {
        using Process client = StartChild("client", pipeName, Convert.ToBase64String(Encoding.UTF8.GetBytes(request)));
        try
        {
            Task<string> errorTask = client.StandardError.ReadToEndAsync();
            string? output = await client.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
            await client.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            string error = await errorTask;
            Require(client.ExitCode == 0 && output is not null, $"Client failed with exit code {client.ExitCode}; stderr={error}");
            return output!;
        }
        finally
        {
            KillChild(client);
        }
    }

    private static async Task<string> ReadLineWithTimeoutAsync(Process process, TimeSpan timeout)
    {
        string? line = await process.StandardOutput.ReadLineAsync().WaitAsync(timeout);
        if (line is not null) return line;
        if (process.HasExited)
        {
            string error = await process.StandardError.ReadToEndAsync();
            return "<closed> " + error;
        }

        return "<closed>";
    }

    private static async Task<string> ReadUntilReadyAsync(Process process, TimeSpan timeout)
    {
        var lines = new List<string>();
        while (true)
        {
            string line = await ReadLineWithTimeoutAsync(process, timeout);
            lines.Add(line);
            if (line == "READY") return string.Join(Environment.NewLine, lines) + Environment.NewLine;
            if (line == "<closed>") throw new InvalidOperationException("Server closed before signaling readiness: " + string.Join(" | ", lines));
        }
    }

    private static async Task<string> FinishChildAsync(Process process, TimeSpan timeout, string prefix)
    {
        await process.WaitForExitAsync().WaitAsync(timeout);
        string remainder = prefix + await process.StandardOutput.ReadToEndAsync();
        Require(process.ExitCode == 0, $"Server failed with exit code {process.ExitCode}: {remainder}");
        return remainder;
    }

    private static void KillChild(Process process)
    {
        if (!process.HasExited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(5000);
        }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateNamedPipeW")]
    private static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SecurityAttributes securityAttributes);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "ConnectNamedPipe")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConnectNamedPipe(SafePipeHandle pipe, IntPtr overlapped);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern IntPtr CreateFile(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string stringSecurityDescriptor, uint stringSdRevision, out IntPtr securityDescriptor, out uint securityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(SafePipeHandle handle, uint objectType, uint securityInfo, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetAce(IntPtr acl, uint aceIndex, out IntPtr ace);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertSidToStringSidW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityDescriptor
    {
        public byte Revision;
        public byte Sbz1;
        public ushort Control;
        public IntPtr Owner;
        public IntPtr Group;
        public IntPtr Sacl;
        public IntPtr Dacl;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AclHeader
    {
        public byte AclRevision;
        public byte Sbz1;
        public ushort AclSize;
        public ushort AceCount;
        public ushort Sbz2;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AceHeader
    {
        public byte AceType;
        public byte AceFlags;
        public ushort AceSize;
    }

    private sealed record PipeDaclEvidence(bool Protected, ushort AceCount, List<string> AllowedSids);

    private sealed class Win32ExceptionWithCode(int errorCode) : Exception($"Win32 error {errorCode}")
    {
        public int ErrorCode { get; } = errorCode;
    }
}
