// Test-only (not in the shipped build, see the csproj): the real supervisor without the SCM, so a host test can start, restart, stop and kill the host like the service
// would be. `serve <config>`: end of standard input plays SERVICE_CONTROL_STOP. Prints CPHOST_READY once the first child is inside its Job and CPHOST_STOPPED when the
// loop has ended; the process exit code is the loop's (0 after a stop, or one of the fixed codes of Program.cs).
internal static class TestSeam
{
    public static int Serve(string configPath)
    {
        if (HostConfig.TryLoad(configPath, out string reason) is not { } config)
        {
            Console.WriteLine($"SERVICE_CONFIG=invalid:{reason}");
            return Program.ExitConfigInvalid;
        }
        using Supervisor supervisor = new(config);
        using CancellationTokenSource stop = new();
        _ = Task.Run(() => { Console.In.ReadToEnd(); stop.Cancel(); });
        int code = supervisor.Run(stop.Token, () => Console.WriteLine("CPHOST_READY"), () => { });
        Console.WriteLine("CPHOST_STOPPED");
        return code;
    }
}
