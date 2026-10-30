namespace Albera.Approver;

// AlberaApprover.exe (ADR-002 "Receipt v2" / Approval Authority, Proposed / NOT VERIFIED): the human's console for the Approval Authority's approver pipe.
//   AlberaApprover.exe list                    show every pending request with all digest inputs
//   AlberaApprover.exe approve <approvalId> [--yes]
//   AlberaApprover.exe deny <approvalId>
// The pipe, the service and the expected owner are fixed (ServerExpectation.Production); the shipped build has no option, file or environment variable that changes
// them. The test-faults build (-p:AlberaApproverTestFaults=true, never the published one) adds --test-* options and the fake presence signer (TestSeam.cs).
// Exit codes: ExitCodes.cs.
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        try { return await RunAsync(args); }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Console.Error.WriteLine("error: internal"); // fixed word: the exception text could carry request content
            return ExitCodes.Internal;
        }
    }

    private static async Task<int> RunAsync(string[] args)
    {
        ServerExpectation expectation = ServerExpectation.Production;
        IPresenceSigner signer = new NotBuiltPresenceSigner();
        int timeoutMs = PipeChannel.DefaultTimeoutMs;
#if ALBERA_APPROVER_TEST_FAULTS
        if (!TestSeam.TryApply(ref args, ref expectation, ref signer, ref timeoutMs)) return Usage();
#endif
        if (CommandLine.TryParse(args) is not { } command) return Usage();
        ApproverCommands commands = new(new PipeChannel(expectation, timeoutMs), signer, Console.Out, Console.Error, Console.In, () => DateTimeOffset.UtcNow);
        return command.Verb switch
        {
            "list" => await commands.ListAsync(),
            "approve" => await commands.ApproveAsync(command.ApprovalId!, command.AssumeYes),
            _ => await commands.DenyAsync(command.ApprovalId!),
        };
    }

    private static int Usage()
    {
        Console.Error.WriteLine(CommandLine.Usage);
        return ExitCodes.BadUsage;
    }
}
