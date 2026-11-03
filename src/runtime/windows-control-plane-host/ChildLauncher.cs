using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// One Job object, and the one way the host starts node.
//
// Launch contract (the argument list is part of the contract with the `room-service` command, which a later PR adds to src/runtime/entry.mjs):
//   <nodePath> <appPath>\src\runtime\entry.mjs room-service --data-root <dataRoot>
//   current directory: appPath; standard input: NUL; standard output and error: pipes the host drains into the capped logs; environment: ChildEnvironment.
// The child is created SUSPENDED, put into the Job, and only then resumed, so it cannot start anything before it is inside the Job. Only the three standard
// handles are inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), nothing else the host holds. The Job has KILL_ON_JOB_CLOSE and no breakaway: when the host ends in
// any way, or terminates the Job, node and everything it started (the pipe helper, Claude Code, the MCP server) end with it. The host never kills by name.
internal sealed class ChildJob : IDisposable
{
    private IntPtr handle;

    private ChildJob(IntPtr handle) => this.handle = handle;

    /// <summary>A new Job with KILL_ON_JOB_CLOSE, or null when the system refuses.</summary>
    public static ChildJob? Create()
    {
        IntPtr job = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return null;
        Native.JobExtendedLimit limit = new() { Basic = new Native.JobBasicLimit { LimitFlags = Native.JobObjectLimitKillOnJobClose } };
        int size = Marshal.SizeOf<Native.JobExtendedLimit>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limit, buffer, false);
            if (Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, buffer, size)) return new ChildJob(job);
        }
        finally { Marshal.FreeHGlobal(buffer); }
        Native.CloseHandle(job);
        return null;
    }

    public bool Assign(IntPtr process) => Native.AssignProcessToJobObject(handle, process);

    /// <summary>Ends every process in the Job. Safe to call twice.</summary>
    public void Terminate() => Native.TerminateJobObject(handle, 1);

    public void Dispose()
    {
        if (handle == IntPtr.Zero) return;
        Native.CloseHandle(handle); // KILL_ON_JOB_CLOSE ends whatever is still in the Job
        handle = IntPtr.Zero;
    }
}

internal sealed class LaunchedChild(IntPtr process, int processId, FileStream output, FileStream error) : IDisposable
{
    public IntPtr Process { get; } = process;
    public int ProcessId { get; } = processId;
    public FileStream Output { get; } = output;
    public FileStream Error { get; } = error;

    public bool TryGetExitCode(out int code)
    {
        code = 0;
        if (!Native.GetExitCodeProcess(Process, out uint value) || value == StillActive) return false;
        code = unchecked((int)value);
        return true;
    }

    private const uint StillActive = 259;

    public void Dispose()
    {
        Output.Dispose();
        Error.Dispose();
        Native.CloseHandle(Process);
    }
}

internal static class ChildLauncher
{
    /// <summary>The arguments after the node path, in order. The one place the contract with `entry.mjs room-service` is spelled out.</summary>
    internal static string CommandLine(HostConfig config) => $"\"{config.NodePath}\" \"{config.EntryPath}\" room-service --data-root \"{config.DataRoot}\"";

    /// <summary>Starts node inside `job`. Returns null with the Win32 error when the child could not be created or could not be put into the Job (then it was ended).</summary>
    public static LaunchedChild? Start(HostConfig config, ChildJob job, IReadOnlyDictionary<string, string> environment, out int error)
    {
        error = 0;
        Native.SecurityAttributes inheritable = new() { Length = Marshal.SizeOf<Native.SecurityAttributes>(), InheritHandle = 1 };
        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, nul = Native.InvalidHandle;
        try
        {
            if (!NewPipe(ref inheritable, out outRead, out outWrite) || !NewPipe(ref inheritable, out errRead, out errWrite)) { error = Marshal.GetLastWin32Error(); return null; }
            nul = Native.CreateFileW("NUL", Native.GenericRead, Native.ShareReadWrite, ref inheritable, Native.OpenExisting, 0, IntPtr.Zero);
            if (nul == Native.InvalidHandle) { error = Marshal.GetLastWin32Error(); return null; }
            if (!CreateSuspended(config, environment, nul, outWrite, errWrite, out Native.ProcessInformation created, out error)) return null;
            if (!job.Assign(created.Process))
            {
                error = Marshal.GetLastWin32Error();
                Native.TerminateProcess(created.Process, 1); // our own, still suspended child
                Native.CloseHandle(created.Thread);
                Native.CloseHandle(created.Process);
                return null;
            }
            Native.ResumeThread(created.Thread);
            Native.CloseHandle(created.Thread);
            FileStream output = new(new SafeFileHandle(outRead, true), FileAccess.Read, 1, false), errorStream = new(new SafeFileHandle(errRead, true), FileAccess.Read, 1, false);
            outRead = errRead = IntPtr.Zero; // owned by the streams now
            return new LaunchedChild(created.Process, created.ProcessId, output, errorStream);
        }
        finally
        {
            // The host's copies of the write ends must go: otherwise the pipes never report end of file when the child is gone.
            foreach (IntPtr h in new[] { outWrite, errWrite, nul, outRead, errRead }) if (h != IntPtr.Zero && h != Native.InvalidHandle) Native.CloseHandle(h);
        }
    }

    private static bool NewPipe(ref Native.SecurityAttributes inheritable, out IntPtr read, out IntPtr write)
    {
        if (!Native.CreatePipe(out read, out write, ref inheritable, 0)) return false;
        return Native.SetHandleInformation(read, Native.HandleFlagInherit, 0); // only the write end goes to the child
    }

    private static bool CreateSuspended(HostConfig config, IReadOnlyDictionary<string, string> environment, IntPtr input, IntPtr output, IntPtr errorOut,
        out Native.ProcessInformation created, out int error)
    {
        error = 0;
        created = default;
        IntPtr size = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size); // fails by design and reports the size
        IntPtr attributes = Marshal.AllocHGlobal(size), handles = Marshal.AllocHGlobal(3 * IntPtr.Size), block = Marshal.StringToHGlobalUni(ChildEnvironment.ToBlock(environment));
        bool listReady = false;
        try
        {
            Marshal.WriteIntPtr(handles, 0, input);
            Marshal.WriteIntPtr(handles, IntPtr.Size, output);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, errorOut);
            listReady = Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref size);
            if (!listReady || !Native.UpdateProcThreadAttribute(attributes, 0, Native.ProcThreadAttributeHandleList, handles, 3 * IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            {
                error = Marshal.GetLastWin32Error();
                return false;
            }
            Native.StartupInfoEx startup = new()
            {
                Info = new Native.StartupInfo { Size = Marshal.SizeOf<Native.StartupInfoEx>(), Flags = (int)Native.StartfUseStdHandles, StdInput = input, StdOutput = output, StdError = errorOut },
                AttributeList = attributes,
            };
            uint flags = Native.ExtendedStartupInfoPresent | Native.CreateSuspended | Native.CreateUnicodeEnvironment | Native.CreateNoWindow;
            if (Native.CreateProcessW(config.NodePath, new StringBuilder(CommandLine(config)), IntPtr.Zero, IntPtr.Zero, true, flags, block, config.AppPath, ref startup, out created)) return true;
            error = Marshal.GetLastWin32Error();
            return false;
        }
        finally
        {
            if (listReady) Native.DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            Marshal.FreeHGlobal(handles);
            Marshal.FreeHGlobal(block);
        }
    }
}
