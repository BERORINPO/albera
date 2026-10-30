using System.Runtime.InteropServices;

namespace Albera.Lab;

// The SCM side: StartServiceCtrlDispatcher + RegisterServiceCtrlHandlerEx, own-process service, STOP only. ServiceMain runs the configured
// job on a background thread and reports RUNNING; when the job ends the service goes STOPPED (exit code in ServiceSpecificExitCode), or
// stays RUNNING until STOP when the config says `linger`.
internal static class ServiceHost
{
    private const uint ServiceWin32OwnProcess = 0x10, StartPending = 2, StopPending = 3, Running = 4, Stopped = 1, AcceptStop = 0x1;
    private const uint ControlStop = 1, ControlInterrogate = 4, ErrorServiceSpecificError = 1066, ErrorCallNotImplemented = 120;

    // The SCM calls back through these for the whole life of the process, so they must stay reachable.
    private static readonly Native.ServiceMainProc MainProc = ServiceMain;
    private static readonly Native.HandlerEx Handler = OnControl;
    private static readonly ManualResetEventSlim StopRequested = new(false);
    private static readonly object StatusGate = new();
    private static string configPath = "";
    private static IntPtr statusHandle;
    private static uint checkPoint;

    public static int Run(string path)
    {
        configPath = path;
        Native.ServiceTableEntry[] table =
        [
            new() { Name = Marshal.StringToHGlobalUni(""), Proc = Marshal.GetFunctionPointerForDelegate(MainProc) }, // own-process service: the name is ignored
            default,
        ];
        if (Native.StartServiceCtrlDispatcherW(table)) return 0;
        Console.Error.WriteLine($"not started by the service control manager (win32 {Marshal.GetLastWin32Error()})");
        return 1;
    }

    private static void ServiceMain(uint argc, IntPtr argv)
    {
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv)) ?? "";
        statusHandle = Native.RegisterServiceCtrlHandlerExW(name, Handler, IntPtr.Zero);
        if (statusHandle == IntPtr.Zero) return;
        Report(StartPending, 0, 0, 0);
        uint win32 = 0, specific = 0;
        try
        {
            JobConfig config = JobConfig.Load(configPath);
            using JobRunner job = new(config);
            int code = int.MinValue;
            using ManualResetEventSlim done = new(false);
            Thread worker = new(() => { code = job.Run(); done.Set(); }) { IsBackground = true };
            worker.Start();
            Report(Running, 0, 0, 0);
            if (WaitHandle.WaitAny([done.WaitHandle, StopRequested.WaitHandle]) == 0)
            {
                if (config.Linger) { job.Line("[shim] job finished; staying RUNNING until STOP"); StopRequested.Wait(); }
                if (code != 0) { win32 = ErrorServiceSpecificError; specific = (uint)code; }
            }
            else
            {
                Report(StopPending, 0, 0, 0);
                job.Line("[shim] STOP received");
                job.Stop();
                _ = worker.Join(TimeSpan.FromSeconds(5)); // an in-process job cannot be cancelled: the process ends with the service instead
            }
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or System.Text.Json.JsonException or UnauthorizedAccessException)
        {
            win32 = ErrorServiceSpecificError;
            specific = 2; // the config could not be read or the result file could not be created
        }
        Report(Stopped, 0, win32, specific);
    }

    private static uint OnControl(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        switch (control)
        {
            case ControlStop: StopRequested.Set(); return 0;
            case ControlInterrogate: return 0;
            default: return ErrorCallNotImplemented;
        }
    }

    private static void Report(uint state, uint accepted, uint win32, uint specific)
    {
        lock (StatusGate)
        {
            bool pending = state is StartPending or StopPending;
            Native.ServiceStatus status = new()
            {
                ServiceType = ServiceWin32OwnProcess, CurrentState = state,
                ControlsAccepted = state == Running ? AcceptStop : accepted,
                Win32ExitCode = win32, ServiceSpecificExitCode = specific,
                CheckPoint = pending ? ++checkPoint : 0, WaitHint = pending ? 10_000u : 0,
            };
            _ = Native.SetServiceStatus(statusHandle, ref status);
        }
    }
}
