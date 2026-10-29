using System.Runtime.InteropServices;
using System.Text;

if (args is ["breakaway", var marker])
{
    var executable = Environment.ProcessPath ?? throw new InvalidOperationException();
    var commandLine = new StringBuilder($"\"{executable}\" escaped \"{marker}\"");
    var startup = new Native.STARTUPINFO { cb = Marshal.SizeOf<Native.STARTUPINFO>() };
    if (!Native.CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false,
        Native.CREATE_BREAKAWAY_FROM_JOB | Native.CREATE_NO_WINDOW, IntPtr.Zero, Path.GetDirectoryName(executable)!,
        ref startup, out var process))
    {
        return Marshal.GetLastWin32Error() == Native.ERROR_ACCESS_DENIED ? 0 : 10;
    }

    Native.WaitForSingleObject(process.hProcess, 5000);
    Native.GetExitCodeProcess(process.hProcess, out var exitCode);
    Native.CloseHandle(process.hThread);
    Native.CloseHandle(process.hProcess);
    return exitCode == 0 ? 42 : 43;
}

if (args is ["escaped", var escapedMarker])
{
    File.WriteAllText(escapedMarker, "breakaway succeeded");
    return 0;
}

return 64;

internal static class Native
{
    internal const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    internal const uint CREATE_NO_WINDOW = 0x08000000;
    internal const int ERROR_ACCESS_DENIED = 5;

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct STARTUPINFO { public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
}
