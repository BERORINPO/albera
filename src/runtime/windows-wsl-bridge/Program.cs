using System.Security.Principal;

namespace Albera.WslBridge;

// The WSL bridge (ADR-012, Proposed / NOT VERIFIED). Run by the owner, in the owner's session, without elevation: the only program that starts wsl.exe.
//   albera-wsl-bridge serve <absolute config path> [--stop-on-stdin-eof]
// It prints fixed words only (BRIDGE_READY, BRIDGE_CONFIG=invalid:<word>, BRIDGE_FATAL=<word>, and one line per verb). Exit codes: 0 stopped, 64 usage, 65 config invalid, 66 a path is not trusted,
// 70 the pipe name is taken, 72 the pipe cannot be owned by this process's SID, 73 the state file cannot be used, 74 a pipe instance died (every run was stopped first), 77 the wrong identity (BRIDGE_FATAL=elevated
// or control_plane_is_self: an elevated bridge would hand a guest that escapes the administrator's token, and a Control Plane that is the bridge's own account has no boundary to cross).
// `--stop-on-stdin-eof` ends the bridge (and every run) when its standard input closes: how a parent process plays "stop". Without it the bridge runs until Ctrl+C.
internal static class Program
{
    private static readonly TimeSpan ReapEvery = TimeSpan.FromSeconds(5);

    public static async Task<int> Main(string[] args)
    {
        IEnumerable<SecurityIdentifier> extraTrusted = [];
        bool selfAsControlPlane = false;
#if ALBERA_WSL_BRIDGE_TEST_SEAMS
        (args, extraTrusted) = TestSeam.Take(args);
        selfAsControlPlane = extraTrusted.Any(); // a host test has one account: the seam is the only way to be both
#endif
        if (args.Length < 2 || args[0] != "serve" || args.Length > 3 || (args.Length == 3 && args[2] != "--stop-on-stdin-eof")) { Console.WriteLine("BRIDGE_FATAL=usage"); return 64; }
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("BRIDGE_FATAL=not_windows"); return 64; }
        PathGuard adminGuard = PathGuard.AdminOnly(extraTrusted);
        BridgeConfig? config = BridgeConfig.TryLoad(args[1], adminGuard, out string reason);
        if (config is null) { Console.WriteLine("BRIDGE_CONFIG=invalid:" + reason); return reason.EndsWith("untrusted", StringComparison.Ordinal) ? 66 : 65; }
        using WindowsIdentity self = WindowsIdentity.GetCurrent();
        bool elevated = new WindowsPrincipal(self).IsInRole(WindowsBuiltInRole.Administrator); // a filtered (UAC) token holds Administrators as deny-only, so the signed-in owner passes
        if (BridgeConfig.RefuseIdentity(config.ControlPlaneSid, self.User!, elevated, selfAsControlPlane) is { } identity) { Console.WriteLine("BRIDGE_FATAL=" + identity); return 77; }
        PathGuard ownerGuard = PathGuard.OwnerToo(self.User!, extraTrusted);
        if (config.CheckPaths(adminGuard, ownerGuard) is { } untrusted) { Console.WriteLine("BRIDGE_CONFIG=invalid:" + untrusted); return 66; }
        return await ServeAsync(config, new LeaseFloorFile(config.LeaseFloorPath, adminGuard), args.Length == 3);
    }

    private static async Task<int> ServeAsync(BridgeConfig config, LeaseFloorFile leaseFloor, bool stopOnStdinEof)
    {
        Func<long> clock = () => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        using OperationLedger? ledger = OperationLedger.TryOpen(Path.Combine(config.StateFolder, "operations.log"), clock);
        using BrokerKey? key = BrokerKey.TryCreate(config.BrokerKeyId, config.BrokerSpki);
        if (ledger is null || key is null) { Console.WriteLine("BRIDGE_FATAL=state"); return 73; }
        string scratch = Path.Combine(config.StateFolder, "git-home");
        Directory.CreateDirectory(scratch);
        Bridge bridge = new(config, new WslExeHost(), new GitRepositories(config.GitPath, scratch), ledger, key, clock, Limits.Default, leaseFloor.Read, Console.WriteLine);
        await using PipeServer? pipe = PipeServer.Create(config.PipeName, config.ControlPlaneSid, bridge, Limits.Default, Console.WriteLine, out int failure);
        if (pipe is null) { Console.WriteLine(failure == 72 ? "BRIDGE_FATAL=pipe_owner" : "BRIDGE_FATAL=pipe_taken"); return failure; }
        using CancellationTokenSource stop = new();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };
        await bridge.SweepLeftoversAsync();
        pipe.Start(stop.Token);
        Console.WriteLine("BRIDGE_READY");
        Task reaper = ReapAsync(bridge, stop.Token);
        if (stopOnStdinEof) _ = Task.Run(() => { while (Console.In.Read() >= 0) { } stop.Cancel(); });
        await Task.WhenAny(Task.Delay(Timeout.Infinite, stop.Token), pipe.Failed);
        bool slotDied = pipe.Failed.IsCompleted;
        stop.Cancel();
        await reaper;
        await bridge.StopAllAsync();
        Console.WriteLine(slotDied ? "BRIDGE_FATAL=pipe_slot" : "BRIDGE_STOPPED");
        return slotDied ? 74 : 0;
    }

    private static async Task ReapAsync(Bridge bridge, CancellationToken stop)
    {
        using PeriodicTimer timer = new(ReapEvery);
        try
        {
            while (await timer.WaitForNextTickAsync(stop))
            {
                try { await bridge.ReapExpiredAsync(); }
                catch (Exception ex) when (ex is not (OutOfMemoryException or OperationCanceledException)) { Console.WriteLine("REAP=failed"); } // the next tick still comes
            }
        }
        catch (OperationCanceledException) { }
    }
}
