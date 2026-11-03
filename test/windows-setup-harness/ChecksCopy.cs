using System.Diagnostics;
using Albera.Setup;

internal static partial class Harness
{
    private static string TempFolder()
    {
        var folder = Path.Combine(Path.GetTempPath(), "albera-setup-copy-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        return folder;
    }

    private static void CopyChecks()
    {
        Check("update copy: only plain relative paths are accepted (no .., absolute, backslash, drive or stream syntax, trailing dot or space, empty part)", () =>
        {
            foreach (var bad in new[] { "../x", "a/../x", "/x", "x/", "a\\b", "C:/x", "a:stream", "x.", "x ", "a//b", ".", "", "a/./b", "a/b?c", "a/b*c" })
                Refused("update_path", () => UpdateCopy.Resolve(@"C:\root", bad));
            Equal(@"C:\root\a\b.dll", UpdateCopy.Resolve(@"C:\root", "a/b.dll"), "good path");
        });

        Check("update copy: a stream copy keeps only the main data (an alternate data stream stays behind) and the copy has the same bytes", () =>
        {
            var source = TempFolder();
            var destination = TempFolder();
            try
            {
                File.WriteAllText(Path.Combine(source, "f.bin"), "main stream");
                var hasStream = true;
                try { File.WriteAllText(Path.Combine(source, "f.bin") + ":hidden", "side"); } catch (Exception) { hasStream = false; }
                new UpdateCopy(source, destination).CopyFile("f.bin");
                Equal("main stream", File.ReadAllText(Path.Combine(destination, "f.bin")), "bytes");
                if (hasStream) Assert(!File.Exists(Path.Combine(destination, "f.bin") + ":hidden"), "the alternate data stream was copied");
            }
            finally { Directory.Delete(source, true); Directory.Delete(destination, true); }
        });

        Check("update copy: a junction inside a tree, and a junction on the way to a file, are refused", () =>
        {
            var source = TempFolder();
            var elsewhere = TempFolder();
            var destination = TempFolder();
            try
            {
                Directory.CreateDirectory(Path.Combine(source, "tree"));
                File.WriteAllText(Path.Combine(source, "tree", "ok.txt"), "ok");
                File.WriteAllText(Path.Combine(elsewhere, "secret.txt"), "outside");
                if (!MakeJunction(Path.Combine(source, "tree", "link"), elsewhere)) return;
                Refused("update_link", () => new UpdateCopy(source, destination).CopyTree("tree"));
                Refused("update_link", () => new UpdateCopy(source, destination).CopyFile("tree/link/secret.txt"));
                Assert(!File.Exists(Path.Combine(destination, "tree", "link", "secret.txt")), "a file behind the junction was copied");
            }
            finally
            {
                Directory.Delete(Path.Combine(source, "tree", "link"));   // removes the junction only, not its target
                Directory.Delete(source, true); Directory.Delete(elsewhere, true); Directory.Delete(destination, true);
            }
        });

        Check("update copy: more files or more bytes than the limit are refused", () =>
        {
            var source = TempFolder();
            var destination = TempFolder();
            try
            {
                File.WriteAllText(Path.Combine(source, "a.txt"), "12345");
                File.WriteAllText(Path.Combine(source, "b.txt"), "12345");
                var byCount = new UpdateCopy(source, destination, maxFiles: 1, maxBytes: 100);
                byCount.CopyFile("a.txt");
                Refused("update_too_many_files", () => byCount.CopyFile("b.txt"));
                var bySize = new UpdateCopy(source, Path.Combine(destination, "s"), maxFiles: 10, maxBytes: 8);
                bySize.CopyFile("a.txt");
                Refused("update_too_large", () => bySize.CopyFile("b.txt"));
            }
            finally { Directory.Delete(source, true); Directory.Delete(destination, true); }
        });

        Check("update copy: a missing file or folder is refused by name", () =>
        {
            var source = TempFolder();
            var destination = TempFolder();
            try
            {
                Refused("update_file_missing", () => new UpdateCopy(source, destination).CopyFile("nope.txt"));
                Refused("update_folder_missing", () => new UpdateCopy(source, destination).CopyTree("nope"));
            }
            finally { Directory.Delete(source, true); Directory.Delete(destination, true); }
        });

        Check("link detection: a path through a junction is reported, a plain path is not", () =>
        {
            var plain = TempFolder();
            var target = TempFolder();
            var parent = TempFolder();
            try
            {
                Assert(!FileSystemChecks.PathHasReparsePoint(plain), "a plain folder reported as a link");
                var link = Path.Combine(parent, "link");
                if (!MakeJunction(link, target)) return;
                Assert(FileSystemChecks.PathHasReparsePoint(link), "the junction itself was not reported");
                Directory.CreateDirectory(Path.Combine(target, "inner"));
                Assert(FileSystemChecks.PathHasReparsePoint(Path.Combine(link, "inner")), "a folder behind the junction was not reported");
                Directory.Delete(link);
            }
            finally { Directory.Delete(plain, true); Directory.Delete(target, true); Directory.Delete(parent, true); }
        });
    }

    /// <summary>mklink /J needs no administrator. Returns false (the check then does nothing) if this machine cannot make one.</summary>
    private static bool MakeJunction(string link, string target)
    {
        var info = new ProcessStartInfo(Path.Combine(SetupLayout.SystemDirectory, "cmd.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "/d", "/c", "mklink", "/J", link, target }) info.ArgumentList.Add(argument);
        using var process = Process.Start(info)!;
        process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        return process.ExitCode == 0 && Directory.Exists(link);
    }
}
