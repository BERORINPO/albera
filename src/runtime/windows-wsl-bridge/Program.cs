using System.Security.Principal;

namespace Albera.WslBridge;

// The WSL bridge (ADR-012, Proposed / NOT VERIFIED). Run by the owner, in the owner's session, without elevation: the only program that starts wsl.exe.
//   albera-wsl-bridge serve <absolute config path> [--stop-on-stdin-eof]
// It prints fixed words only (BRIDGE_READY, BRIDGE_CONFIG=invalid:<word>, BRIDGE_FATAL=<word>, and one line per verb). Exit codes: 0 stopped, 64 usage, 65 config invalid, 66 a path is not trusted,
// 70 the pipe name is taken, 72 the pipe cannot be owned by this process's SID, 73 the state file cannot be used.
// `--stop-on-stdin-eof` ends the bridge (and every run) when its standard input closes: how a parent process plays "stop". Without it the bridge runs until Ctrl+C.
internal static class Program
{
    private static readonly TimeSpan ReapEvery = TimeSpan.FromSeconds(5);

    public static async Task<int> Main(string[] args)
    {
        IEnumerable<SecurityIdentifier> extraTrusted = [];
#if ALBERA_WSL_BRIDGE_TEST_SEAMS
        (args, extraTrusted) = TestSeam.Take(args);
#endif
        if (args.Length < 2 || args[0] != "serve" || args.Length > 3 || (args.Length == 3 && args[2] != "--stop-on-stdin-eof")) { Console.WriteLine("BRIDGE_FATAL=usage"); return 64; }
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("BRIDGE_FATAL=not_windows"); return 64; }
        PathGuard adminGuard = PathGuard.AdminOnly(extraTrusted);
        BridgeConfig? config = BridgeConfig.TryLoad(args[1], adminGuard, out string reason);
        if (config is null) { Console.WriteLine("BRIDGE_CONFIG=invalid:" + reason); return reason.EndsWith("untrusted", StringComparison.Ordinal) ? 66 : 65; }
        using WindowsIdentity self = WindowsIdentity.GetCurrent();
        PathGuard ownerGuard = PathGuard.OwnerToo(self.User!, extraTrusted);
        if (config.CheckPaths(adminGuard, ownerGuard) is { } untrusted) { Console.WriteLine("BRIDGE_CONFIG=invalid:" + untrusted); return 66; }
        return await ServeAsync(config, args.Length == 3);
    }

    private static async Task<int> ServeAsync(BridgeConfig config, bool stopOnStdinEof)
    {
        Func<long> clock = () => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        using OperationLedger? ledger = OperationLedger.TryOpen(Path.Combine(config.StateFolder, "operations.log"), clock);
        using BrokerKey? key = BrokerKey.TryCreate(config.BrokerKeyId, config.BrokerSpki);
        if (ledger is null || key is null) { Console.WriteLine("BRIDGE_FATAL=state"); return 73; }
        string scratch = Path.Combine(config.StateFolder, "git-home");
        Directory.CreateDirectory(scratch);
        Bridge bridge = new(config, new WslExeHost(), new GitRepositories(config.GitPath, scratch), ledger, key, clock, Limits.Default, Console.WriteLine);
        await using PipeServer? pipe = PipeServer.Create(config.PipeName, config.ControlPlaneSid, bridge, Limits.Default, Console.WriteLine, out int failure);
        if (pipe is null) { Console.WriteLine(failure == 72 ? "BRIDGE_FATAL=pipe_owner" : "BRIDGE_FATAL=pipe_taken"); return failure; }
        using CancellationTokenSource stop = new();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };
        await bridge.SweepLeftoversAsync();
        pipe.Start(stop.Token);
        Console.WriteLine("BRIDGE_READY");
        Task reaper = ReapAsync(bridge, stop.Token);
        if (stopOnStdinEof) _ = Task.Run(() => { while (Console.In.Read() >= 0) { } stop.Cancel(); });
        try { await Task.Delay(Timeout.Infinite, stop.Token); }
        catch (OperationCanceledException) { }
        await reaper;
        await bridge.StopAllAsync();
        Console.WriteLine("BRIDGE_STOPPED");
        return 0;
    }

    private static async Task ReapAsync(Bridge bridge, CancellationToken stop)
    {
        using PeriodicTimer timer = new(ReapEvery);
        try { while (await timer.WaitForNextTickAsync(stop)) await bridge.ReapExpiredAsync(); }
        catch (OperationCanceledException) { }
    }
}
