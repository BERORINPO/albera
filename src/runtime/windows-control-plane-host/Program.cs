using System.Security.Principal;

// The Control Plane's service host (docs/architecture/control-plane-service.md section 2, Proposed / NOT VERIFIED beyond the lab run of 2026-11-03).
// It is the program the SCM starts as NT SERVICE\AlberaControlPlane. It makes no decision and uses no network: it answers the SCM, starts
// `node.exe <app>\src\runtime\entry.mjs room-service --data-root <dataRoot>` inside a kill-on-close Job object, restarts it a bounded number of times,
// writes its output to size-capped files, and ends the Job on STOP. Nothing here registers, starts or configures a service, creates a folder or
// changes an ACL; the installer (PR7) does that.
//
//   albera-control-plane-host.exe service <config.json>       the service entry (needs the SCM)
//   albera-control-plane-host.exe service-check <config.json>  validate the config exactly as the service would; print one fixed line; start nothing
//   albera-control-plane-host.exe launch-check <config.json>   service-check, then the checks made before every node launch (node hash, ACLs); start nothing
//
// Fixed exit codes (also the service-specific exit code): 64 usage, 73 config rejected, 74 not started by the SCM, 75 unexpected failure,
// 77 the child ended more often than the restart limit allows, 78 node or the app tree refused (missing, hash differs, writable by others),
// 79 the Job object could not be created.
internal static class Program
{
    internal const int ExitUsage = 64;
    internal const int ExitConfigInvalid = 73;
    internal const int ExitNotStartedByScm = 74;
    internal const int ExitUnexpected = 75;
    internal const int ExitRestartLimit = 77;
    internal const int ExitChildRefused = 78;
    internal const int ExitJobFailed = 79;

    private static int Main(string[] args)
    {
#if ALBERA_CPHOST_TEST_SEAMS
        // Test-only: `--trust-sid <sid> <subcommand> ...` makes PathGuard trust that SID in place of the administrators (a host test is an ordinary user).
        // Without it the production rule applies, so a test-seam build also shows the refusal of a file that only the token user can write.
        if (args.Length >= 2 && args[0] == "--trust-sid")
        {
            try { PathGuard.StandInForAdministrators = new SecurityIdentifier(args[1]); }
            catch (ArgumentException) { return ExitUsage; }
            args = args[2..];
        }
#endif
        if (args is ["service", var serviceConfig]) return ServiceHost.Run(serviceConfig);
        if (args is ["service-check", var checkConfig]) return CheckConfig(checkConfig, launch: false);
        if (args is ["launch-check", var launchConfig]) return CheckConfig(launchConfig, launch: true);
#if ALBERA_CPHOST_TEST_SEAMS
        if (args is ["serve", var serveConfig]) return TestSeam.Serve(serveConfig);
#endif
        return ExitUsage;
    }

    private static int CheckConfig(string path, bool launch)
    {
        if (HostConfig.TryLoad(path, out string reason) is not { } config)
        {
            Console.WriteLine($"SERVICE_CONFIG=invalid:{reason}");
            return ExitConfigInvalid;
        }
        Console.WriteLine("SERVICE_CONFIG=ok");
        if (!launch) return 0;
        using LaunchGate gate = LaunchGate.Open(config, out string? refusal);
        if (refusal is not null)
        {
            Console.WriteLine($"CPHOST_LAUNCH=refused:{refusal}");
            return ExitChildRefused;
        }
        Console.WriteLine("CPHOST_LAUNCH=ok");
        return 0;
    }
}
