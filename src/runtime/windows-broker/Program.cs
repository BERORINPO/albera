using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Win32.SafeHandles;

internal static partial class Program
{
    private const int MaxFrameLength = 2048; // ADR-002: 2 KiB maximum protocol message
    private const string Denied = "{\"ok\":false,\"code\":\"denied\"}";

    // Fixed process exit codes (ADR-002 negative test matrix). 0 = served one request, 64 = bad usage.
    private const int ExitPipeUnavailable = 70;           // pipe name already exists (squatting / second Broker): refuse to start
    private const int ExitImpersonationRevertFailed = 71; // RevertToSelf failed or lied: terminate, never handle another request
    private const int ExitPipeOwnerUnavailable = 72;      // the pipe owner could not be set to this process's own SID: clients cannot verify us, refuse to start
    // Service mode (the `service` entry; see ServiceHost.cs). Used as the service-specific exit code and as the process exit code.
    internal const int ExitServiceConfigInvalid = 73; // the config file is missing, unreadable, malformed or has a rejected value: nothing is served
    internal const int ExitNotStartedByScm = 74;      // not started by the service control manager (StartServiceCtrlDispatcher failed): nothing is created
    internal const int ExitServiceLoopFailed = 75;    // an unexpected exception ended the serve loop: fail closed, stop the service
    private const int ErrorInvalidOwner = 1307;

    private enum ImpersonationFault { None, RevertFails, RevertThrows, RevertLies }

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "restricted-client") return RunRestrictedClient(args[1]);
        if (args.Length == 2 && args[0] == "inspect") return await InspectAsync(args[1]);
        if (args.Length == 7 && args[0] == "serve") return await ServeAsync(args, ImpersonationFault.None);
        if (args.Length == 2 && args[0] == "service") return ServiceHost.Run(args[1]);
        if (args.Length == 2 && args[0] == "service-check") return CheckServiceConfig(args[1]);
#if ALBERA_BROKER_TEST_FAULTS
        // Test-only failure injection. Compiled in only when the test builds with -p:AlberaBrokerTestFaults=true;
        // the shipped build (npm run build:windows-broker) has no such subcommand and answers 64.
        if (args.Length == 8 && args[0] == "serve-fault" &&
            Enum.TryParse(args[1], ignoreCase: false, out ImpersonationFault fault) && Enum.IsDefined(fault))
            return await ServeAsync(["serve", .. args[2..]], fault);
        if (args.Length == 2 && args[0] == "serve-loop") return await ServeLoopForTestAsync(args[1]);
