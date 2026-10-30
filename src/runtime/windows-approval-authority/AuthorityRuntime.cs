using System.IO.Pipes;

namespace Albera.ApprovalAuthority;

// Composition: the pipes, the protocol and the core. Both pipes exist (first instance, owner and DACL checked) before AUTHORITY_READY is printed
// and before the service reports RUNNING. If either loop ends (a fatal condition) the other is stopped and the first code is returned.
internal static class AuthorityRuntime
{
    public static long UnixNow() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    public static AuthorityIdentity IdentityOf(AuthorityConfig config) => new(config.Kid, config.Audience, config.PolicyVersion, config.ApproverKeyId);

    /// <summary>The shipped composition: the machine-key signer and the pinned Hello key. 77 when the signing key cannot be opened.</summary>
    public static async Task<int> RunProductionAsync(AuthorityConfig config, CancellationToken stop, Action onReady)
    {
        CngMachineKeySigner signer;
        try { signer = CngMachineKeySigner.Open(config.SigningKeyName, config.SigningProvider); }
        catch (SignerUnavailableException)
        {
            Console.WriteLine("AUTHORITY_FATAL=SIGNER_UNAVAILABLE");
            return ExitCodes.SignerUnavailable;
        }
        using (signer)
        {
            using RsaPresenceVerifier presence = RsaPresenceVerifier.TryCreate(config.ApproverPublicKey) ?? throw new InvalidOperationException(); // the config already passed this check
            AuthorityCore core = new(new PendingStore(UnixNow), signer, presence, IdentityOf(config), UnixNow);
            return await RunAsync(config, core, stop, onReady);
        }
    }

    public static async Task<int> RunAsync(AuthorityConfig config, AuthorityCore core, CancellationToken stop, Action onReady)
    {
        NamedPipeServerStream? submit = PipeHost.CreatePipe(config.SubmitPipe, config.ControlPlaneSid, out int failure);
        if (submit is null) return failure;
        await using (submit)
        {
            NamedPipeServerStream? approver = PipeHost.CreatePipe(config.ApproverPipe, config.ApproverSid, out failure);
            if (approver is null) return failure;
            await using (approver)
            {
                AuthorityProtocol protocol = new(core);
                using CancellationTokenSource either = CancellationTokenSource.CreateLinkedTokenSource(stop);
                Task<int> submitLoop = Task.Run(() => PipeHost.ServeAsync(submit, PipeRole.Submit, config.ControlPlaneSid, protocol.Handle, either.Token));
                Task<int> approverLoop = Task.Run(() => PipeHost.ServeAsync(approver, PipeRole.Approver, config.ApproverSid, protocol.Handle, either.Token));
                Console.WriteLine("AUTHORITY_READY");
                onReady();
                int code = await await Task.WhenAny(submitLoop, approverLoop);
                either.Cancel();
                await Task.WhenAny(Task.WhenAll(submitLoop, approverLoop), Task.Delay(TimeSpan.FromSeconds(2)));
                return code;
            }
        }
    }
}
