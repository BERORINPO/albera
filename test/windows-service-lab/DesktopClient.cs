using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Albera.Lab;

// Lab client for the Broker's desktop pipe (probe `desktop`; ADR-002 "Amendment 2026-11-03", "Desktop pipe"). The Control Plane's real client does not exist yet (the pipe client helper has no
// desktop mode), so the lab brings its own small one; it keeps the helper's rules for knowing WHO it talks to:
//   * open the pipe with exactly the Control Plane's rights (0x00120083) at SECURITY_IDENTIFICATION, so the server cannot act as this account;
//   * on the CONNECTED handle, before a single byte is written: the pipe's owner SID is the expected one, the server PID is the expected one, and (service mode) the server runs in session 0.
// The expected owner and PID come from the identity argument: `service:<name>` (the PID from the SCM, the owner from NT SERVICE\<name>; what the Control Plane does, it may query that one
// service) or `pid:<pid>:<ownerSid>` (an account that may not query the service, e.g. the stand-in for "somebody else" in the lab).
//
//   albera-lab-service-shim.exe desktop <pipeName> <identity> <step>... [save=<path>]
//   step  open:<view|act>:<computerId>     the first frame of a session, answered `{"ok":true}` or the fixed denied frame
//         capture:<width>x<height>         answered by a header frame and one PNG frame (checked: sizes agree, signature, IHDR, IEND)
//   save=<path>   write the first valid PNG to that file (evidence a person can look at)
// A step kind that appears twice gets the id `<kind>_2` the second time. `act` is only SENT here, so the lab can prove that it is refused; the lease fields and `input` come with the act session.
//
// Output: ONE JSON line per step, flushed as it happens: {"probe":"desktop","id":"connect"|"open"|"capture"...,"ok":bool, ...}
//   connect  result: connected | denied (the pipe's DACL refused the open) | broker_unavailable | server_identity_mismatch | server_identity_unavailable
//   open     reply: accepted | denied | closed (the connection ended without a frame) | invalid
//   capture  reply: png | denied | closed | invalid | png_invalid (+ pngCheck); on png: width, height, bytes, sha256
//   a step that did not run: {"ok":false,"skipped":true,"because":"<the step before it>"}
// Exit 0 after the steps (the verdict belongs to the caller), 64 for a bad argument.
internal static class DesktopClient
{
    private const uint ClientAccess = 0x1 /*FILE_READ_DATA*/ | 0x2 /*FILE_WRITE_DATA*/ | 0x80 /*FILE_READ_ATTRIBUTES*/ | 0x20000 /*READ_CONTROL*/ | 0x100000 /*SYNCHRONIZE*/;
    private const uint OpenExisting = 3, SecuritySqosPresent = 0x00100000, SecurityIdentification = 0x00010000;
    private const int MaxReplyBytes = 256, MaxPngBytes = 8 * 1024 * 1024, MaxRequestBytes = 16 * 1024;
    private const string ServicePrefix = "service:", PidPrefix = "pid:", SavePrefix = "save=";

    private sealed record Step(string Kind, string Id, string Mode, string ComputerId, int Width, int Height);
    private sealed record Expectation(uint Pid, SecurityIdentifier Owner, bool ServiceMode);

    public static int Run(string pipeName, string identity, string[] arguments)
    {
        string? savePath = arguments.FirstOrDefault(a => a.StartsWith(SavePrefix, StringComparison.Ordinal))?[SavePrefix.Length..];
        if (ParseSteps(arguments.Where(a => !a.StartsWith(SavePrefix, StringComparison.Ordinal))) is not { Count: > 0 } plan || !IsPlainName(pipeName)) return 64;

        Dictionary<string, object?> connectLine = new() { ["probe"] = "desktop", ["id"] = "connect" };
        (NamedPipeClientStream? pipe, string result) = Connect(pipeName, identity);
        connectLine["ok"] = pipe is not null;
        connectLine["result"] = result;
        Emit(connectLine);

        using (pipe)
        {
            string? stoppedAt = pipe is null ? "connect" : null;
            foreach (Step step in plan)
            {
                if (stoppedAt is not null) { Emit(new Dictionary<string, object?> { ["probe"] = "desktop", ["id"] = step.Id, ["ok"] = false, ["skipped"] = true, ["because"] = stoppedAt }); continue; }
                Dictionary<string, object?> line = new() { ["probe"] = "desktop", ["id"] = step.Id };
                bool ok = step.Kind == "open" ? Open(pipe!, step, line) : Capture(pipe!, step, line, ref savePath);
                line["ok"] = ok;
                Emit(line);
                if (!ok) stoppedAt = step.Id;
            }
        }
        return 0;
    }

