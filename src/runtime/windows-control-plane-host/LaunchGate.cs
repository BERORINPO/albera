using System.Security.Cryptography;

// What must hold before node is started, every time it is started (docs/architecture/control-plane-service.md section 2, row "node"): node.exe and the entry
// script exist, node.exe, the app tree and its folders are not writable by anyone but the trusted principals (PathGuard.cs), and node.exe is the file whose
// SHA-256 the config names. node.exe stays open (readers only) from the hash until the child has been created, so it cannot be swapped in between;
// once the process exists Windows keeps its image from being written. The refusals are fixed words, never file content.
internal sealed class LaunchGate : IDisposable
{
    internal static class Refusal
    {
        public const string NodeMissing = "node_missing", EntryMissing = "entry_missing", NodeUntrusted = "node_untrusted", AppUntrusted = "app_untrusted", NodeHash = "node_hash";
    }

    private FileStream? nodeFile;

    private LaunchGate() { }

    /// <summary>Opens the gate. `refusal` is null when every check passed (then <see cref="Dispose"/> after the child exists); otherwise one word from <see cref="Refusal"/>.</summary>
    public static LaunchGate Open(HostConfig config, out string? refusal)
    {
        LaunchGate gate = new();
        refusal = gate.Check(config);
        if (refusal is not null) gate.Dispose();
        return gate;
    }

    private string? Check(HostConfig config)
    {
        try { nodeFile = new FileStream(config.NodePath, FileMode.Open, FileAccess.Read, FileShare.Read); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return Refusal.NodeMissing; }
        if (!File.Exists(config.EntryPath)) return Refusal.EntryMissing;
        if (!PathGuard.IsTrustedFile(config.NodePath)) return Refusal.NodeUntrusted;
        if (!PathGuard.IsTrustedTree(config.AppPath)) return Refusal.AppUntrusted;
        return string.Equals(Convert.ToHexStringLower(SHA256.HashData(nodeFile)), config.NodeSha256, StringComparison.Ordinal) ? null : Refusal.NodeHash;
    }

    public void Dispose()
    {
        nodeFile?.Dispose();
        nodeFile = null;
    }
}
