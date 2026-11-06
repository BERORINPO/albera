using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text.Json;

// Relay mode of the pipe client helper (ADR-012, "The WSL bridge"; Proposed / NOT VERIFIED): the helper started with the single argument `wsl-bridge`. One process = one connection = one request, as the bridge serves it.
// Node cannot see who owns a pipe, so this mode does the one thing Node cannot do and nothing else: it proves the server, then carries bytes. The wire itself belongs to Node (wsl2-bridge-wire.mjs).
//   Node -> helper, first frame [int32 little-endian length][JSON, at most 8 KiB]: {pipeName, timeoutMs, replyTimeoutMs, expect:{ownerSid[, imageSha256]}}
//   helper -> Node: {ok:true} in the same form once the server is proved; or {ok:false,code} and the process ends. Node sends nothing else before {ok:true}.
//   Node -> helper, then ONE wire frame (u32 big-endian length, 1 to MaxBridgeRequestBytes), read only after the proof and copied to the pipe; the pipe's bytes go to stdout, unread, until the server closes.
// The bridge has no service and its PID is not known in advance, so the proof is the pipe's OWNER on the CONNECTED handle (OpenVerified with neither a PID nor a service name), plus the server image when Node pinned one.
// Only the owner of the name can be the owner of the pipe (setting another SID needs a restore privilege), and the bridge refuses a squatter at its own start with FILE_FLAG_FIRST_PIPE_INSTANCE.
// After {ok:true} nothing but relayed bytes reach stdout: a failure ends the process in silence and Node sees a short read. `replyTimeoutMs` bounds the whole relay, so a helper Node forgot cannot stay.
internal static partial class Program
{
    private const uint MaxBridgeRequestBytes = 16 * 1024 * 1024 + 512 + 1024; // the bridge's Limits.MaxRequestFrame
    private const int BridgeChunkBytes = 64 * 1024;

    private sealed record BridgeStart(string PipeName, int TimeoutMs, int ReplyTimeoutMs, string OwnerSid, string? ImageSha256);

    private static int RunBridgeRelay()
    {
        Stream stdout = hostFrames = Console.OpenStandardOutput();
        using Stream stdin = Console.OpenStandardInput();
        if (ReadBridgeStart(stdin) is not { } start) return ExitOk;
        bool armed = true; // read and written only under Gate: a callback that fired just before the answer finds it answered and does nothing
        using Timer watchdog = new(_ => { lock (Gate) { if (armed) Finish(Failure("server_identity_unavailable"), ExitOk); } }, null, start.TimeoutMs, Timeout.Infinite);
        using NamedPipeClientStream pipe = OpenVerified(start.PipeName, start.OwnerSid, null, null, start.ImageSha256);
        lock (Gate) { armed = false; watchdog.Change(Timeout.Infinite, Timeout.Infinite); }
        WriteHostFrame("{\"ok\":true}"u8.ToArray());
        using Timer lifetime = new(_ => Environment.Exit(ExitOk), null, start.ReplyTimeoutMs, Timeout.Infinite);
        try { RelayOneRequest(stdin, pipe, stdout); return ExitOk; }
        catch (Exception) { return ExitInternal; } // never a frame here: the stream to Node now carries the server's bytes
    }

    private static void RelayOneRequest(Stream stdin, Stream pipe, Stream stdout)
    {
        byte[] header = new byte[4], chunk = new byte[BridgeChunkBytes];
        if (!ReadFull(stdin, header)) return; // Node closed without asking: nothing was written
        uint length = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (length == 0 || length > MaxBridgeRequestBytes) return;
        lock (Gate) sent = true;
        pipe.Write(header);
        for (uint left = length; left > 0;)
        {
            int read = stdin.Read(chunk, 0, (int)Math.Min(left, (uint)chunk.Length));
            if (read == 0) return; // cut short: the bridge sees a bad frame
            pipe.Write(chunk, 0, read);
            left -= (uint)read;
        }
        pipe.Flush();
        for (int read = pipe.Read(chunk); read > 0; read = pipe.Read(chunk))
        {
            stdout.Write(chunk, 0, read);
            stdout.Flush();
        }
    }

    private static BridgeStart? ReadBridgeStart(Stream stdin)
    {
        if (ReadHostFrame(stdin, MaxStartBytes) is not { } frame) return null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = 3 });
            JsonElement root = document.RootElement, expect = root.GetProperty("expect");
            RequireKeys(root, "pipeName", "timeoutMs", "replyTimeoutMs", "expect");
            RequireKeys(expect, "ownerSid", "imageSha256");
            string pipeName = root.GetProperty("pipeName").GetString() ?? "", ownerSid = expect.GetProperty("ownerSid").GetString() ?? "";
            string? imageSha256 = Optional(expect, "imageSha256");
            int timeoutMs = root.GetProperty("timeoutMs").GetInt32(), replyTimeoutMs = root.GetProperty("replyTimeoutMs").GetInt32();
            _ = new System.Security.Principal.SecurityIdentifier(ownerSid); // a SID that does not parse is a bad request, not a server that failed the check
            if (!IsToken(pipeName, 128, "_-", false) || timeoutMs is < 100 or > 30_000 || replyTimeoutMs is < 1000 or > 3_900_000 || !ValidExpectation(ownerSid, 1, null, imageSha256)) throw new InvalidDataException();
            return new BridgeStart(pipeName, timeoutMs, replyTimeoutMs, ownerSid, imageSha256);
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException)
        {
            Finish(Failure("invalid_request"), ExitBadInput);
            throw; // unreachable
        }
    }
}
