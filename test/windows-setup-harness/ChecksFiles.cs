using System.Text;
using Albera.Setup;

internal static partial class Harness
{
    /// <summary>Known answer made by Get-CanonicalTreeHash (scripts/host/albera-host-lib.ps1) for <see cref="VectorInput"/>; test/runtime-windows-setup-source.test.mjs recomputes it with PowerShell so the two cannot drift.</summary>
    private const string VectorHash = "c462338c2a16abc0b5a6bd4a8d9362e5f8e333f97367303351f3451577676b70";

    private static FileHashes VectorInput()
    {
        string a = new('a', 64), b = new('b', 64), c = new('c', 64), d = new('d', 64);
        return new FileHashes
        {
            ["broker"] = new() { ["a.dll"] = a, ["B.dll"] = b, ["z/b.dll"] = c, ["\u00e9.dll"] = d },
            ["authority"] = new() { ["x.exe"] = c },
            ["pipe-client"] = new() { ["p.exe"] = d, ["sub/q.dll"] = a },
        };
    }

    private static void BuildHashesChecks()
    {
        Check("tree hash: the C# rule gives the value PowerShell's Get-CanonicalTreeHash gave for the same files (ordinal order, upper case before lower case, non-ASCII, nested paths)", () =>
            Equal(VectorHash, BuildHashes.CanonicalTreeHash(VectorInput()), "tree hash"));

        Check("tree hash: a renamed, moved, dropped, added or changed file gives another value", () =>
        {
            var baseline = BuildHashes.CanonicalTreeHash(VectorInput());
            var variants = new List<Action<FileHashes>>
            {
                f => { f["broker"]["a2.dll"] = f["broker"]["a.dll"]; f["broker"].Remove("a.dll"); },
                f => { f["authority"]["a.dll"] = f["broker"]["a.dll"]; f["broker"].Remove("a.dll"); },
                f => f["broker"].Remove("a.dll"),
                f => f["broker"]["extra.dll"] = new string('e', 64),
                f => f["broker"]["a.dll"] = new string('f', 64),
            };
            foreach (var change in variants)
            {
                var files = VectorInput();
                change(files);
                Assert(BuildHashes.CanonicalTreeHash(files) != baseline, "a change did not change the tree hash");
            }
        });

        Check("tree hash: an empty component, a missing component, a bad path and a bad hash are refused", () =>
        {
            var empty = VectorInput(); empty["authority"].Clear();
            Refused("build_hashes", () => BuildHashes.CanonicalTreeHash(empty));
            var missing = VectorInput(); missing.Remove("authority");
            Refused("build_hashes", () => BuildHashes.CanonicalTreeHash(missing));
            foreach (var path in new[] { "../x.dll", "/x.dll", "a:b.dll", "a\tb.dll", "a\nb.dll", "a\\b.dll", "" })
            {
                var files = VectorInput(); files["broker"][path] = new string('a', 64);
                Refused("build_hashes", () => BuildHashes.CanonicalTreeHash(files));
            }
            var bad = VectorInput(); bad["broker"]["a.dll"] = new string('A', 64);
            Refused("build_hashes", () => BuildHashes.CanonicalTreeHash(bad));
        });

        Check("build-hashes.json: the file -Mode hashes prints is read; version, components and hashes are checked strictly", () =>
        {
            var files = VectorInput();
            var good = Scenario.BuildHashesJson(files, VectorHash);
            var parsed = BuildHashes.Parse(Encoding.UTF8.GetBytes(good));
            Equal(VectorHash, parsed.TreeHash, "tree hash");
            Equal(7, parsed.Files.Sum(c => c.Value.Count), "file count");
            foreach (var broken in new[]
            {
                good.Replace("\"version\":1", "\"version\":2"),
                good.Replace("\"treeHash\":\"" + VectorHash + "\"", "\"treeHash\":\"abc\""),
                good.Replace("\"authority\"", "\"authorityX\""),
                good.Replace(new string('c', 64), "NOT-A-HASH"),
                "[]", "", "{\"version\":1}",
            }) Refused("build_hashes", () => BuildHashes.Parse(Encoding.UTF8.GetBytes(broken)));
        });

        Check("build-hashes.json: the first differing path is named (extra, missing, changed)", () =>
        {
            var attested = VectorInput();
            Assert(BuildHashes.FirstDifference(attested, VectorInput()) is null, "equal lists reported as different");
            var extra = VectorInput(); extra["broker"]["evil.dll"] = new string('e', 64);
            Equal("broker/evil.dll is not in the attested list", BuildHashes.FirstDifference(attested, extra), "extra");
            var missing = VectorInput(); missing["authority"].Remove("x.exe");
            Equal("authority/x.exe is missing", BuildHashes.FirstDifference(attested, missing), "missing");
            var changed = VectorInput(); changed["pipe-client"]["p.exe"] = new string('0', 64);
            Equal("pipe-client/p.exe differs", BuildHashes.FirstDifference(attested, changed), "changed");
        });

        Check("administrator-only check: a folder the current user owns and can write is not accepted", () =>
        {
            var folder = Path.Combine(Path.GetTempPath(), "albera-setup-acl-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            try { Assert(FileSystemChecks.AdministratorOnlyProblems(folder).Count > 0, "a user-writable temp folder passed"); }
            finally { Directory.Delete(folder); }
        });

        Check("administrator-only check: C:\\Program Files itself (owner TrustedInstaller, users read-only) is accepted", () =>
        {
            var problems = FileSystemChecks.AdministratorOnlyProblems(SetupLayout.ProgramFilesDirectory);
            Assert(problems.Count == 0, "C:\\Program Files: " + string.Join("; ", problems));
        });
    }
}
