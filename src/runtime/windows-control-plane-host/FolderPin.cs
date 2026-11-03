using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Keeps the app folder where LaunchGate found it (same shape as the Broker's DatabaseFolderPin). The gate checks the app tree once, but node then reads the
// scripts by path for as long as it runs, so a principal that could rename or delete the folder between the check and a later read could swap in another tree
// under the same name. The host therefore opens the folder ONCE, before it checks anything, and holds that handle while the child lives WITHOUT FILE_SHARE_DELETE:
// while it is open, a rename or a delete of the folder fails with a sharing violation for everybody (administrators and SYSTEM included).
// FILE_LIST_DIRECTORY (a data right) is deliberate: a handle opened with attribute rights only is ignored by the share-mode check and would pin nothing.
// The folder is opened with FILE_FLAG_OPEN_REPARSE_POINT (a junction is opened as itself, never followed); the gate's checks then run on what was pinned.
// What this does NOT prove is that a PARENT folder cannot be renamed: that is measured in the host tests, and the parent ACL check (PathGuard) is what protects there.
internal static class FolderPin
{
    private const uint FileListDirectory = 0x1, FileShareRead = 0x1, FileShareWrite = 0x2, OpenExisting = 3,
        FileFlagBackupSemantics = 0x02000000, FileFlagOpenReparsePoint = 0x00200000; // BACKUP_SEMANTICS is what lets CreateFile open a directory

    /// <summary>The handle to hold (dispose it to release the folder), or null when the folder cannot be opened.</summary>
    public static SafeFileHandle? TryPin(string folder)
    {
        SafeFileHandle handle = CreateFileW(folder, FileListDirectory, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        return null;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
}