    private static void Emit(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }

    private static bool IsPlainName(string name) => name.Length is >= 1 and <= 128 && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.');

    // open:<view|act>:<computerId> | capture:<w>x<h>; null when any argument is malformed.
    private static List<Step>? ParseSteps(IEnumerable<string> arguments)
    {
        List<Step> plan = [];
        Dictionary<string, int> seen = [];
        foreach (string argument in arguments)
        {
            string[] parts = argument.Split(':');
            string kind = parts[0];
            seen[kind] = seen.GetValueOrDefault(kind) + 1;
            string id = seen[kind] == 1 ? kind : $"{kind}_{seen[kind]}";
            switch (parts)
            {
                case ["open", "view" or "act", var computerId] when IsPlainName(computerId):
                    plan.Add(new Step(kind, id, parts[1], computerId, 0, 0));
                    break;
                case ["capture", var size] when size.Split('x') is [var w, var h] && int.TryParse(w, out int width) && int.TryParse(h, out int height) && width > 0 && height > 0:
                    plan.Add(new Step(kind, id, "", "", width, height));
                    break;
                default:
                    return null;
            }
        }
        return plan;
    }

    // ---- who is on the other end

    private static (NamedPipeClientStream? Pipe, string Result) Connect(string pipeName, string identity)
    {
        Expectation expected;
        try { expected = Expect(identity); }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or ArgumentException or IdentityNotMappedException or FormatException) { return (null, "server_identity_unavailable"); }

