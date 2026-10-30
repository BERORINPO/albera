#if ALBERA_AUTHORITY_TEST_FAULTS
using System.IO.Pipes;
using System.Security.Principal;

namespace Albera.ApprovalAuthority;

// Test-only (compiled in only with -p:AlberaAuthorityTestFaults=true; the published build pins that off, so none of this exists there).
//   serve-loop <config> <real|fake> <ttlSeconds>   the real pipes and protocol with an in-memory signer (FakeReceiptSigner) and either the real RSA
//                                                  presence verifier ("real", key from the config) or FakePresenceVerifier ("fake"). Prints
//                                                  AUTHORITY_PUBLIC_KEY=<base64 SPKI of the fake signer> and AUTHORITY_READY. End of stdin plays STOP.
//                                                  The config may name the same SID for both pipes (a test has one user).
//   request <pipeName> <base64 json> [declaredLen]  one client: connect with SQOS identification, send one frame, print the reply JSON.
//                                                  `declaredLen` lies about the frame length and sends the header only (the oversize-frame test).
internal static partial class Program
{
    private static async Task<int> ServeLoopForTestAsync(string configPath, string presenceMode, string ttlSeconds)
    {
        if (AuthorityConfig.TryLoad(configPath, strictSeparation: false, out string reason) is not { } config)
        {
            Console.WriteLine($"SERVICE_CONFIG=invalid:{reason}");
            return ExitCodes.ConfigInvalid;
        }
        using FakeReceiptSigner signer = new();
        using RsaPresenceVerifier? real = RsaPresenceVerifier.TryCreate(config.ApproverPublicKey);
        IHumanPresenceVerifier presence = presenceMode == "fake" ? new FakePresenceVerifier() : real!;
        AuthorityCore core = new(new PendingStore(AuthorityRuntime.UnixNow, int.Parse(ttlSeconds, System.Globalization.CultureInfo.InvariantCulture)), signer, presence, AuthorityRuntime.IdentityOf(config), AuthorityRuntime.UnixNow);
        Console.WriteLine("AUTHORITY_PUBLIC_KEY=" + Convert.ToBase64String(signer.PublicKeySpki));
        using CancellationTokenSource stop = new();
        _ = Task.Run(() => { Console.In.ReadToEnd(); stop.Cancel(); });
        int code = await AuthorityRuntime.RunAsync(config, core, stop.Token, () => { });
        Console.WriteLine("AUTHORITY_STOPPED");
        return code;
    }

    private static async Task<int> RequestForTestAsync(string pipeName, string jsonBase64, string? declaredLength)
    {
        try
        {
            byte[] json = Convert.FromBase64String(jsonBase64);
            using CancellationTokenSource limit = new(TimeSpan.FromSeconds(10));
            using NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
            await client.ConnectAsync(5000, limit.Token);
            int length = declaredLength is null ? json.Length : int.Parse(declaredLength, System.Globalization.CultureInfo.InvariantCulture);
            await client.WriteAsync(BitConverter.GetBytes(length), limit.Token);
            if (length == json.Length) await client.WriteAsync(json, limit.Token); // a lying header is sent alone: the server refuses it before reading a body
            await client.FlushAsync(limit.Token);
            byte[] size = new byte[4];
            await client.ReadExactlyAsync(size, limit.Token);
            byte[] reply = new byte[BitConverter.ToInt32(size)];
            await client.ReadExactlyAsync(reply, limit.Token);
            Console.WriteLine("REPLY=" + System.Text.Encoding.UTF8.GetString(reply));
            return 0;
        }
        catch (Exception ex) when (ex is IOException or TimeoutException or OperationCanceledException or UnauthorizedAccessException or FormatException)
        {
            Console.WriteLine("CLIENT_ERROR=" + ex.GetType().Name);
            return 1;
        }
    }
}
#endif
