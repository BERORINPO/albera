using System.Globalization;
using System.Text;

namespace Albera.WslBridge;

// The bridge's memory of the leases it has served, kept in a file so that a restart forgets nothing (Zaku's review of the run lease contract). Reuse is decided by the operation id, never by
// the signature: an ECDSA signature can be changed without breaking it, so two different signed bytes can carry one lease.
//
// An entry lives until the lease's expiresAt plus a margin: after that the lease is refused as expired anyway, so nothing is lost by dropping it, and the file stays small.
// Every change is written and flushed BEFORE the bridge acts on it; if the write fails the bridge refuses (it never runs on a promise it could not keep).
// File: ASCII lines, `R <id> <expiresAt>` (reserved) and `C <id> <calls>` (a later line replaces an earlier one). The open handle denies other writers.
internal sealed class OperationLedger : IDisposable
{
    public const long MarginSeconds = 30;
    private const int MaxEntries = 100_000;
    private sealed class Entry(long expiresAt) { public long ExpiresAt = expiresAt; public long Calls; }

    private readonly object _lock = new();
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly FileStream _file;
    private readonly Func<long> _clock;

    private OperationLedger(FileStream file, Func<long> clock) { _file = file; _clock = clock; }

    /// <summary>Opens (or makes) the file, drops entries past their margin, and rewrites the file without them. Null when the file is unreadable, malformed or cannot be written.</summary>
    public static OperationLedger? TryOpen(string path, Func<long> clock)
    {
        try
        {
            Dictionary<string, Entry> loaded = new(StringComparer.Ordinal);
            if (File.Exists(path) && !TryLoad(path, loaded, clock())) return null;
            WriteFlushed(path + ".new", Render(loaded));
            File.Move(path + ".new", path, overwrite: true);
            FileStream file = new(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read);
            file.Seek(0, SeekOrigin.End);
            OperationLedger ledger = new(file, clock);
            foreach ((string id, Entry entry) in loaded) ledger._entries[id] = entry;
            return ledger;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    // On disk before the rename: otherwise a power cut can leave the new name on a file whose bytes never arrived, and every operation id in it would be forgotten.
    private static void WriteFlushed(string path, string text)
    {
        using FileStream file = new(path, FileMode.Create, FileAccess.Write, FileShare.None);
        file.Write(Encoding.ASCII.GetBytes(text));
        file.Flush(flushToDisk: true);
    }

    private static bool TryLoad(string path, Dictionary<string, Entry> into, long now)
    {
        foreach (string line in File.ReadAllLines(path, Encoding.ASCII))
        {
            string[] parts = line.Split(' ');
            if (parts.Length != 3 || !Wire.IsId(parts[1]) || !long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out long number)) return false;
            if (parts[0] == "R") into[parts[1]] = new Entry(number);
            else if (parts[0] == "C" && into.TryGetValue(parts[1], out Entry? entry)) entry.Calls = number;
            else return false;
        }
        foreach (string id in into.Where(pair => pair.Value.ExpiresAt + MarginSeconds <= now).Select(pair => pair.Key).ToList()) into.Remove(id);
        return true;
    }

    private static string Render(Dictionary<string, Entry> entries) =>
        string.Concat(entries.Select(pair => FormattableString.Invariant($"R {pair.Key} {pair.Value.ExpiresAt}\nC {pair.Key} {pair.Value.Calls}\n")));

    private bool TryAppend(string line)
    {
        try
        {
            byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
            _file.Write(bytes, 0, bytes.Length);
            _file.Flush(flushToDisk: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ObjectDisposedException) { return false; }
    }

    private void Forget(long now)
    {
        foreach (string id in _entries.Where(pair => pair.Value.ExpiresAt + MarginSeconds <= now).Select(pair => pair.Key).ToList()) _entries.Remove(id);
    }

    /// <summary>Records the operation as used. Null when it was recorded; otherwise the refusal word (LeaseUsed, StateFull or StateUnwritable).</summary>
    public string? TryReserve(string operationId, long expiresAt)
    {
        lock (_lock)
        {
            Forget(_clock());
            if (_entries.ContainsKey(operationId)) return Reason.LeaseUsed;
            if (_entries.Count >= MaxEntries) return Reason.StateFull;
            if (!TryAppend(FormattableString.Invariant($"R {operationId} {expiresAt}"))) return Reason.StateUnwritable;
            _entries[operationId] = new Entry(expiresAt);
            return null;
        }
    }

    /// <summary>Counts one call against <paramref name="maxCalls"/> and saves the count. Null when it may go ahead.</summary>
    public string? TryCountCall(string operationId, long maxCalls)
    {
        lock (_lock)
        {
            if (!_entries.TryGetValue(operationId, out Entry? entry)) return Reason.NoRun;
            if (entry.Calls >= maxCalls) return Reason.CallsExhausted;
            if (!TryAppend(FormattableString.Invariant($"C {operationId} {entry.Calls + 1}"))) return Reason.StateUnwritable;
            entry.Calls++;
            return null;
        }
    }

    public long CallsOf(string operationId) { lock (_lock) return _entries.TryGetValue(operationId, out Entry? entry) ? entry.Calls : -1; }

    public void Dispose() => _file.Dispose();
}
