using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Albera.Lab;

// Single-purpose probes, each printing ONE JSON line (squat prints two). They run as whichever account launches them: the interactive
// Administrator, or a service account through the shim's child mode. They only open, read and report; none changes system state.
//   token                          this process's own token (TokenReport)
//   pipe-open <pipe> <hexMask>     CreateFile on an existing pipe with exactly that access (SQOS identification), then owner / DACL / server pid / session.
//                                  A successful open uses up the single connection a Broker serves.
//   scm <service>                  which access masks OpenService grants this account, and the service status + PID
//   openproc <pid>                 which access masks OpenProcess grants this account, and the image SHA-256 when it may be read
//   squat <pipe> <seconds>         a hostile first-instance pipe server that grants Everyone, reports its owner, counts the bytes a client sends
internal static class Probes
{
    private const uint OpenExisting = 3, SecuritySqosPresent = 0x00100000, SecurityIdentification = 0x00010000;
    private static readonly (string Name, uint Mask)[] ServiceMasks =
    [
        ("SERVICE_QUERY_STATUS", 0x4), ("SERVICE_QUERY_CONFIG", 0x1), ("SERVICE_INTERROGATE", 0x80), ("SERVICE_START", 0x10), ("SERVICE_STOP", 0x20),
        ("SERVICE_PAUSE_CONTINUE", 0x40), ("SERVICE_CHANGE_CONFIG", 0x2), ("WRITE_DAC", 0x40000), ("DELETE", 0x10000), ("SERVICE_ALL_ACCESS", 0xF01FF),
    ];
    private static readonly (string Name, uint Mask)[] ProcessMasks =
    [
        ("PROCESS_QUERY_LIMITED_INFORMATION", 0x1000), ("PROCESS_QUERY_INFORMATION", 0x400), ("PROCESS_VM_READ", 0x10), ("PROCESS_TERMINATE", 0x1), ("PROCESS_ALL_ACCESS", 0x1FFFFF),
    ];

    public static int Run(string[] args)
    {
        switch (args)
        {
            case ["token"]: Emit(TokenReport.Capture()); return 0;
            case ["pipe-open", var pipe, var mask]: return PipeOpen(pipe, Convert.ToUInt32(mask, 16));
            case ["scm", var service]: return Scm(service);
            case ["openproc", var pid]: return OpenProc(uint.Parse(pid, System.Globalization.CultureInfo.InvariantCulture));
            case ["squat", var pipe, var seconds]: return Squat(pipe, int.Parse(seconds, System.Globalization.CultureInfo.InvariantCulture));
            default: return 64;
        }
    }

