namespace Albera.ApprovalAuthority;

// Entry points (ADR-002 "Receipt v2", Proposed / NOT VERIFIED):
//   albera-approval-authority.exe service <config.json>        the Windows service process (ServiceHost.cs); started by the SCM only
//   albera-approval-authority.exe service-check <config.json>  validate the config exactly as the service would, print one fixed line, change nothing
// The test-faults build (-p:AlberaAuthorityTestFaults=true, never the published one) adds serve-loop and request (TestSeam.cs). Anything else exits 64.
internal static partial class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "service") return ServiceHost.Run(args[1]);
        if (args.Length == 2 && args[0] == "service-check") return CheckServiceConfig(args[1]);
#if ALBERA_AUTHORITY_TEST_FAULTS
        if (args.Length == 4 && args[0] == "serve-loop") return await ServeLoopForTestAsync(args[1], args[2], args[3]);
        if (args.Length is 3 or 4 && args[0] == "request") return await RequestForTestAsync(args[1], args[2], args.Length == 4 ? args[3] : null);
#endif
        await Task.CompletedTask;
        return ExitCodes.BadUsage;
    }

    private static int CheckServiceConfig(string configPath)
    {
        if (AuthorityConfig.TryLoad(configPath, strictSeparation: true, out string reason) is null)
        {
            Console.WriteLine($"SERVICE_CONFIG=invalid:{reason}");
            return ExitCodes.ConfigInvalid;
        }
        Console.WriteLine("SERVICE_CONFIG=ok");
        return 0;
    }
}
