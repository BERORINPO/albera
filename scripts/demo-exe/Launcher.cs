// ALBERA demo launcher: unpacks the embedded node.exe and room into %LOCALAPPDATA%\AlberaDemo, then runs the demo room (fake VMs, scripted AI). No administrator, no Hyper-V, no network.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

static class Launcher
{
    private const string Port = "48760";

    private static void Unpack(string root)
    {
        Directory.CreateDirectory(root);
        using (Stream data = Assembly.GetExecutingAssembly().GetManifestResourceStream("demo.zip"))
        using (ZipArchive zip = new ZipArchive(data, ZipArchiveMode.Read))
        {
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\")) continue;
                string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("unexpected path in the package");
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                entry.ExtractToFile(target, true);
            }
        }
    }

    private static int Main()
    {
        string root = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AlberaDemo"));
        try
        {
            Console.WriteLine("ALBERA demo. The VMs and the AI here are fake. Unpacking (about 20 seconds)...");
            Unpack(root);
            ProcessStartInfo start = new ProcessStartInfo(Path.Combine(root, "node.exe"), "\"" + Path.Combine(root, "launch.mjs") + "\" \"" + root + "\" " + Port);
            start.UseShellExecute = false;
            using (Process node = Process.Start(start))
            {
                node.WaitForExit();
                return node.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.WriteLine("NOT DONE: " + error.Message);
            Console.WriteLine("Copy this line and paste it to Velo. Press Enter to close.");
            Console.ReadLine();
            return 1;
        }
    }
}
