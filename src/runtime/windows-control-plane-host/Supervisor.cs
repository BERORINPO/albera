using System.Diagnostics;
using Microsoft.Win32.SafeHandles;

// The host's one loop (docs/architecture/control-plane-service.md section 2): start node in a Job, wait for it to end or for STOP, and start it again a bounded
// number of times. Used by the service entry (ServiceHost.cs) and by the test-only foreground `serve`. No decision is made here beyond "the limit is reached".
//
// Restart rule: every end of the child (any exit code, or a start that failed) counts one failure; a run that lasted at least `stableRun` first resets the count to 0.
// When the count would pass `maxRestarts` the host gives up with exit 77 and the SCM's failure actions decide what happens next. A launch refusal (LaunchGate: node or
// the app tree changed, or is writable by others) is never retried: exit 78.
// STOP ends the Job (every process the host started, and nothing else), waits a bounded time for the child, drains the output pipes, and returns 0.
internal sealed class Supervisor : IDisposable
{
    private static readonly TimeSpan ChildEndWait = TimeSpan.FromSeconds(3), DrainWait = TimeSpan.FromSeconds(1);
    private const int PumpChunkBytes = 4096; // far below the smallest log cap, so one write always fits a fresh file

    private readonly HostConfig config;
    private readonly BoundedLog output, error, hostFile;
    private readonly HostLog events;

    public Supervisor(HostConfig config)
    {
        this.config = config;
        output = new BoundedLog(Path.Combine(config.LogDirectory, "room-service.out.log"), config.LogMaxBytes);
        error = new BoundedLog(Path.Combine(config.LogDirectory, "room-service.err.log"), config.LogMaxBytes);
        hostFile = new BoundedLog(Path.Combine(config.LogDirectory, "host.log"), config.LogMaxBytes);
        events = new HostLog(hostFile);
    }

    private enum EndKind { Stopped, ChildEnded, StartFailed, Refused, JobFailed }
    private readonly record struct RunEnd(EndKind Kind, string Detail = "");

    /// <summary>Runs until `stop` is cancelled (returns 0) or a fixed exit code ends the loop. `onFirstStart` runs once, after the first child is inside its Job;
    /// `onWaiting` runs before each restart delay (the service keeps reporting START_PENDING with it until the first start).</summary>
    public int Run(CancellationToken stop, Action onFirstStart, Action onWaiting)
    {
        int failures = 0;
        bool announced = false;
        while (!stop.IsCancellationRequested)
        {
            long begun = Stopwatch.GetTimestamp();
            RunEnd end = RunOnce(stop, () => { if (!announced) { announced = true; onFirstStart(); } });
            switch (end.Kind)
            {
                case EndKind.Stopped: return 0;
                case EndKind.JobFailed: return Fatal("job_failed", Program.ExitJobFailed);
                case EndKind.Refused: return Fatal($"child_untrusted:{end.Detail}", Program.ExitChildRefused);
            }
            if (Stopwatch.GetElapsedTime(begun) >= config.StableRun) failures = 0;
            if (++failures > config.MaxRestarts) return Fatal("restart_limit", Program.ExitRestartLimit);
            events.Event($"CPHOST_RESTART={failures}/{config.MaxRestarts}");
            onWaiting();
            if (stop.WaitHandle.WaitOne(config.RestartDelay)) break;
        }
        return 0;
    }

    private int Fatal(string reason, int code)
    {
        events.Event($"CPHOST_FATAL={reason}");
        return code;
    }

    private RunEnd RunOnce(CancellationToken stop, Action onStarted)
    {
        using ChildJob? job = ChildJob.Create();
        if (job is null) return new RunEnd(EndKind.JobFailed);
        LaunchedChild? child;
        int win32;
        using (LaunchGate gate = LaunchGate.Open(config, out string? refusal))
        {
            if (refusal is not null) return new RunEnd(EndKind.Refused, refusal);
            try { child = ChildLauncher.Start(config, job, ChildEnvironment.Create(), out win32); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return StartFailed("environment"); }
        }
        if (child is null) return StartFailed($"win32_{win32}");
        using (child)
        {
            events.Event($"CPHOST_CHILD_STARTED={child.ProcessId}");
            onStarted();
            Task[] pumps = [Pump(child.Output, output), Pump(child.Error, error)];
            using ManualResetEvent exited = new(false) { SafeWaitHandle = new SafeWaitHandle(child.Process, ownsHandle: false) };
            bool stopRequested = WaitHandle.WaitAny([exited, stop.WaitHandle]) == 1;
            if (stopRequested) events.Event("CPHOST_STOPPING");
            job.Terminate(); // on STOP this is the stop; after the child ended on its own it removes whatever the child left behind
            bool ended = exited.WaitOne(ChildEndWait);
            Task.WaitAll(pumps, DrainWait);
            long dropped = output.DroppedBytes + error.DroppedBytes;
            if (dropped > 0) events.Event($"CPHOST_LOG_DROPPED={dropped}");
            if (stopRequested) return new RunEnd(EndKind.Stopped);
            events.Event(ended && child.TryGetExitCode(out int code) ? $"CPHOST_CHILD_EXITED={code}" : "CPHOST_CHILD_EXITED=unknown");
            return new RunEnd(EndKind.ChildEnded);
        }
    }

    private RunEnd StartFailed(string detail)
    {
        events.Event($"CPHOST_CHILD_START_FAILED={detail}");
        return new RunEnd(EndKind.StartFailed, detail);
    }

    // A pipe that breaks or is closed under the reader is the normal end of the child's output, so those two exceptions end the loop quietly.
    private static Task Pump(FileStream source, BoundedLog sink) => Task.Run(() =>
    {
        byte[] buffer = new byte[PumpChunkBytes];
        try
        {
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0) sink.Write(buffer.AsSpan(0, read));
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException) { }
    });

    public void Dispose()
    {
        output.Dispose();
        error.Dispose();
        hostFile.Dispose();
    }
}
