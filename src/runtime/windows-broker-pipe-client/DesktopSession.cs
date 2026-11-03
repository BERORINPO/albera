using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

// Desktop mode of the pipe client helper (ADR-002 "Amendment 2026-11-03", "Desktop pipe"; Proposed / NOT VERIFIED): the helper started with the single argument `desktop`.
// One process = one session on the Broker's desktop pipe (`<pipeName>_desktop`), alive until Node closes stdin. Node and the helper speak [int32 little-endian length][payload] frames on stdin / stdout.
//   Node -> helper, first frame (at most 8 KiB): {pipeName, timeoutMs, requestTimeoutMs, expect:{ownerSid, pid | serviceName, imageSha256?}, open:{computerId, mode:"view"|"act"[, operationId, leaseGeneration]}}
//   helper -> Node: {ok:true} once the server was verified AND the Broker accepted the open; or {ok:false,code} and the process ends.
//   Node -> helper, then one request frame at a time (at most 16 KiB): {capture:{width,height}} | {input:{steps:[...]}}. The Broker validates them strictly; here only the kind is read (input only in an act session).
//   helper -> Node, per request: capture {ok:true,width,height,bytes} then ONE binary frame of exactly `bytes` PNG bytes (at most 8 MiB); input {ok:true}.
//   A failure or a refusal is one {ok:false,code} frame and the end of the process: the Broker closes the connection after `denied`, and a desynchronised stream is never reused. Closing stdin ends a session quietly (exit 0).
// Order, as in the one-request modes (Program.cs): open with SQOS identification -> verify the server on the CONNECTED handle (OpenVerified) -> only then write the first frame.
// Codes: before the open frame is written the pre-send codes of Program.cs; after it every code is post-send (the Broker may have acted), except invalid_request (a malformed Node frame, exit 64).
// Time: `timeoutMs` covers connect + verify + open; `requestTimeoutMs` covers each request (write, reply, PNG) and is not running while the session waits for Node.
internal static partial class Program
{
    private const int MaxStartBytes = 8192, MaxDesktopRequestBytes = 16 * 1024, MaxDesktopHeaderBytes = 256, MaxPngBytes = 8 * 1024 * 1024;
    private const long MaxLeaseGeneration = 9_007_199_254_740_991; // 2^53 - 1: what a JavaScript number holds exactly
    private static Stream? hostFrames; // set only in desktop mode: Finish then writes a frame to Node instead of a text line

    private sealed record DesktopStart(string PipeName, string OpenBody, bool Act, int TimeoutMs, int RequestTimeoutMs, string? OwnerSid, uint? Pid, string? ServiceName, string? ImageSha256);

    private static void RunDesktop()
    {
        hostFrames = Console.OpenStandardOutput();
        using Stream stdin = Console.OpenStandardInput();
        if (ReadDesktopStart(stdin) is not { } start) return;
        using Timer watchdog = new(_ => { lock (Gate) Finish(Failure(sent ? "timeout" : "server_identity_unavailable"), ExitOk); }, null, start.TimeoutMs, Timeout.Infinite);
        using NamedPipeClientStream pipe = OpenVerified(start.PipeName, start.OwnerSid, start.Pid, start.ServiceName, start.ImageSha256);
        lock (Gate) sent = true; // from here the outcome is unknown even if the write throws
        SendFrame(pipe, Encoding.UTF8.GetBytes(start.OpenBody));
        if (ReadBrokerObject(pipe).EnumerateObject().Count() != 1) Finish(Failure("invalid_response"), ExitOk); // exactly { "ok": true }
        watchdog.Change(Timeout.Infinite, Timeout.Infinite);
        WriteHostFrame("{\"ok\":true}"u8.ToArray());

        while (ReadHostFrame(stdin, MaxDesktopRequestBytes) is { } request)
        {
            bool capture = IsCaptureRequest(request, start.Act);
            watchdog.Change(start.RequestTimeoutMs, Timeout.Infinite);
            SendFrame(pipe, request);
            JsonElement header = ReadBrokerObject(pipe);
            if (!capture && header.EnumerateObject().Count() != 1) Finish(Failure("invalid_response"), ExitOk); // exactly { "ok": true }
            byte[][] reply = capture ? ReadCaptureReply(pipe, header) : new[] { "{\"ok\":true}"u8.ToArray() };
            watchdog.Change(Timeout.Infinite, Timeout.Infinite); // before the reply goes out: a late timeout must not follow a good answer
            lock (Gate) foreach (byte[] frame in reply) WriteHostFrame(frame);
        }
    }

