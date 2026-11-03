using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

// Secret mode of the pipe client helper (docs/architecture/control-plane-service.md "Secret storage"; Proposed / NOT VERIFIED): the helper started with the single argument `secret`.
// DPAPI protect / unprotect for the Control Plane, run as a child with the Control Plane's own token, so Node needs no native addon and no PowerShell. It opens no pipe and reaches no network.
// One process = one request. Frames are [int32 little-endian length][payload] on stdin and stdout; the payloads are binary so that Node can hold a secret in a Buffer it can wipe.
//   Node -> helper : [op][entropyLength][entropy][data]   op 1 = protect (data = plaintext, 1..4096 bytes), op 2 = unprotect (data = a blob, 1..8192 bytes)
//                    entropy = 1..64 ASCII characters of [a-z0-9._-] (a name such as albera.claude-code-token.v1); it is part of the key, it is not a secret
//   helper -> Node : [0][data] (the blob / the plaintext)   or   [1][word] with word one of invalid_request, too_large, protect_failed, unprotect_failed, internal_error
// Scope: CryptProtectData / CryptUnprotectData with CRYPTPROTECT_UI_FORBIDDEN and without LOCAL_MACHINE, which is DPAPI CurrentUser (the same call as the lab probe, PR #175).
// Exit: 0 = a reply frame was written (including protect_failed / unprotect_failed), 64 = bad input (invalid_request, too_large), 70 = internal error.
// A word never carries text of the input or of the OS. A wrong entropy, a damaged blob and a blob made by another identity are the SAME word (unprotect_failed): the helper is no oracle.
// Every buffer that held the plaintext (the request, the native copies, the result, the reply frame) is zeroed before the process ends.
internal static partial class Program
{
    private const int MaxPlaintextBytes = 4096, MaxBlobBytes = 8192, MaxEntropyBytes = 64, MaxSecretFrameBytes = 2 + MaxEntropyBytes + MaxBlobBytes;
    private const byte OpProtect = 1, OpUnprotect = 2, ReplyOk = 0, ReplyRefused = 1;
    private const uint CryptUiForbidden = 0x1; // CRYPTPROTECT_UI_FORBIDDEN; no CRYPTPROTECT_LOCAL_MACHINE flag

    [StructLayout(LayoutKind.Sequential)] private struct DataBlob { public int Size; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptProtectData(ref DataBlob input, IntPtr description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    private static int RunSecret()
    {
        byte[] request = [], result = [];
        try
        {
            using Stream stdin = Console.OpenStandardInput();
            if (ReadSecretFrame(stdin, out request) is { } unreadable) return Refuse(unreadable, ExitBadInput);
            byte op = request[0];
            int entropyLength = request[1], dataOffset = 2 + entropyLength;
            bool protect = op == OpProtect;
            if ((!protect && op != OpUnprotect) || entropyLength is < 1 or > MaxEntropyBytes || dataOffset >= request.Length || !IsEntropyName(request, entropyLength)) return Refuse("invalid_request", ExitBadInput);
            if (request.Length - dataOffset > (protect ? MaxPlaintextBytes : MaxBlobBytes)) return Refuse("too_large", ExitBadInput);
            try { result = Transform(protect, request, dataOffset, entropyLength); }
            catch (Win32Exception) { return Refuse(protect ? "protect_failed" : "unprotect_failed", ExitOk); }
            WriteSecretFrame(ReplyOk, result);
            return ExitOk;
        }
        catch (Exception) { return Refuse("internal_error", ExitInternal); }
        finally
        {
            CryptographicOperations.ZeroMemory(request);
            CryptographicOperations.ZeroMemory(result);
        }
    }

    // The frame is read whole before anything is looked at. A length above the bound is refused without reading the body; the shortest valid frame is op, entropyLength, 1 entropy byte and 1 data byte.
    private static string? ReadSecretFrame(Stream stdin, out byte[] frame)
    {
        frame = [];
        byte[] header = new byte[4];
        if (!ReadFull(stdin, header)) return "invalid_request";
        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length > MaxSecretFrameBytes) return "too_large";
        if (length < 4) return "invalid_request";
        frame = new byte[length];
        return ReadFull(stdin, frame) ? null : "invalid_request";
    }

    private static bool IsEntropyName(byte[] request, int length)
    {
        for (int i = 2; i < 2 + length; i++) if (!(request[i] is (>= (byte)'a' and <= (byte)'z') or (>= (byte)'0' and <= (byte)'9') or (byte)'.' or (byte)'_' or (byte)'-')) return false;
        return true;
    }

    // Native copies are made for the call and zeroed after it; the OS-owned output is zeroed before LocalFree because for an unprotect it is the plaintext.
    private static byte[] Transform(bool protect, byte[] request, int dataOffset, int entropyLength)
    {
        int dataLength = request.Length - dataOffset;
        IntPtr dataPointer = Marshal.AllocHGlobal(dataLength), entropyPointer = Marshal.AllocHGlobal(entropyLength);
        DataBlob output = default;
        try
        {
            Marshal.Copy(request, dataOffset, dataPointer, dataLength);
            Marshal.Copy(request, 2, entropyPointer, entropyLength);
            DataBlob input = new() { Size = dataLength, Data = dataPointer }, extra = new() { Size = entropyLength, Data = entropyPointer };
            bool ok = protect
                ? CryptProtectData(ref input, IntPtr.Zero, ref extra, IntPtr.Zero, IntPtr.Zero, CryptUiForbidden, out output)
                : CryptUnprotectData(ref input, IntPtr.Zero, ref extra, IntPtr.Zero, IntPtr.Zero, CryptUiForbidden, out output);
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] result = new byte[output.Size];
            Marshal.Copy(output.Data, result, 0, output.Size);
            return result;
        }
        finally
        {
            Marshal.Copy(new byte[dataLength], 0, dataPointer, dataLength);
            Marshal.FreeHGlobal(dataPointer);
            Marshal.FreeHGlobal(entropyPointer);
            if (output.Data != IntPtr.Zero)
            {
                Marshal.Copy(new byte[output.Size], 0, output.Data, output.Size);
                _ = LocalFree(output.Data);
            }
        }
    }

    private static int Refuse(string word, int exitCode)
    {
        try { WriteSecretFrame(ReplyRefused, System.Text.Encoding.ASCII.GetBytes(word)); }
        catch (Exception) { return ExitInternal; } // Node went away: nothing left to tell
        return exitCode;
    }

    private static void WriteSecretFrame(byte status, ReadOnlySpan<byte> body)
    {
        byte[] frame = new byte[5 + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, 1 + body.Length);
        frame[4] = status;
        body.CopyTo(frame.AsSpan(5));
        try
        {
            using Stream stdout = Console.OpenStandardOutput();
            stdout.Write(frame);
            stdout.Flush();
        }
        finally { CryptographicOperations.ZeroMemory(frame); }
    }
}
