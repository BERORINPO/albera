using System.Runtime.InteropServices;
using System.Text;

namespace Albera.Lab;

// Win32 surface of the lab tool. Nothing here changes system state except SetServiceStatus for the shim's own service.
internal static class Native
{
    public const uint ServiceRunning = 4;

    [StructLayout(LayoutKind.Sequential)] public struct ServiceTableEntry { public IntPtr Name; public IntPtr Proc; }
    [StructLayout(LayoutKind.Sequential)] public struct ServiceStatus { public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint; }
    [StructLayout(LayoutKind.Sequential)] public struct ServiceStatusProcess { public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags; }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct LuidAndAttributes { public uint LowPart; public int HighPart; public uint Attributes; }

    public delegate void ServiceMainProc(uint argc, IntPtr argv);
    public delegate uint HandlerEx(uint control, uint eventType, IntPtr eventData, IntPtr context);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool StartServiceCtrlDispatcherW([In] ServiceTableEntry[] table);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr RegisterServiceCtrlHandlerExW(string name, HandlerEx handler, IntPtr context);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetServiceStatus(IntPtr handle, ref ServiceStatus status);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool QueryServiceStatusEx(IntPtr service, int infoLevel, out ServiceStatusProcess status, uint size, out uint needed);
    [DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool LookupPrivilegeNameW(string? system, ref LuidAndAttributes luid, StringBuilder name, ref int length);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerSessionId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint session);
}
