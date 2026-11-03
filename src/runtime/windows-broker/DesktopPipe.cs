using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using static DesktopProtocol;

// The Broker's second pipe, for the room's desktop operations (ADR-002 "Amendment 2026-11-03", "Desktop pipe"; Proposed / NOT VERIFIED). Two kinds of session: `view` (screen capture) and
// `act` (capture and input), the latter only while it holds the Broker's desktop lease (DesktopLeases.cs). Made only when the config has `computers`; without them the Broker is what it was.
//   * Name: the claim pipe's name + "_desktop" (ServiceConfig.DesktopPipeName). Same owner, same DACL (the Broker, plus the Control Plane SID with 0x00120083), same
//     PIPE_REJECT_REMOTE_CLIENTS, same first-instance rule, and the same per-connection check (thread token user SID == the configured Control Plane SID), made after the first frame's
//     length bytes and before anything of the request is read or looked at.
//   * Instances: 16, all created at start and each served by its own task ("slot"): a slot waits for a client, serves one session, resets the instance and waits again. The first instance
//     is created with FILE_FLAG_FIRST_PIPE_INSTANCE and every slot keeps its instance until STOP, so the name is never free for a squatter. A 17th client gets "pipe busy" from the system.
//   * Captures: ONE at a time in the whole Broker (CaptureSlot), because the WMI scripting API boxes every byte of the picture (see MaxCapturePixels). Another session's capture waits for
//     the slot (at most CaptureQueueTimeout, then it is refused); within one session a capture starts at least 200 ms after the previous one started (the contract's limit): the later request waits.
//   * Act: the open names the operationId and leaseGeneration of the lease that is current for that computer (the Broker made it when it recorded that task.start claim); anything else is
//     refused. The session ends, with the fixed denied frame, when a newer claim replaces the lease or the lease expires. Input runs ONE request at a time per computer, and the lease is
//     checked again once the request holds that turn. A request that never returns stops the Broker, as a hung capture does.
//   * A session that is idle for 60 s is closed (no reply). Every refusal is the fixed `denied` frame followed by closing the connection; the reason is a fixed word on stdout only (DESKTOP_DENY=).
internal static partial class Program
{
    private static readonly byte[] DesktopOk = Encoding.UTF8.GetBytes("{\"ok\":true}"); // the reply to an accepted open and to an input that was sent

    // One session may hold its instance idle this long between two frames; one reply (a PNG is up to 8 MiB) must be read by the client within the write budget.
    // The capture queue is bounded by the instance count (every session has one request at a time), and by this timeout.
#if ALBERA_BROKER_TEST_FAULTS
    // Test-only (not in the shipped build): ALBERA_BROKER_TEST_DESKTOP_IDLE_MS shortens the idle close; ALBERA_BROKER_TEST_DESKTOP_CAPTURE_HOLD_MS keeps every capture in the
    // single capture slot that long and makes it print DESKTOP_TEST=capture_enter / capture_exit, so a test can see that two captures never overlap; ALBERA_BROKER_TEST_DESKTOP_INPUT_HOLD_MS
    // does the same for an input request (input_enter / input_exit); ALBERA_BROKER_TEST_DESKTOP_LEASE_SECONDS shortens the lease's lifetime, the only way to reach "expired" in a test.
    private static readonly TimeSpan DesktopIdleTimeout = TimeSpan.FromMilliseconds(long.TryParse(Environment.GetEnvironmentVariable("ALBERA_BROKER_TEST_DESKTOP_IDLE_MS"), out long idle) ? idle : 60_000);
    private static readonly TimeSpan DesktopCaptureHold = TimeSpan.FromMilliseconds(long.TryParse(Environment.GetEnvironmentVariable("ALBERA_BROKER_TEST_DESKTOP_CAPTURE_HOLD_MS"), out long hold) ? hold : 0);
    private static readonly TimeSpan DesktopInputHold = TimeSpan.FromMilliseconds(long.TryParse(Environment.GetEnvironmentVariable("ALBERA_BROKER_TEST_DESKTOP_INPUT_HOLD_MS"), out long inputHold) ? inputHold : 0);
    private static readonly long DesktopLeaseSeconds = long.TryParse(Environment.GetEnvironmentVariable("ALBERA_BROKER_TEST_DESKTOP_LEASE_SECONDS"), out long leaseSeconds) ? leaseSeconds : DesktopLeases.MaxLifetimeSeconds;
#else
    private static readonly TimeSpan DesktopIdleTimeout = TimeSpan.FromSeconds(60);
    private const long DesktopLeaseSeconds = DesktopLeases.MaxLifetimeSeconds;
#endif
    private static readonly TimeSpan DesktopWriteTimeout = TimeSpan.FromSeconds(10), CaptureQueueTimeout = TimeSpan.FromSeconds(30), MinCaptureInterval = TimeSpan.FromMilliseconds(200),
        CaptureHungTimeout = TimeSpan.FromSeconds(15), // a capture takes about a second; one that never returns would hold the slot forever
        InputQueueTimeout = TimeSpan.FromSeconds(30), // an input waits this long for the turn of its computer (one request is ~12 s of sleep at most, plus its calls)
        InputHungTimeout = TimeSpan.FromMinutes(5); // far beyond any request the limits allow; one that never returns would hold its computer's turn forever

