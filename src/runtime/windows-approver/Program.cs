using System.Security.Principal;

namespace Albera.Approver;

// AlberaApprover.exe (ADR-002 "Receipt v2" / Approval Authority, Proposed / NOT VERIFIED): the human's console for the Approval Authority's approver pipe.
//   AlberaApprover.exe list                    show every pending request with all digest inputs
//   AlberaApprover.exe approve <approvalId>    show it, type yes, verify with Windows Hello (needs a console you type in; there is no way to skip the typed yes)
//   AlberaApprover.exe deny <approvalId>
//   AlberaApprover.exe enroll [--show|--replace]   make / show the Windows Hello key and print the Authority config values
// The pipe, the service and the expected owner are fixed (ServerExpectation.Production); the shipped build has no option, file or environment variable that changes
// them. The shipped build signs with Windows Hello (WindowsHello.cs). The test-faults build (-p:AlberaApproverTestFaults=true, never the published one) does NOT contain the
// Hello code: it adds --test-* options and the fake signer / key store (TestSeam.cs). Exit codes: ExitCodes.cs.
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
#if ALBERA_APPROVER_TEST_FAULTS
        Wiring wiring = new(ServerExpectation.Production, new NotReadyPresenceSigner(), new FakeKeyStore(null, unavailable: true), PipeChannel.DefaultTimeoutMs, !Console.IsInputRedirected);
        if (!TestSeam.TryApply(ref args, ref wiring)) return Usage();
#else
        Wiring wiring = new(ServerExpectation.Production, new WindowsHelloPresenceSigner(), new WindowsHelloKeyStore(), PipeChannel.DefaultTimeoutMs, !Console.IsInputRedirected);
#endif
        if (CommandLine.TryParse(args) is not { } command) return Usage();
        if (command.Verb == "enroll")
            return new EnrollCommand(wiring.KeyStore, CurrentUserSid, Console.Out, Console.Error, Console.In, wiring.Interactive).Run(command.Option);
        ApproverCommands commands = new(new PipeChannel(wiring.Expectation, wiring.TimeoutMs), wiring.Signer, Console.Out, Console.Error, Console.In, () => DateTimeOffset.UtcNow, wiring.Interactive);
        return command.Verb switch
        {
            "list" => await commands.ListAsync(),
            "approve" => await commands.ApproveAsync(command.ApprovalId!),
            _ => await commands.DenyAsync(command.ApprovalId!),
        };
    }

    private static string CurrentUserSid() => WindowsIdentity.GetCurrent().User?.Value ?? "";

    private static int Usage()
    {
        Console.Error.WriteLine(CommandLine.Usage);
        return ExitCodes.BadUsage;
    }
}
