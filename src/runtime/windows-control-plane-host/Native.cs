using System.Runtime.InteropServices;
using System.Text;

// The Win32 surface of the host that is not the service dispatcher: Job object, pipes and CreateProcess. kernel32 only; nothing here touches an ACL or the registry.
internal static class Native
{
    public const uint JobObjectLimitKillOnJobClose = 0x2000;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint ExtendedStartupInfoPresent = 0x80000, CreateSuspended = 0x4, CreateUnicodeEnvironment = 0x400, CreateNoWindow = 0x08000000;
    public const uint StartfUseStdHandles = 0x100, HandleFlagInherit = 0x1;
    public const uint GenericRead = 0x80000000, ShareReadWrite = 0x3, OpenExisting = 3;
    public static readonly IntPtr ProcThreadAttributeHandleList = 0x20002;
    public static readonly IntPtr InvalidHandle = new(-1);

    [StructLayout(LayoutKind.Sequential)] public struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int InheritHandle; }
    [StructLayout(LayoutKind.Sequential)] public struct JobBasicLimit
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public nuint Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] public struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] public struct JobExtendedLimit
    {
        public JobBasicLimit Basic; public IoCounters Io; public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] public struct StartupInfo
    {
        public int Size; public IntPtr Reserved, Desktop, Title; public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, Reserved2Size; public IntPtr Reserved2, StdInput, StdOutput, StdError;
    }
    [StructLayout(LayoutKind.Sequential)] public struct StartupInfoEx { public StartupInfo Info; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] public struct ProcessInformation { public IntPtr Process, Thread; public int ProcessId, ThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, int length);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string currentDirectory, ref StartupInfoEx startup, out ProcessInformation information);
}