    // The capture reply: the header (sizes within the Broker's own bounds) and the PNG frame, which must be exactly as long as the header says. Both are relayed re-serialised / as read.
    private static byte[][] ReadCaptureReply(Stream pipe, JsonElement header)
    {
        long? width = Number(header, "width"), height = Number(header, "height"), bytes = Number(header, "bytes");
        if (header.EnumerateObject().Count() != 4 || width is not (>= 64 and <= 1920) || height is not (>= 64 and <= 1920) || bytes is not (>= 1 and <= MaxPngBytes)) Finish(Failure("invalid_response"), ExitOk);
        byte[] png = ReadPipeFrame(pipe, MaxPngBytes);
        if (png.Length != bytes) Finish(Failure("invalid_response"), ExitOk);
        return [Encoding.UTF8.GetBytes($"{{\"ok\":true,\"width\":{width},\"height\":{height},\"bytes\":{bytes}}}"), png];
    }

    // True for a capture, false for an input in an act session; anything else (another key, a second key, input in a view session) is a bad request from Node and nothing is written for it.
    private static bool IsCaptureRequest(byte[] request, bool act)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(request, new JsonDocumentOptions { MaxDepth = 6 });
            JsonElement root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object && root.EnumerateObject().Count() == 1)
            {
                if (root.TryGetProperty("capture", out _)) return true;
                if (act && root.TryGetProperty("input", out _)) return false;
            }
        }
        catch (JsonException) { }
        Finish(Failure("invalid_request"), ExitBadInput);
        throw new InvalidDataException(); // unreachable
    }

    // One reply frame of the Broker as a JSON object with ok:true. A denial ends the session with the fixed `denied`; anything else is invalid_response (or response_too_large).
    private static JsonElement ReadBrokerObject(Stream pipe)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(ReadPipeFrame(pipe, MaxDesktopHeaderBytes), new JsonDocumentOptions { MaxDepth = 2 });
            JsonElement root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ok", out JsonElement ok))
            {
                if (ok.ValueKind == JsonValueKind.False && root.EnumerateObject().Count() == 2 && Text(root, "code") == "denied") Finish(Failure("denied"), ExitOk);
                if (ok.ValueKind == JsonValueKind.True) return root.Clone();
            }
        }
        catch (JsonException) { }
        Finish(Failure("invalid_response"), ExitOk);
        throw new InvalidDataException(); // unreachable
    }

    private static byte[] ReadPipeFrame(Stream pipe, int max)
    {
        byte[] header = new byte[4];
        if (!ReadFull(pipe, header)) Finish(Failure("invalid_response"), ExitOk);
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length > max) Finish(Failure("response_too_large"), ExitOk);
        byte[] body = new byte[Math.Max(length, 0)];
        if (length < 1 || !ReadFull(pipe, body)) Finish(Failure("invalid_response"), ExitOk);
        return body;
    }

    // The only write to the Broker in desktop mode (Program.cs has the other one): reached only after OpenVerified returned.
    private static void SendFrame(Stream pipe, byte[] body)
    {
        byte[] frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        pipe.Write(frame);
        pipe.Flush();
    }

    // Frames to Node are written under Gate, so the watchdog's final frame can never land inside another one.
    private static void WriteHostFrame(byte[] body)
    {
        lock (Gate)
        {
            byte[] head = new byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(head, body.Length);
            hostFrames!.Write(head);
            hostFrames.Write(body);
            hostFrames.Flush();
        }
    }

    // One frame from Node, or null when Node closed stdin between two frames (the normal end of a session). A frame that is cut short, empty or too large ends the process as a bad input.
    private static byte[]? ReadHostFrame(Stream stdin, int max)
    {
        byte[] header = new byte[4];
        for (int used = 0; used < header.Length;)
        {
            int read = stdin.Read(header, used, header.Length - used);
            if (read == 0 && used == 0) return null;
            if (read == 0) Finish(Failure("invalid_request"), ExitBadInput);
            used += read;
        }
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        byte[] body = new byte[length >= 1 && length <= max ? length : 0];
        if (body.Length == 0 || !ReadFull(stdin, body)) Finish(Failure("invalid_request"), ExitBadInput);
        return body;
    }

    private static DesktopStart? ReadDesktopStart(Stream stdin)
    {
        if (ReadHostFrame(stdin, MaxStartBytes) is not { } frame) return null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 4 });
            JsonElement root = document.RootElement, expect = root.GetProperty("expect"), open = root.GetProperty("open");
            RequireKeys(root, "pipeName", "timeoutMs", "requestTimeoutMs", "expect", "open");
            RequireKeys(expect, "ownerSid", "pid", "serviceName", "imageSha256");
            RequireKeys(open, "computerId", "mode", "operationId", "leaseGeneration");
            string pipeName = root.GetProperty("pipeName").GetString() ?? "";
            int timeoutMs = root.GetProperty("timeoutMs").GetInt32(), requestTimeoutMs = root.GetProperty("requestTimeoutMs").GetInt32();
            string? ownerSid = Optional(expect, "ownerSid"), serviceName = Optional(expect, "serviceName"), imageSha256 = Optional(expect, "imageSha256");
            uint? pid = expect.TryGetProperty("pid", out JsonElement p) ? p.GetUInt32() : null;
            // The desktop pipe only: a name that does not end in `_desktop` is the claim pipe (or something else) and has its own modes.
            if (!pipeName.EndsWith("_desktop", StringComparison.Ordinal) || !IsToken(pipeName, 128, "_-", false) || timeoutMs is < 100 or > 30_000 || requestTimeoutMs is < 1000 or > 120_000 ||
                !ValidExpectation(ownerSid, pid, serviceName, imageSha256)) throw new InvalidDataException();
            return new DesktopStart(pipeName, OpenBody(open), open.GetProperty("mode").GetString() == "act", timeoutMs, requestTimeoutMs, ownerSid, pid, serviceName, imageSha256);
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException)
        {
            Finish(Failure("invalid_request"), ExitBadInput);
            throw; // unreachable
        }
    }

    // The open frame the Broker expects, built here from validated parts (contract ids, a generation Node can hold exactly): a view open carries neither lease field, an act open carries both.
    private static string OpenBody(JsonElement open)
    {
        string computerId = Id(open.GetProperty("computerId")), mode = open.GetProperty("mode").GetString() ?? "";
        bool act = mode == "act", hasOperation = open.TryGetProperty("operationId", out JsonElement operation), hasGeneration = open.TryGetProperty("leaseGeneration", out JsonElement generation);
        if (mode is not ("view" or "act") || hasOperation != act || hasGeneration != act) throw new InvalidDataException();
        if (!act) return $"{{\"open\":{{\"computerId\":\"{computerId}\",\"mode\":\"view\"}}}}";
        long leaseGeneration = generation.GetInt64();
        if (leaseGeneration is < 1 or > MaxLeaseGeneration) throw new InvalidDataException();
        return $"{{\"open\":{{\"computerId\":\"{computerId}\",\"mode\":\"act\",\"operationId\":\"{Id(operation)}\",\"leaseGeneration\":{leaseGeneration}}}}}";
    }
}
