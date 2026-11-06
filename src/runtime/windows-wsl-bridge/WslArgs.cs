namespace Albera.WslBridge;

// Every argument list this program ever gives to wsl.exe, built from constants and a checked run name (never from request bytes). The harness pins them one by one.
// There is no builder for `--shutdown`: it restarts the kernel and stops the owner's Ubuntu and Docker too, so it is a separate decision (ADR-012, decision 13) and not part of this program.
internal static class WslArgs
{
    public static string[] Version() => ["--version"];
    public static string[] List() => ["--list", "--quiet"];
    public static string[] Import(string name, string folder, string image) => ["--import", RunName.Require(name), folder, image, "--version", "2"];
    public static string[] Terminate(string name) => ["--terminate", RunName.Require(name)];
    public static string[] Unregister(string name) => ["--unregister", RunName.Require(name)];
    /// <summary>Root starts the sandbox script, which drops to the job user (enter.sh); the agent's frames then travel on this process's stdin and stdout.</summary>
    public static string[] Agent(string name) => ["-d", RunName.Require(name), "-u", "root", "--cd", "/", "--", "/bin/bash", "/opt/albera/enter.sh", "albera-agent"];
}
