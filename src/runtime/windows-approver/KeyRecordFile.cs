using System.Text.RegularExpressions;

namespace Albera.Approver;

// The record file of a WebAuthn key made on this PC: %LOCALAPPDATA%\Albera\approver-keys\<keyId>.json, the canonical key record (public data only, no trailing newline). `enroll --webauthn` writes one and prints
// the elevated `-Mode set-approver -ApproverKeyFile <that file>` command that reads it. Nothing else in the approver reads it: `keys remove` needs no record (its message is the key id and the challenge).
// This is the ONLY file code in the approver (source-guarded): a record is created, never overwritten, deleted or moved (an existing file is read only to see whether it already holds the same bytes); the directory is created if missing; the file name is the key id and nothing else.
// The file is an ordinary same-user file. Whoever can write it can change what the installer is later told to pin, so the installer must show the key id and the owner compare it with the one printed at enroll.
internal sealed class KeyRecordStore(string directory)
{
    private static readonly Regex KeyIdPattern = new(@"^(?:webauthn|hello)-[0-9a-f]{16}\z", RegexOptions.CultureInvariant);

    public static string DefaultDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Albera", "approver-keys");

    public string Folder { get; } = directory;

    /// <summary>The file for a key id, or null when the id is not in the contract's derived form (so no other path can ever be built).</summary>
    public string? PathOf(string keyId) => KeyIdPattern.IsMatch(keyId) ? Path.Combine(Folder, keyId + ".json") : null;

    /// <summary>Writes the record's canonical bytes. true when the file now holds exactly them (it is created, or it already did); false when another file with the same name differs or the write failed.</summary>
    public bool TrySave(ApproverKeyRecord record, out string? path)
    {
        path = PathOf(record.KeyId);
        if (path is null) return false;
        byte[] bytes = record.CanonicalBytes();
        try
        {
            Directory.CreateDirectory(Folder);
            using FileStream file = new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            file.Write(bytes);
            return true;
        }
        catch (IOException) when (File.Exists(path)) { return File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return false; }
    }
}
