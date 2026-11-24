using System.Reflection;
using System.Text;
using Albera.WslBridge;

namespace Albera.WslBridge.Harness;

internal static partial class Harness
{
    private static void HostChecks()
    {
        Check("wsl arguments: exact lists, built from constants and a checked name", () =>
        {
            Same("--import|albera-run-x1|C:\\d\\albera-run-x1|C:\\i.tar|--version|2", string.Join('|', WslArgs.Import("albera-run-x1", "C:\\d\\albera-run-x1", "C:\\i.tar")), "import");
            Same("--terminate|albera-run-x1", string.Join('|', WslArgs.Terminate("albera-run-x1")), "terminate");
            Same("--unregister|albera-run-x1", string.Join('|', WslArgs.Unregister("albera-run-x1")), "unregister");
            Same("-d|albera-run-x1|-u|root|--cd|/|--|/bin/bash|/opt/albera/enter.sh|albera-agent", string.Join('|', WslArgs.Agent("albera-run-x1")), "agent");
            Same("--list|--quiet", string.Join('|', WslArgs.List()), "list");
        });

        Check("wsl arguments: a name that is not an albera-run- name is refused by every builder (Ubuntu, docker-desktop, look-alikes)", () =>
        {
            foreach (string name in new[] { "Ubuntu", "docker-desktop", "albera-runner", "albera-run-", "albera-run-A", "albera-run-a b", "albera-run-a;b", "albera-run-a\n", "albera-run-a\r\n", "ALBERA-RUN-a", "", "albera-run-" + new string('a', 49) })
            {
                foreach (Func<string, string[]> build in new Func<string, string[]>[] { WslArgs.Terminate, WslArgs.Unregister, WslArgs.Agent, n => WslArgs.Import(n, "C:\\d", "C:\\i") })
                {
                    try { build(name); Assert(false, "accepted " + name); }
                    catch (ArgumentException) { }
                }
            }
        });

        Check("wsl arguments: no builder can produce --shutdown, and the sources never write it as an argument", () =>
        {
            string[] all = [.. WslArgs.Version(), .. WslArgs.List(), .. WslArgs.Import("albera-run-x", "C:\\d", "C:\\i"), .. WslArgs.Terminate("albera-run-x"), .. WslArgs.Unregister("albera-run-x"), .. WslArgs.Agent("albera-run-x")];
            Assert(!all.Any(arg => arg.Contains("shutdown", StringComparison.OrdinalIgnoreCase)), "shutdown in an argument list");
            Assert(typeof(WslArgs).GetMethods(BindingFlags.Public | BindingFlags.Static).All(m => !m.Name.Contains("Shutdown", StringComparison.OrdinalIgnoreCase)), "a shutdown builder");
        });

        Check("wsl environment: no WSLENV, UTF-8 text, PATH is System32 only", () =>
        {
            IReadOnlyDictionary<string, string> env = WslExeHost.ChildEnvironment();
            Assert(!env.ContainsKey("WSLENV") && !env.ContainsKey("WSL_INTEROP"), "WSLENV must not be passed on");
            Same("1", env["WSL_UTF8"], "WSL_UTF8");
            Same(Environment.SystemDirectory, env["PATH"], "PATH");
            Assert(!env.Keys.Any(key => key.Contains("TOKEN", StringComparison.OrdinalIgnoreCase) || key.Contains("KEY", StringComparison.OrdinalIgnoreCase)), "no secret-looking variable");
        });

        Check("wsl --version: the numbers are read whatever language the labels are in", () =>
        {
            WslVersions? ja = WslExeHost.ParseVersions("WSL バージョン: 2.6.3.0\r\nカーネル バージョン: 6.6.87.2-1\r\nWSLg バージョン: 1.0.71\r\n");
            Assert(ja is not null && ja.Wsl == new Version(2, 6, 3, 0) && ja.Kernel == new Version(6, 6, 87, 2), "japanese");
            WslVersions? en = WslExeHost.ParseVersions("WSL version: 2.4.8.0\nKernel version: 5.15.167.4-1\n");
            Assert(en is not null && en.Wsl == new Version(2, 4, 8, 0) && en.Kernel == new Version(5, 15, 167, 4), "english");
            Assert(WslExeHost.ParseVersions("nothing here\nat all\n") is null && WslExeHost.ParseVersions("") is null, "garbage");
        });

        Check("floor: older WSL, older kernel and an expired floor each refuse; a newer one passes", () =>
        {
            Floor floor = new(new Version(2, 4, 0), new Version(6, 6, 0), 2000);
            WslVersions ok = new(new Version(2, 6, 0), new Version(6, 6, 87));
            Assert(floor.Check(ok, 1999) is null, "pass");
            Same(Reason.FloorExpired, floor.Check(ok, 2000)!, "expiry is exclusive of the last second");
            Same(Reason.WslOld, floor.Check(ok with { Wsl = new Version(2, 3, 9) }, 1)!, "wsl");
            Same(Reason.KernelOld, floor.Check(ok with { Kernel = new Version(6, 5, 9) }, 1)!, "kernel");
            Same(Reason.WslUnavailable, floor.Check(null, 1)!, "none");
        });

        Check("wire: requests parse only with a known verb and a plain id", () =>
        {
            Assert(Wire.Parse([2, 4, (byte)'o', (byte)'p', (byte)'-', (byte)'1', 9, 9]) is { Verb: Verb.Exec, RunId: "op-1" } r && r.Body.SequenceEqual(new byte[] { 9, 9 }), "good");
            Assert(Wire.Parse([]) is null && Wire.Parse([0, 1, (byte)'a']) is null && Wire.Parse([9, 1, (byte)'a']) is null && Wire.Parse([7, 1, (byte)'a']) is { Verb: Verb.Bundle } && Wire.Parse([8, 1, (byte)'a']) is { Verb: Verb.Status }, "verb");
            Assert(Wire.Parse([2, 0]) is null && Wire.Parse([2, 5, (byte)'a']) is null && Wire.Parse([2, 2, (byte)'-', (byte)'a']) is null && Wire.Parse([2, 2, (byte)'a', (byte)' ']) is null, "id");
            Assert(Wire.Parse([2, 1, (byte)'/', 1]) is null, "slash");
            Assert(Wire.Parse([2, 2, (byte)'a', (byte)'\n']) is null && !Wire.IsId("a\n"), "a final line feed");
            Assert(RunName.For("a\n") is null && !RunName.IsRunName("albera-run-a\n"), "a final line feed in a run name");
        });

        Check("wire: a frame over the cap or of length zero is refused before anything is allocated", () =>
        {
            using MemoryStream huge = new([0x7f, 0xff, 0xff, 0xff, 1, 2, 3]);
            Assert(Wire.ReadFrameAsync(huge, 1024, CancellationToken.None).GetAwaiter().GetResult() is null, "huge");
            using MemoryStream zero = new([0, 0, 0, 0]);
            Assert(Wire.ReadFrameAsync(zero, 1024, CancellationToken.None).GetAwaiter().GetResult() is null, "zero");
            using MemoryStream cut = new([0, 0, 0, 5, 1, 2]);
            Assert(Wire.ReadFrameAsync(cut, 1024, CancellationToken.None).GetAwaiter().GetResult() is null, "cut");
            Same("0000", Convert.ToHexString(Wire.Encode(Reply.Success([0])).Take(2).ToArray()), "ok reply");
            Same("01" + Convert.ToHexString(Encoding.ASCII.GetBytes("no_run")), Convert.ToHexString(Wire.Encode(Reply.Refuse(Reason.NoRun))), "refusal reply");
        });

        Check("bundle header: only a full bundle whose one ref is HEAD names a head", () =>
        {
            string oid = new('d', 40);
            Same(oid, BundleHeader.HeadOf(FakeRepositories.BundleOf(oid))!, "v2");
            Same(oid, BundleHeader.HeadOf(Encoding.ASCII.GetBytes($"# v3 git bundle\n@object-format=sha1\n{oid} HEAD\n\nPACK"))!, "v3");
            Assert(BundleHeader.HeadOf(Encoding.ASCII.GetBytes($"# v2 git bundle\n{oid} refs/heads/main\n\nPACK")) is null, "not HEAD");
            Assert(BundleHeader.HeadOf(Encoding.ASCII.GetBytes($"# v2 git bundle\n{oid} HEAD\n{oid} refs/heads/x\n\nPACK")) is null, "two refs");
            Assert(BundleHeader.HeadOf(Encoding.ASCII.GetBytes($"# v2 git bundle\n-{oid} prereq\n{oid} HEAD\n\nPACK")) is null, "prerequisite");
            Assert(BundleHeader.HeadOf(Encoding.ASCII.GetBytes("garbage")) is null && BundleHeader.HeadOf([]) is null, "garbage");
        });

        Check("git: the real reader finds the head and a bundle whose header names it, and runs no planted fsmonitor or hook", () =>
        {
            const string gitExe = @"C:\Program Files\Git\cmd\git.exe";
            if (!File.Exists(gitExe)) return; // this machine has no Git for Windows: the on-device gates cover it
            string root = Path.Combine(Path.GetTempPath(), "albera-realgit-" + Guid.NewGuid().ToString("N")[..10]);
            string repo = Path.Combine(root, "repo"), scratch = Path.Combine(root, "scratch"), marker = Path.Combine(root, "ran");
            Directory.CreateDirectory(repo); Directory.CreateDirectory(scratch);
            try
            {
                string Run(params string[] args)
                {
                    ChildResult result = ChildProcess.Run(gitExe, new[] { "-C", repo }.Concat(args), new Dictionary<string, string> { ["SystemRoot"] = @"C:\Windows", ["PATH"] = Environment.SystemDirectory + @";C:\Program Files\Git\cmd" }, 1 << 20, TimeSpan.FromSeconds(30));
                    return Encoding.UTF8.GetString(result.Output).Trim();
                }
                Run("init", "-q");
                File.WriteAllText(Path.Combine(repo, "a.txt"), "a");
                Run("add", ".");
                Run("-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "one");
                string head = Run("rev-parse", "HEAD");
                File.WriteAllText(Path.Combine(root, "fsmonitor.cmd"), "@echo off\r\necho x> \"" + marker + "\"\r\n");
                Run("config", "core.fsmonitor", Path.Combine(root, "fsmonitor.cmd").Replace('\\', '/'));
                GitRepositories git = new(gitExe, scratch);
                Same(head, git.ReadHead(repo) ?? "(null)", "head");
                byte[]? bundle = git.MakeBundle(repo, 1 << 20);
                Assert(bundle is not null && BundleHeader.HeadOf(bundle) == head, "bundle header names the head");
                Assert(!File.Exists(marker), "the planted fsmonitor ran");
                Assert(git.MakeBundle(repo, 10) is null, "a bundle over the cap is refused");
            }
            finally { try { Directory.Delete(root, true); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { } }
        });

        Check("git: hardening flags and a fixed environment, as in git-process.mjs", () =>
        {
            GitRepositories git = new(@"C:\Program Files\Git\cmd\git.exe", Path.Combine(Path.GetTempPath(), "albera-git-scratch-" + Guid.NewGuid().ToString("N")));
            string flags = string.Join(' ', git.Hardening());
            foreach (string need in new[] { "core.fsmonitor=false", "protocol.allow=never", "protocol.file.allow=never", "transfer.fsckObjects=true", "core.useReplaceRefs=false", "credential.helper=", "core.pager=cat", "gc.auto=0", "core.hooksPath=" })
                Assert(flags.Contains(need), "missing " + need);
            Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "albera-git-scratch-env"));
            GitRepositories withScratch = new(@"C:\Program Files\Git\cmd\git.exe", Path.Combine(Path.GetTempPath(), "albera-git-scratch-env"));
            Dictionary<string, string> env = withScratch.Environment(@"C:\repos\one");
            Same("1", env["GIT_CONFIG_NOSYSTEM"], "no system config");
            Same("1", env["GIT_NO_LAZY_FETCH"], "no lazy fetch");
            Same(@"C:\repos", env["GIT_CEILING_DIRECTORIES"], "no search above the repository");
            Assert(env["GIT_CONFIG_GLOBAL"].EndsWith("empty.gitconfig", StringComparison.Ordinal) && !env.ContainsKey("WSLENV"), "global config is an empty file");
            Directory.Delete(Path.Combine(Path.GetTempPath(), "albera-git-scratch-env"), recursive: true);
        });
    }
}
