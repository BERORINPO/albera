using System.Security.Principal;
using Albera.Setup;

// albera-setup.exe: see docs/architecture/control-plane-service.md section 8. All the logic is in SetupFlow and the files beside it (the tests compile those without this file).
// This file only turns the command line and Windows into the values the flow needs. It reads no environment variable.
if (args.Length == 1 && args[0] is "--help" or "-h" or "/?")
{
    Console.WriteLine(SetupOptions.Usage);
    return SetupFlow.Done;
}

SetupOptions options;
try
{
    options = SetupOptions.Parse(args);
}
catch (SetupUsageException error)
{
    Console.Error.WriteLine($"{error.Message}\r\n{SetupOptions.Usage}");
    return SetupFlow.Usage;
}

var deps = new SetupDeps
{
    Runner = new RealProcessRunner(),
    Folders = new KnownFolders(Environment.SystemDirectory, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData)),
    IsElevated = () => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),
    SetupDirectory = Path.GetDirectoryName(Environment.ProcessPath) ?? string.Empty,
    InstalledSetupDirectory = SetupLayout.InstalledSetupDirectory,
    WorkRoot = SetupLayout.WorkRoot,
    NewWorkName = () => Guid.NewGuid().ToString("N")[..12],   // short on purpose: the installer script (Windows PowerShell 5.1) works with paths under the 260-character limit
    CreateWorkDirectory = path => FileSystemChecks.CreateAdministratorOnlyDirectory(path),
    AdministratorOnlyProblems = FileSystemChecks.AdministratorOnlyProblems,
    PathHasReparsePoint = FileSystemChecks.PathHasReparsePoint,
    InstallRecordPath = SetupLayout.InstallRecordFile,
    ReadRunIdFloor = FileSystemChecks.ReadSetupRunIdFloor,
    Out = Console.Out,
};

var exitCode = SetupFlow.Run(options, deps);
if (!options.NoPause && !Console.IsInputRedirected)
{
    Console.WriteLine("Press Enter to close this window.");
    Console.ReadLine();
}
return exitCode;
