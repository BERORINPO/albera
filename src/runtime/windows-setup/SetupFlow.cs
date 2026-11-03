namespace Albera.Setup;

/// <summary>The SHA-256 of the bundled gh.exe and trusted root that this setup build was made with (a generated file, see scripts/publish-windows-setup.mjs; tests supply their own).</summary>
internal static class PinnedToolsCheck
{
    public static bool IsConfigured => Valid(PinnedTools.GhSha256) && Valid(PinnedTools.TrustedRootSha256);
    private static bool Valid(string value) => BuildHashes.IsHash(value) && value.Any(c => c != '0');
}

/// <summary>Everything the flow touches outside itself, so a test can replace gh, the installer, Windows and the clock-free parts.</summary>
internal sealed class SetupDeps
{
    public required IProcessRunner Runner { get; init; }
    public required KnownFolders Folders { get; init; }
    public required Func<bool> IsElevated { get; init; }
    /// <summary>The folder setup.exe runs from; gh.exe and the trusted root must sit in it.</summary>
    public required string SetupDirectory { get; init; }
    public required string InstalledSetupDirectory { get; init; }
    public required string WorkRoot { get; init; }
    public required Func<string> NewWorkName { get; init; }
    public required Func<string, IReadOnlyList<string>> AdministratorOnlyProblems { get; init; }
    public required Func<string, bool> PathHasReparsePoint { get; init; }
    public required TextWriter Out { get; init; }
}

/// <summary>The order of the checks is the order of the steps below; the first failed one stops everything with a <see cref="SetupRefusal"/>.</summary>
internal static class SetupFlow
{
    public const int Done = 0, Usage = 2, Refused = 3, EngineFailed = 4;

    public static int Run(SetupOptions options, SetupDeps deps)
    {
        string? work = null;
        try
        {
            Preflight(options, deps);
            work = CreateWork(deps);
            RequireAdministratorOnly(deps, work);
            var verified = VerifyUpdate(options, deps, work);
            deps.Out.WriteLine($"ALBERA_SETUP_VERIFIED commit={verified.Commit} run={verified.RunId} treeHash={verified.TreeHash}");
            if (options.Mode == SetupMode.Verify) return Done;
            return StartEngine(options, deps, work, verified);
        }
        catch (SetupRefusal refusal)
        {
            deps.Out.WriteLine($"REFUSED {refusal.Code}: {refusal.Message}");
            return Refused;
        }
        catch (Exception error)
        {
            // Anything unexpected (a file in use, a missing right, a process that would not start) also ends in a refusal: nothing continues after a failure nobody planned for.
            deps.Out.WriteLine($"REFUSED unexpected_error: {error.GetType().Name}: {GhVerifier.FirstLine(error.Message)}");
            return Refused;
        }
        finally
        {
            if (work is not null) RemoveWork(deps, work);
        }
    }

    private sealed record Verified(string Commit, ulong RunId, string TreeHash);

    private static void Preflight(SetupOptions options, SetupDeps deps)
    {
        Step(deps, "1/6", "checking this run: elevated, standard Windows folders, pinned tools");
        if (!deps.IsElevated()) throw new SetupRefusal("not_elevated", "setup must run elevated (UAC); it never elevates itself");
        SetupEnvironment.RequireStandardFolders(deps.Folders);
        if (!PinnedToolsCheck.IsConfigured) throw new SetupRefusal("pins_not_configured", "this build has no pinned gh.exe / trusted root hash (a CI build has)");
        if (options.Mode == SetupMode.Install) RequireInstalledLocation(deps);
        RequireTool(deps, SetupLayout.GhExecutable, PinnedTools.GhSha256, "gh_pin_mismatch");
        RequireTool(deps, SetupLayout.TrustedRoot, PinnedTools.TrustedRootSha256, "trusted_root_pin_mismatch");
    }

    /// <summary>Only makes the folder: the caller holds its path before any check, so it is removed even when a check refuses.</summary>
    private static string CreateWork(SetupDeps deps)
    {
        var work = Path.Combine(deps.WorkRoot, deps.NewWorkName());
        if (Directory.Exists(work) || File.Exists(work)) throw new SetupRefusal("work_exists", "the work folder already exists");
        Directory.CreateDirectory(work);
        return work;
    }

