using Albera.Setup;

internal static partial class Harness
{
    private static void OptionsChecks()
    {
        Check("options: --update is required and must be a full path; install is the default mode", () =>
        {
            var options = SetupOptions.Parse(["--update", @"C:\update\"]);
            Equal(SetupMode.Install, options.Mode, "mode");
            Equal(@"C:\update", options.UpdateFolder, "folder");
            Assert(!options.NoPause, "pause by default");
            foreach (var bad in new[] { Array.Empty<string>(), ["--update"], ["--update", "relative"], ["--update", ""] })
                Assert(Throws<SetupUsageException>(() => SetupOptions.Parse(bad)), "accepted: " + string.Join(" ", bad));
        });

        Check("options: unknown arguments, repeated ones and a bad mode are usage errors", () =>
        {
            foreach (var bad in new[]
            {
                new[] { "--update", @"C:\u", "--bogus" }, ["--update", @"C:\u", "--update", @"C:\v"], ["--update", @"C:\u", "--mode", "uninstall"], ["--update", @"C:\u", "--no-pause", "--no-pause"],
                ["--update", @"C:\u", "-ExpectedTreeHash", "a"],
            }) Assert(Throws<SetupUsageException>(() => SetupOptions.Parse(bad)), "accepted: " + string.Join(" ", bad));
        });

        Check("options: installer values are passed on only with a safe character set; a leading dash, a quote, a space where none belongs, or a control character is refused", () =>
        {
            var ok = SetupOptions.Parse(["--update", @"C:\u", "--approver-key-id", "hello-ab_1.2", "--approver-public-key", "MIIB+/=", "--approver-sid", "S-1-5-21-1-2-3-1001",
                "--grant-hyperv-to-broker", "--vm-name", "my vm-01", "--computer-id", "clone-01"]);
            Equal("my vm-01", ok.Engine.VmName, "vm name with a space");
            foreach (var (name, value) in new[]
            {
                ("--approver-key-id", "-evil"), ("--approver-key-id", "a b"), ("--approver-key-id", "a\"b"), ("--approver-public-key", "AA;BB"), ("--approver-sid", "S-1-5-21;calc"),
                ("--vm-name", "vm\"x"), ("--vm-name", "vm\nx"), ("--computer-id", "a b"), ("--approver-key-id", ""),
            })
            {
                var args = new List<string> { "--update", @"C:\u", "--grant-hyperv-to-broker", name, value };
                Assert(Throws<SetupUsageException>(() => SetupOptions.Parse(args)), $"accepted {name} {value}");
            }
        });

        Check("options: --vm-name needs --grant-hyperv-to-broker, and verify mode takes no installer values", () =>
        {
            Assert(Throws<SetupUsageException>(() => SetupOptions.Parse(["--update", @"C:\u", "--vm-name", "x"])), "vm name alone");
            Assert(Throws<SetupUsageException>(() => SetupOptions.Parse(["--update", @"C:\u", "--mode", "verify", "--approver-sid", "S-1-5-21-1"])), "verify with values");
            Equal(SetupMode.Verify, SetupOptions.Parse(["--update", @"C:\u", "--mode", "verify", "--no-pause"]).Mode, "verify mode");
        });
    }

    /// <summary>`path` is `name` inside the tools folder of a work folder of this scenario.</summary>
    private static bool IsToolsCopy(Scenario s, string path, string name) =>
        Path.GetFileName(path) == name && Path.GetFileName(Path.GetDirectoryName(path)) == "tools"
        && path.StartsWith(s.WorkRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private static bool Throws<T>(Action body) where T : Exception
    {
        try { body(); return false; }
        catch (T) { return true; }
    }

    /// <summary>Anti-rollback: the install record's setupRunId against the run id of the verified build.</summary>
    private static void RollbackChecks()
    {
        const string Newer = "2000000", Same = "1234567", Older = "1234566";   // Scenario.DefaultRun is 1234567
        Check("rollback: no install record, a record without setupRunId, or an equal or smaller recorded run id lets the update through; the installer is started", () =>
        {
            foreach (var record in new string?[] { null, "{\"schema\":1}", $"{{\"setupRunId\":\"{Same}\"}}", $"{{\"setupRunId\":\"{Older}\"}}", $"{{\"setupRunId\":{Older}}}", "{\"setupRunId\":\"0\"}" })
            {
                using var s = new Scenario();
                if (record is not null) s.WriteInstallRecord(record);
                var started = false;
                s.Runner.Engine = _ => { started = true; return new ProcessResult(0, "", "", false, false); };
                Equal(SetupFlow.Done, SetupFlow.Run(s.Options(), s.Deps()), $"exit code for {record ?? "(no record)"}: {s.Out}");
                Assert(started, $"the installer was not started for {record ?? "(no record)"}");
            }
        });

        Check("rollback: a recorded run id larger than the build's refuses it (REFUSED rollback_refused), the installer is never started, and the work folder is removed; verify mode does not look", () =>
        {
            foreach (var record in new[] { $"{{\"setupRunId\":\"{Newer}\"}}", $"{{\"setupRunId\":{Newer}}}", "{\"setupRunId\":\"18446744073709551615\"}", "{\"setupRunId\":\"9999999\"}" })
            {
                using var s = new Scenario();
                s.WriteInstallRecord(record);
                s.Runner.Engine = _ => throw new InvalidOperationException("the installer must not start");
                Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), $"exit code for {record}: {s.Out}");
                Assert(s.Out.ToString().Contains("REFUSED rollback_refused"), s.Out.ToString());
                Assert(s.Out.ToString().Contains($"run {Scenario.DefaultRun}") && s.Out.ToString().Contains("never installed over a newer one"), s.Out.ToString());
                Equal(0, s.Runner.EngineCalls.Count(), "installer started");
                Assert(!Directory.Exists(s.WorkRoot) || !Directory.EnumerateFileSystemEntries(s.WorkRoot).Any(), "the work folder was left behind");
                using var v = new Scenario();
                v.WriteInstallRecord(record);
                Equal(SetupFlow.Done, SetupFlow.Run(v.Options(SetupMode.Verify), v.Deps()), "verify mode only verifies: " + v.Out);
            }
        });

        Check("rollback: the numbers are compared as numbers (a longer or shorter text does not decide), including the largest unsigned 64-bit value", () =>
        {
            using var s = new Scenario();
            s.WriteInstallRecord("{\"setupRunId\":\"99\"}");   // as text "99" > "1234567"; as a number it is smaller
            s.Runner.Engine = _ => new ProcessResult(0, "", "", false, false);
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(), s.Deps()), "99 < 1234567: " + s.Out);
            Equal(18446744073709551615UL, InstallRecord.Parse("{\"setupRunId\":\"18446744073709551615\"}"u8.ToArray()) ?? 0, "ulong maximum");
            Equal(5UL, InstallRecord.Parse("{\"setupRunId\":5}"u8.ToArray()) ?? 0, "a JSON number");
            Assert(InstallRecord.Parse("{\"x\":1}"u8.ToArray()) is null, "no property, no bound");
        });

