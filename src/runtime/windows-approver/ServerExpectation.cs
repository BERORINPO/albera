using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Albera.Approver;

/// <summary>Who must be on the other end of the pipe: the account that owns it, the process that serves it, and (service mode) that it is a session-0 service.</summary>
internal sealed record ResolvedServer(SecurityIdentifier Owner, uint Pid, bool RequireSessionZero);

// What the approver expects of the pipe server, resolved at connect time (the same checks as the Broker's trusted pipe client, copied: that project is not referenced).
//   production: the pipe is owned by NT SERVICE\AlberaApprovalAuthority, the server process is the one the SCM reports as RUNNING for service AlberaApprovalAuthority,
//               and it runs in session 0.
//   tests:      an explicit owner SID and PID (test-faults builds only, see TestSeam.cs): a test has no service.
// The pipe root is the Authority's default; there is no config file, environment variable or option in the shipped build that changes it or the expectations.
internal sealed record ServerExpectation(string PipeRoot, string? ServiceName, string? OwnerSid, uint? Pid)
{
    public const string ProductionPipeRoot = @"ALBERA\ApprovalAuthority", ProductionServiceName = "AlberaApprovalAuthority";
    private const uint ServiceRunning = 4;

    public static ServerExpectation Production { get; } = new(ProductionPipeRoot, ProductionServiceName, null, null);

    public string ApproverPipe => PipeRoot + @"\approver\v1";

    public ResolvedServer Resolve()
    {
        if (ServiceName is null) return new ResolvedServer(new SecurityIdentifier(OwnerSid!), Pid!.Value, RequireSessionZero: false);
        SecurityIdentifier owner = (SecurityIdentifier)new NTAccount("NT SERVICE", ServiceName).Translate(typeof(SecurityIdentifier));
        return new ResolvedServer(owner, ServicePid(ServiceName), RequireSessionZero: true);
    }

    private static uint ServicePid(string name)
    {
        IntPtr manager = OpenSCManagerW(null, null, 0x1 /*SC_MANAGER_CONNECT*/);
        if (manager == IntPtr.Zero) throw new Win32Exception();
        try
        {
            IntPtr service = OpenServiceW(manager, name, 0x4 /*SERVICE_QUERY_STATUS*/);
            if (service == IntPtr.Zero) throw new Win32Exception();
            try
            {
                if (!QueryServiceStatusEx(service, 0, out ServiceStatusProcess status, (uint)Marshal.SizeOf<ServiceStatusProcess>(), out _)) throw new Win32Exception();
                return status.CurrentState == ServiceRunning && status.ProcessId != 0 ? status.ProcessId : throw new InvalidOperationException();
            }
            finally { _ = CloseServiceHandle(service); }
        }
        finally { _ = CloseServiceHandle(manager); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess { public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags; }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, int infoLevel, out ServiceStatusProcess status, uint bufferSize, out uint bytesNeeded);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
}
