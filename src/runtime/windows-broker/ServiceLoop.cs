using System.IO.Pipes;

// The serve loop of the service entry (ADR-002, Proposed / NOT VERIFIED). `serve` keeps its one-request behaviour (Program.cs); a service
// keeps serving: after each connection it disposes the pipe, creates it again as the first instance (max 1, same owner and DACL) and waits for the
// next client, until the stop token is cancelled or a fatal condition ends the loop with one of the fixed exit codes.
internal static partial class Program
{
    // One client may hold the Broker's only pipe instance for this long between connect and answer; a client that connects and stalls is dropped,
    // so it can neither block the next client indefinitely nor delay SERVICE_CONTROL_STOP.
    private static readonly TimeSpan ConnectionDeadline = TimeSpan.FromSeconds(15);

    // Set by ServiceHost: report STOPPED with the given service-specific exit code. Called, best effort, just before the process is terminated.
    internal static Action<int>? ServiceTerminationNotice;

    // Returns 0 once `stop` is cancelled, or 70 / 72 when the pipe cannot be (re)created. `onReady` runs once, after the first pipe exists
    // (the service reports RUNNING from there). Nothing is swallowed except a single connection's I/O failure or deadline.
    internal static async Task<int> RunServiceLoopAsync(ServiceConfig config, CancellationToken stop, Action onReady)
    {
        BrokerSettings settings = new(config.Database, config.PublicKey, config.ControlPlaneSid, config.Generation, Hold: false, ImpersonationFault.None);
        bool announced = false;
        while (!stop.IsCancellationRequested)
        {
            // A squatter that takes the name between two requests makes this fail with 70: the service stops (fail closed) instead of serving.
            NamedPipeServerStream? pipe = CreateBrokerPipe(config.PipeName, config.ControlPlaneSid, out int failure);
            if (pipe is null) return failure;
            await using (pipe)
            {
                if (!announced)
                {
                    announced = true;
                    Console.WriteLine("BROKER_READY");
                    onReady();
                }
                try
                {
                    await pipe.WaitForConnectionAsync(stop);
                    using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
                    deadline.CancelAfter(ConnectionDeadline);
                    await HandleConnectionAsync(pipe, settings, deadline.Token);
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { return 0; }
                catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException)
                {
                    Console.WriteLine("REQUEST=ABORTED"); // client vanished mid-request or hit the deadline; nothing was claimed unless CLAIM= was printed
                }
            }
        }
        return 0;
    }

    // `service-check <config>`: validate the config exactly as the service would, print one fixed line, change nothing. Usable by an installer
    // as a pre-flight and by host tests (no SCM needed).
    private static int CheckServiceConfig(string configPath)
    {
        if (ServiceConfig.TryLoad(configPath, out string reason) is null)
        {
            Console.WriteLine($"SERVICE_CONFIG=invalid:{reason}");
            return ExitServiceConfigInvalid;
        }
        Console.WriteLine("SERVICE_CONFIG=ok");
        return 0;
    }

    // The thread that detected the revert failure may still carry the client's token, and SetServiceStatus must run as the service: a new thread
    // starts with the process token. Bounded wait, then the caller terminates the process regardless.
    private static void NotifyServiceTermination(int code)
    {
        Action<int>? notice = ServiceTerminationNotice;
        if (notice is null) return;
        Thread reporter = new(() =>
        {
            try { notice(code); }
            catch (Exception) { /* best effort on the way to TerminateProcess; the exit code 71 is the authoritative signal */ }
        }) { IsBackground = true };
        reporter.Start();
        _ = reporter.Join(TimeSpan.FromSeconds(2));
    }

#if ALBERA_BROKER_TEST_FAULTS
    // Test-only (not in the shipped build): the real service loop without the SCM. `serve-loop <config>`; end of stdin plays SERVICE_CONTROL_STOP.
    private static async Task<int> ServeLoopForTestAsync(string configPath)
    {
        if (ServiceConfig.TryLoad(configPath, out _) is not { } config) return ExitServiceConfigInvalid;
        using CancellationTokenSource stop = new();
        _ = Task.Run(() => { Console.In.ReadToEnd(); stop.Cancel(); });
        int code = await RunServiceLoopAsync(config, stop.Token, () => { });
        Console.WriteLine("BROKER_STOPPED");
        return code;
    }
#endif
}