        IntPtr raw = Native.CreateFileW(@"\\.\pipe\" + pipeName, ClientAccess, 0, IntPtr.Zero, OpenExisting, SecuritySqosPresent | SecurityIdentification, IntPtr.Zero);
        if (raw == new IntPtr(-1)) return (null, Marshal.GetLastWin32Error() == 5 ? "denied" : "broker_unavailable");
        NamedPipeClientStream pipe = new(PipeDirection.InOut, false, true, new SafePipeHandle(raw, true));
        try
        {
            bool sameOwner = pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) is SecurityIdentifier owner && owner.Equals(expected.Owner);
            bool samePid = Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint serverPid) && serverPid == expected.Pid;
            bool sameSession = !expected.ServiceMode || (Native.GetNamedPipeServerSessionId(pipe.SafePipeHandle, out uint session) && session == 0);
            if (sameOwner && samePid && sameSession) return (pipe, "connected");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or InvalidOperationException) { }
        pipe.Dispose();
        return (null, "server_identity_mismatch");
    }

    private static Expectation Expect(string identity)
    {
        if (identity.StartsWith(ServicePrefix, StringComparison.Ordinal))
        {
            string name = identity[ServicePrefix.Length..];
            if (!IsPlainName(name)) throw new ArgumentException("service name");
            return new Expectation(ServicePid(name), (SecurityIdentifier)new NTAccount("NT SERVICE", name).Translate(typeof(SecurityIdentifier)), true);
        }
        if (identity.StartsWith(PidPrefix, StringComparison.Ordinal) && identity[PidPrefix.Length..].Split(':') is [var pid, var owner])
            return new Expectation(uint.Parse(pid, System.Globalization.CultureInfo.InvariantCulture), new SecurityIdentifier(owner), false);
        throw new ArgumentException("identity");
    }

    private static uint ServicePid(string name)
    {
        IntPtr manager = Native.OpenSCManagerW(null, null, 0x1 /*SC_MANAGER_CONNECT*/);
        if (manager == IntPtr.Zero) throw new Win32Exception();
        try
        {
            IntPtr service = Native.OpenServiceW(manager, name, 0x4 /*SERVICE_QUERY_STATUS*/);
            if (service == IntPtr.Zero) throw new Win32Exception();
            try
            {
                if (!Native.QueryServiceStatusEx(service, 0, out Native.ServiceStatusProcess status, (uint)Marshal.SizeOf<Native.ServiceStatusProcess>(), out _)) throw new Win32Exception();
                return status.CurrentState == Native.ServiceRunning && status.ProcessId != 0 ? status.ProcessId : throw new InvalidOperationException("service not running");
            }
            finally { _ = Native.CloseServiceHandle(service); }
        }
        finally { _ = Native.CloseServiceHandle(manager); }
    }

    // ---- the session

    private static bool Open(Stream pipe, Step step, Dictionary<string, object?> line)
    {
        line["mode"] = step.Mode;
        string reply = Classify(Exchange(pipe, $"{{\"open\":{{\"computerId\":\"{step.ComputerId}\",\"mode\":\"{step.Mode}\"}}}}", MaxReplyBytes));
        line["reply"] = reply;
        return reply == "accepted";
    }

    private static bool Capture(Stream pipe, Step step, Dictionary<string, object?> line, ref string? savePath)
    {
        byte[]? header = Exchange(pipe, $"{{\"capture\":{{\"width\":{step.Width},\"height\":{step.Height}}}}}", MaxReplyBytes);
        if (!TryReadCaptureHeader(header, step, out int length))
        {
            string reply = Classify(header);
            line["reply"] = reply == "accepted" ? "invalid" : reply;   // a bare {"ok":true} is not a capture header
            return false;
        }
        byte[]? png;
        try { png = ReadFrame(pipe, MaxPngBytes); }
        catch (InvalidDataException) { line["reply"] = "invalid"; return false; }
        if (png is null || png.Length != length) { line["reply"] = png is null ? "closed" : "invalid"; return false; }
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
    private static bool TryReadCaptureHeader(byte[]? header, Step step, out int length)
    {
        length = 0;
        if (header is null) return false;
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

    // accepted = exactly {"ok":true}; denied = exactly the fixed {"ok":false,"code":"denied"}; closed = the connection ended without a frame; invalid = anything else.
    private static string Classify(byte[]? reply)
    {
        if (reply is null) return "closed";
        try
        {
            using JsonDocument document = JsonDocument.Parse(reply, new JsonDocumentOptions { MaxDepth = 2 });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return "invalid";
            int members = root.EnumerateObject().Count();
            if (members == 1 && root.TryGetProperty("ok", out JsonElement ok) && ok.ValueKind == JsonValueKind.True) return "accepted";
            if (members == 2 && root.TryGetProperty("ok", out ok) && ok.ValueKind == JsonValueKind.False && root.TryGetProperty("code", out JsonElement code) && code.ValueKind == JsonValueKind.String && code.GetString() == "denied") return "denied";
        }
        catch (JsonException) { }
        return "invalid";
    }

    // One request frame out, one reply frame in. Null when the connection ended (or broke) before a complete frame came back; an empty array (never a valid reply) when the reply's length is out of bounds.
    private static byte[]? Exchange(Stream pipe, string request, int maxReply)
    {
        byte[] body = Encoding.UTF8.GetBytes(request);
        if (body.Length > MaxRequestBytes) throw new InvalidOperationException("request too large");
        byte[] frame = new byte[4 + body.Length];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        try
        {
            pipe.Write(frame);
            pipe.Flush();
            return ReadFrame(pipe, maxReply);
        }
        catch (IOException) { return null; }
        catch (InvalidDataException) { return []; }
    }

    // 4-byte little-endian length, then that many bytes. Null when the stream ends first; InvalidDataException when the length is outside 1..max (nothing is read after it).
    private static byte[]? ReadFrame(Stream pipe, int max)
    {
        try
        {
            byte[] size = new byte[4];
            if (!ReadFull(pipe, size)) return null;
            int length = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(size);
            if (length < 1 || length > max) throw new InvalidDataException("frame length");
            byte[] body = new byte[length];
            return ReadFull(pipe, body) ? body : null;
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
}