    private static void RequireAdministratorOnly(SetupDeps deps, string work)
    {
        var problems = deps.AdministratorOnlyProblems(work);
        if (problems.Count > 0) throw new SetupRefusal("work_not_admin_only", string.Join("; ", problems));
        foreach (var sub in new[] { "copy", "tmp", @"gh\config", @"gh\home", @"gh\local", @"gh\roaming" }) Directory.CreateDirectory(Path.Combine(work, sub));
    }

    /// <summary>Install mode only: setup runs from C:\Program Files\Albera\bin\setup, a folder only administrators can write, with no link on its path.</summary>
    private static void RequireInstalledLocation(SetupDeps deps)
    {
        var here = deps.SetupDirectory.TrimEnd('\\');
        if (!string.Equals(here, deps.InstalledSetupDirectory.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new SetupRefusal("setup_location", $"install runs only from {deps.InstalledSetupDirectory}, not from {here}");
        if (deps.PathHasReparsePoint(here)) throw new SetupRefusal("setup_location", "the setup folder path contains a link or junction");
        var problems = deps.AdministratorOnlyProblems(here);
        if (problems.Count > 0) throw new SetupRefusal("setup_location", $"the setup folder is writable by others: {string.Join("; ", problems)}");
    }

    private static void RequireTool(SetupDeps deps, string relative, string pinned, string code)
    {
        var path = Path.Combine(deps.SetupDirectory, Path.GetFileName(relative));
        if (!File.Exists(path) || FileSystemChecks.IsReparsePoint(path)) throw new SetupRefusal(code, $"{Path.GetFileName(path)} is not a regular file beside setup");
        var actual = FileSystemChecks.Sha256(path);
        if (!string.Equals(actual, pinned, StringComparison.Ordinal)) throw new SetupRefusal(code, $"{Path.GetFileName(path)} is not the file this setup was built with");
        if (relative == SetupLayout.TrustedRoot && !File.ReadAllBytes(path).AsSpan().EndsWith("\n"u8))
            throw new SetupRefusal(code, "the trusted root must end with a line feed (gh skips an unterminated last line)");
    }

    private static Verified VerifyUpdate(SetupOptions options, SetupDeps deps, string work)
    {
        var copyRoot = Path.Combine(work, "copy");
        Step(deps, "2/6", "copying the update folder into the administrator-only work folder");
        CopyUpdate(options.UpdateFolder, copyRoot);

        Step(deps, "3/6", $"verifying {SetupLayout.AttestedFiles.Count} attested files offline with the bundled gh.exe");
        var ghEnvironment = SetupEnvironment.ForGh(Path.Combine(work, "tmp"), Path.Combine(work, "gh"));
        var gh = new GhVerifier(deps.Runner, Path.Combine(deps.SetupDirectory, "gh.exe"), Path.Combine(deps.SetupDirectory, "trusted_root.jsonl"), ghEnvironment, work);
        var perFile = SetupLayout.AttestedFiles.Select(file => (file, facts: VerifyFile(gh, copyRoot, file))).ToList();

        Step(deps, "4/6", "checking that one run built all of them");
        var run = CommonRun(perFile);

        Step(deps, "5/6", "checking the attested tree hash against the copies");
        var treeHash = CheckTreeHash(copyRoot);
        return new Verified(run.Commit, run.RunId, treeHash);
    }

    private static void CopyUpdate(string source, string destination)
    {
        if (!Directory.Exists(source)) throw new SetupRefusal("update_missing", "the update folder does not exist");
        var copy = new UpdateCopy(source, destination);
        foreach (var file in SetupLayout.AttestedFiles) copy.CopyFile(file);
        foreach (var component in SetupLayout.Components) copy.CopyTree($"{SetupLayout.RepoDirectory}/{component.PublishDirectory}");
        var bundles = Path.Combine(source, SetupLayout.BundlesDirectory);
        if (!Directory.Exists(bundles)) throw new SetupRefusal("update_folder_missing", SetupLayout.BundlesDirectory);
        foreach (var bundle in Directory.EnumerateFiles(bundles, "sha256-*.jsonl").Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal))
            copy.CopyFile($"{SetupLayout.BundlesDirectory}/{bundle}");
    }

    private static IReadOnlyList<AttestationFacts> VerifyFile(GhVerifier gh, string copyRoot, string relative)
    {
        var file = Path.Combine(copyRoot, relative.Replace('/', '\\'));
        var sha = FileSystemChecks.Sha256(file);
        var bundle = Path.Combine(copyRoot, SetupLayout.BundlesDirectory, $"sha256-{sha}.jsonl");
        if (!File.Exists(bundle)) throw new SetupRefusal("bundle_missing", $"{relative}: no {SetupLayout.BundlesDirectory}/sha256-{sha}.jsonl in the update folder");
        return gh.Verify(file, sha, bundle);
    }

    /// <summary>
    /// A bundle from `gh attestation download` holds every attestation of that digest, from every run that produced the same bytes. The run is the newest one that appears for ALL attested
    /// files, so leaving attestations out can only lower it, and a run that did not attest every file (an older build) cannot be it.
    /// </summary>
    private static AttestationFacts CommonRun(List<(string file, IReadOnlyList<AttestationFacts> facts)> perFile)
    {
        var common = perFile[0].facts.Select(f => f.RunId).ToHashSet();
        foreach (var (_, facts) in perFile) common.IntersectWith(facts.Select(f => f.RunId));
        if (common.Count == 0) throw new SetupRefusal("no_common_run", "no single workflow run attested all the files");
        var run = common.Max();
        var commits = perFile.SelectMany(p => p.facts).Where(f => f.RunId == run).Select(f => f.Commit).Distinct(StringComparer.Ordinal).ToList();
        if (commits.Count != 1) throw new SetupRefusal("commit_mismatch", $"run {run} is attested for {commits.Count} different commits");
        return new AttestationFacts(commits[0], run);
    }

    private static string CheckTreeHash(string copyRoot)
    {
        var attested = BuildHashes.Parse(File.ReadAllBytes(Path.Combine(copyRoot, SetupLayout.BuildHashesFile)));
        var listed = BuildHashes.CanonicalTreeHash(attested.Files);
        if (!string.Equals(listed, attested.TreeHash, StringComparison.Ordinal)) throw new SetupRefusal("tree_hash_inconsistent", "the attested treeHash is not the hash of the attested file list");
        var actual = BuildHashes.HashPublishFolders(Path.Combine(copyRoot, SetupLayout.RepoDirectory));
        var difference = BuildHashes.FirstDifference(attested.Files, actual);
        if (difference is not null) throw new SetupRefusal("tree_hash_mismatch", $"the copies are not the attested build: {difference}");
        // Equal lists give equal hashes, so this cannot differ once the lines above passed; it stays so the comparison the contract asks for is explicit in the code.
        var computed = BuildHashes.CanonicalTreeHash(actual);
        if (!string.Equals(computed, attested.TreeHash, StringComparison.Ordinal)) throw new SetupRefusal("tree_hash_mismatch", "the tree hash of the copies is not the attested treeHash");
        return computed;
    }

    private static int StartEngine(SetupOptions options, SetupDeps deps, string work, Verified verified)
    {
        Step(deps, "6/6", "starting the installer script from the verified copy");
        var environment = SetupEnvironment.ForEngine(Path.Combine(work, "tmp"));
        var spec = EngineLaunch.Build(Path.Combine(work, "copy"), verified.TreeHash, verified.RunId, options.Engine, environment);
        var result = deps.Runner.Run(spec);
        if (result.TimedOut) { deps.Out.WriteLine("REFUSED engine_timeout: the installer script did not finish in time and was stopped"); return EngineFailed; }
        if (result.ExitCode != 0) { deps.Out.WriteLine($"ENGINE_EXIT {result.ExitCode}"); return EngineFailed; }
        return Done;
    }

    private static void RemoveWork(SetupDeps deps, string work)
    {
        try { Directory.Delete(work, recursive: true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            deps.Out.WriteLine($"NOTE: could not remove {work} ({error.GetType().Name}); it is administrator-only and safe to delete by hand");
        }
    }

    private static void Step(SetupDeps deps, string number, string text) => deps.Out.WriteLine($"[{number}] {text}");
}