    // The one capture slot of the whole Broker.
    private static readonly SemaphoreSlim CaptureSlot = new(1, 1);

    private sealed class DesktopPipeHost : IAsyncDisposable
    {
        private const uint MaxInstances = 16;
        private static readonly TimeSpan SlotShutdownGrace = TimeSpan.FromSeconds(2); // below the 5 s the service host grants on STOP
        private readonly ServiceConfig _config;
        private readonly HyperVDesktop _desktop;
        private readonly Dictionary<string, SemaphoreSlim> _inputTurns; // one turn per computer: two act sessions of one lease never interleave their key presses
        private readonly List<NamedPipeServerStream> _instances = [];
        private readonly List<Task> _slots = [];
        private CancellationTokenSource? _stop;

        private DesktopPipeHost(ServiceConfig config)
        {
            _config = config;
            _desktop = new HyperVDesktop(config.Computers, ComWmiConnection.TryConnect);
            _inputTurns = config.Computers.ToDictionary(c => c.ComputerId, _ => new SemaphoreSlim(1, 1), StringComparer.Ordinal);
            Leases = new DesktopLeases(config.Computers, NowSeconds, DesktopLeaseSeconds);
        }

        /// <summary>The Broker's lease table: the claim path grants into it (BrokerRequests.cs), act sessions open against it. A restart is a new process, so a new and empty one.</summary>
        internal DesktopLeases Leases { get; }

        /// <summary>The host for `config`: all 16 instances created (no instance at all when the config has no computers), or null with the Broker's fixed exit code in `failure`.</summary>
        internal static DesktopPipeHost? Create(ServiceConfig config, out int failure)
        {
            failure = 0;
            DesktopPipeHost host = new(config);
            if (config.Computers.Count == 0) return host;
            for (uint i = 0; i < MaxInstances; i++)
            {
                NamedPipeServerStream? pipe = CreateBrokerPipe(ServiceConfig.DesktopPipeName(config.PipeName), config.ControlPlaneSid, out failure, MaxInstances, firstInstance: i == 0);
                if (pipe is null) { host.DisposeInstances(); return null; }
                host._instances.Add(pipe);
            }
            return host;
        }

        internal void Start(CancellationToken stop)
        {
            _stop = CancellationTokenSource.CreateLinkedTokenSource(stop);
            foreach (NamedPipeServerStream pipe in _instances) _slots.Add(Task.Run(() => RunSlotAsync(pipe, _stop.Token)));
        }

