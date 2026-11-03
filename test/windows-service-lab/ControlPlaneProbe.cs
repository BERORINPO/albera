using System.ComponentModel;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace Albera.Lab;

// Probes for "can the Control Plane run as NT SERVICE\AlberaControlPlane (restricted service SID, SeChangeNotifyPrivilege only)?" (lab-vm.ps1 -ControlPlaneService). Each prints JSON lines
// {"probe":"cp","id":"<sub>",...}; they run as whichever account launches them (a service through the shim's child mode, or the interactive Administrator), and change nothing except the
// one file `acl-file` is told to create. Secrets never reach the output: a DPAPI plaintext is hashed, never printed.
//   cp dpapi-protect <entropyText>                          CryptProtectData, CurrentUser scope (no LOCAL_MACHINE flag), with entropy, on 32 random bytes; prints the blob (base64), the plaintext SHA-256 and a profile report
//   cp dpapi-unprotect <blobFile> <entropyText> <sha256>    CryptUnprotectData on that blob; prints whether it worked and whether the plaintext hash matches (never the plaintext)
//   cp tcp-listen <seconds> <maxConnections>                listen on 127.0.0.1 port 0, print the port, accept up to <max> connections within <seconds>, answer "pong"
//   cp tcp-connect <port> <label> <seconds>                 connect to 127.0.0.1:<port>, say hello:<label>, read the answer
//   cp acl-file <path> <cpSid> <holderSid>                  create <path> (CreateNew), read the DACL it inherited, replace it with a PROTECTED DACL of exactly two ACEs
//                                                           (cpSid Modify, holderSid Read), read it back, append one line
//   cp file-access <path> <read|write>                      open <path> that way (no byte is written) and say opened / denied / missing / error_<n>
//   cp https <url> <seconds>                                one HTTPS GET; on failure a coarse kind (access_denied = this identity may not connect; unreachable / name_resolution / timeout = no network)
// DPAPI goes through crypt32 directly: ProtectedData is a NuGet package, and this tool is BCL only. CryptProtectData with flags 0x1 (UI forbidden) and no LOCAL_MACHINE is what
// ProtectedData.Protect(..., DataProtectionScope.CurrentUser) calls.
internal static class ControlPlaneProbe
{
    private const uint CryptUiForbidden = 0x1;

