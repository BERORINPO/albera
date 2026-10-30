using System.Runtime.InteropServices;

namespace Albera.ApprovalAuthority;

// The Authority as its own Windows service process (copied from the Broker's ServiceHost; the Broker is not referenced). The Authority calls
// StartServiceCtrlDispatcher itself, so the PID the SCM reports is the PID that creates the pipes. advapi32 P/Invoke only: no managed service wrapper,
// no installer; nothing here registers, starts or configures a service. Own-process service, STOP only.
//
//   albera-approval-authority.exe service <config.json>
//
// Lifecycle: START_PENDING -> read config -> open the signing key -> create both pipes -> RUNNING (only once the pipes exist) -> serve until
// SERVICE_CONTROL_STOP -> STOP_PENDING -> cancel the loops (bounded wait) -> STOPPED. A fatal end reports STOPPED with ERROR_SERVICE_SPECIFIC_ERROR
// and the fixed code as the service-specific exit code (ExitCodes.cs). Outside the SCM, StartServiceCtrlDispatcher fails at once and the process
// exits 74 before it reads the config, opens the key or creates a pipe.
internal static class ServiceHost
{
    private const uint ServiceWin32OwnProcess = 0x10, Stopped = 1, StartPending = 2, StopPending = 3, Running = 4, AcceptStop = 0x1;
    private const uint ControlStop = 1, ControlInterrogate = 4, ErrorServiceSpecificError = 1066, ErrorCallNotImplemented = 120;
    private const uint PendingWaitHintMs = 10_000;
    private static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(5); // below the wait hint: STOPPED is reported before the SCM gives up on us

    // The SCM calls back through these for the whole life of the process, so they must stay reachable.
    private static readonly ServiceMainProc MainProc = ServiceMain;
    private static readonly HandlerEx Handler = OnControl;
    private static readonly TaskCompletionSource StopRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static readonly object StatusGate = new();
    private static string configPath = "";
    private static IntPtr statusHandle;
    private static uint checkPoint;
    private static bool stopping, stoppedReported;
    private static int exitCode;

    public static int Run(string path)
    {
        configPath = path;
        IntPtr serviceName = Marshal.StringToHGlobalUni(""); // own-process service: the name is ignored
        try
        {
            ServiceTableEntry[] table = [new() { Name = serviceName, Proc = Marshal.GetFunctionPointerForDelegate(MainProc) }, default];
            if (StartServiceCtrlDispatcherW(table)) return exitCode;
            int error = Marshal.GetLastWin32Error(); // 1063 = ERROR_FAILED_SERVICE_CONTROLLER_CONNECT when not started by the SCM
            Console.WriteLine("AUTHORITY_FATAL=SERVICE_CONTROLLER_UNAVAILABLE");
            Console.WriteLine($"SERVICE_DISPATCHER_ERROR={error}");
            return ExitCodes.NotStartedByScm;
        }
        finally { Marshal.FreeHGlobal(serviceName); }
    }

    private static void ServiceMain(uint argc, IntPtr argv)
    {
        try { RunService(argv); }
        catch (Exception)
        {
            // An exception must not unwind into the SCM's native thread: fail closed with a fixed code.
            Console.WriteLine("AUTHORITY_FATAL=SERVICE_LOOP_FAILED");
            ReportStopped(ExitCodes.LoopFailed);
        }
    }

    private static void RunService(IntPtr argv)
    {
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv)) ?? "";
        statusHandle = RegisterServiceCtrlHandlerExW(name, Handler, IntPtr.Zero);
        if (statusHandle == IntPtr.Zero) { exitCode = ExitCodes.LoopFailed; return; } // cannot even report: the dispatcher returns and the process exits
        PipeHost.ServiceTerminationNotice = ReportStopped;
        Report(StartPending);
        if (AuthorityConfig.TryLoad(configPath, strictSeparation: true, out string reason) is not { } config)
        {
            Console.WriteLine($"SERVICE_CONFIG=invalid:{reason}");
            ReportStopped(ExitCodes.ConfigInvalid);
            return;
        }
        using CancellationTokenSource stop = new();
        Task<int> loop = Task.Run(() => RunLoopAsync(config, stop.Token));
        int code;
        if (Task.WaitAny(loop, StopRequested.Task) == 1)
        {
            stop.Cancel();
            if (loop.Wait(StopGrace)) code = loop.Result;
            else { Console.WriteLine("AUTHORITY_STOP_TIMEOUT"); code = 0; } // the process ends with the service; pending requests are memory only
        }
        else code = loop.Result; // the loop ended on its own: a fatal condition
        ReportStopped(code);
    }

    private static async Task<int> RunLoopAsync(AuthorityConfig config, CancellationToken stop)
    {
        try { return await AuthorityRuntime.RunProductionAsync(config, stop, () => Report(Running)); }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { return 0; }
        catch (Exception)
        {
            Console.WriteLine("AUTHORITY_FATAL=SERVICE_LOOP_FAILED");
            return ExitCodes.LoopFailed;
        }
    }

    private static uint OnControl(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        switch (control)
        {
            case ControlStop:
                Report(StopPending);
                StopRequested.TrySetResult();
                return 0;
            case ControlInterrogate: return 0;
            default: return ErrorCallNotImplemented;
        }
    }

    private static void ReportStopped(int code)
    {
        exitCode = code;
        Report(Stopped, code == 0 ? 0 : ErrorServiceSpecificError, (uint)code);
    }

    // Serialised and monotonic: nothing is reported after STOPPED, and RUNNING never overtakes a STOP that arrived while the pipes were being created.
    private static void Report(uint state, uint win32 = 0, uint specific = 0)
    {
        lock (StatusGate)
        {
            if (stoppedReported || (state == Running && stopping)) return;
            if (state == StopPending) stopping = true;
            if (state == Stopped) stoppedReported = true;
            bool pending = state is StartPending or StopPending;
            ServiceStatus status = new()
            {
                ServiceType = ServiceWin32OwnProcess, CurrentState = state,
                ControlsAccepted = state == Running ? AcceptStop : 0,
                Win32ExitCode = win32, ServiceSpecificExitCode = specific,
                CheckPoint = pending ? ++checkPoint : 0, WaitHint = pending ? PendingWaitHintMs : 0,
            };
            _ = SetServiceStatus(statusHandle, ref status);
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct ServiceTableEntry { public IntPtr Name; public IntPtr Proc; }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint; }
    private delegate void ServiceMainProc(uint argc, IntPtr argv);
    private delegate uint HandlerEx(uint control, uint eventType, IntPtr eventData, IntPtr context);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartServiceCtrlDispatcherW([In] ServiceTableEntry[] table);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr RegisterServiceCtrlHandlerExW(string name, HandlerEx handler, IntPtr context);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetServiceStatus(IntPtr handle, ref ServiceStatus status);
}
