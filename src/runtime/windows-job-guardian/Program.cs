using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Albera.WindowsJobGuardian;

internal static class Program
{
    private const int MaxLineBytes = 1024 * 1024;
    private const int MaxArgs = 128;
    private const int MaxArgBytes = 32 * 1024;
    private const int MaxEnvBytes = 256 * 1024;
    private const int MaxInputBytes = 16 * 1024;
    private const int JobDrainTimeoutMs = 3_500;
    private static readonly SemaphoreSlim OutputGate = new(1, 1);

    public static async Task<int> Main()
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false);
        string? line;
        try { line = await Console.In.ReadLineAsync(); }
        catch { return 1; }
        if (line is null || Encoding.UTF8.GetByteCount(line) > MaxLineBytes) return 1;

        LaunchSpec launch;
        try { launch = ParseLaunch(line); }
        catch { await WriteAsync(new { type = "error" }); return 1; }

        JobSession? session = null;
        try
        {
            session = JobSession.Start(launch);
            await WriteAsync(new { type = "started", pid = session.ProcessId });
            return await RunSessionAsync(session);
        }
        catch
        {
            if (session is not null) session.TerminateAndDrain(JobDrainTimeoutMs);
            await WriteAsync(new { type = "error" });
            return 1;
        }
        finally { session?.Dispose(); }
    }

    private static async Task<int> RunSessionAsync(JobSession session)
    {
        using var stopped = new CancellationTokenSource();
        var controls = StartControlReader(session, stopped);

        while (!stopped.IsCancellationRequested)
        {
            if (session.TryGetRootExit(out var code))
            {
                // A provider may exit while leaving background descendants behind. Clean the
                // whole Job before reporting an exit; a zero root exit alone proves nothing.
                var drained = session.ActiveProcesses() == 0 || session.TerminateAndDrain(JobDrainTimeoutMs);
                await WriteAsync(new { type = "exit", code, signal = (string?)null, treeConfirmed = drained });
                stopped.Cancel();
                return drained ? 0 : 1;
            }

            if (controls.IsFaulted || controls.IsCanceled) return 1;
            await Task.Delay(20);
        }

        // EOF is the parent-liveness signal. Closing the last Job handle is a second
        // kernel-enforced cleanup path if orderly termination cannot be observed in time.
        session.TerminateAndDrain(JobDrainTimeoutMs);
        return 0;
    }

    private static Task StartControlReader(JobSession session, CancellationTokenSource stopped)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { ReadControlsAsync(session, stopped).GetAwaiter().GetResult(); completion.TrySetResult(); }
            catch (Exception) { completion.TrySetException(new InvalidOperationException()); }
        }) { IsBackground = true, Name = "AlberaRuntimeControlReader" };
        thread.Start();
        return completion.Task;
    }

    private static async Task ReadControlsAsync(JobSession session, CancellationTokenSource stopped)
    {
        var cancellationToken = stopped.Token;
        while (!cancellationToken.IsCancellationRequested)
        {
            string? line;
            try { line = await Console.In.ReadLineAsync(cancellationToken); }
            catch (OperationCanceledException) { return; }
            catch { session.TerminateAndDrain(JobDrainTimeoutMs); return; }
            if (line is null)
            {
                session.TerminateAndDrain(JobDrainTimeoutMs);
                return;
            }
            if (Encoding.UTF8.GetByteCount(line) > MaxLineBytes)
            {
                session.TerminateAndDrain(JobDrainTimeoutMs);
                return;
            }

            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                var type = GetString(root, "type");
                if (type == "stop")
                {
                    if (!HasOnlyKeys(root, "type", "signal") || !IsAllowedSignal(GetString(root, "signal")))
                    {
                        await WriteAsync(new { type = "error" });
                        continue;
                    }
                    var confirmed = session.TerminateAndDrain(JobDrainTimeoutMs);
                    await WriteAsync(new { type = "tree_stop", treeConfirmed = confirmed });
                    if (confirmed)
                    {
                        session.TryGetRootExit(out var code);
                        await WriteAsync(new { type = "exit", code, signal = (string?)"SIGKILL", treeConfirmed = true });
                        stopped.Cancel();
                        return;
                    }
                }
                else if (type == "input")
                {
                    if (!HasOnlyKeys(root, "type", "requestId", "text")
                        || !Regex.IsMatch(GetString(root, "requestId") ?? string.Empty,
                            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                        || GetString(root, "text") is not { Length: > 0 } text
                        || text.Contains('\0') || Encoding.UTF8.GetByteCount(text) > MaxInputBytes)
                    {
                        await WriteAsync(new { type = "error" });
                        continue;
                    }
                    var requestId = GetString(root, "requestId")!;
                    var accepted = session.WriteInput(text);
                    await WriteAsync(new { type = accepted ? "input_accepted" : "input_rejected", requestId });
                }
                else
                {
                    await WriteAsync(new { type = "error" });
                    session.TerminateAndDrain(JobDrainTimeoutMs);
                    return;
                }
            }
            catch
            {
                await WriteAsync(new { type = "error" });
                session.TerminateAndDrain(JobDrainTimeoutMs);
                return;
            }
        }
    }

    private static LaunchSpec ParseLaunch(string line)
    {
        using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 12 });
        var root = document.RootElement;
        if (!HasOnlyKeys(root, "type", "executable", "args", "cwd", "env", "inputMode", "initialInput")
            || GetString(root, "type") != "launch") throw new InvalidDataException();
        var executable = GetString(root, "executable");
        var cwd = GetString(root, "cwd");
        if (string.IsNullOrWhiteSpace(executable) || !Path.IsPathFullyQualified(executable) || executable.Contains('\0')
            || string.IsNullOrWhiteSpace(cwd) || !Path.IsPathFullyQualified(cwd) || cwd.Contains('\0')
            || !File.Exists(executable) || !Directory.Exists(cwd)) throw new InvalidDataException();

        var argsElement = root.GetProperty("args");
        if (argsElement.ValueKind != JsonValueKind.Array || argsElement.GetArrayLength() > MaxArgs) throw new InvalidDataException();
        var args = argsElement.EnumerateArray().Select(item => item.GetString() ?? throw new InvalidDataException()).ToArray();
        if (args.Any(arg => arg.Contains('\0')) || args.Sum(Encoding.UTF8.GetByteCount) > MaxArgBytes) throw new InvalidDataException();

        var envElement = root.GetProperty("env");
        if (envElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in envElement.EnumerateObject())
        {
            if (!Regex.IsMatch(property.Name, "^[A-Za-z_][A-Za-z0-9_]{0,127}$", RegexOptions.CultureInvariant)
                || property.Value.ValueKind != JsonValueKind.String) throw new InvalidDataException();
            var value = property.Value.GetString()!;
            if (value.Contains('\0') || !env.TryAdd(property.Name, value)) throw new InvalidDataException();
        }
        if (Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(env)) > MaxEnvBytes) throw new InvalidDataException();

        string? inputMode = null;
        string? initialInput = null;
        if (root.TryGetProperty("inputMode", out var modeElement))
        {
            inputMode = modeElement.GetString();
            initialInput = GetString(root, "initialInput");
            if (inputMode != "claude-stream-json" || string.IsNullOrEmpty(initialInput)
                || initialInput.Contains('\0') || Encoding.UTF8.GetByteCount(initialInput) > MaxInputBytes)
                throw new InvalidDataException();
        }
        else if (root.TryGetProperty("initialInput", out _)) throw new InvalidDataException();

        return new LaunchSpec(executable, args, cwd, env, inputMode, initialInput);
    }

    private static bool HasOnlyKeys(JsonElement element, params string[] allowed)
    {
        if (element.ValueKind != JsonValueKind.Object) return false;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            if (!allowed.Contains(property.Name, StringComparer.Ordinal) || !seen.Add(property.Name)) return false;
        }
        return true;
    }

    private static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool IsAllowedSignal(string? signal) =>
        signal is "SIGINT" or "SIGTERM" or "SIGKILL" or "SIGHUP" or "SIGQUIT" or "SIGABRT";

    private static async Task WriteAsync(object message)
    {
        await OutputGate.WaitAsync();
        try
        {
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(message));
            await Console.Out.FlushAsync();
        }
        catch { }
        finally { OutputGate.Release(); }
    }

    private sealed record LaunchSpec(string Executable, string[] Args, string Cwd,
        Dictionary<string, string> Environment, string? InputMode, string? InitialInput);

    private sealed class JobSession : IDisposable
    {
        private IntPtr _job;
        private IntPtr _process;
        private IntPtr _thread;
        private IntPtr _providerInput;
        private bool _inputEnabled;
        private bool _rootExitRead;
        private uint? _rootExitCode;

        public int ProcessId { get; private init; }

        public static JobSession Start(LaunchSpec launch)
        {
            var job = Native.CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException();
            try
            {
                var limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref limits,
                    (uint)Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())) throw new InvalidOperationException();

                var created = CreateSuspended(launch);
                try
                {
                    if (!Native.AssignProcessToJobObject(job, created.Process)) throw new InvalidOperationException();
                    if (Native.ResumeThread(created.Thread) == uint.MaxValue) throw new InvalidOperationException();
                    var session = new JobSession
                    {
                        _job = job,
                        _process = created.Process,
                        _thread = created.Thread,
                        _providerInput = created.ParentInput,
                        _inputEnabled = launch.InputMode == "claude-stream-json",
                        ProcessId = checked((int)created.ProcessId),
                    };
                    job = IntPtr.Zero;
                    if (launch.InitialInput is not null && !session.WriteInput(launch.InitialInput)) throw new InvalidOperationException();
                    return session;
                }
                catch
                {
                    Native.TerminateProcess(created.Process, 1);
                    Native.WaitForSingleObject(created.Process, 5000);
                    Native.CloseHandle(created.Thread);
                    Native.CloseHandle(created.Process);
                    if (created.ParentInput != IntPtr.Zero) Native.CloseHandle(created.ParentInput);
                    throw;
                }
            }
            finally { if (job != IntPtr.Zero) Native.CloseHandle(job); }
        }

        public bool WriteInput(string text)
        {
            if (!_inputEnabled || _providerInput == IntPtr.Zero || text.Length == 0 || text.Contains('\0')
                || Encoding.UTF8.GetByteCount(text) > MaxInputBytes) return false;
            var json = JsonSerializer.Serialize(new { type = "user", message = new { role = "user", content = text }, parent_tool_use_id = (string?)null }) + "\n";
            var bytes = Encoding.UTF8.GetBytes(json);
            return Native.WriteFile(_providerInput, bytes, (uint)bytes.Length, out var written, IntPtr.Zero) && written == bytes.Length;
        }

        public bool TryGetRootExit(out int? code)
        {
            code = null;
            if (_rootExitRead || _process == IntPtr.Zero) return false;
            var wait = Native.WaitForSingleObject(_process, 0);
            if (wait != Native.WAIT_OBJECT_0)
            {
                if (!Native.GetExitCodeProcess(_process, out var observedCode) || observedCode == Native.STILL_ACTIVE) return false;
            }
            _rootExitRead = true;
            if (Native.GetExitCodeProcess(_process, out var exitCode)) _rootExitCode = exitCode;
            code = _rootExitCode is { } value && value <= int.MaxValue ? (int)value : null;
            CloseProcessHandles();
            return true;
        }

        public uint ActiveProcesses()
        {
            if (_job == IntPtr.Zero || !Native.QueryInformationJobObject(_job, Native.JobObjectBasicAccountingInformation,
                out var info, (uint)Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), out _))
                return uint.MaxValue;
            return info.ActiveProcesses;
        }

        public bool TerminateAndDrain(int timeoutMs)
        {
            if (_job == IntPtr.Zero) return false;
            var active = ActiveProcesses();
            if (active == uint.MaxValue) return false;
            if (active == 0) return true;
            if (!Native.TerminateJobObject(_job, 1)) return false;
            var timer = Stopwatch.StartNew();
            while (timer.ElapsedMilliseconds < timeoutMs)
            {
                active = ActiveProcesses();
                if (active == 0) return true;
                if (active == uint.MaxValue) return false;
                Thread.Sleep(20);
            }
            return false;
        }

        private void CloseProcessHandles()
        {
            if (_thread != IntPtr.Zero) { Native.CloseHandle(_thread); _thread = IntPtr.Zero; }
            if (_process != IntPtr.Zero) { Native.CloseHandle(_process); _process = IntPtr.Zero; }
            if (_providerInput != IntPtr.Zero) { Native.CloseHandle(_providerInput); _providerInput = IntPtr.Zero; }
        }

        public void Dispose()
        {
            CloseProcessHandles();
            if (_job != IntPtr.Zero) { Native.CloseHandle(_job); _job = IntPtr.Zero; }
        }

        private static (IntPtr Process, IntPtr Thread, IntPtr ParentInput, uint ProcessId) CreateSuspended(LaunchSpec launch)
        {
            var security = new Native.SECURITY_ATTRIBUTES { Length = Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), InheritHandle = true };
            IntPtr childInput;
            IntPtr parentInput = IntPtr.Zero;
            IntPtr nullDevice = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            try
            {
                nullDevice = Native.CreateFileW("NUL", Native.GENERIC_READ | Native.GENERIC_WRITE,
                    Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, ref security, Native.OPEN_EXISTING, 0, IntPtr.Zero);
                if (nullDevice == Native.INVALID_HANDLE_VALUE) throw new InvalidOperationException();
                if (launch.InputMode == "claude-stream-json")
                {
                    if (!Native.CreatePipe(out childInput, out parentInput, ref security, 0)) throw new InvalidOperationException();
                    Native.SetHandleInformation(parentInput, Native.HANDLE_FLAG_INHERIT, 0);
                }
                else childInput = nullDevice;

                var needed = IntPtr.Zero;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref needed);
                attributeList = Marshal.AllocHGlobal(needed);
                if (!Native.InitializeProcThreadAttributeList(attributeList, 1, 0, ref needed)) throw new InvalidOperationException();
                var separateInputHandle = childInput != nullDevice;
                handleList = Marshal.AllocHGlobal(IntPtr.Size * (separateInputHandle ? 2 : 1));
                Marshal.WriteIntPtr(handleList, 0, childInput);
                if (separateInputHandle) Marshal.WriteIntPtr(handleList, IntPtr.Size, nullDevice);
                var count = IntPtr.Size * (separateInputHandle ? 2 : 1);
                if (!Native.UpdateProcThreadAttribute(attributeList, 0, Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    handleList, (IntPtr)count, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException();

                var startup = new Native.STARTUPINFOEX
                {
                    StartupInfo = new Native.STARTUPINFO
                    {
                        cb = Marshal.SizeOf<Native.STARTUPINFOEX>(),
                        dwFlags = Native.STARTF_USESTDHANDLES,
                        hStdInput = childInput,
                        hStdOutput = nullDevice,
                        hStdError = nullDevice,
                    },
                    lpAttributeList = attributeList,
                };
                var commandLine = new StringBuilder(string.Join(" ", new[] { launch.Executable }.Concat(launch.Args).Select(QuoteArgument)));
                var envBlock = BuildEnvironmentBlock(launch.Environment);
                environment = Marshal.StringToHGlobalUni(envBlock);
                var flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW | Native.EXTENDED_STARTUPINFO_PRESENT;
                if (!Native.CreateProcessW(launch.Executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags,
                    environment, launch.Cwd, ref startup, out var info)) throw new InvalidOperationException();
                Native.CloseHandle(nullDevice);
                nullDevice = IntPtr.Zero;
                return (info.hProcess, info.hThread, parentInput, info.dwProcessId);
            }
            catch
            {
                if (parentInput != IntPtr.Zero) Native.CloseHandle(parentInput);
                if (nullDevice != IntPtr.Zero && nullDevice != Native.INVALID_HANDLE_VALUE) Native.CloseHandle(nullDevice);
                throw;
            }
            finally
            {
                if (attributeList != IntPtr.Zero) { Native.DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            }
        }

        private static string BuildEnvironmentBlock(Dictionary<string, string> environment)
        {
            var entries = environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => $"{pair.Key}={pair.Value}");
            return string.Join('\0', entries) + "\0\0";
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length > 0 && !value.Any(char.IsWhiteSpace) && !value.Contains('"')) return value;
            var result = new StringBuilder("\"");
            var slashes = 0;
            foreach (var character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                {
                    result.Append('\\', slashes * 2 + 1).Append('"');
                    slashes = 0;
                    continue;
                }
                result.Append('\\', slashes).Append(character);
                slashes = 0;
            }
            result.Append('\\', slashes * 2).Append('"');
            return result.ToString();
        }
    }

    private static class Native
    {
        internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        internal const uint CREATE_SUSPENDED = 0x00000004;
        internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        internal const uint CREATE_NO_WINDOW = 0x08000000;
        internal const uint STARTF_USESTDHANDLES = 0x00000100;
        internal const uint HANDLE_FLAG_INHERIT = 0x00000001;
        internal const uint GENERIC_READ = 0x80000000;
        internal const uint GENERIC_WRITE = 0x40000000;
        internal const uint FILE_SHARE_READ = 0x00000001;
        internal const uint FILE_SHARE_WRITE = 0x00000002;
        internal const uint OPEN_EXISTING = 3;
        internal const uint WAIT_OBJECT_0 = 0;
        internal const uint STILL_ACTIVE = 259;
        internal static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);
        internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
        internal const int JobObjectExtendedLimitInformation = 9;
        internal const int JobObjectBasicAccountingInformation = 1;

        [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { public int Length; public IntPtr SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO { public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
        [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WriteFile(IntPtr file, byte[] buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    }
}