    private static void Emit(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
    private static string Outcome(bool ok, int error) => ok ? "opened" : error == 5 ? "denied" : $"error_{error}";

    private static int PipeOpen(string pipe, uint mask)
    {
        Dictionary<string, object?> result = new() { ["probe"] = "pipe-open", ["pipe"] = pipe, ["mask"] = $"0x{mask:X8}" };
        IntPtr raw = Native.CreateFileW(@"\\.\pipe\" + pipe, mask, 0, IntPtr.Zero, OpenExisting, SecuritySqosPresent | SecurityIdentification, IntPtr.Zero);
        int error = Marshal.GetLastWin32Error();
        result["result"] = Outcome(raw != new IntPtr(-1), error);
        if (raw != new IntPtr(-1))
        {
            using NamedPipeClientStream stream = new(PipeDirection.InOut, false, true, new SafePipeHandle(raw, true));
            try
            {
                result["owner"] = (stream.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier)?.Value;
                result["sddl"] = stream.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access);
            }
            catch (UnauthorizedAccessException) { result["sddl"] = "unreadable_without_READ_CONTROL"; }
            if (Native.GetNamedPipeServerProcessId(stream.SafePipeHandle, out uint serverPid)) result["serverPid"] = serverPid;
            if (Native.GetNamedPipeServerSessionId(stream.SafePipeHandle, out uint session)) result["serverSession"] = session;
        }
        Emit(result);
        return 0;
    }

    private static int Scm(string service)
    {
        Dictionary<string, object?> result = new() { ["probe"] = "scm", ["service"] = service };
        IntPtr manager = Native.OpenSCManagerW(null, null, 0x1 /*SC_MANAGER_CONNECT*/);
        result["SC_MANAGER_CONNECT"] = Outcome(manager != IntPtr.Zero, Marshal.GetLastWin32Error());
        if (manager != IntPtr.Zero)
        {
            Dictionary<string, string> opens = [];
            foreach ((string name, uint mask) in ServiceMasks)
            {
                IntPtr handle = Native.OpenServiceW(manager, service, mask);
                opens[name] = Outcome(handle != IntPtr.Zero, Marshal.GetLastWin32Error());
                if (handle != IntPtr.Zero) _ = Native.CloseServiceHandle(handle);
            }
            result["openService"] = opens;
            IntPtr query = Native.OpenServiceW(manager, service, 0x4);
            if (query != IntPtr.Zero && Native.QueryServiceStatusEx(query, 0, out Native.ServiceStatusProcess status, (uint)Marshal.SizeOf<Native.ServiceStatusProcess>(), out _))
            {
                result["state"] = status.CurrentState == Native.ServiceRunning ? "RUNNING" : $"state_{status.CurrentState}";
                result["pid"] = status.ProcessId;
            }
            if (query != IntPtr.Zero) _ = Native.CloseServiceHandle(query);
            _ = Native.CloseServiceHandle(manager);
        }
        Emit(result);
        return 0;
    }

    private static int OpenProc(uint pid)
    {
        Dictionary<string, object?> result = new() { ["probe"] = "openproc", ["pid"] = pid };
        Dictionary<string, string> opens = [];
        foreach ((string name, uint mask) in ProcessMasks)
        {
            IntPtr handle = Native.OpenProcess(mask, false, pid);
            opens[name] = Outcome(handle != IntPtr.Zero, Marshal.GetLastWin32Error());
            if (handle != IntPtr.Zero) _ = Native.CloseHandle(handle);
        }
        result["openProcess"] = opens;
        result["imageSha256"] = ImageSha256(pid);
        Emit(result);
        return 0;
    }

    // Same steps as the pipe client helper's optional image check; never throws, reports why it could not.
    private static string ImageSha256(uint pid)
    {
        IntPtr process = Native.OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return $"unavailable_open_{Marshal.GetLastWin32Error()}";
        try
        {
            StringBuilder path = new(1024);
            uint size = (uint)path.Capacity;
            if (!Native.QueryFullProcessImageNameW(process, 0, path, ref size)) return $"unavailable_query_{Marshal.GetLastWin32Error()}";
            using FileStream image = new(path.ToString(), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return Convert.ToHexStringLower(SHA256.HashData(image));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return $"unavailable_read_{ex.GetType().Name}"; }
        finally { _ = Native.CloseHandle(process); }
    }

    private static int Squat(string pipe, int seconds)
    {
        PipeSecurity security = new();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        NamedPipeServerStream server;
        try { server = NamedPipeServerStreamAcl.Create(pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, security); }
        catch (IOException) { Emit(new { probe = "squat", state = "pipe_exists" }); return 0; }
        using (server)
        {
            string? owner = (server.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier)?.Value;
            Emit(new { probe = "squat", state = "ready", owner, pid = Environment.ProcessId });
            using CancellationTokenSource wait = new(TimeSpan.FromSeconds(seconds));
            int bytes = 0;
            bool connected = false;
            try
            {
                server.WaitForConnectionAsync(wait.Token).GetAwaiter().GetResult();
                connected = true;
                byte[] buffer = new byte[8192];
                using CancellationTokenSource read = new(TimeSpan.FromSeconds(3));
                int count;
                while ((count = server.ReadAsync(buffer, read.Token).AsTask().GetAwaiter().GetResult()) > 0) bytes += count;
            }
            catch (Exception ex) when (ex is OperationCanceledException or IOException) { }
            Emit(new { probe = "squat", state = "done", connected, bytesReceived = bytes });
        }
        return 0;
    }
}
