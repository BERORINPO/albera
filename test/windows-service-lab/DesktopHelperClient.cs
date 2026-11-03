using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Albera.Lab;

// Lab stand-in for the Node side of the Control Plane's desktop client (src/runtime/windows-desktop-broker-client.mjs), driving the REAL pipe client helper in `desktop` mode
// (src/runtime/windows-broker-pipe-client/DesktopSession.cs; ADR-002 "Amendment 2026-11-03", "Desktop pipe"). The guest has no Node, so this process does what the Node client does:
// check the helper against the SHA-256 manifest next to it, start it with the argument `desktop`, send the start frame, then one request frame at a time, and read the frames back.
// Unlike `desktop` (DesktopClient.cs) it does NOT open the pipe itself: the helper does, so the identity checks that decide a result (owner SID, SCM PID, session 0, image SHA-256) are the
// helper's, not the lab's.
//
//   albera-lab-service-shim.exe desktop-helper <helperExe> <desktopPipe> <identity> <step>... [image=<sha256>] [save=<path>]
//   <desktopPipe>  the Broker's desktop pipe name (it must end in `_desktop`; the helper refuses anything else)
//   <identity>     service:<name>              the Control Plane's way: the helper asks the SCM for the PID and takes the owner from NT SERVICE\<name>
//                  pid:<pid>:<ownerSid>        a PID and an owner SID given by the caller (a caller that may not query the service, or a stale identity in a negative check)
//   image=<hex>    expect.imageSha256: the helper hashes the image of the process behind the pipe and compares (64 lower-case hex characters)
//   steps          open:<view|act>:<computerId>, open:act:<computerId>:<operationId>[:<leaseGeneration>]  exactly one, first (it is the start frame). An act open without a generation joins the
//                  current lease of its operation (what the room does); it is answered {"ok":true,"leaseGeneration":n}, the lease it joined, which must be the named one when one was named.
//                  A bare act open (no operation) is not expressible.
//                  capture:<w>x<h>, input:<ops>            as for `desktop` (DesktopClient.cs). `claim` and `end` do not exist here: the helper reads the pipe only while a request is in flight.
//   save=<path>    write the first valid PNG to that file
//
// Output: ONE JSON line per step, flushed as it happens: {"probe":"desktop-helper","id":"helper"|"open"|"capture"|"input"|...|"close","ok":bool, ...}
//   helper   result: verified (the manifest next to the helper names its SHA-256) | helper_unavailable (no helper, no manifest, or a different hash: nothing was started)
//   open     reply: accepted (an act open: + joinedGeneration, the generation the Broker answered) | one of the helper's codes (denied, server_identity_mismatch, server_identity_unavailable, access_denied, broker_unavailable, timeout, transport_error, ...) | closed | invalid
//   capture  reply: png | a helper code | closed | invalid | png_invalid (+ pngCheck); on png: width, height, bytes, sha256
//   input    reply: accepted | a helper code | closed | invalid
//   close    helperExit (the helper's exit code once stdin was closed; -1 when it had to be killed), stdoutExtraBytes (bytes the helper said that nobody asked for: expected 0)
//   a step that did not run: {"ok":false,"skipped":true,"because":"<the step before it>"}.
// A helper code before the open is accepted is PRE-SEND (the helper wrote nothing to the pipe); the helper itself explains which (see Program.cs). Exit 0 after the steps (the verdict belongs to
// the caller), 64 for a bad argument.
internal static class DesktopHelperClient
{
    private const int OpenTimeoutMs = 10_000, RequestTimeoutMs = 30_000, GraceMs = 4_000, MaxReplyBytes = 256, MaxPngBytes = 8 * 1024 * 1024, CloseWaitMs = 5_000;
    private const string ImagePrefix = "image=", SavePrefix = "save=", DesktopSuffix = "_desktop";
    private static readonly string[] OptionPrefixes = [ImagePrefix, SavePrefix];
    // What the helper can say (DesktopSession.cs / Program.cs); anything else it sends is `invalid`, so it cannot put its own text into a result.
    private static readonly string[] HelperCodes =
    [
        "denied", "invalid_request", "access_denied", "broker_unavailable", "server_identity_mismatch", "server_identity_unavailable", "timeout", "transport_error", "invalid_response", "response_too_large",
    ];

