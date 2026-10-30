using System.Buffers.Binary;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

// Trusted pipe client for the Host Broker and the Approval Authority submit pipe (ADR-002, Proposed / NOT VERIFIED). Input: ONE JSON line on stdin
//   {pipeName, timeoutMs, expect:{ownerSid, pid | serviceName, imageSha256?}} plus exactly one request: {receipt, signature} | {fence:computerId} | {inspect:operationId}
//   | {authority:"<the Authority's JSON request text>"} (Node builds and validates it; here only {v:1, verb: submit|status} and the 2 KiB bound are checked, and the
//   exact bytes are sent). Only the request, the pipe-name grammar and the reply shapes differ between the two servers; the identity checks below are shared.
// Output: ONE JSON line, {ok:true,state,action[,replayed]} | {ok:true,brokerEpoch,leaseGeneration,leaseId,brokerChallenge} | {ok:false,code}; for `authority` the
// Authority's own {ok:true,...} object (re-serialised) or {ok:false,code} with a code from its fixed set.
// Exit: 0 = the line is the result, 64 = bad input, 70 = internal error (line still written).
// Order: open with SQOS identification -> verify the pipe server on the CONNECTED handle -> only then write the 2 KiB frame.
// Pre-send codes (receipt never left, safe to retry): server_identity_mismatch, server_identity_unavailable, broker_unavailable, access_denied.
// Post-send codes (outcome unknown): timeout, transport_error, invalid_response, response_too_large.
internal static class Program
{
    private const int ExitOk = 0, ExitBadInput = 64, ExitInternal = 70;
    private const int MaxInputBytes = 8192, MaxRequestBytes = 2048, MaxResponseBytes = 256, MaxAuthorityResponseBytes = 2048;
    private static readonly string[] AuthorityCodes = ["authority_unavailable", "request_invalid", "request_expired", "human_denied", "presence_unavailable", "presence_mismatch", "queue_full"];
    // Specific rights, never GENERIC_WRITE (its FILE_APPEND_DATA bit is FILE_CREATE_PIPE_INSTANCE on a pipe): the CP ACE is 0x00120083.
    private const uint ClientAccess = 0x1 /*FILE_READ_DATA*/ | 0x2 /*FILE_WRITE_DATA*/ | 0x80 /*FILE_READ_ATTRIBUTES*/ | 0x20000 /*READ_CONTROL*/ | 0x100000 /*SYNCHRONIZE*/;
    private const uint OpenExisting = 3, SecuritySqosPresent = 0x00100000, SecurityIdentification = 0x00010000; // identification only: the server cannot act as us
    private const uint ServiceRunning = 4;
    private static readonly object Gate = new();
    private static volatile bool sent;

    private sealed record Input(string PipeName, string Body, int TimeoutMs, string? OwnerSid, uint? Pid, string? ServiceName, string? ImageSha256, bool Authority);

    private static int Main()
    {
        try { Run(ReadInput()); }
        catch (Exception) { lock (Gate) Finish(Failure(sent ? "transport_error" : "server_identity_unavailable"), ExitInternal); }
        return ExitInternal; // unreachable: Finish exits the process
    }

