// Test-only (not in the shipped build, see the csproj): the real supervisor without the SCM, so a host test can start, restart, stop and kill the host like the service
// would be. `serve <config>`: end of standard input plays SERVICE_CONTROL_STOP. Prints CPHOST_READY once the first child is inside its Job and CPHOST_STOPPED when the
// loop has ended; the process exit code is the loop's (0 after a stop, or one of the fixed codes of Program.cs).
// `--fault <name>` (before the subcommand) injects one failure a test cannot cause from outside: `resume-fails` (ResumeThread fails), `empty-profile` (Windows returns an
// empty user profile folder), `relative-appdata` (Windows returns a relative APPDATA folder), `pin-only` (the launch gate passes and is held, no child is started: prints CPHOST_PIN_HELD).
internal static class TestSeam
{
    public static bool ResumeFails { get; private set; }
    public static bool PinOnly { get; private set; }

    public static bool TryInject(string fault)
    {
        switch (fault)
        {
            case "resume-fails": ResumeFails = true; return true;
            case "pin-only": PinOnly = true; return true;
            case "empty-profile": ChildEnvironment.UseFolderSource(kind => kind == Environment.SpecialFolder.UserProfile ? "" : Environment.GetFolderPath(kind)); return true;
            case "relative-appdata": ChildEnvironment.UseFolderSource(kind => kind == Environment.SpecialFolder.ApplicationData ? @"AppData\Roaming" : Environment.GetFolderPath(kind)); return true;
            default: return false;
        }
    }

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