        public async ValueTask DisposeAsync()
        {
            _stop?.Cancel();
            DisposeInstances(); // ends every wait for a client and every read
            try { await Task.WhenAll(_slots).WaitAsync(SlotShutdownGrace); }
            catch (TimeoutException) { Console.WriteLine("DESKTOP=STOP_TIMEOUT"); } // a capture that is still inside WMI; the process ends with the service
            _stop?.Dispose();
        }

        private void DisposeInstances()
        {
            foreach (NamedPipeServerStream pipe in _instances) pipe.Dispose();
        }

        private async Task RunSlotAsync(NamedPipeServerStream pipe, CancellationToken stop)
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    try
                    {
                        await pipe.WaitForConnectionAsync(stop);
                        await ServeSessionAsync(pipe, stop);
                        await WaitForClientToReadAsync(pipe);
                    }
                    catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
                    catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException) { Console.WriteLine("DESKTOP=ABORTED"); } // a client that vanished or never read
                    catch (Exception) when (!stop.IsCancellationRequested) { Console.WriteLine("DESKTOP=SESSION_FAILED"); } // something unforeseen: this connection ends (fail closed), the slot keeps serving
                    if (stop.IsCancellationRequested) return;
                    try { DisconnectForNextClient(pipe); }
                    catch (Exception) when (!stop.IsCancellationRequested)
                    {
                        // A slot that cannot be reset would silently stop serving while still holding the name: stop instead of shrinking (fail closed).
                        Console.WriteLine("DESKTOP=SLOT_RESET_FAILED");
                        TerminateForDesktopFailure();
                    }
                }
            }
            catch (Exception ex) when (stop.IsCancellationRequested && ex is ObjectDisposedException or IOException) { /* STOP disposed the instance */ }
            catch (Exception) { Console.WriteLine("DESKTOP=SLOT_FAILED"); } // this slot is gone, the others keep serving; nothing about the failure leaves the process
        }

        // One connection: the session, then the fixed denied frame when it ended in a refusal.
        private async Task ServeSessionAsync(NamedPipeServerStream pipe, CancellationToken stop)
        {
            if (await RunSessionAsync(pipe, stop) is not { } reason) return;
            Console.WriteLine("DESKTOP_DENY=" + reason);
            await WriteAsync(pipe, BrokerReply.Denied.Body, stop);
        }

        // Returns the reason word of a refusal, or null when the session ended on its own (the client left, or it was idle for too long).
        private async Task<string?> RunSessionAsync(NamedPipeServerStream pipe, CancellationToken stop)
        {
            CaptureThrottle throttle = new(MinCaptureInterval);
            string computerId = "";
            DesktopLeases.LeaseSession? lease = null; // set by an accepted act open; gone with the session
            try
            {
                for (bool opened = false; ; opened = true)
                {
                    byte[]? frame;
                    string? refusal;
                    try { (frame, refusal) = await ReadRequestAsync(pipe, first: !opened, lease?.Token ?? CancellationToken.None, stop); }
                    catch (OperationCanceledException) when (!stop.IsCancellationRequested)
                    {
                        // The lease was replaced by a newer claim or ran out: the session ends with a refusal. Otherwise the idle budget ran out.
                        if (lease is { Token.IsCancellationRequested: true }) return lease.Refusal() ?? DesktopLeases.Deny.Revoked;
                        Console.WriteLine("DESKTOP=IDLE_CLOSED");
                        return null;
                    }
                    catch (EndOfStreamException) { Console.WriteLine("DESKTOP=CLOSED"); return null; }
                    if (frame is null) return refusal;
                    if (!opened)
                    {
                        if (TryParseOpen(frame, _config.Computers, out DesktopOpen? open) is { } openRefusal) return openRefusal;
                        computerId = open!.ComputerId;
                        if (open.IsAct && (lease = Leases.TryOpen(computerId, open.OperationId!, open.LeaseGeneration, out string leaseRefusal)) is null) return leaseRefusal;
                        await WriteAsync(pipe, DesktopOk, stop);
                        Console.WriteLine("DESKTOP=OPENED");
                        if (lease is not null) Console.WriteLine("DESKTOP=ACT");
                    }
                    else
                    {
                        if (TryParseRequest(frame, lease is not null, out DesktopRequest? request) is { } requestRefusal) return requestRefusal;
                        string? failure = request!.IsInput
                            ? await InputAndReplyAsync(pipe, lease!, computerId, request.Steps!, stop)
                            : await CaptureAndReplyAsync(pipe, computerId, request.Width, request.Height, throttle, stop);
                        if (failure is not null) return failure;
                    }
                }
            }
            finally { lease?.Dispose(); }
        }

        // One request frame. On the first frame of a connection the peer is checked right after the length bytes: an impersonation needs a read to have happened, and nothing the client
        // sends after that is read or parsed for a peer that is not the Control Plane. The idle budget covers the whole frame. `leaseEnded` is cancelled when the session's lease ends.
        private async Task<(byte[]? Frame, string? Refusal)> ReadRequestAsync(NamedPipeServerStream pipe, bool first, CancellationToken leaseEnded, CancellationToken stop)
        {
            using CancellationTokenSource idle = CancellationTokenSource.CreateLinkedTokenSource(stop, leaseEnded);
            idle.CancelAfter(DesktopIdleTimeout);
            byte[] size = new byte[4];
            await pipe.ReadExactlyAsync(size, idle.Token);
            if (first && !IsControlPlane(pipe)) return (null, DesktopDeny.Peer);
            int length = BitConverter.ToInt32(size);
            if (length is < 1 or > MaxRequestBytes) return (null, DesktopDeny.FrameSize);
            byte[] frame = new byte[length];
            await pipe.ReadExactlyAsync(frame, idle.Token);
            return (frame, null);
        }

        private bool IsControlPlane(NamedPipeServerStream pipe)
        {
            bool isControlPlane;
            try { isControlPlane = string.Equals(ReadPeerSid(pipe, ImpersonationFault.None), _config.ControlPlaneSid, StringComparison.Ordinal); }
            catch (UnauthorizedAccessException) { isControlPlane = false; } // the token could not be read: fail closed
            Console.WriteLine(isControlPlane ? "DESKTOP_PEER=authenticated" : "DESKTOP_PEER=denied");
            return isControlPlane;
        }

        // Null when the picture was sent (header frame, then the PNG frame); otherwise the reason word of the refusal.
        private async Task<string?> CaptureAndReplyAsync(NamedPipeServerStream pipe, string computerId, int width, int height, CaptureThrottle throttle, CancellationToken stop)
        {
            await Task.Delay(throttle.WaitBeforeNext(), stop);
            if (!await CaptureSlot.WaitAsync(CaptureQueueTimeout, stop)) return DesktopDeny.CaptureBusy;
            DesktopResult result;
            try
            {
                throttle.Started();
                result = await CaptureInSlotAsync(computerId, width, height);
            }
            finally { CaptureSlot.Release(); }
            if (result.Png is not { } png || !result.Ok || png.Length > DesktopLimits.MaxPngBytes) return result.Reason ?? DesktopReason.CaptureFailed;
            await WriteAsync(pipe, Encoding.UTF8.GetBytes($"{{\"ok\":true,\"width\":{width},\"height\":{height},\"bytes\":{png.Length}}}"), stop);
            await WriteAsync(pipe, png, stop);
            return null;
        }

        // The adapter call runs on a pool thread (it blocks on COM for about a second) and is not cancelled half-way.
        private async Task<DesktopResult> CaptureInSlotAsync(string computerId, int width, int height)
        {
#if ALBERA_BROKER_TEST_FAULTS
            Console.WriteLine("DESKTOP_TEST=capture_enter");
            await Task.Delay(DesktopCaptureHold);
#endif
            Task<DesktopResult> capture = Task.Run(() => _desktop.Capture(computerId, width, height));
            if (await Task.WhenAny(capture, Task.Delay(CaptureHungTimeout)) != capture)
            {
                // The COM call cannot be cancelled and still holds the slot (and its buffer): every later capture would be capture_busy until a restart. Restart now.
                Console.WriteLine("DESKTOP=CAPTURE_HUNG");
                TerminateForDesktopFailure();
            }
            DesktopResult result = await capture;
#if ALBERA_BROKER_TEST_FAULTS
            Console.WriteLine("DESKTOP_TEST=capture_exit");
#endif
            return result;
        }

        // Null when the steps were sent (answered { "ok": true }); otherwise the reason word of the refusal. The lease is asked again once this request holds its computer's turn: a newer
        // claim can have replaced it while the request waited behind another one.
        private async Task<string?> InputAndReplyAsync(NamedPipeServerStream pipe, DesktopLeases.LeaseSession lease, string computerId, IReadOnlyList<DesktopStep> steps, CancellationToken stop)
        {
            SemaphoreSlim turn = _inputTurns[computerId];
            if (!await turn.WaitAsync(InputQueueTimeout, stop)) return DesktopDeny.InputBusy;
            DesktopResult result;
            try
            {
                if (lease.Refusal() is { } ended) return ended;
                result = await InputInTurnAsync(computerId, steps);
            }
            finally { turn.Release(); }
            if (!result.Ok) return result.Reason ?? DesktopReason.InputFailed;
            await WriteAsync(pipe, DesktopOk, stop);
            return null;
        }

        // Like the capture: the adapter call runs on a pool thread and is not cancelled half-way (a released key matters more than a prompt STOP).
        private async Task<DesktopResult> InputInTurnAsync(string computerId, IReadOnlyList<DesktopStep> steps)
        {
#if ALBERA_BROKER_TEST_FAULTS
            Console.WriteLine("DESKTOP_TEST=input_enter");
            await Task.Delay(DesktopInputHold);
#endif
            Task<DesktopResult> input = Task.Run(() => _desktop.Input(computerId, steps));
            if (await Task.WhenAny(input, Task.Delay(InputHungTimeout)) != input)
            {
                // The COM call cannot be cancelled and still holds this computer's turn: every later input would be input_busy until a restart. Restart now.
                Console.WriteLine("DESKTOP=INPUT_HUNG");
                TerminateForDesktopFailure();
            }
            DesktopResult result = await input;
#if ALBERA_BROKER_TEST_FAULTS
            Console.WriteLine("DESKTOP_TEST=input_exit");
#endif
            return result;
        }

        private static async Task WriteAsync(NamedPipeServerStream pipe, byte[] frame, CancellationToken stop)
        {
            using CancellationTokenSource budget = CancellationTokenSource.CreateLinkedTokenSource(stop);
            budget.CancelAfter(DesktopWriteTimeout);
            await WriteFrameAsync(pipe, frame, budget.Token);
        }
    }

    // Fail closed: report STOPPED(80) to the SCM, then end the process the way the revert-failure path does (a hung COM thread must not keep it alive).
    // No recovery action is installed, so the Broker stays stopped until the operator starts it again.
    private static void TerminateForDesktopFailure()
    {
        NotifyServiceTermination(ExitDesktopFailed);
        _ = TerminateProcess(GetCurrentProcess(), ExitDesktopFailed);
        Environment.Exit(ExitDesktopFailed); // only reached if TerminateProcess itself failed
    }
}

/// <summary>The 200 ms rule of one session: a capture starts at least `minInterval` after the previous one started.</summary>
internal sealed class CaptureThrottle(TimeSpan minInterval)
{
    private long _lastStart;
    private bool _started;

    /// <summary>How long the next capture has to wait before it may start (zero for the first one of the session).</summary>
    internal TimeSpan WaitBeforeNext()
    {
        if (!_started) return TimeSpan.Zero;
        TimeSpan elapsed = Stopwatch.GetElapsedTime(_lastStart);
        return elapsed >= minInterval ? TimeSpan.Zero : minInterval - elapsed;
    }

    internal void Started()
    {
        _started = true;
        _lastStart = Stopwatch.GetTimestamp();
    }
}
