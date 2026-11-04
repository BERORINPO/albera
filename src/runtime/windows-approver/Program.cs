using System.Security.Cryptography;
using System.Security.Principal;

namespace Albera.Approver;

// AlberaApprover.exe (ADR-002 "Receipt v2" / Approval Authority, Proposed / NOT VERIFIED): the human's console for the Approval Authority's approver pipe.
//   AlberaApprover.exe list                    show every pending request with all digest inputs
//   AlberaApprover.exe approve <approvalId>    show it, type yes, verify with Windows Hello (needs a console you type in; there is no way to skip the typed yes)
//   AlberaApprover.exe deny <approvalId>
//   AlberaApprover.exe enroll [--show|--replace]   make / show the Windows Hello key and print the Authority config values
//   AlberaApprover.exe enroll --check [--expect <approverKeyId>]   sign a fresh self-check message with the EXISTING Hello key and verify it locally (no Authority, nothing sent)
//   AlberaApprover.exe enroll --webauthn --accept-unattested   make a WebAuthn credential (works over Remote Desktop), print its key record and write the record file the installer's set-approver reads
//   AlberaApprover.exe keys list | keys remove <keyId>   the approver keys the Authority accepts (a remove is signed by a registered key; keys are added only by the elevated set-approver)
//   AlberaApprover.exe policy [show]           show the Authority's tier policy
//   AlberaApprover.exe policy set <careful|standard> [--prompt <action>]...   ask the Authority for a new tier policy; a change that lets an action skip a person needs a typed yes and Hello
//   AlberaApprover.exe --tray                  GUI mode: sit in the notification area, watch the pending list (every 2 s) and open one window per request (match code, then Hello); `approve` stays as the fallback
// The pipe, the service and the expected owner are fixed (ServerExpectation.Production); the shipped build has no option, file or environment variable that changes
// them. The shipped build signs with a registered WebAuthn key (WebAuthn.cs; works over Remote Desktop) or, on a local session with no WebAuthn key registered, with Windows Hello
// (WindowsHello.cs). The test-faults build (-p:AlberaApproverTestFaults=true, never the published one) does NOT contain the Hello or WebAuthn platform code: it adds --test-* options and the fake
// signer / key store / software authenticator (TestSeam.cs). Exit codes: ExitCodes.cs.
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
        Wiring wiring = new(ServerExpectation.Production, new WindowsHelloPresenceSigner(), new WindowsHelloKeyStore(), PipeChannel.DefaultTimeoutMs, !Console.IsInputRedirected,
            new WebAuthnKit(new PlatformWebAuthn(), () => System.Windows.Forms.SystemInformation.TerminalServerSession, new KeyRecordStore(KeyRecordStore.DefaultDirectory))); // GetSystemMetrics(SM_REMOTESESSION), read at each signing attempt: Hello does not work there
#endif
        if (CommandLine.TryParse(args) is not { } command) return Usage();
        if (command.Verb == "tray") return TrayApp.Run(wiring);
        if (command.Option == "check")
            return new SelfCheckCommand(wiring.KeyStore, wiring.Signer, CurrentUserSid, () => RandomNumberGenerator.GetBytes(SelfCheckMessage.NonceBytes), Console.Out, Console.Error, wiring.Interactive).Run(command.Expect);
        if (command.Option == "webauthn")
            return new EnrollWebAuthnCommand(wiring.WebAuthn, CurrentUserSid, Console.Out, Console.Error, wiring.Interactive).Run(command.AcceptUnattested);
        if (command.Verb == "enroll")
            return new EnrollCommand(wiring.KeyStore, CurrentUserSid, Console.Out, Console.Error, Console.In, wiring.Interactive).Run(command.Option, command.AcceptUnattested);
        if (command.Verb == "keys")
        {
            KeysCommand keys = new(new PipeChannel(wiring.Expectation, wiring.TimeoutMs), wiring.Signer, wiring.WebAuthn, Console.Out, Console.Error, Console.In, wiring.Interactive);
            return command.Option == "list" ? await keys.ListAsync() : await keys.RemoveAsync(command.KeyId!);
        }
        if (command.Verb == "policy")
        {
            PolicyCommand policy = new(new PipeChannel(wiring.Expectation, wiring.TimeoutMs), wiring.Signer, Console.Out, Console.Error, Console.In, wiring.Interactive, wiring.WebAuthn);
            return command.Option == "show" ? await policy.ShowAsync() : await policy.SetAsync(command.Tier!, command.Prompts!);
        }
        ApproverCommands commands = new(new PipeChannel(wiring.Expectation, wiring.TimeoutMs), wiring.Signer, Console.Out, Console.Error, Console.In, () => DateTimeOffset.UtcNow, wiring.Interactive, wiring.WebAuthn);
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