    [StructLayout(LayoutKind.Sequential)] private struct DataBlob { public int Size; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptProtectData(ref DataBlob input, IntPtr description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, uint flags, out DataBlob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    public static int Run(string[] args)
    {
        switch (args)
        {
            case ["dpapi-protect", var entropy]: return DpapiProtect(entropy);
            case ["dpapi-unprotect", var blobFile, var entropy, var sha256]: return DpapiUnprotect(blobFile, entropy, sha256);
            case ["tcp-listen", var seconds, var max]: return TcpListen(Number(seconds), Number(max));
            case ["tcp-connect", var port, var label, var seconds]: return TcpConnect(Number(port), label, Number(seconds));
            case ["acl-file", var path, var cpSid, var holderSid]: return AclFile(path, cpSid, holderSid);
            case ["file-access", var path, var mode] when mode is "read" or "write": return FileAccessProbe(path, mode);
            case ["https", var url, var seconds]: return Https(url, Number(seconds));
            default: return 64;
        }
    }

    private static int Number(string text) => int.Parse(text, System.Globalization.CultureInfo.InvariantCulture);
    private static Dictionary<string, object?> Line(string id) => new() { ["probe"] = "cp", ["id"] = id };
    private static void Emit(Dictionary<string, object?> line) { Console.WriteLine(JsonSerializer.Serialize(line)); Console.Out.Flush(); }
    private static string Hex(uint value) => $"0x{value:X8}";

    // ---- DPAPI

    private static byte[] Transform(bool protect, byte[] data, byte[] entropy)
    {
        IntPtr dataPointer = Marshal.AllocHGlobal(Math.Max(data.Length, 1)), entropyPointer = Marshal.AllocHGlobal(Math.Max(entropy.Length, 1));
        try
        {
            Marshal.Copy(data, 0, dataPointer, data.Length);
            Marshal.Copy(entropy, 0, entropyPointer, entropy.Length);
            DataBlob input = new() { Size = data.Length, Data = dataPointer }, extra = new() { Size = entropy.Length, Data = entropyPointer }, output;
            bool ok = protect
                ? CryptProtectData(ref input, IntPtr.Zero, ref extra, IntPtr.Zero, IntPtr.Zero, CryptUiForbidden, out output)
                : CryptUnprotectData(ref input, IntPtr.Zero, ref extra, IntPtr.Zero, IntPtr.Zero, CryptUiForbidden, out output);
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                byte[] result = new byte[output.Size];
                Marshal.Copy(output.Data, result, 0, output.Size);
                return result;
            }
            finally { _ = LocalFree(output.Data); }
        }
        finally
        {
            Marshal.Copy(new byte[data.Length], 0, dataPointer, data.Length); // the input may be the plaintext
            Marshal.FreeHGlobal(dataPointer);
            Marshal.FreeHGlobal(entropyPointer);
        }
    }

    private static int DpapiProtect(string entropyText)
    {
        Dictionary<string, object?> line = Line("dpapi-protect");
        byte[] plaintext = RandomNumberGenerator.GetBytes(32);
        try
        {
            byte[] blob = Transform(true, plaintext, Encoding.UTF8.GetBytes(entropyText));
            byte[] again = Transform(false, blob, Encoding.UTF8.GetBytes(entropyText)); // the same identity, same entropy: must come back
            line["ok"] = true;
            line["roundTrip"] = again.AsSpan().SequenceEqual(plaintext);
            line["blobBase64"] = Convert.ToBase64String(blob);
            line["plaintextSha256"] = Convert.ToHexStringLower(SHA256.HashData(plaintext));
            // The same blob with the wrong entropy must NOT open (entropy is part of the key).
            try { _ = Transform(false, blob, Encoding.UTF8.GetBytes(entropyText + "-wrong")); line["wrongEntropyRefused"] = false; }
            catch (Win32Exception) { line["wrongEntropyRefused"] = true; }
            CryptographicOperations.ZeroMemory(again);
        }
        catch (Win32Exception ex) { line["ok"] = false; line["win32"] = ex.NativeErrorCode; }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
        line["profile"] = ProfileReport();
        Emit(line);
        return 0;
    }

    private static int DpapiUnprotect(string blobFile, string entropyText, string expectedSha256)
    {
        Dictionary<string, object?> line = Line("dpapi-unprotect");
        line["identity"] = WindowsIdentity.GetCurrent().Name;
        try
        {
            byte[] blob = Convert.FromBase64String(File.ReadAllText(blobFile).Trim());
            byte[] plaintext = Transform(false, blob, Encoding.UTF8.GetBytes(entropyText));
            line["ok"] = true;
            line["matches"] = string.Equals(Convert.ToHexStringLower(SHA256.HashData(plaintext)), expectedSha256, StringComparison.Ordinal);
            CryptographicOperations.ZeroMemory(plaintext);
        }
        catch (Win32Exception ex) { line["ok"] = false; line["win32"] = ex.NativeErrorCode; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException) { line["ok"] = false; line["setupError"] = ex.GetType().Name; }
        Emit(line);
        return 0;
    }

    // Where the account's profile is, and whether Windows loaded it for this process: the facts the DPAPI master key location depends on.
    private static Dictionary<string, object?> ProfileReport()
    {
        Dictionary<string, object?> report = [];
        string? sid = WindowsIdentity.GetCurrent().User?.Value;
        report["userSid"] = sid;
        report["userProfileEnv"] = Environment.GetEnvironmentVariable("USERPROFILE");
        report["appDataEnv"] = Environment.GetEnvironmentVariable("APPDATA");
        report["localAppDataEnv"] = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        try
        {
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            report["userProfileFolder"] = profile;
            report["userProfileFolderExists"] = profile.Length > 0 && Directory.Exists(profile);
            report["appDataFolder"] = appData;
            string protect = appData.Length > 0 && sid is not null ? Path.Combine(appData, "Microsoft", "Protect", sid) : "";
            report["masterKeyFolderExists"] = protect.Length > 0 && Directory.Exists(protect);
            report["masterKeyFileCount"] = protect.Length > 0 && Directory.Exists(protect) ? Directory.GetFiles(protect).Length : 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { report["folderError"] = ex.GetType().Name; }
        try
        {
            report["registryHiveLoaded"] = sid is not null && Registry.Users.OpenSubKey(sid) is { } hive && DisposeTrue(hive);
            using RegistryKey? entry = sid is null ? null : Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid);
            report["profileListPath"] = entry?.GetValue("ProfileImagePath") as string;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException) { report["registryError"] = ex.GetType().Name; }
        return report;
    }

    private static bool DisposeTrue(IDisposable value) { value.Dispose(); return true; }

    // ---- loopback TCP

    private static int TcpListen(int seconds, int max)
    {
        Dictionary<string, object?> ready = Line("tcp-listen");
        TcpListener listener = new(IPAddress.Loopback, 0);
        try { listener.Start(); }
        catch (SocketException ex)
        {
            ready["state"] = "error"; ready["socketError"] = ex.SocketErrorCode.ToString(); ready["win32"] = ex.NativeErrorCode;
            Emit(ready);
            return 0;
        }
        ready["state"] = "ready";
        ready["address"] = ((IPEndPoint)listener.LocalEndpoint).Address.ToString();
        ready["port"] = ((IPEndPoint)listener.LocalEndpoint).Port;
        Emit(ready);
        DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
        int accepted = 0;
        while (accepted < max && DateTime.UtcNow < deadline)
        {
            if (!listener.Pending()) { Thread.Sleep(100); continue; }
            using TcpClient client = listener.AcceptTcpClient();
            client.ReceiveTimeout = 3000;
            Dictionary<string, object?> got = Line("tcp-listen");
            got["state"] = "accepted";
            try
            {
                byte[] buffer = new byte[128];
                int count = client.GetStream().Read(buffer, 0, buffer.Length);
                string hello = Encoding.ASCII.GetString(buffer, 0, count);
                got["hello"] = hello.Length > 64 ? hello[..64] : hello;
                client.GetStream().Write(Encoding.ASCII.GetBytes("pong"));
            }
            catch (IOException ex) { got["readError"] = ex.GetType().Name; }
            accepted++;
            Emit(got);
        }
        listener.Stop();
        Dictionary<string, object?> done = Line("tcp-listen");
        done["state"] = "done";
        done["accepted"] = accepted;
        Emit(done);
        return 0;
    }

    private static int TcpConnect(int port, string label, int seconds)
    {
        Dictionary<string, object?> line = Line("tcp-connect");
        line["label"] = label;
        line["identity"] = WindowsIdentity.GetCurrent().Name;
        try
        {
            using TcpClient client = new();
            if (!client.ConnectAsync(IPAddress.Loopback, port).Wait(TimeSpan.FromSeconds(seconds))) { line["ok"] = false; line["kind"] = "timeout"; Emit(line); return 0; }
            client.ReceiveTimeout = seconds * 1000;
            client.GetStream().Write(Encoding.ASCII.GetBytes("hello:" + label));
            byte[] buffer = new byte[16];
            int count = client.GetStream().Read(buffer, 0, buffer.Length);
            line["ok"] = true;
            line["reply"] = Encoding.ASCII.GetString(buffer, 0, count);
        }
        catch (Exception ex) when (ex is AggregateException or SocketException or IOException)
        {
            SocketException? socket = FindSocketException(ex);
            line["ok"] = false;
            line["kind"] = "connect_failed";
            line["socketError"] = socket?.SocketErrorCode.ToString();
            line["win32"] = socket?.NativeErrorCode;
        }
        Emit(line);
        return 0;
    }

    private static SocketException? FindSocketException(Exception? ex)
    {
        for (Exception? current = ex; current is not null; current = current.InnerException)
        {
            if (current is SocketException socket) return socket;
            if (current is AggregateException { InnerExceptions.Count: > 0 } aggregate && FindSocketException(aggregate.InnerExceptions[0]) is { } inner) return inner;
        }
        return null;
    }

    // ---- a file under ProgramData with a protected DACL

    private static List<Dictionary<string, object?>> Describe(FileSecurity security) =>
        [.. security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().Select(rule => new Dictionary<string, object?>
        {
            ["sid"] = rule.IdentityReference.Value, ["type"] = rule.AccessControlType.ToString(), ["rights"] = $"0x{(int)rule.FileSystemRights:X8}", ["inherited"] = rule.IsInherited,
        })];

    private static int AclFile(string path, string cpSid, string holderSid)
    {
        Dictionary<string, object?> line = Line("acl-file");
        string step = "create";
        try
        {
            using (FileStream created = new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) created.Write(Encoding.ASCII.GetBytes("created by the Control Plane stand-in\n"));
            FileInfo info = new(path);
            step = "read_inherited";
            FileSecurity before = info.GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
            line["owner"] = (before.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier)?.Value;
            line["inheritedAces"] = Describe(before);
            step = "set_protected_dacl";
            // A new, empty security object: protected (no inheritance, nothing copied from the folder), then exactly two ACEs. Synchronize is part of FILE_GENERIC_READ; without it a plain read open is refused.
            FileSecurity wanted = new();
            wanted.SetAccessRuleProtection(true, false);
            wanted.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(cpSid), FileSystemRights.Modify, AccessControlType.Allow));
            wanted.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(holderSid), FileSystemRights.Read | FileSystemRights.Synchronize, AccessControlType.Allow));
            info.SetAccessControl(wanted);
            step = "read_back";
            FileSecurity after = info.GetAccessControl(AccessControlSections.Access);
            line["finalAces"] = Describe(after);
            line["protected"] = after.AreAccessRulesProtected;
            step = "append";
            using (FileStream append = new(path, FileMode.Append, FileAccess.Write, FileShare.Read)) append.Write(Encoding.ASCII.GetBytes("appended after the DACL was replaced\n"));
            line["appendedAfterSet"] = true;
            line["ok"] = true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception or ArgumentException)
        {
            line["ok"] = false;
            line["failedStep"] = step;
            line["exception"] = ex.GetType().Name;
            line["hresult"] = Hex((uint)ex.HResult);
        }
        Emit(line);
        return 0;
    }

    private static int FileAccessProbe(string path, string mode)
    {
        Dictionary<string, object?> line = Line("file-access");
        line["mode"] = mode;
        line["identity"] = WindowsIdentity.GetCurrent().Name;
        try
        {
            using FileStream stream = new(path, FileMode.Open, mode == "write" ? FileAccess.Write : FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            line["outcome"] = "opened";
            if (mode == "read") line["firstByteRead"] = stream.ReadByte() >= 0;
        }
        catch (UnauthorizedAccessException) { line["outcome"] = "denied"; }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { line["outcome"] = "missing"; }
        catch (IOException ex) { line["outcome"] = $"error_{ex.HResult & 0xFFFF}"; }
        Emit(line);
        return 0;
    }

    // ---- outbound HTTPS

    private static int Https(string url, int seconds)
    {
        Dictionary<string, object?> line = Line("https");
        line["url"] = url;
        using HttpClient client = new() { Timeout = TimeSpan.FromSeconds(seconds) };
        try
        {
            using HttpResponseMessage reply = client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult();
            line["ok"] = true;
            line["status"] = (int)reply.StatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            SocketException? socket = FindSocketException(ex);
            line["ok"] = false;
            line["socketError"] = socket?.SocketErrorCode.ToString();
            line["win32"] = socket?.NativeErrorCode;
            line["kind"] = socket?.SocketErrorCode switch
            {
                SocketError.AccessDenied => "access_denied",
                SocketError.HostNotFound or SocketError.TryAgain or SocketError.NoData => "name_resolution",
                SocketError.NetworkUnreachable or SocketError.HostUnreachable or SocketError.ConnectionRefused or SocketError.NetworkDown => "unreachable",
                SocketError.TimedOut => "timeout",
                _ => ex is TaskCanceledException ? "timeout" : (ex as HttpRequestException)?.HttpRequestError == HttpRequestError.NameResolutionError ? "name_resolution" : "error",
            };
            line["exceptionTypes"] = ExceptionTypes(ex);
        }
        Emit(line);
        return 0;
    }

    private static string[] ExceptionTypes(Exception ex)
    {
        List<string> types = [];
        for (Exception? current = ex; current is not null && types.Count < 6; current = current.InnerException) types.Add(current.GetType().Name);
        return [.. types];
    }
}
