using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

namespace Albera.Lab;

// One configured job per service start. The config file is written by the lab runner before `sc start`, so one installed service can be
// reused for several runs without touching its registration.
//   mode "child"   launch `program args...` as a child (stdin from stdinFile when given); its stdout / stderr go to the result file.
//                  The child shares this process's token, but the SCM-reported PID is the shim's, not the child's.
//   mode "inproc"  load a .NET program's assembly (`program` = its .dll) into this process and call its entry point with `args`. The
//                  Broker needs this: the PID that SCM reports for the service must be the PID that created the pipe.
internal sealed class JobConfig
{
    public string Mode { get; init; } = "";
    public string Program { get; init; } = "";
    public string[] Args { get; init; } = [];
    public string? StdinFile { get; init; }
    public string ResultFile { get; init; } = "";
    public string? TokenFile { get; init; }
    public bool Linger { get; init; } // keep the service RUNNING after the job ends, until STOP
    public int TimeoutSeconds { get; init; } = 60;

    public static JobConfig Load(string path)
    {
        JobConfig config = JsonSerializer.Deserialize<JobConfig>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException("empty config");
        if (config.Mode is not ("child" or "inproc") || config.Program.Length == 0 || config.ResultFile.Length == 0 || config.TimeoutSeconds is < 1 or > 600)
            throw new InvalidDataException("invalid config");
        return config;
    }
}

internal sealed class JobRunner : IDisposable
{
    private readonly JobConfig config;
    private readonly TextWriter log; // synchronized: Console.SetOut(log) in inproc mode reuses the same lock
    private readonly object childGate = new();
    private Process? child;

    public JobRunner(JobConfig config)
    {
        this.config = config;
        log = TextWriter.Synchronized(new StreamWriter(new FileStream(config.ResultFile, FileMode.Create, FileAccess.Write, FileShare.Read)) { AutoFlush = true });
    }

    public void Line(string text) => log.WriteLine(text);

    public int Run()
    {
        int code;
        try
        {
            Dictionary<string, object?> token = TokenReport.Capture();
            if (config.TokenFile is not null) File.WriteAllText(config.TokenFile, JsonSerializer.Serialize(token, new JsonSerializerOptions { WriteIndented = true }));
            Line($"[shim] start pid={Environment.ProcessId} mode={config.Mode}");
            code = config.Mode == "inproc" ? RunInProcess() : RunChild();
        }
        catch (Exception ex)
        {
            Line($"[shim] error {ex.GetType().Name}: {(ex is TargetInvocationException { InnerException: { } inner } ? $"{inner.GetType().Name}: {inner.Message}" : ex.Message)}");
            code = -1;
        }
        Line($"[shim] exit={code}");
        return code;
    }

    public void Stop()
    {
        lock (childGate)
        {
            if (child is { HasExited: false }) child.Kill(entireProcessTree: true);
        }
    }

    private int RunInProcess()
    {
        Console.SetOut(log);
        Console.SetError(log);
        BrokerLoadContext context = new(config.Program);
        MethodInfo entry = context.LoadFromAssemblyPath(config.Program).EntryPoint ?? throw new InvalidOperationException("no entry point");
        return entry.Invoke(null, [config.Args]) is int code ? code : 0;
    }

    private int RunChild()
    {
        ProcessStartInfo start = new(config.Program)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = config.StdinFile is not null,
        };
        foreach (string argument in config.Args) start.ArgumentList.Add(argument);
        using Process process = Process.Start(start) ?? throw new InvalidOperationException("child did not start");
        lock (childGate) child = process;
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) log.WriteLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) log.WriteLine($"[stderr] {e.Data}"); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        Line($"[shim] child pid={process.Id}");
        if (config.StdinFile is not null)
        {
            process.StandardInput.Write(File.ReadAllText(config.StdinFile));
            process.StandardInput.Close();
        }
        if (!process.WaitForExit(config.TimeoutSeconds * 1000))
        {
            Line("[shim] timeout; killing the child");
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            return -2;
        }
        process.WaitForExit(); // drain the asynchronous output readers
        return process.ExitCode;
    }

    public void Dispose() => log.Dispose();

    // Framework assemblies come from this host's runtime; everything else (Microsoft.Data.Sqlite, SQLitePCLRaw, the native sqlite) from the Broker's own folder.
    private sealed class BrokerLoadContext(string assemblyPath) : AssemblyLoadContext("albera-broker")
    {
        private readonly AssemblyDependencyResolver resolver = new(assemblyPath);

        protected override Assembly? Load(AssemblyName name)
        {
            try { return Default.LoadFromAssemblyName(name); }
            catch (FileNotFoundException) { }
            return resolver.ResolveAssemblyToPath(name) is { } path ? LoadFromAssemblyPath(path) : null;
        }

        protected override IntPtr LoadUnmanagedDll(string name) =>
            resolver.ResolveUnmanagedDllToPath(name) is { } path ? LoadUnmanagedDllFromPath(path) : IntPtr.Zero;
    }
}
