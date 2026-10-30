using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Keeps the journal folder where ServicePathGuard found it (ADR-002, Proposed / NOT VERIFIED; CISO accept condition C3). The guard checks the folder
// once, but every request reopens the database by path, so a principal that can rename or delete the folder (or a parent) between two requests could
// swap in an empty folder with the same name and replay an unexpired receipt. The service therefore opens the folder ONCE, right after the guard
// passed, and holds that handle for the life of the serve loop WITHOUT FILE_SHARE_DELETE: while it is open, a rename or a delete of the folder fails
// with a sharing violation for everybody (administrators and SYSTEM included). Requests keep using the same path. The handle asks for
// FILE_LIST_DIRECTORY and shares read and write, so SQLite and `inspect` work unchanged. FILE_LIST_DIRECTORY (a data right) is deliberate: a handle
// opened with attribute rights only (FILE_READ_ATTRIBUTES, SYNCHRONIZE, READ_CONTROL) is ignored by the share-mode check and would pin nothing
// (measured: a rename of the folder succeeded with such a handle open).
// The folder is opened with FILE_FLAG_OPEN_REPARSE_POINT (a junction is opened as itself, never followed) and the guard is run again on the pinned
// folder, so a swap that happened between the first check and the pin is caught too. Failing closed: no pin, no service (exit 73, `database_pin`).
internal static class DatabaseFolderPin
{
    private const uint FileListDirectory = 0x1, FileShareRead = 0x1, FileShareWrite = 0x2, OpenExisting = 3,
        FileFlagBackupSemantics = 0x02000000, FileFlagOpenReparsePoint = 0x00200000; // BACKUP_SEMANTICS is what lets CreateFile open a directory

    // The handle to hold (dispose it to release the folder), or null when the folder cannot be pinned or is no longer trusted once pinned.
    public static SafeFileHandle? TryPin(string database)
    {
        string folder = Path.GetDirectoryName(database)!;
        SafeFileHandle handle = CreateFileW(folder, FileListDirectory, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); return null; }
        if (ServicePathGuard.IsTrustedDatabaseLocation(database)) return handle;
        handle.Dispose();
        return null;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
}
