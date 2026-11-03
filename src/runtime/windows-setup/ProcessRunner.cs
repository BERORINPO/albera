using System.Diagnostics;
using System.Text;

namespace Albera.Setup;

/// <summary>What to start. FileName is a full path (no PATH lookup). Environment is the complete block (nothing is inherited). Capture=false leaves the child on setup's own console (the installer).</summary>
internal sealed record ProcessSpec(string FileName, IReadOnlyList<string> Arguments, IReadOnlyDictionary<string, string> Environment, string WorkingDirectory, bool Capture, TimeSpan Timeout);

internal sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError, bool TimedOut, bool OutputTooLarge);

/// <summary>The seam the tests replace: gh.exe and the installer are never started by a test, a fake answers instead.</summary>
internal interface IProcessRunner
{
    ProcessResult Run(ProcessSpec spec);
}

/// <summary>
/// CreateProcess with an explicit environment block: <c>ProcessStartInfo.Environment</c> is cleared and then filled from the spec only. A timeout ends the one process setup
/// started, by its handle (<c>Process.Kill()</c>, not the tree, never by image name).
/// </summary>
internal sealed class RealProcessRunner : IProcessRunner
{
    public const int MaxCaptureCharacters = 8 * 1024 * 1024;

    public ProcessResult Run(ProcessSpec spec)
    {
        if (!Path.IsPathFullyQualified(spec.FileName)) throw new SetupRefusal("process_path", $"not a full path: {spec.FileName}");
        var info = new ProcessStartInfo
        {
            FileName = spec.FileName,
            WorkingDirectory = spec.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardInput = spec.Capture,
            RedirectStandardOutput = spec.Capture,
            RedirectStandardError = spec.Capture,
        };
        foreach (var argument in spec.Arguments) info.ArgumentList.Add(argument);
        info.Environment.Clear();
        foreach (var (name, value) in spec.Environment) info.Environment[name] = value;

        using var process = Process.Start(info) ?? throw new SetupRefusal("process_start", $"could not start {Path.GetFileName(spec.FileName)}");
        if (!spec.Capture) return Finish(process, spec.Timeout, new Capture(), new Capture());

        process.StandardInput.Close();
        var output = new Capture();
        var error = new Capture();
        var readers = new[] { Task.Run(() => output.Fill(process.StandardOutput)), Task.Run(() => error.Fill(process.StandardError)) };
        return Finish(process, spec.Timeout, output, error, readers);
    }

    private static ProcessResult Finish(Process process, TimeSpan timeout, Capture output, Capture error, Task[]? readers = null)
    {
        var timedOut = !process.WaitForExit(timeout);
        if (timedOut)
        {
            process.Kill();
            process.WaitForExit();
        }
        if (readers is not null) Task.WaitAll(readers);
        return new ProcessResult(timedOut ? -1 : process.ExitCode, output.Text, error.Text, timedOut, output.TooLarge || error.TooLarge);
    }

    /// <summary>Reads a stream to its end but keeps only the first MaxCaptureCharacters (the rest is drained and dropped, so the child never blocks on a full pipe).</summary>
    private sealed class Capture
    {
        private readonly StringBuilder _text = new();
        public bool TooLarge { get; private set; }
        public string Text => _text.ToString();

        public void Fill(TextReader reader)
        {
            var buffer = new char[8192];
            int read;
            while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                var room = MaxCaptureCharacters - _text.Length;
                if (read > room) TooLarge = true;
                if (room > 0) _text.Append(buffer, 0, Math.Min(read, room));
            }
        }
    }
}
