using System.Text;

// The host's own event lines (CPHOST_*): to standard output, which a test reads and the SCM discards, and, with a UTC time in front, to host.log in the log directory
// (capped like the child's logs). Only fixed words and numbers are written, never file content or the child's output.
internal sealed class HostLog(BoundedLog file)
{
    public void Event(string line)
    {
        Console.WriteLine(line);
        file.Write(Encoding.UTF8.GetBytes($"{DateTime.UtcNow:O} {line}\n"));
    }
}