    public static int Run(string helperExe, string pipeName, string identity, string[] arguments)
    {
        string? Option(string prefix) => arguments.FirstOrDefault(a => a.StartsWith(prefix, StringComparison.Ordinal))?[prefix.Length..];
        string? image = Option(ImagePrefix), savePath = Option(SavePrefix);
        if (DesktopClient.ParseSteps(arguments.Where(a => !OptionPrefixes.Any(p => a.StartsWith(p, StringComparison.Ordinal))), allowJoin: true) is not { Count: > 0 } plan) return 64;
        if (!Path.IsPathFullyQualified(helperExe) || !DesktopClient.IsPlainName(pipeName) || !pipeName.EndsWith(DesktopSuffix, StringComparison.Ordinal) || !IsSha256(image)) return 64;
        if (plan[0] is not { Kind: "open" } open || plan.Skip(1).Any(s => s.Kind is not ("capture" or "input")) || (open.Mode == "act" && open.OperationId is null)) return 64;
        if (ExpectOf(identity, image) is not { } expect) return 64;

        string? stoppedAt = null;
        (string verified, string sha256) = VerifyHelper(helperExe);
        DesktopClient.Emit(new Dictionary<string, object?> { ["probe"] = "desktop-helper", ["id"] = "helper", ["ok"] = verified == "verified", ["result"] = verified, ["sha256"] = sha256 });
        if (verified != "verified") stoppedAt = "helper";
        using Process? process = stoppedAt is null ? Start(helperExe) : null;
        Stream? stdin = process?.StandardInput.BaseStream, stdout = process?.StandardOutput.BaseStream;

        foreach (DesktopClient.Step step in plan)
        {
            if (stoppedAt is not null) { DesktopClient.Emit(new Dictionary<string, object?> { ["probe"] = "desktop-helper", ["id"] = step.Id, ["ok"] = false, ["skipped"] = true, ["because"] = stoppedAt }); continue; }
            Dictionary<string, object?> line = new() { ["probe"] = "desktop-helper", ["id"] = step.Id };
            bool ok = step.Kind switch
            {
                "open" => Open(process!, stdin!, stdout!, pipeName, expect, step, line),
                "capture" => Capture(process!, stdin!, stdout!, step, line, ref savePath),
                _ => Input(process!, stdin!, stdout!, step, line),
            };
            line["ok"] = ok;
            DesktopClient.Emit(line);
            if (!ok) stoppedAt = step.Id;
        }
        if (process is not null) Close(process, stdin!, stdout!);
        return 0;
    }

