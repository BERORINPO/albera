using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Test-only fakes (never shipped, never built by npm scripts).
//   serve <pipe> <reply|impersonate|drop>  a same-user pipe server that is NOT the Broker. It owns the pipe as this user, prints
//                                          "READY pid=<n>", counts the bytes the client sent ("BYTES=<n>") and then
//                                          reply: answers with a Broker-shaped denial / impersonate: also tries ImpersonateNamedPipeClient and
//                                          prints "IMPERSONATION=<level>" / drop: closes without answering.
//   client <pipe>                          a plain client that asks for full impersonation (the control for the SQOS test).
//   dacl <pipe>                            opens an existing pipe and prints "SDDL=<owner + DACL>" (the Control Plane ACE test).
internal static class Program
{
    private static readonly byte[] Denied = Frame("{\"ok\":false,\"code\":\"denied\"}");

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 3 && args[0] == "serve" && args[2] is "reply" or "impersonate" or "drop") return await ServeAsync(args[1], args[2]);
        if (args.Length == 2 && args[0] == "client") return await ClientAsync(args[1]);
        if (args.Length == 2 && args[0] == "dacl") return Dacl(args[1]);
        return 64;
    }

    // Opens an existing pipe as this user and prints its owner and DACL as SDDL ("SDDL=..."), then hangs up without sending a byte.
    // The open uses up the single connection a Broker serves, so the Broker then exits on its own.
    private static int Dacl(string pipeName)
    {
        using NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Identification);
        client.Connect(5000);
        Console.WriteLine($"SDDL={client.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access)}");
        return 0;
    }

    private static async Task<int> ServeAsync(string pipeName, string mode)
    {
        using WindowsIdentity me = WindowsIdentity.GetCurrent();
        SecurityIdentifier self = me.User!;
        PipeSecurity security = new();
        security.SetOwner(self);
        security.AddAccessRule(new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow));
        await using NamedPipeServerStream pipe = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, security);
        Console.WriteLine($"READY pid={Environment.ProcessId}");
        using CancellationTokenSource connectLimit = new(TimeSpan.FromSeconds(20));
        await pipe.WaitForConnectionAsync(connectLimit.Token);

        byte[] buffer = new byte[8192];
        int total = 0;
        using CancellationTokenSource readLimit = new(TimeSpan.FromSeconds(3));
        try
        {
            while (total < 4 || total < 4 + BitConverter.ToInt32(buffer, 0))
            {
                int read = await pipe.ReadAsync(buffer.AsMemory(total), readLimit.Token);
                if (read == 0) break;
                total += read;
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException) { }
        Console.WriteLine($"BYTES={total}");
        if (mode == "impersonate" && total > 0) Console.WriteLine($"IMPERSONATION={ImpersonationLevel(pipe.SafePipeHandle)}");
        try { if (mode != "drop") { await pipe.WriteAsync(Denied); await pipe.FlushAsync(); } }
        catch (IOException) { } // the client already hung up (the identity check failed): nothing to answer
        return 0;
    }

    // No await between impersonate and revert: a continuation could resume on another thread and leave this one impersonated.
    private static string ImpersonationLevel(SafePipeHandle pipe)
    {
        if (!ImpersonateNamedPipeClient(pipe)) return "ImpersonateNamedPipeClient_failed";
        try
        {
            if (!OpenThreadToken(GetCurrentThread(), 0x8 /*TOKEN_QUERY*/, true, out IntPtr token)) return "OpenThreadToken_failed";
            try { return GetTokenInformation(token, 9 /*TokenImpersonationLevel*/, out int level, 4, out _) ? level switch { 0 => "Anonymous", 1 => "Identification", 2 => "Impersonation", 3 => "Delegation", _ => "Unknown" } : "GetTokenInformation_failed"; }
            finally { _ = CloseHandle(token); }
        }
        finally { _ = RevertToSelf(); }
    }

    private static async Task<int> ClientAsync(string pipeName)
    {
        await using NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Impersonation);
        await client.ConnectAsync(5000);
        await client.WriteAsync(Frame("{\"receipt\":\"AAAA\",\"signature\":\"AAAA\"}"));
        await client.FlushAsync();
        byte[] sink = new byte[512];
        while (await client.ReadAsync(sink) > 0) { }
        return 0;
    }

    private static byte[] Frame(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        return [.. BitConverter.GetBytes(body.Length), .. body];
    }

    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ImpersonateNamedPipeClient(SafePipeHandle pipe);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool RevertToSelf();
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int informationClass, out int information, int length, out int returned);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
