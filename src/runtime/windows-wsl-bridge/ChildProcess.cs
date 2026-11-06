using System.Diagnostics;

namespace Albera.WslBridge;

/// <summary>Output of a short child program. Truncated is true when it wrote more than the cap (the rest is dropped and the child is stopped).</summary>
internal sealed record ChildResult(int ExitCode, byte[] Output, bool Truncated, bool TimedOut);

// Starts a program with an argument list (never a command line string, never a shell), a fixed environment and a deadline. Used for wsl.exe (short commands) and git.
internal static class ChildProcess
{
    public static ProcessStartInfo Start(string file, IEnumerable<string> args, IReadOnlyDictionary<string, string> environment, bool pipeInput)
    {
        ProcessStartInfo info = new(file)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = pipeInput, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string arg in args) info.ArgumentList.Add(arg);
        info.Environment.Clear();
        foreach ((string key, string value) in environment) info.Environment[key] = value;
        return info;
    }

    /// <summary>Runs to the end or the deadline. Standard error is read and dropped, so a full pipe never stops the child.</summary>
    public static ChildResult Run(string file, IEnumerable<string> args, IReadOnlyDictionary<string, string> environment, int maxOutput, TimeSpan timeout)
    {
        using Process process = new() { StartInfo = Start(file, args, environment, pipeInput: false) };
        try { process.Start(); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { return new ChildResult(-1, [], false, false); }
        Task drainError = Task.Run(() => process.StandardError.BaseStream.CopyTo(Stream.Null));
        Task<(byte[] Bytes, bool Truncated)> read = Task.Run(() => ReadCapped(process.StandardOutput.BaseStream, maxOutput, process));
        bool finished = process.WaitForExit(timeout) && read.Wait(timeout);
        if (!finished) Kill(process);
        (byte[] bytes, bool truncated) = read.Wait(TimeSpan.FromSeconds(5)) ? read.Result : ([], false);
        drainError.Wait(TimeSpan.FromSeconds(1));
        return new ChildResult(finished && process.HasExited ? process.ExitCode : -1, bytes, truncated, !finished);
    }

    private static (byte[], bool) ReadCapped(Stream stream, int max, Process process)
    {
        using MemoryStream buffer = new();
        byte[] chunk = new byte[65536];
        int n;
        while ((n = stream.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (buffer.Length + n > max) { Kill(process); return (buffer.ToArray(), true); }
            buffer.Write(chunk, 0, n);
        }
        return (buffer.ToArray(), false);
    }

    public static void Kill(Process process)
    {
        try { process.Kill(entireProcessTree: true); }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { /* already gone */ }
    }
}