        Check("rollback: a record that is there but cannot be understood or trusted is a refusal, never 'nothing recorded' (bad value, not JSON, not an object, too long a number, untrusted folder or file, a link)", () =>
        {
            foreach (var record in new[] { "{\"setupRunId\":\"abc\"}", "{\"setupRunId\":\"-1\"}", "{\"setupRunId\":\"18446744073709551616\"}", "{\"setupRunId\":1.5}", "{\"setupRunId\":null}", "{\"setupRunId\":true}", "{\"setupRunId\":\"\"}", "{\"setupRunId\":\" 5\"}", "nope", "[1,2]", "" })
            {
                using var s = new Scenario();
                s.WriteInstallRecord(record);
                s.Runner.Engine = _ => throw new InvalidOperationException("the installer must not start");
                Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), $"exit code for {record}: {s.Out}");
                Assert(s.Out.ToString().Contains("REFUSED install_record_invalid"), $"{record}: {s.Out}");
                Equal(0, s.Runner.EngineCalls.Count(), "installer started");
            }
            using var t = new Scenario();
            t.WriteInstallRecord("{\"setupRunId\":\"1\"}");
            t.AdminProblems = p => p.EndsWith("install-manifest.json", StringComparison.Ordinal) ? ["S-1-5-32-545 may WriteData"] : [];
            Equal(SetupFlow.Refused, SetupFlow.Run(t.Options(), t.Deps()), "a record anyone can write: " + t.Out);
            Assert(t.Out.ToString().Contains("REFUSED install_record_untrusted"), t.Out.ToString());
            using var u = new Scenario();
            u.WriteInstallRecord("{\"setupRunId\":\"1\"}");
            u.AdminProblems = p => p.EndsWith("Albera", StringComparison.Ordinal) ? ["S-1-5-32-545 may CreateFiles"] : [];
            Equal(SetupFlow.Refused, SetupFlow.Run(u.Options(), u.Deps()), "a folder anyone can write: " + u.Out);
            Assert(u.Out.ToString().Contains("REFUSED install_record_untrusted"), u.Out.ToString());
            Equal(0, u.Runner.EngineCalls.Count(), "installer started");
            using var w = new Scenario();
            w.WriteInstallRecord("{\"setupRunId\":\"1\"}");
            Assert(Throws<SetupRefusal>(() => InstallRecord.ReadSetupRunId(w.InstallRecordPath, _ => [], _ => true)), "a link on the path of the record was accepted");
        });

        Check("rollback: the check runs after the attestation is verified and before the installer is started, and the run id it compares is the attested one", () =>
        {
            using var s = new Scenario();
            s.WriteInstallRecord($"{{\"setupRunId\":\"{Newer}\"}}");
            s.Attestations = _ => [new Attested(3_000_000, Scenario.DefaultCommit)];   // this build was made by a LATER run than the record
            s.Runner.Engine = _ => new ProcessResult(0, "", "", false, false);
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(), s.Deps()), "a newer attested run than the record is the normal update: " + s.Out);
            Assert(s.Out.ToString().IndexOf("ALBERA_SETUP_VERIFIED", StringComparison.Ordinal) < s.Out.ToString().IndexOf("6/7", StringComparison.Ordinal), "the run id is known before the check");
        });
    }

    private static void FlowChecks()
    {
        RollbackChecks();
        Check("flow: a good update verifies every attested file once with the bundled gh, prints commit, run id and tree hash, starts nothing in verify mode, and removes its work folder", () =>
        {
            using var s = new Scenario();
            var code = SetupFlow.Run(s.Options(SetupMode.Verify), s.Deps());
            Equal(SetupFlow.Done, code, "exit code (" + s.Out + ")");
            Equal(SetupLayout.AttestedFiles.Count, s.Runner.GhCalls.Count(), "gh calls");
            Equal(0, s.Runner.EngineCalls.Count(), "installer calls");
            Assert(s.Out.ToString().Contains($"ALBERA_SETUP_VERIFIED commit={Scenario.DefaultCommit} run={Scenario.DefaultRun} treeHash={s.TreeHash}"), "summary line missing: " + s.Out);
            Assert(s.Runner.GhCalls.All(c => c.Capture && IsToolsCopy(s, c.FileName, "gh.exe") && IsToolsCopy(s, c.Arguments[6], "trusted_root.jsonl")), "gh and its trusted root are not the copies in the work folder's tools folder");
            Assert(!Directory.EnumerateFileSystemEntries(s.WorkRoot).Any(), "the work folder was left behind");
        });

        Check("flow: install starts the installer script from the verified copy with the attested tree hash and run id, a rebuilt environment and the owner's values", () =>
        {
            using var s = new Scenario();
            var scriptBytes = File.ReadAllBytes(s.Path_(SetupLayout.HostScript));
            ProcessSpec? seen = null;
            s.Runner.Engine = spec =>
            {
                seen = spec;
                var script = spec.Arguments[spec.Arguments.ToList().IndexOf("-File") + 1];
                Assert(File.Exists(script) && File.ReadAllBytes(script).SequenceEqual(scriptBytes), "the script that runs is not the verified copy");
                Assert(spec.Arguments[spec.Arguments.ToList().IndexOf("-RepoRoot") + 1].EndsWith(@"\copy\repo", StringComparison.Ordinal), "repo root is not the copy");
                Assert(File.Exists(Path.Combine(spec.Arguments[spec.Arguments.ToList().IndexOf("-RepoRoot") + 1], SetupLayout.Components[0].PublishDirectory.Replace('/', '\\'), "runtime.dll")), "the copied builds are not under the repo root");
                return new ProcessResult(0, "", "", false, false);
            };
            var engine = new EngineOptions("hello-key", "MIIB", "S-1-5-21-1-2-3-1001", true, "my vm", "clone-01");
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(SetupMode.Install, engine), s.Deps()), "exit code (" + s.Out + ")");
            var call = seen ?? throw new CheckFailed("the installer was not started");
            Equal(SetupLayout.PowerShellExecutable, call.FileName, "program");
            Assert(!call.Capture, "the installer must keep the owner's console");
            var args = call.Arguments;
            Equal("-NoProfile", args[0], "arg 0"); Equal("-ExecutionPolicy", args[1], "arg 1"); Equal("Bypass", args[2], "arg 2"); Equal("-File", args[3], "arg 3");
            var tail = args.Skip(7).ToArray();
            Assert(tail.SequenceEqual(new[]
            {
                "-Mode", "install", "-ExpectedTreeHash", s.TreeHash, "-SetupRunId", Scenario.DefaultRun.ToString(), "-ApproverKeyId", "hello-key", "-ApproverPublicKey", "MIIB",
                "-ApproverSid", "S-1-5-21-1-2-3-1001", "-GrantHyperVToBroker", "-VmName", "my vm", "-ComputerId", "clone-01",
            }), "arguments: " + string.Join(" | ", tail));
            Equal(string.Join(",", EngineKeys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase)), string.Join(",", call.Environment.Keys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase)), "environment keys");
            Assert(!Directory.EnumerateFileSystemEntries(s.WorkRoot).Any(), "the work folder was left behind");
        });

        Check("flow: install without owner values passes none (no -Approver*, no -GrantHyperVToBroker)", () =>
        {
            using var s = new Scenario();
            ProcessSpec? seen = null;
            s.Runner.Engine = spec => { seen = spec; return new ProcessResult(0, "", "", false, false); };
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(), s.Deps()), "exit code");
            Assert(seen is not null && !seen.Arguments.Any(a => a.StartsWith("-Approver", StringComparison.Ordinal) || a == "-GrantHyperVToBroker" || a == "-VmName"), "unexpected owner values");
        });

        Check("flow: the installer's failure (non-zero exit, timeout) is reported with its own exit code", () =>
        {
            using var s = new Scenario();
            s.Runner.Engine = _ => new ProcessResult(73, "", "", false, false);
            Equal(SetupFlow.EngineFailed, SetupFlow.Run(s.Options(), s.Deps()), "non-zero");
            Assert(s.Out.ToString().Contains("ENGINE_EXIT 73"), "engine exit not shown");
            using var t = new Scenario();
            t.Runner.Engine = _ => new ProcessResult(-1, "", "", true, false);
            Equal(SetupFlow.EngineFailed, SetupFlow.Run(t.Options(), t.Deps()), "timeout");
        });

        Refusal("a process that is not elevated", s => s.Elevated = false, "not_elevated");
        Refusal("an unconfigured build (no pinned tools)", s => { PinnedTools.GhSha256 = new string('0', 64); }, "pins_not_configured");
        Refusal("a gh.exe that is not the pinned one", s => File.WriteAllText(Path.Combine(s.SetupDirectory, "gh.exe"), "another gh"), "gh_pin_mismatch");
        Refusal("a trusted root that is not the pinned one", s => File.WriteAllText(Path.Combine(s.SetupDirectory, "trusted_root.jsonl"), "{}\n"), "trusted_root_pin_mismatch");
        Refusal("a trusted root without a closing line feed", s =>
        {
            var bytes = "{\"a\":1}"u8.ToArray();
            File.WriteAllBytes(Path.Combine(s.SetupDirectory, "trusted_root.jsonl"), bytes);
            PinnedTools.TrustedRootSha256 = FileSystemChecks.Sha256(bytes);
        }, "trusted_root_pin_mismatch");
        Refusal("a missing gh.exe", s => File.Delete(Path.Combine(s.SetupDirectory, "gh.exe")), "gh_pin_mismatch");
        Refusal("a work folder others can write", s => s.AdminProblems = p => p.Contains("setup-work", StringComparison.Ordinal) ? ["S-1-5-32-545 may WriteData"] : [], "work_not_admin_only");
        Refusal("an update folder that does not exist", s => Directory.Delete(s.Update, true), "update_missing");
        Refusal("a missing file of the update", s => File.Delete(s.Path_(SetupLayout.HostLibrary)), "update_file_missing");
        Refusal("a missing publish folder (its attested exe is gone too)", s => Directory.Delete(s.Path_("repo/" + SetupLayout.Components[1].PublishDirectory), true), "update_file_missing");
        Refusal("a missing bundle", s => Directory.Delete(s.Path_(SetupLayout.BundlesDirectory), true), "update_folder_missing");
        Refusal("a bundle missing for one file", s => File.Delete(s.Path_($"bundles/sha256-{FileSystemChecks.Sha256(s.Path_(SetupLayout.HostScript))}.jsonl")), "bundle_missing", ghCallsAtMost: SetupLayout.AttestedFiles.Count);
        Refusal("a file changed after it was attested (no bundle for its bytes)", s =>
        {
            s.Write(SetupLayout.HostScript, "tampered script");   // the old bundle is named by the old hash
        }, "bundle_missing", ghCallsAtMost: SetupLayout.AttestedFiles.Count);

        Check("flow: setup refuses to install when it is not running from C:\\Program Files\\Albera\\bin\\setup; verify mode skips only that location check and still runs gh from a checked copy", () =>
        {
            using var s = new Scenario { InstalledDirectory = @"C:\Program Files\Albera\bin\setup" };
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), "install from elsewhere");
            Assert(s.Out.ToString().Contains("REFUSED setup_location"), s.Out.ToString());
            Equal(0, s.Runner.Calls.Count, "nothing may be started");
            using var v = new Scenario { InstalledDirectory = @"C:\Program Files\Albera\bin\setup" };
            Equal(SetupFlow.Done, SetupFlow.Run(v.Options(SetupMode.Verify), v.Deps()), "verify from elsewhere");
            Assert(v.Runner.GhCalls.All(c => IsToolsCopy(v, c.FileName, "gh.exe")), "verify mode ran the gh that sits beside setup");
        });

        foreach (var mode in new[] { SetupMode.Verify, SetupMode.Install })
        {
            Check($"flow ({mode}): the gh.exe and trusted root that run are checked COPIES; replacing the originals after the copy changes nothing", () =>
            {
                using var s = new Scenario();
                var deps = s.Deps();
                var fake = s.Runner.Gh;
                var calls = 0;
                s.Runner.Gh = spec =>
                {
                    calls++;
                    Assert(IsToolsCopy(s, spec.FileName, "gh.exe") && IsToolsCopy(s, spec.Arguments[6], "trusted_root.jsonl"), "gh or its trusted root is not a copy in the work folder");
                    Equal(PinnedTools.GhSha256, FileSystemChecks.Sha256(spec.FileName), "the gh that runs");
                    Equal(PinnedTools.TrustedRootSha256, FileSystemChecks.Sha256(spec.Arguments[6]), "the trusted root gh reads");
                    File.WriteAllText(Path.Combine(s.SetupDirectory, "gh.exe"), "evil gh swapped in after the copy");   // an agent in the owner's session replaces the originals
                    File.WriteAllText(Path.Combine(s.SetupDirectory, "trusted_root.jsonl"), "{\"evil\":true}\n");
                    return fake(spec);
                };
                s.Runner.Engine = _ => new ProcessResult(0, "", "", false, false);
                Equal(SetupFlow.Done, SetupFlow.Run(s.Options(mode), deps), "exit code (" + s.Out + ")");
                Equal(SetupLayout.AttestedFiles.Count, calls, "gh calls");
                Assert(File.ReadAllText(Path.Combine(s.SetupDirectory, "gh.exe")).StartsWith("evil", StringComparison.Ordinal), "the test did not replace the original");
            });
        }

        Check("flow (Verify): a gh.exe that is not the pinned one is refused in verify mode too, and never started", () =>
        {
            using var s = new Scenario();
            File.WriteAllText(Path.Combine(s.SetupDirectory, "gh.exe"), "another gh");
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(SetupMode.Verify), s.Deps()), "exit code");
            Assert(s.Out.ToString().Contains("REFUSED gh_pin_mismatch"), s.Out.ToString());
            Equal(0, s.Runner.Calls.Count, "nothing may be started");
        });

        Check("flow: the work folder is made through the protected-DACL call and read back before anything is copied into it", () =>
        {
            using var s = new Scenario();
            var order = new List<string>();
            s.CreateWorkDirectory = path => { order.Add("create"); Directory.CreateDirectory(path); };
            s.AdminProblems = path => { order.Add("readback"); return []; };
            var deps = s.Deps();
            var fake = s.Runner.Gh;
            s.Runner.Gh = spec => { order.Add("gh"); return fake(spec); };
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(SetupMode.Verify), deps), "exit code");
            Equal("create,readback,gh", string.Join(",", order.Take(3)), "order");
        });

        Check("flow: setup refuses to install from a setup folder others can write or that passes through a link", () =>
        {
            using var s = new Scenario();
            var deps = s.Deps();
            var writable = new SetupDeps { Runner = deps.Runner, Folders = deps.Folders, IsElevated = deps.IsElevated, SetupDirectory = deps.SetupDirectory, InstalledSetupDirectory = deps.InstalledSetupDirectory, WorkRoot = deps.WorkRoot, NewWorkName = deps.NewWorkName, PathHasReparsePoint = deps.PathHasReparsePoint, InstallRecordPath = deps.InstallRecordPath, Out = deps.Out, CreateWorkDirectory = deps.CreateWorkDirectory, AdministratorOnlyProblems = p => p == s.SetupDirectory ? ["S-1-5-32-545 may WriteData"] : [] };
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), writable), "writable setup folder");
            Assert(s.Out.ToString().Contains("setup_location") && s.Out.ToString().Contains("writable by others"), s.Out.ToString());
            using var t = new Scenario();
            var d = t.Deps();
            var linked = new SetupDeps { Runner = d.Runner, Folders = d.Folders, IsElevated = d.IsElevated, SetupDirectory = d.SetupDirectory, InstalledSetupDirectory = d.InstalledSetupDirectory, WorkRoot = d.WorkRoot, NewWorkName = d.NewWorkName, CreateWorkDirectory = d.CreateWorkDirectory, AdministratorOnlyProblems = d.AdministratorOnlyProblems, InstallRecordPath = d.InstallRecordPath, Out = d.Out, PathHasReparsePoint = _ => true };
            Equal(SetupFlow.Refused, SetupFlow.Run(t.Options(), linked), "link on the path");
            Assert(t.Out.ToString().Contains("link or junction"), t.Out.ToString());
            Equal(0, t.Runner.Calls.Count, "nothing may be started");
        });

        Check("flow: gh rejecting any one file stops everything before the installer", () =>
        {
            using var s = new Scenario();
            var rejected = SetupLayout.SetupExecutable;
            var inner = s.Deps();
            s.Runner.Gh = spec => FileSystemChecks.Sha256(spec.Arguments[2]) == FileSystemChecks.Sha256(s.Path_(rejected))
                ? new ProcessResult(1, "", "HTTP 404: no attestation\nmore", false, false)
                : s.GhOk(spec);
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), inner), "exit code");
            Assert(s.Out.ToString().Contains("REFUSED gh_verify_failed: albera-setup.exe: HTTP 404: no attestation"), s.Out.ToString());
            Equal(0, s.Runner.EngineCalls.Count(), "installer started");
        });

        Check("flow: an unexpected failure (a runner that throws) is a refusal too, with the exception named, and the installer is not started", () =>
        {
            using var s = new Scenario();
            var deps = s.Deps();
            s.Runner.Gh = _ => throw new IOException("the file is in use by another process");
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), deps), "exit code");
            Assert(s.Out.ToString().Contains("REFUSED unexpected_error: IOException: the file is in use by another process"), s.Out.ToString());
            Equal(0, s.Runner.EngineCalls.Count(), "installer started");
            Assert(!Directory.EnumerateFileSystemEntries(s.WorkRoot).Any(), "the work folder was left behind");
        });

        PolicyAtFlowLevel();
        RunSelection();
        TreeHashFlow();

        Check("flow: the bytes that run are the bytes that were verified (the source is changed while gh runs; the installer still gets the verified copy)", () =>
        {
            using var s = new Scenario();
            var original = File.ReadAllBytes(s.Path_(SetupLayout.HostScript));
            s.OnFirstGh = () => File.WriteAllText(s.Path_(SetupLayout.HostScript), "evil script written after the copy");
            var ghSawEvil = false;
            var deps = s.Deps();
            var fake = s.Runner.Gh;
            s.Runner.Gh = spec => { ghSawEvil |= File.ReadAllText(spec.Arguments[2]).Contains("evil", StringComparison.Ordinal); return fake(spec); };
            s.Runner.Engine = spec =>
            {
                var script = spec.Arguments[spec.Arguments.ToList().IndexOf("-File") + 1];
                Assert(File.ReadAllBytes(script).SequenceEqual(original), "the installer script is not the verified one");
                return new ProcessResult(0, "", "", false, false);
            };
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(), deps), "exit code (" + s.Out + ")");
            Assert(!ghSawEvil, "gh was given the changed source file instead of the copy");
        });
    }

    private static void Refusal(string name, Action<Scenario> arrange, string code, int ghCallsAtMost = 0)
    {
        Check($"flow: refused for {name} ({code}); the installer is never started and the work folder is removed", () =>
        {
            using var s = new Scenario();
            arrange(s);
            var deps = s.Deps();
            var exit = SetupFlow.Run(s.Options(), deps);
            Equal(SetupFlow.Refused, exit, "exit code (" + s.Out + ")");
            Assert(s.Out.ToString().Contains($"REFUSED {code}"), $"expected REFUSED {code}: {s.Out}");
            Equal(0, s.Runner.EngineCalls.Count(), "installer started");
            if (ghCallsAtMost == 0) Equal(0, s.Runner.GhCalls.Count(), "gh started although the input was refused earlier");
            else Assert(s.Runner.GhCalls.Count() <= ghCallsAtMost, "too many gh calls");
            Assert(!Directory.Exists(s.WorkRoot) || !Directory.EnumerateFileSystemEntries(s.WorkRoot).Any(), "the work folder was left behind");
        });
    }

    private static void PolicyAtFlowLevel()
    {
        Check("flow: a certificate from a self-hosted runner, another branch or another repository on any one file refuses the update", () =>
        {
            foreach (var (field, value) in new[] { ("runnerEnvironment", "self-hosted"), ("sourceRepositoryRef", "refs/heads/feature/x"), ("sourceRepositoryURI", "https://github.com/x/albera"), ("subjectAlternativeName", "https://github.com/BERORINPO/albera/.github/workflows/host-build-hashes.yml@refs/heads/dev") })
            {
                using var s = new Scenario();
                s.CertificateTweak = (rel, cert) => { if (rel == SetupLayout.GhExecutable) cert[field] = value; };
                Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), $"{field} (exit code)");
                Assert(s.Out.ToString().Contains($"REFUSED attestation_policy: gh.exe: certificate {field}"), s.Out.ToString());
                Equal(0, s.Runner.EngineCalls.Count(), "installer started");
            }
        });
    }

    private static void RunSelection()
    {
        Check("run id: a bundle that lists older runs of the same bytes does not lower it, and the newest run that attested every file wins", () =>
        {
            using var s = new Scenario();
            s.Attestations = rel => rel == SetupLayout.HostScript
                ? [new Attested(50, Scenario.DefaultCommit), new Attested(90, Scenario.DefaultCommit), new Attested(Scenario.DefaultRun, Scenario.DefaultCommit)]
                : [new Attested(90, Scenario.DefaultCommit), new Attested(Scenario.DefaultRun, Scenario.DefaultCommit), new Attested(20, Scenario.DefaultCommit)];
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(SetupMode.Verify), s.Deps()), "exit code (" + s.Out + ")");
            Assert(s.Out.ToString().Contains($"run={Scenario.DefaultRun} "), "run id is not the newest common run: " + s.Out);
        });

        Check("run id: an old validly attested set is reported with its own (older) run id, so the installer can refuse it", () =>
        {
            using var s = new Scenario();
            s.Attestations = _ => [new Attested(1000, Scenario.DefaultCommit)];
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(SetupMode.Verify), s.Deps()), "exit code");
            Assert(s.Out.ToString().Contains("run=1000 "), s.Out.ToString());
        });

        Check("run id: no single run that attested all the files, or two commits for one run, refuses the update", () =>
        {
            using var s = new Scenario();
            s.Attestations = rel => rel == SetupLayout.BuildHashesFile ? [new Attested(5, Scenario.DefaultCommit)] : [new Attested(6, Scenario.DefaultCommit)];
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), "exit code");
            Assert(s.Out.ToString().Contains("REFUSED no_common_run"), s.Out.ToString());
            using var t = new Scenario();
            t.Attestations = rel => rel == SetupLayout.HostScript ? [new Attested(7, new string('b', 40))] : [new Attested(7, Scenario.DefaultCommit)];
            Equal(SetupFlow.Refused, SetupFlow.Run(t.Options(), t.Deps()), "exit code");
            Assert(t.Out.ToString().Contains("REFUSED commit_mismatch"), t.Out.ToString());
            Equal(0, t.Runner.EngineCalls.Count(), "installer started");
        });
    }

    private static void TreeHashFlow()
    {
        Check("tree hash: a DLL changed after the build (not an attested exe) is caught by the tree hash of the copies", () =>
        {
            using var s = new Scenario();
            var dll = SetupLayout.Components[0];
            s.Write($"repo/{dll.PublishDirectory}/runtime.dll", "tampered");
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), "exit code");
            Assert(s.Out.ToString().Contains("REFUSED tree_hash_mismatch: the copies are not the attested build: broker/runtime.dll differs"), s.Out.ToString());
            Equal(0, s.Runner.EngineCalls.Count(), "installer started");
        });

        Check("tree hash: an extra file in a publish folder, and a missing one, are caught and named", () =>
        {
            using var s = new Scenario();
            s.Write($"repo/{SetupLayout.Components[1].PublishDirectory}/planted.dll", "extra");
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), "exit code");
            Assert(s.Out.ToString().Contains("authority/planted.dll is not in the attested list"), s.Out.ToString());
            using var t = new Scenario();
            File.Delete(t.Path_($"repo/{SetupLayout.Components[2].PublishDirectory}/Z.dll"));
            Equal(SetupFlow.Refused, SetupFlow.Run(t.Options(), t.Deps()), "exit code");
            Assert(t.Out.ToString().Contains("pipe-client/Z.dll is missing"), t.Out.ToString());
        });

        Check("tree hash: an attested build-hashes.json whose treeHash is not the hash of its own list is refused", () =>
        {
            using var s = new Scenario();
            var json = File.ReadAllText(s.Path_(SetupLayout.BuildHashesFile)).Replace(s.TreeHash, new string('1', 64));
            s.Write(SetupLayout.BuildHashesFile, json);
            s.WriteBundles();
            Equal(SetupFlow.Refused, SetupFlow.Run(s.Options(), s.Deps()), "exit code");
            Assert(s.Out.ToString().Contains("REFUSED tree_hash_inconsistent"), s.Out.ToString());
            Equal(0, s.Runner.EngineCalls.Count(), "installer started");
        });

        Check("tree hash: the value handed to the installer is the attested one, never anything the owner typed", () =>
        {
            using var s = new Scenario();
            ProcessSpec? seen = null;
            s.Runner.Engine = spec => { seen = spec; return new ProcessResult(0, "", "", false, false); };
            Equal(SetupFlow.Done, SetupFlow.Run(s.Options(), s.Deps()), "exit code");
            Assert(seen is not null && seen.Arguments.Contains(s.TreeHash), "attested tree hash not passed");
        });
    }
}