    private static bool IsSha256(string? value) => value is null || (value.Length == 64 && value.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f')));

    // service:<name> | pid:<pid>:<ownerSid> -> the helper's `expect` object; null when the argument is malformed.
    private static Dictionary<string, object?>? ExpectOf(string identity, string? image)
    {
        Dictionary<string, object?> expect = [];
        if (identity.StartsWith("service:", StringComparison.Ordinal) && DesktopClient.IsPlainName(identity["service:".Length..])) expect["serviceName"] = identity["service:".Length..];
        else if (identity.StartsWith("pid:", StringComparison.Ordinal) && identity["pid:".Length..].Split(':') is [var pid, var owner]
            && uint.TryParse(pid, NumberStyles.None, CultureInfo.InvariantCulture, out uint number) && number > 0 && IsSid(owner))
        {
            expect["ownerSid"] = owner;
            expect["pid"] = number;
        }
        else return null;
        if (image is not null) expect["imageSha256"] = image;
        return expect;
    }

    private static bool IsSid(string text)
    {
        try { _ = new SecurityIdentifier(text); return true; }
        catch (ArgumentException) { return false; }
    }

    // The Node client's check before every launch: the SHA-256 recorded next to the helper at build time must be the hash of the file.
    private static (string Result, string Sha256) VerifyHelper(string helperExe)
    {
        try
        {
            string actual = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(helperExe)));
            using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(helperExe + ".manifest.json"), new JsonDocumentOptions { MaxDepth = 2 });
            bool same = manifest.RootElement.TryGetProperty("sha256", out JsonElement recorded) && recorded.ValueKind == JsonValueKind.String && recorded.GetString() == actual;
            return (same ? "verified" : "helper_unavailable", actual);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return ("helper_unavailable", ""); }
    }

    // `shell: false, windowsHide`, stdin and stdout are frame streams; stderr is read and dropped so the helper can never block on it.
    private static Process Start(string helperExe)
    {
        ProcessStartInfo start = new(helperExe) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add("desktop");
        Process process = Process.Start(start) ?? throw new InvalidOperationException("helper did not start");
        _ = process.StandardError.ReadToEndAsync();
        return process;
    }

    // ---- the session (one step = one request frame out, the reply frames in)

    private static bool Open(Process process, Stream stdin, Stream stdout, string pipeName, Dictionary<string, object?> expect, DesktopClient.Step step, Dictionary<string, object?> line)
    {
        line["mode"] = step.Mode;
        Dictionary<string, object?> open = new() { ["computerId"] = step.ComputerId, ["mode"] = step.Mode };
        if (step.OperationId is not null)
        {
            line["operationId"] = step.OperationId;
            open["operationId"] = step.OperationId;
            if (step.Generation > 0)   // named; left out, the Broker joins the current lease of the operation
            {
                line["leaseGeneration"] = step.Generation;
                open["leaseGeneration"] = step.Generation;
            }
        }
        Dictionary<string, object?> start = new() { ["pipeName"] = pipeName, ["timeoutMs"] = OpenTimeoutMs, ["requestTimeoutMs"] = RequestTimeoutMs, ["expect"] = expect, ["open"] = open };
        byte[]? answer = Exchange(process, stdin, stdout, JsonSerializer.Serialize(start), MaxReplyBytes, OpenTimeoutMs + GraceMs);
        long joined = 0;
        string reply = step.OperationId is null ? Classify(answer) : ClassifyActOpen(answer, step.Generation, out joined);
        line["reply"] = reply;
        if (reply == "accepted" && step.OperationId is not null) line["joinedGeneration"] = joined;
        return reply == "accepted";
    }

    // An act open is answered exactly {"ok":true,"leaseGeneration":n} with n >= 1, and n is the named generation when one was named (the helper checks this too; a helper that did not would be caught here).
    // A bare {"ok":true} is not an answer to an act open. Failures are classified as for any other step.
    private static string ClassifyActOpen(byte[]? reply, long named, out long joined)
    {
        joined = 0;
        if (reply is { Length: > 0 })
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(reply, new JsonDocumentOptions { MaxDepth = 2 });
                JsonElement root = document.RootElement;
                if (root.ValueKind == JsonValueKind.Object && root.EnumerateObject().Count() == 2 && root.TryGetProperty("ok", out JsonElement ok) && ok.ValueKind == JsonValueKind.True
                    && root.TryGetProperty("leaseGeneration", out JsonElement generation) && generation.ValueKind == JsonValueKind.Number && generation.TryGetInt64(out long number) && number >= 1)
                {
                    joined = number;
                    return named == 0 || named == number ? "accepted" : "invalid";
                }
            }
            catch (JsonException) { }
        }
        string other = Classify(reply);
        return other == "accepted" ? "invalid" : other;
    }

    private static bool Input(Process process, Stream stdin, Stream stdout, DesktopClient.Step step, Dictionary<string, object?> line)
    {
        string reply = Classify(Exchange(process, stdin, stdout, step.InputJson!, MaxReplyBytes, RequestTimeoutMs + GraceMs));
        line["reply"] = reply;
        return reply == "accepted";
    }

    private static bool Capture(Process process, Stream stdin, Stream stdout, DesktopClient.Step step, Dictionary<string, object?> line, ref string? savePath)
    {
        byte[]? header = Exchange(process, stdin, stdout, $"{{\"capture\":{{\"width\":{step.Width},\"height\":{step.Height}}}}}", MaxReplyBytes, RequestTimeoutMs + GraceMs);
        if (!TryReadCaptureHeader(header, step, out int length))
        {
            string reply = Classify(header);
            line["reply"] = reply == "accepted" ? "invalid" : reply;   // a bare {"ok":true} is not a capture header
            return false;
        }
        byte[]? png = ReadFrame(process, stdout, MaxPngBytes, RequestTimeoutMs + GraceMs);
        if (png is not { Length: > 0 } || png.Length != length) { line["reply"] = png is null ? "closed" : "invalid"; return false; }
        line["bytes"] = png.Length;
        if (HyperVProbe.PngDefect(png, step.Width, step.Height) is { } defect) { line["reply"] = "png_invalid"; line["pngCheck"] = defect; return false; }
        line["reply"] = "png";
        line["width"] = step.Width;
        line["height"] = step.Height;
        line["pngCheck"] = "signature_ihdr_iend_ok";
        line["sha256"] = Convert.ToHexStringLower(SHA256.HashData(png));
        if (savePath is not null) { File.WriteAllBytes(savePath, png); line["saved"] = true; savePath = null; }
        return true;
    }

    // {"ok":true,"width":w,"height":h,"bytes":n} with the asked size and n in 1..8 MiB: nothing else is a capture header.
    private static bool TryReadCaptureHeader(byte[]? header, DesktopClient.Step step, out int length)
    {
        length = 0;
        if (header is not { Length: > 0 }) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(header, new JsonDocumentOptions { MaxDepth = 2 });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 4 || !root.TryGetProperty("ok", out JsonElement ok) || ok.ValueKind != JsonValueKind.True) return false;
            if (Int(root, "width") != step.Width || Int(root, "height") != step.Height || Int(root, "bytes") is not { } bytes || bytes is < 1 or > MaxPngBytes) return false;
            length = bytes;
            return true;
        }
        catch (JsonException) { return false; }
    }

    private static int? Int(JsonElement root, string name) => root.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out int n) ? n : null;

    // accepted = exactly {"ok":true}; a helper code = exactly {"ok":false,"code":"<one of the helper's codes>"}; closed = the helper ended without a frame; invalid = anything else (also a frame
    // whose length is out of bounds, and a reply that did not come in time: `timeout`, after which the helper is killed).
    private static string Classify(byte[]? reply)
    {
        if (reply is null) return "closed";
        if (reply.Length == 0) return "invalid";
        try
        {
            using JsonDocument document = JsonDocument.Parse(reply, new JsonDocumentOptions { MaxDepth = 2 });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return "invalid";
            int members = root.EnumerateObject().Count();
            if (members == 1 && root.TryGetProperty("ok", out JsonElement ok) && ok.ValueKind == JsonValueKind.True) return "accepted";
            if (members == 2 && root.TryGetProperty("ok", out ok) && ok.ValueKind == JsonValueKind.False && root.TryGetProperty("code", out JsonElement code) && code.ValueKind == JsonValueKind.String
                && code.GetString() is { } word && HelperCodes.Contains(word)) return word;
        }
        catch (JsonException) { }
        return "invalid";
    }

    // One request frame out, one reply frame in. A write to a helper that has already ended is ignored: its last frame (a code) is still in the pipe.
    private static byte[]? Exchange(Process process, Stream stdin, Stream stdout, string request, int maxReply, int timeoutMs)
    {
        byte[] body = Encoding.UTF8.GetBytes(request);
        byte[] frame = new byte[4 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        try { stdin.Write(frame); stdin.Flush(); }
        catch (IOException) { }
        return ReadFrame(process, stdout, maxReply, timeoutMs);
    }

    // 4-byte little-endian length, then that many bytes. Null when the stream ends first (or the helper did not answer in time and was killed); an empty array when the length is outside 1..max.
    private static byte[]? ReadFrame(Process process, Stream stdout, int max, int timeoutMs)
    {
        Task<byte[]?> read = Task.Run(() => ReadFrameBlocking(stdout, max));
        if (read.Wait(timeoutMs)) return read.Result;
        process.Kill(entireProcessTree: true);   // the blocked read ends with the process
        _ = read.Wait(2_000);
        return null;
    }

    private static byte[]? ReadFrameBlocking(Stream stdout, int max)
    {
        try
        {
            byte[] size = new byte[4];
            if (!ReadFull(stdout, size)) return null;
            int length = BinaryPrimitives.ReadInt32LittleEndian(size);
            if (length < 1 || length > max) return [];
            byte[] body = new byte[length];
            return ReadFull(stdout, body) ? body : null;
        }
        catch (IOException) { return null; }
    }

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

    // Closing stdin is how Node ends a session quietly. A helper that does not leave within a moment is killed; whatever it still said is counted (a session that is out of step says more than it was asked).
    private static void Close(Process process, Stream stdin, Stream stdout)
    {
        try { stdin.Close(); } catch (IOException) { }
        bool exited = process.WaitForExit(CloseWaitMs);
        if (!exited) process.Kill(entireProcessTree: true);
        process.WaitForExit();
        long extra = 0;
        try
        {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = stdout.Read(buffer, 0, buffer.Length)) > 0) extra += read;
        }
        catch (IOException) { }
        DesktopClient.Emit(new Dictionary<string, object?> { ["probe"] = "desktop-helper", ["id"] = "close", ["ok"] = exited, ["helperExit"] = exited ? process.ExitCode : -1, ["stdoutExtraBytes"] = extra });
    }
}
