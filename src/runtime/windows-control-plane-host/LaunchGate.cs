using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

// What must hold before node is started, every time it is started (docs/architecture/control-plane-service.md section 2, row "node"), and what is kept in place
// while it runs. In this order, so a swap between two steps is caught by the later one:
//   1. the app folder is pinned (FolderPin.cs: opened without FILE_SHARE_DELETE, so it cannot be renamed or deleted),
//   2. node.exe is opened for reading only (no FILE_SHARE_DELETE or write share, so it cannot be replaced or renamed),
//   3. the entry script exists, node.exe, the app tree and every folder in it are not writable by anyone but the trusted principals (PathGuard.cs) and hold no link,
//   4. the parent folders of the app and of node.exe, up to the drive root, cannot be renamed or re-permissioned by others (PathGuard.IsParentChainSafe; node.exe's own
//      folder also takes no new file),
//   5. node.exe is the file whose SHA-256 the config names.
// The gate is disposed only after the child has ended, so the pin and the node.exe handle are held for as long as node may read its scripts. The refusals are fixed words,
// never file content.
internal sealed class LaunchGate : IDisposable
{
    internal static class Refusal
    {
        public const string NodeMissing = "node_missing", EntryMissing = "entry_missing", NodeUntrusted = "node_untrusted", AppUntrusted = "app_untrusted", NodeHash = "node_hash",
            AppPin = "app_pin", NodeParentUntrusted = "node_parent_untrusted", AppParentUntrusted = "app_parent_untrusted";
    }

    private FileStream? nodeFile;
    private SafeFileHandle? appPin;

    private LaunchGate() { }

    /// <summary>Opens the gate. `refusal` is null when every check passed (then <see cref="Dispose"/> after the child has ended); otherwise one word from <see cref="Refusal"/>.</summary>
    public static LaunchGate Open(HostConfig config, out string? refusal)
    {
        LaunchGate gate = new();
        refusal = gate.Check(config);
        if (refusal is not null) gate.Dispose();
        return gate;
    }

    private string? Check(HostConfig config)
    {
        appPin = FolderPin.TryPin(config.AppPath);
        if (appPin is null) return Refusal.AppPin;
        try { nodeFile = new FileStream(config.NodePath, FileMode.Open, FileAccess.Read, FileShare.Read); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return Refusal.NodeMissing; }
        if (!File.Exists(config.EntryPath)) return Refusal.EntryMissing;
        if (!PathGuard.IsTrustedFile(config.NodePath)) return Refusal.NodeUntrusted;
        if (!PathGuard.IsTrustedTree(config.AppPath)) return Refusal.AppUntrusted;
        if (!PathGuard.IsParentChainSafe(Path.GetDirectoryName(config.NodePath)!, denyAddFile: true)) return Refusal.NodeParentUntrusted;
        if (!PathGuard.IsParentChainSafe(Path.GetDirectoryName(config.AppPath)!, denyAddFile: false)) return Refusal.AppParentUntrusted;
        return string.Equals(Convert.ToHexStringLower(SHA256.HashData(nodeFile)), config.NodeSha256, StringComparison.Ordinal) ? null : Refusal.NodeHash;
    }

    public void Dispose()
    {
        nodeFile?.Dispose();
        nodeFile = null;
        appPin?.Dispose();
        appPin = null;
    }
}