    private static void Run(Input input)
    {
        // `sent` is read and written only under Gate, and Finish exits while holding it, so a pre-send code can never follow a write.
        using Timer watchdog = new(_ => { lock (Gate) Finish(Failure(sent ? "timeout" : "server_identity_unavailable"), ExitOk); }, null, input.TimeoutMs, Timeout.Infinite);
        bool serviceMode = input.ServiceName is not null;
        uint expectedPid = serviceMode ? ServicePid(input.ServiceName!) : input.Pid!.Value;
        SecurityIdentifier expectedOwner = input.OwnerSid is not null ? new SecurityIdentifier(input.OwnerSid)
            : (SecurityIdentifier)new NTAccount("NT SERVICE", input.ServiceName!).Translate(typeof(SecurityIdentifier));

        IntPtr raw = CreateFileW(@"\\.\pipe\" + input.PipeName, ClientAccess, 0, IntPtr.Zero, OpenExisting, SecuritySqosPresent | SecurityIdentification, IntPtr.Zero);
        if (raw == new IntPtr(-1)) Finish(Failure(Marshal.GetLastWin32Error() == 5 ? "access_denied" : "broker_unavailable"), ExitOk);
        using NamedPipeClientStream pipe = new(PipeDirection.InOut, false, true, new SafePipeHandle(raw, true));

        // Identity of the server, on the connected handle, BEFORE a single byte is written.
        SecurityIdentifier? owner = pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner is null || !owner.Equals(expectedOwner)) Finish(Failure("server_identity_mismatch"), ExitOk);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint serverPid)) throw new Win32Exception();
        if (serverPid != expectedPid) Finish(Failure("server_identity_mismatch"), ExitOk);
        if (serviceMode && (!GetNamedPipeServerSessionId(pipe.SafePipeHandle, out uint session) || session != 0)) Finish(Failure("server_identity_mismatch"), ExitOk);
        if (input.ImageSha256 is not null && !string.Equals(ImageSha256(serverPid), input.ImageSha256, StringComparison.Ordinal)) Finish(Failure("server_identity_mismatch"), ExitOk);

        byte[] body = Encoding.UTF8.GetBytes(input.Body), frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        lock (Gate) sent = true; // from here the outcome is unknown even if the write throws; a watchdog that already holds Gate has exited
        pipe.Write(frame);
        pipe.Flush();

        byte[] header = new byte[4];
        if (!ReadFull(pipe, header)) Finish(Failure("invalid_response"), ExitOk);
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length > (input.Authority ? MaxAuthorityResponseBytes : MaxResponseBytes)) Finish(Failure("response_too_large"), ExitOk);
        byte[] reply = new byte[Math.Max(length, 0)];
        if (length < 1 || !ReadFull(pipe, reply) || pipe.ReadByte() != -1) Finish(Failure("invalid_response"), ExitOk);
        Finish(input.Authority ? RelayAuthority(reply) : Relay(reply), ExitOk);
    }

    // Only the Broker's three reply shapes pass (denied, claim / inspect, fence); any other server text becomes invalid_response, so a server can never inject a pre-send code.
    private static string Relay(byte[] reply)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(reply, new JsonDocumentOptions { MaxDepth = 2 });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("ok", out JsonElement ok)) return Failure("invalid_response");
            if (ok.ValueKind == JsonValueKind.False && root.TryGetProperty("code", out JsonElement code) && code.ValueKind == JsonValueKind.String && code.GetString() == "denied") return Failure("denied");
            if (ok.ValueKind != JsonValueKind.True) return Failure("invalid_response");
            if (Text(root, "state") is { } state && Text(root, "action") is { } action)
                return $"{{\"ok\":true,\"state\":{JsonSerializer.Serialize(state)},\"action\":{JsonSerializer.Serialize(action)}{(root.TryGetProperty("replayed", out JsonElement replayed) && replayed.ValueKind == JsonValueKind.True ? ",\"replayed\":true" : "")}}}";
            if (Number(root, "brokerEpoch") is { } epoch && Number(root, "leaseGeneration") is { } generation && Text(root, "brokerChallenge") is { } challenge)
            {
                // `leaseId` (a contract id) is required: the Broker always sends it (PR #92).
                if (!root.TryGetProperty("leaseId", out JsonElement lease) || lease.ValueKind != JsonValueKind.String || !IsId(lease.GetString())) return Failure("invalid_response");
                return $"{{\"ok\":true,\"brokerEpoch\":{epoch},\"leaseGeneration\":{generation},\"leaseId\":{JsonSerializer.Serialize(lease.GetString())},\"brokerChallenge\":{JsonSerializer.Serialize(challenge)}}}";
            }
        }
        catch (JsonException) { }
        return Failure("invalid_response");
    }
    // The Authority's replies are richer (approvalId, receipt, signature), so a success is re-serialised after parsing (one compact line); a failure must carry one of its fixed codes.
    private static string RelayAuthority(byte[] reply)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(reply, new JsonDocumentOptions { MaxDepth = 2 });
            JsonElement root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ok", out JsonElement ok))
            {
                if (ok.ValueKind == JsonValueKind.True) return JsonSerializer.Serialize(root);
                if (ok.ValueKind == JsonValueKind.False && Text(root, "code") is { } code && AuthorityCodes.Contains(code)) return Failure(code);
            }
        }
        catch (JsonException) { }
        return Failure("invalid_response");
    }
    private static string? Text(JsonElement root, string name) => root.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static long? Number(JsonElement root, string name) => root.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out long n) ? n : null;

    private static Input ReadInput()
    {
        try
        {
            using Stream stdin = Console.OpenStandardInput();
            byte[] buffer = new byte[MaxInputBytes + 1];
            int used = 0, read;
            while (used < buffer.Length && (read = stdin.Read(buffer, used, buffer.Length - used)) > 0) used += read;
            if (used > MaxInputBytes) throw new InvalidDataException();
            using JsonDocument document = JsonDocument.Parse(buffer.AsMemory(0, used), new JsonDocumentOptions { MaxDepth = 4 });
            JsonElement root = document.RootElement, expect = root.GetProperty("expect");
            RequireKeys(root, "pipeName", "receipt", "signature", "fence", "inspect", "authority", "timeoutMs", "expect");
            RequireKeys(expect, "ownerSid", "pid", "serviceName", "imageSha256");
            string pipeName = root.GetProperty("pipeName").GetString() ?? "";
            bool authority = root.TryGetProperty("authority", out _);
            if (authority ? !IsPipePath(pipeName) : !IsToken(pipeName, 128, "_-", false)) throw new InvalidDataException();
            string requestBody = RequestBody(root); // the tokens it embeds need no JSON escaping; same bytes as the Node client's body
            int timeoutMs = root.GetProperty("timeoutMs").GetInt32();
            string? ownerSid = Optional(expect, "ownerSid"), serviceName = Optional(expect, "serviceName"), imageSha256 = Optional(expect, "imageSha256");
            uint? pid = expect.TryGetProperty("pid", out JsonElement p) ? p.GetUInt32() : null;
            if (Encoding.UTF8.GetByteCount(requestBody) > MaxRequestBytes || timeoutMs is < 100 or > 30_000 || (pid is null) == (serviceName is null) || (serviceName is null && ownerSid is null) ||
                (serviceName is not null && !IsToken(serviceName, 256, "_-", false)) || (imageSha256 is not null && (imageSha256.Length != 64 || !IsToken(imageSha256, 64, "", false) || imageSha256.Any(char.IsUpper))))
                throw new InvalidDataException();
            return new Input(pipeName, requestBody, timeoutMs, ownerSid, pid, serviceName, imageSha256, authority);
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException)
        {
            Finish(Failure("invalid_request"), ExitBadInput);
            throw; // unreachable
        }
    }

    // Exactly one request: a claim {receipt, signature} (base64), {fence: computerId}, {inspect: operationId} (contract ids) or {authority: <request text>}.
    private static string RequestBody(JsonElement root)
    {
        bool hasReceipt = root.TryGetProperty("receipt", out JsonElement receipt), hasSignature = root.TryGetProperty("signature", out JsonElement signature);
        bool hasFence = root.TryGetProperty("fence", out JsonElement fence), hasInspect = root.TryGetProperty("inspect", out JsonElement inspect);
        bool hasAuthority = root.TryGetProperty("authority", out JsonElement authority);
        if (hasReceipt != hasSignature || (hasReceipt ? 1 : 0) + (hasFence ? 1 : 0) + (hasInspect ? 1 : 0) + (hasAuthority ? 1 : 0) != 1) throw new InvalidDataException();
        if (hasAuthority) return AuthorityBody(authority.GetString() ?? "");
        if (hasFence) return $"{{\"fence\":{{\"computerId\":\"{Id(fence)}\"}}}}";
        if (hasInspect) return $"{{\"inspect\":{{\"operationId\":\"{Id(inspect)}\"}}}}";
        string r = receipt.GetString() ?? "", s = signature.GetString() ?? "";
        return IsToken(r, 2048, "+/=", true) && IsToken(s, 2048, "+/=", true) ? $"{{\"receipt\":\"{r}\",\"signature\":\"{s}\"}}" : throw new InvalidDataException();
    }
    // The Approval Authority submit pipe takes {v:1, verb: "submit"|"status", ...}; the strict field check is the Authority's, the bytes sent are exactly Node's.
    private static string AuthorityBody(string text)
    {
        using JsonDocument document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 4 });
        JsonElement root = document.RootElement;
        bool valid = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("v", out JsonElement v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out int version) && version == 1 && Text(root, "verb") is "submit" or "status";
        return valid ? text : throw new InvalidDataException();
    }
    private static bool IsPipePath(string value) => value.Length <= 256 && value.Split((char)92).All(segment => IsToken(segment, 128, "_-", false)); // backslash-separated tokens: no empty segment, no dot, so the name cannot leave the pipe namespace
    private static bool IsId(string? id) => id is { Length: > 0 } && char.IsAsciiLetterOrDigit(id[0]) && IsToken(id, 64, "._:-", false);
    private static string Id(JsonElement element) => element.GetString() is { } id && IsId(id) ? id : throw new InvalidDataException();

    private static void RequireKeys(JsonElement element, params string[] allowed)
    {
        if (element.ValueKind != JsonValueKind.Object || element.EnumerateObject().Any(property => !allowed.Contains(property.Name))) throw new InvalidDataException();
    }
    private static string? Optional(JsonElement element, string name) => element.TryGetProperty(name, out JsonElement value) ? value.GetString() : null;
    private static bool IsToken(string value, int max, string extra, bool base64) =>
        value.Length >= 1 && value.Length <= max && value.All(c => c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9') || extra.Contains(c)) && (!base64 || value.Length % 4 == 0);

    private static bool ReadFull(Stream stream, byte[] buffer)
    {
        for (int used = 0; used < buffer.Length;)
        {
            int read = stream.Read(buffer, used, buffer.Length - used);
            if (read == 0) return false;
            used += read;
        }
        return true;
    }

    private static uint ServicePid(string name)
    {
        IntPtr manager = OpenSCManagerW(null, null, 0x1 /*SC_MANAGER_CONNECT*/);
        if (manager == IntPtr.Zero) throw new Win32Exception();
        try
        {
            IntPtr service = OpenServiceW(manager, name, 0x4 /*SERVICE_QUERY_STATUS*/);
            if (service == IntPtr.Zero) throw new Win32Exception();
            try
            {
                if (!QueryServiceStatusEx(service, 0, out ServiceStatusProcess status, (uint)Marshal.SizeOf<ServiceStatusProcess>(), out _)) throw new Win32Exception();
                return status.CurrentState == ServiceRunning && status.ProcessId != 0 ? status.ProcessId : throw new InvalidOperationException();
            }
            finally { _ = CloseServiceHandle(service); }
        }
        finally { _ = CloseServiceHandle(manager); }
    }

    private static string ImageSha256(uint pid)
    {
        IntPtr process = OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, pid);
        if (process == IntPtr.Zero) throw new Win32Exception();
        try
        {
            StringBuilder path = new(1024);
            uint size = (uint)path.Capacity;
            if (!QueryFullProcessImageNameW(process, 0, path, ref size)) throw new Win32Exception();
            using FileStream image = new(path.ToString(), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return Convert.ToHexStringLower(SHA256.HashData(image));
        }
        finally { _ = CloseHandle(process); }
    }

    private static string Failure(string code) => $"{{\"ok\":false,\"code\":\"{code}\"}}";
    private static void Finish(string line, int exitCode)
    {
        lock (Gate) { Console.Out.WriteLine(line); Console.Out.Flush(); Environment.Exit(exitCode); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess { public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerSessionId(SafePipeHandle pipe, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, int infoLevel, out ServiceStatusProcess status, uint bufferSize, out uint bytesNeeded);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
}
