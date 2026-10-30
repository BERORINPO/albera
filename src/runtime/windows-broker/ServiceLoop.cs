using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// The serve loop of the service entry (ADR-002, Proposed / NOT VERIFIED). `serve` keeps its one-request behaviour (Program.cs); a service keeps
// serving: it creates the pipe ONCE as the first instance (max 1, same owner and DACL) and reuses that one instance for every client. After each
// connection it waits for the client to read the answer, calls Disconnect() and waits for the next client on the same instance, until the stop token
// is cancelled or a fatal condition ends the loop with one of the fixed exit codes. The name is never released between two requests, so no local user
// can take it in a dispose / recreate gap (which used to stop the service with 70). The database folder is pinned (DatabaseFolderPin.cs) before the
// pipe exists and stays pinned until the loop ends, so it cannot be renamed, deleted or swapped between two requests.
internal static partial class Program
{
    // One client may hold the Broker's only pipe instance for this long between connect and answer; a client that connects and stalls is dropped,
    // so it can neither block the next client indefinitely nor delay SERVICE_CONTROL_STOP.
    private static readonly TimeSpan ConnectionDeadline = TimeSpan.FromSeconds(15);

    // Disconnect() throws unread data away, so the loop first waits (bounded) until the client has read the answer. A client that never reads is
    // disconnected after this long. Reply write (2 s) + this wait stay below the 5 s the service host grants on STOP.
    private static readonly TimeSpan ReplyDrainGrace = TimeSpan.FromSeconds(1);

    // Set by ServiceHost: report STOPPED with the given service-specific exit code. Called, best effort, just before the process is terminated.
    internal static Action<int>? ServiceTerminationNotice;

#if ALBERA_BROKER_TEST_FAULTS
    private static TimeSpan? serviceClaimHold; // test-only: the seam build's loop entry holds every claim open this long (STOP arriving meanwhile)
    private static TimeSpan? ServiceClaimHold => serviceClaimHold;
#else
    private static TimeSpan? ServiceClaimHold => null;
#endif

    // Returns 0 once `stop` is cancelled, 73 when the database folder cannot be pinned, 76 when the journal is refused, or 70 / 72 when the pipe cannot be created. `onReady` runs
    // once, after the folder is pinned and the pipe exists (the service reports RUNNING from there). Nothing is swallowed except a single
    // connection's I/O failure or deadline.
    internal static async Task<int> RunServiceLoopAsync(ServiceConfig config, CancellationToken stop, Action onReady)
    {
        BrokerSettings settings = new(config.Database, config.PublicKey, config.ControlPlaneSid, config.Generation, ServiceClaimHold, ImpersonationFault.None);
        // Held for the whole loop (released by `using` when the loop ends): the journal folder cannot be renamed, deleted or swapped meanwhile.
        using SafeFileHandle? databaseFolder = DatabaseFolderPin.TryPin(config.Database);
        if (databaseFolder is null)
        {
            Console.WriteLine("SERVICE_CONFIG=invalid:" + ServiceConfig.Reason.DatabasePin);
            return ExitServiceConfigInvalid;
        }
        // An existing journal is migrated forward here, or refused (76) when it is newer, unknown or unreadable: RUNNING is never reported for a journal the Broker cannot use.
        if (await RefuseUnusableJournalAsync(config.Database)) return ExitJournalRefused;
        // A squatter that already owns the name makes this fail with 70: the service stops (fail closed) instead of serving.
        NamedPipeServerStream? pipe = CreateBrokerPipe(config.PipeName, config.ControlPlaneSid, out int failure);
        if (pipe is null) return failure;
        await using (pipe)
        {
            Console.WriteLine("BROKER_READY");
            onReady();
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    await pipe.WaitForConnectionAsync(stop);
                    using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
                    deadline.CancelAfter(ConnectionDeadline);
                    await HandleConnectionAsync(pipe, settings, deadline.Token);
                    await WaitForClientToReadAsync(pipe);
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { return 0; }
                catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException)
                {
                    Console.WriteLine("REQUEST=ABORTED"); // client vanished mid-request or hit the deadline; nothing was claimed unless CLAIM= was printed
                }
                if (stop.IsCancellationRequested) return 0; // the answer to a claim that was running when STOP arrived has been written above
                DisconnectForNextClient(pipe);
            }
        }
        return 0;
    }

    // FlushFileBuffers on a pipe returns once the client has read everything written. A client that does not read, or has already gone, ends the
    // wait after the grace period / at once; that single connection's failure is the only thing swallowed here.
    private static async Task WaitForClientToReadAsync(NamedPipeServerStream pipe)
    {
        try { await Task.Run(pipe.WaitForPipeDrain).WaitAsync(ReplyDrainGrace); }
        catch (Exception ex) when (ex is TimeoutException or IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    // .NET only lets Disconnect() run on a pipe it believes is connected. A client that connected and left before WaitForConnection finished leaves
    // the instance waiting in .NET's eyes but half-closed in the system's: the system call resets it. Either way the instance (and the name) stays ours.
    private static void DisconnectForNextClient(NamedPipeServerStream pipe)
    {
        try { pipe.Disconnect(); }
        catch (InvalidOperationException)
        {
            if (!DisconnectNamedPipe(pipe.SafePipeHandle)) throw new IOException("DisconnectNamedPipe failed", Marshal.GetLastWin32Error());
        }
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

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DisconnectNamedPipe(SafePipeHandle pipe);

#if ALBERA_BROKER_TEST_FAULTS
    // Test-only (not in the shipped build): the real service loop without the SCM. `serve-loop <config> [holdMs]`; end of stdin plays
    // SERVICE_CONTROL_STOP. `holdMs` keeps each claim open that many milliseconds after it is committed (the answer is written afterwards).
    private static async Task<int> ServeLoopForTestAsync(string configPath, string? holdMilliseconds)
    {
        if (holdMilliseconds is not null) serviceClaimHold = TimeSpan.FromMilliseconds(int.Parse(holdMilliseconds, System.Globalization.CultureInfo.InvariantCulture));
        if (ServiceConfig.TryLoad(configPath, out _) is not { } config) return ExitServiceConfigInvalid;
        using CancellationTokenSource stop = new();
        _ = Task.Run(() => { Console.In.ReadToEnd(); stop.Cancel(); });
        int code = await RunServiceLoopAsync(config, stop.Token, () => { });
        Console.WriteLine("BROKER_STOPPED");
        return code;
    }
#endif
}
