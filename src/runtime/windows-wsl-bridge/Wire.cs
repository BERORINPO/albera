using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;

namespace Albera.WslBridge;

internal enum Verb : byte { Begin = 1, Exec = 2, Put = 3, Get = 4, End = 5, Stop = 6, Bundle = 7, Status = 8 }

/// <summary>One decoded request. RunId is the operation id of the lease (it also names the distribution).</summary>
internal sealed record Request(Verb Verb, string RunId, byte[] Body);

/// <summary>What a verb answers: Ok with a body, or a refusal with one fixed word.</summary>
internal sealed record Reply(bool Ok, string Reason, byte[] Body)
{
    public static Reply Success(byte[]? body = null) => new(true, "", body ?? []);
    public static Reply Refuse(string reason) => new(false, reason, []);
}

// The pipe's wire format (ADR-012, "The WSL bridge"). Every message, both ways, is a frame: u32 big-endian length, then that many bytes. Numbers are big-endian.
//   request   u8 verb, u8 id length (1..64), id (ASCII, the operation id), then the body
//               1 begin  body = the signed run lease as strict JSON         2 exec  body = u32 seconds, command (UTF-8, for bash -c in the sandbox)
//               3 put    body = u32 path length, path, data                 4 get   body = path
//               5 end    body empty                                         6 stop  body empty
//               7 bundle body empty (needs a run)                           8 status body empty, or a repository id (needs no run)
//   response  u8 status (0 ok, 1 refused), then for ok the verb's answer, for refused one fixed word (ASCII, see Reason.cs)
//               begin: empty    exec: i32 exit code, u8 flags (1 output cut, 2 out of time), output    put: empty    get: the bytes    end, stop: empty
//               bundle: the bundle, at most Limits.MaxBundleBytes    status: JSON {"kernelOk":bool,"reason":word|null[,"head":oid|null]} (head only when a repository id was sent)
// There is no field that carries a Windows path, a Windows command line or a distribution name: the bridge builds those itself.
internal static class Wire
{
    public const int MaxIdLength = 64;
    private static readonly Regex IdRegex = new(@"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\z", RegexOptions.CultureInvariant); // \z: $ would also pass a final line feed

    public static bool IsId(string value) => IdRegex.IsMatch(value);

    public static Request? Parse(ReadOnlySpan<byte> payload)
    {
        if (payload.Length < 2 || payload[0] is < 1 or > 8) return null;
        int idLength = payload[1];
        if (idLength is < 1 or > MaxIdLength || payload.Length < 2 + idLength) return null;
        string id = Encoding.ASCII.GetString(payload.Slice(2, idLength));
        return IsId(id) ? new Request((Verb)payload[0], id, payload[(2 + idLength)..].ToArray()) : null;
    }

    public static byte[] Encode(Reply reply)
    {
        byte[] body = reply.Ok ? reply.Body : Encoding.ASCII.GetBytes(reply.Reason);
        byte[] bytes = new byte[1 + body.Length];
        bytes[0] = reply.Ok ? (byte)0 : (byte)1;
        body.CopyTo(bytes, 1);
        return bytes;
    }

    public static byte[] Frame(ReadOnlySpan<byte> payload)
    {
        byte[] bytes = new byte[4 + payload.Length];
        BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)payload.Length);
        payload.CopyTo(bytes.AsSpan(4));
        return bytes;
    }

    /// <summary>The payload of one frame, or null when the length is 0 or over <paramref name="max"/> (nothing is allocated for it) or the stream ends part way.</summary>
    public static async Task<byte[]?> ReadFrameAsync(Stream stream, int max, CancellationToken cancel)
    {
        byte[] header = new byte[4];
        if (!await TryReadExactlyAsync(stream, header, cancel)) return null;
        uint length = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (length == 0 || length > (uint)max) return null;
        byte[] payload = new byte[length];
        return await TryReadExactlyAsync(stream, payload, cancel) ? payload : null;
    }

    private static async Task<bool> TryReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancel)
    {
        int got = 0;
        while (got < buffer.Length)
        {
            int n = await stream.ReadAsync(buffer.AsMemory(got), cancel);
            if (n <= 0) return false;
            got += n;
        }
        return true;
    }
}
