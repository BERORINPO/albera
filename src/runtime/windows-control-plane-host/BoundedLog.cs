// A log file with a hard size cap (docs/architecture/control-plane-service.md section 2: output goes to files with a limit). When the next write would pass the
// cap, the file moves to <name>.1 (replacing the previous backup) and a new file starts, so the disk holds at most two files of `maxBytes` per log and the latest
// output is always kept. Appends to a file left by an earlier run. A write that fails (disk full, file locked) is counted in `DroppedBytes` and never stops the
// caller: the child's output pipe must keep draining or the child would block on a full pipe.
internal sealed class BoundedLog : IDisposable
{
    private readonly string path;
    private readonly int maxBytes;
    private readonly object gate = new();
    private FileStream? stream;
    private long size;

    public BoundedLog(string path, int maxBytes)
    {
        this.path = path;
        this.maxBytes = maxBytes;
    }

    public long DroppedBytes { get; private set; }

    /// <summary>Writes `data` (at most `maxBytes` long; the pumps read in chunks far below the cap).</summary>
    public void Write(ReadOnlySpan<byte> data)
    {
        lock (gate)
        {
            try
            {
                Open();
                if (size + data.Length > maxBytes) Rotate();
                stream!.Write(data);
                stream.Flush();
                size += data.Length;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                DroppedBytes += data.Length;
                CloseStream(); // the next write tries to open the file again
            }
        }
    }

    private void Open()
    {
        if (stream is not null) return;
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("log file is a reparse point");
        stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
        size = stream.Length;
    }

    private void Rotate()
    {
        CloseStream();
        File.Move(path, path + ".1", overwrite: true);
        Open();
    }

    private void CloseStream()
    {
        stream?.Dispose();
        stream = null;
    }

    public void Dispose()
    {
        lock (gate) CloseStream();
    }
}