#endif
        return 64;
    }

    private static async Task<int> ServeAsync(string[] args, ImpersonationFault fault)
    {
        string pipeName = args[1];
        BrokerSettings settings = new(args[2], Convert.FromBase64String(args[3]), args[4],
            long.Parse(args[5], System.Globalization.CultureInfo.InvariantCulture), args[6] == "hold", fault);
        NamedPipeServerStream? pipe = CreateBrokerPipe(pipeName, settings.AllowedSid, out int failure);
        if (pipe is null) return failure;
        await using (pipe)
        {
            Console.WriteLine("BROKER_READY");
            await pipe.WaitForConnectionAsync().WaitAsync(TimeSpan.FromSeconds(20));
            await HandleConnectionAsync(pipe, settings, CancellationToken.None);
            return 0;
        }
    }

    private sealed record BrokerSettings(string Database, byte[] PublicKey, string AllowedSid, long Generation, bool Hold, ImpersonationFault Fault);

    // maxNumberOfServerInstances == 1 makes .NET create the pipe with FILE_FLAG_FIRST_PIPE_INSTANCE, so an
    // existing instance of this name (squatter, or another Broker) fails creation. Keep it at 1.
    // The owner is set to this process's own user SID (not the token's default owner, which is Administrators for an
    // elevated token) so that the Control Plane client can compare GetSecurityInfo(OWNER) with the SID it expects.
    // Returns null with a fixed exit code (70 pipe name taken, 72 owner could not be set) when the pipe cannot be served.
    private static NamedPipeServerStream? CreateBrokerPipe(string pipeName, string allowedSid, out int failure)
    {
        failure = 0;
        NamedPipeServerStream pipe;
        try
        {
            pipe = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, OwnedBySelf(out SecurityIdentifier self, allowedSid));
            if (!self.Equals(pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)))) { pipe.Dispose(); failure = PipeOwnerUnavailable(); return null; }
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or InvalidOperationException)
        {
            if (ex is IOException io && (io.HResult & 0xffff) == ErrorInvalidOwner || ex is InvalidOperationException) failure = PipeOwnerUnavailable();
            else
            {
                Console.WriteLine("BROKER_FATAL=PIPE_UNAVAILABLE");
                failure = ExitPipeUnavailable;
            }
            return null;
        }
        return pipe;
    }

    // One connected client: read one frame, check the peer, answer. `ioToken` bounds the frame read and the answer write only (the service loop's
    // stop request and per-connection deadline); the claim itself is never cancelled half-way.
    private static async Task HandleConnectionAsync(NamedPipeServerStream pipe, BrokerSettings settings, CancellationToken ioToken)
    {
        byte[] response;
        try
        {
            byte[] frame = await ReadFrameAsync(pipe, ioToken);
            string? peerSid = ReadPeerSid(pipe, settings.Fault);
            Console.WriteLine(peerSid == settings.AllowedSid ? "PEER=authenticated" : "PEER=denied");
            response = string.Equals(peerSid, settings.AllowedSid, StringComparison.Ordinal)
                ? await ValidateAndClaimAsync(frame, settings.Database, settings.PublicKey, settings.Generation, settings.Hold)
                : Encoding.UTF8.GetBytes(Denied);
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or
                                   CryptographicException or FormatException or UnauthorizedAccessException or
                                   SqliteException or ArgumentException)
        {
            response = Encoding.UTF8.GetBytes(Denied);
            Console.WriteLine("REQUEST=DENIED");
        }
        await WriteFrameAsync(pipe, response, ioToken);
    }

    private static int PipeOwnerUnavailable()
    {
        Console.WriteLine("BROKER_FATAL=PIPE_OWNER_UNAVAILABLE");
        return ExitPipeOwnerUnavailable;
    }

    // What PipeOptions.CurrentUserOnly would set (this user, full control, nobody else), plus an explicit owner. CurrentUserOnly cannot be combined
    // with a PipeSecurity. The SID is read from this process's token. When the configured Control Plane SID is a different principal (service mode)
    // it gets exactly one more ACE, ControlPlaneAccess; a malformed, aliased or group SID adds nothing (the peer check below denies everyone anyway).
    private static PipeSecurity OwnedBySelf(out SecurityIdentifier self, string controlPlaneSid)
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        self = identity.User ?? throw new InvalidOperationException();
        PipeSecurity security = new();
        security.SetOwner(self);
        security.AddAccessRule(new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow));
        if (TryParseSid(controlPlaneSid) is { } controlPlane && !controlPlane.Equals(self))
            security.AddAccessRule(new PipeAccessRule(controlPlane, ControlPlaneAccess, AccessControlType.Allow));
        return security;
    }

    // FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE = 0x00120083 (ADR-002). Never FILE_APPEND_DATA, which is
    // FILE_CREATE_PIPE_INSTANCE on a pipe, and never a generic right.
    private const PipeAccessRights ControlPlaneAccess = (PipeAccessRights)0x00120083;

    // Only a single principal may get the Control Plane ACE: a virtual service account (S-1-5-80-...) or a user/computer account SID, written
    // out in full. SDDL aliases (WD, AU, BU, BA) and group SIDs such as S-1-1-0 would let anyone take the Broker's one connection.
    internal static SecurityIdentifier? TryParseSid(string value)
    {
        try
        {
            SecurityIdentifier sid = new(value);
            return sid.Value == value && (sid.Value.StartsWith("S-1-5-80-", StringComparison.Ordinal) || sid.IsAccountSid()) ? sid : null;
        }
        catch (ArgumentException) { return null; }
    }

    // Impersonate, read the peer SID and revert on the same thread (no await in between: a continuation could
    // resume on another thread and leave this one carrying the client token).
    private static string? ReadPeerSid(NamedPipeServerStream pipe, ImpersonationFault fault)
    {
        if (!ImpersonateNamedPipeClient(pipe.SafePipeHandle)) throw new UnauthorizedAccessException();
        try
        {
            using WindowsIdentity identity = WindowsIdentity.GetCurrent(ifImpersonating: true)
                ?? throw new UnauthorizedAccessException();
            return identity.User?.Value;
        }
        finally { RevertOrTerminate(fault); }
    }

    // Fail closed: if the revert fails, throws, or the thread still carries a token afterwards, the process dies
    // here with a fixed code. The caller never sees a return, so no response is written and no claim is made.
    private static void RevertOrTerminate(ImpersonationFault fault)
    {
        bool reverted;
        try
        {
            reverted = RevertImpersonation(fault);
            if (reverted)
            {
                using WindowsIdentity? leaked = WindowsIdentity.GetCurrent(ifImpersonating: true);
                reverted = leaked is null;
            }
        }
        catch (Exception) { reverted = false; }
        if (reverted) return;
        Console.WriteLine("BROKER_FATAL=IMPERSONATION_REVERT_FAILED");
        NotifyServiceTermination(ExitImpersonationRevertFailed);
        _ = TerminateProcess(GetCurrentProcess(), ExitImpersonationRevertFailed);
        Environment.Exit(ExitImpersonationRevertFailed); // only reached if TerminateProcess itself failed
    }

    private static bool RevertImpersonation(ImpersonationFault fault)
    {
#if ALBERA_BROKER_TEST_FAULTS
        // Each injected fault skips the real RevertToSelf, so the thread genuinely stays impersonated.
        switch (fault)
        {
            case ImpersonationFault.RevertFails: return false;
            case ImpersonationFault.RevertThrows: throw new InvalidOperationException();
            case ImpersonationFault.RevertLies: return true;
        }
#endif
        return RevertToSelf();
    }

    private static async Task<byte[]> ValidateAndClaimAsync(byte[] frame, string database, byte[] key, long currentGeneration, bool hold)
    {
        using JsonDocument envelope = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 4 });
        JsonElement root = envelope.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
            !root.TryGetProperty("receipt", out JsonElement receiptElement) || receiptElement.ValueKind != JsonValueKind.String ||
            !root.TryGetProperty("signature", out JsonElement signatureElement) || signatureElement.ValueKind != JsonValueKind.String)
            return Encoding.UTF8.GetBytes(Denied);
        byte[] receipt = Convert.FromBase64String(receiptElement.GetString()!);
        byte[] signature = Convert.FromBase64String(signatureElement.GetString()!);
        using ECDsa authority = ECDsa.Create();
        authority.ImportSubjectPublicKeyInfo(key, out int used);
        if (used != key.Length || !authority.VerifyData(receipt, signature, HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) { Console.WriteLine("DENY=signature"); return Encoding.UTF8.GetBytes(Denied); }

        using JsonDocument signed = JsonDocument.Parse(receipt, new JsonDocumentOptions { MaxDepth = 4 });
        JsonElement r = signed.RootElement;
        string[] fields = ["issuer", "audience", "approvalId", "receiptId", "operationId", "idempotencyKey", "action", "actionDigest", "leaseId", "leaseGeneration", "policyVersion", "expiresAt"];
        if (r.ValueKind != JsonValueKind.Object || r.EnumerateObject().Count() != fields.Length || fields.Any(x => !r.TryGetProperty(x, out _))) { Console.WriteLine("DENY=schema"); return Encoding.UTF8.GetBytes(Denied); }
        string Get(string name) => RequiredString(r, name);
        string action = Get("action");
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(action)));
        long leaseGeneration = r.GetProperty("leaseGeneration").GetInt64();
        if (Get("issuer") != "albera-test-approval-authority" || Get("audience") != "ALBERA-HostBroker" ||
            action != "synthetic.noop" || Get("actionDigest") != digest || Get("leaseId") != "test-lease" ||
            leaseGeneration != currentGeneration || Get("policyVersion") != "test-policy-v1" ||
            r.GetProperty("expiresAt").GetInt64() <= DateTimeOffset.UtcNow.ToUnixTimeSeconds() ||
            fields.Where(x => x is "approvalId" or "receiptId" or "operationId" or "idempotencyKey").Any(x => string.IsNullOrWhiteSpace(Get(x))))
        { Console.WriteLine("DENY=receipt-policy"); return Encoding.UTF8.GetBytes(Denied); }

        await using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database, Mode = SqliteOpenMode.ReadWriteCreate }.ToString());
        await db.OpenAsync();
        await using (var setup = db.CreateCommand())
        {
            setup.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS claims (operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, lease_generation INTEGER NOT NULL, state TEXT NOT NULL);";
            await setup.ExecuteNonQueryAsync();
        }
        await using var tx = await db.BeginTransactionAsync();
        await using var claim = db.CreateCommand();
        claim.Transaction = (SqliteTransaction)tx;
        claim.CommandText = "INSERT INTO claims(operation_id, receipt_id, approval_id, digest, lease_generation, state) VALUES ($o,$r,$a,$d,$g,'UNKNOWN');";
        claim.Parameters.AddWithValue("$o", Get("operationId")); claim.Parameters.AddWithValue("$r", Get("receiptId"));
        claim.Parameters.AddWithValue("$a", Get("approvalId")); claim.Parameters.AddWithValue("$d", digest);
        claim.Parameters.AddWithValue("$g", leaseGeneration);
        try { await claim.ExecuteNonQueryAsync(); }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 19) { Console.WriteLine("DENY=duplicate"); return Encoding.UTF8.GetBytes(Denied); }
        await tx.CommitAsync();
        Console.WriteLine("CLAIM=PERSISTED_UNKNOWN");
        if (hold) await Task.Delay(Timeout.InfiniteTimeSpan);
        return Encoding.UTF8.GetBytes("{\"ok\":true,\"state\":\"UNKNOWN\",\"action\":\"synthetic.noop\"}");
    }

    private static string RequiredString(JsonElement element, string name) => element.GetProperty(name).ValueKind == JsonValueKind.String ? element.GetProperty(name).GetString()! : throw new JsonException();
    private static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken token)
    {
        byte[] size = new byte[4]; await stream.ReadExactlyAsync(size, token);
        int length = BitConverter.ToInt32(size); if (length < 1 || length > MaxFrameLength) throw new InvalidDataException();
        byte[] frame = new byte[length]; await stream.ReadExactlyAsync(frame, token); return frame;
    }
    private static async Task WriteFrameAsync(Stream stream, byte[] frame, CancellationToken token)
    {
        await stream.WriteAsync(BitConverter.GetBytes(frame.Length), token); await stream.WriteAsync(frame, token); await stream.FlushAsync(token);
    }
    private static async Task<int> InspectAsync(string database)
    {
        if (!File.Exists(database)) { Console.WriteLine("0"); return 0; }
        await using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database, Mode = SqliteOpenMode.ReadOnly }.ToString());
        await db.OpenAsync(); await using var command = db.CreateCommand(); command.CommandText = "SELECT COUNT(*) FROM claims;";
        Console.WriteLine(await command.ExecuteScalarAsync()); return 0;
    }

    private static int RunRestrictedClient(string pipeName)
    {
        const uint TokenDuplicate = 0x0002;
        const uint TokenImpersonate = 0x0004;
        const uint TokenQuery = 0x0008;
        const uint DisableMaxPrivilege = 0x0001;
        const int SecurityImpersonation = 2;
        const int TokenImpersonation = 2;
        const string SyntheticRestrictingSid = "S-1-5-21-111111111-222222222-333333333-4444";

        // Load System.IO.Pipes now: under the restricted token below the runtime could not read the assembly file
        // lazily. (It used to be loaded as a side effect of JIT-compiling the old Main that held the server code.)
        _ = typeof(NamedPipeClientStream).Assembly;

        if (!OpenProcessToken(GetCurrentProcess(), TokenDuplicate | TokenQuery, out SafeAccessTokenHandle processToken))
            return ReportRestrictedTokenSetupFailure("open_token");
        using (processToken)
        {
            if (!ConvertStringSidToSid(SyntheticRestrictingSid, out IntPtr sid))
                return ReportRestrictedTokenSetupFailure("sid_parse");
            try
            {
                var restrictingSid = new SidAndAttributes { Sid = sid, Attributes = 0 };
                if (!CreateRestrictedToken(processToken, DisableMaxPrivilege, 0, IntPtr.Zero, 0, IntPtr.Zero,
                        1, ref restrictingSid, out SafeAccessTokenHandle restrictedPrimary))
                    return ReportRestrictedTokenSetupFailure("create_restricted_token");
                using (restrictedPrimary)
                {
                    if (!DuplicateTokenEx(restrictedPrimary, TokenQuery | TokenImpersonate | TokenDuplicate,
                            IntPtr.Zero, SecurityImpersonation, TokenImpersonation, out SafeAccessTokenHandle impersonationToken))
                        return ReportRestrictedTokenSetupFailure("duplicate_impersonation_token");
                    using (impersonationToken)
                    {
                        string outcome = WindowsIdentity.RunImpersonated(impersonationToken, () =>
                        {
                            try
                            {
                                using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
                                    PipeOptions.None, TokenImpersonationLevel.Identification);
                                client.Connect(3000);
                                return "connected";
                            }
                            catch (UnauthorizedAccessException) { return "access_denied"; }
                            catch (IOException ex) when ((ex.HResult & 0xffff) == 5) { return "access_denied"; }
                        });
                        if (outcome != "access_denied")
                        {
                            Console.WriteLine("RESTRICTED_TOKEN_PIPE_DENIAL=false");
                            return 2;
                        }
                        Console.WriteLine("RESTRICTED_TOKEN_PIPE_DENIAL=true");
                        Console.WriteLine("TOKEN_USER_CHANGED=false");
                        Console.WriteLine("RESTRICTING_SID_MATCHED_PIPE_DACL=false");
                        return 0;
                    }
                }
            }
            finally { _ = LocalFree(sid); }
        }
    }

    private static int ReportRestrictedTokenSetupFailure(string stage)
    {
        Console.WriteLine($"RESTRICTED_TOKEN_SETUP=BLOCKED_{stage}");
        return 3;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ImpersonateNamedPipeClient(SafePipeHandle pipe);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool RevertToSelf();
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(SafeAccessTokenHandle existingToken, uint flags, uint disableSidCount, IntPtr sidsToDisable, uint deletePrivilegeCount, IntPtr privilegesToDelete, uint restrictedSidCount, ref SidAndAttributes sidsToRestrict, out SafeAccessTokenHandle newToken);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DuplicateTokenEx(SafeAccessTokenHandle existingToken, uint desiredAccess, IntPtr tokenAttributes, int impersonationLevel, int tokenType, out SafeAccessTokenHandle newToken);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
