using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32;

namespace Albera.Setup;

/// <summary>One allow or deny rule of a folder's DACL, reduced to what the administrator-only check looks at.</summary>
internal sealed record AceInfo(string Sid, bool Allow, FileSystemRights Rights, bool InheritOnly);

/// <summary>File hashing, link detection, the work folder's protected DACL and the "only administrators can write here" check that every folder setup trusts has to pass.</summary>
internal static class FileSystemChecks
{
    public const string LocalSystemSid = "S-1-5-18";
    public const string AdministratorsSid = "S-1-5-32-544";

    private static readonly HashSet<string> TrustedWriters = new(StringComparer.Ordinal)
    {
        LocalSystemSid,
        AdministratorsSid,
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",   // NT SERVICE\TrustedInstaller
    };

    /// <summary>CREATOR OWNER: an INHERIT-ONLY rule for it is the placeholder every Program Files folder carries (it turns into the creator's own rule on a child). Any other rule for it - one that applies to the folder itself - is a writer like any other.</summary>
    public const string CreatorOwnerSid = "S-1-3-0";

    /// <summary>Everything beyond read and execute. The generic bits are listed too: a rule written with GENERIC_WRITE or GENERIC_ALL is not translated by every writer of ACLs.</summary>
    private const FileSystemRights WriteLike =
        FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes
        | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership
        | (FileSystemRights)0x40000000   /* GENERIC_WRITE */ | (FileSystemRights)0x10000000   /* GENERIC_ALL */;

    public static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>
    /// The run-id floor of this PC: HKLM\SOFTWARE\Albera\SetupRunIdFloor, a REG_SZ with a decimal number (64-bit view, as the installer script's 64-bit PowerShell writes it). null = no key or no value; a value of any other
    /// type, or one that is not a decimal number, is a refusal. Administrators write it; Users cannot create or change anything under HKLM\SOFTWARE.
    /// </summary>
    public static ulong? ReadSetupRunIdFloor()
    {
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = machine.OpenSubKey(InstallRecord.FloorKeyPath);
        if (key is null) return null;
        var value = key.GetValue(InstallRecord.FloorValueName, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
        if (value is null) return null;
        if (key.GetValueKind(InstallRecord.FloorValueName) != RegistryValueKind.String) throw new SetupRefusal("run_id_floor_invalid", $"{InstallRecord.FloorKeyPath}\\{InstallRecord.FloorValueName} is not a string value");
        return InstallRecord.ParseFloor((string)value);
    }

    public static bool IsReparsePoint(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;

    /// <summary>A link or junction at `path` or on any folder of its path (drive root excluded).</summary>
    public static bool PathHasReparsePoint(string path)
    {
        var current = Path.GetFullPath(path).TrimEnd('\\');
        while (!string.IsNullOrEmpty(current) && Path.GetPathRoot(current)?.TrimEnd('\\') != current)
        {
            if ((File.Exists(current) || Directory.Exists(current)) && IsReparsePoint(current)) return true;
            current = Path.GetDirectoryName(current) ?? string.Empty;
        }
        return false;
    }

    /// <summary>
    /// What is wrong with a folder that setup would trust: its owner is not SYSTEM, Administrators or TrustedInstaller, or an allow rule lets anyone else write, delete, change permissions or
    /// take ownership. Rules that only apply to children (InheritOnly) count too: a child made later would carry them; the one exception is an inherit-only rule for CREATOR OWNER, which turns into the
    /// creator's own rule (without the exception no ordinary Program Files folder would pass). A CREATOR OWNER rule that is not inherit-only counts. Empty = only administrators can change it.
    /// </summary>
    public static IReadOnlyList<string> AdministratorOnlyProblems(string folder)
    {
        // a folder or - for the install record - a file: the same rule for both
        FileSystemSecurity security = File.Exists(folder) ? new FileInfo(folder).GetAccessControl() : new DirectoryInfo(folder).GetAccessControl();
        var owner = security.GetOwner(typeof(SecurityIdentifier))?.Value ?? "(none)";
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
            .Select(r => new AceInfo(r.IdentityReference.Value, r.AccessControlType == AccessControlType.Allow, r.FileSystemRights, (r.PropagationFlags & PropagationFlags.InheritOnly) != 0));
        return EvaluateRules(owner, rules);
    }

    private static bool IsCreatorOwnerPlaceholder(AceInfo rule) => rule.Sid == CreatorOwnerSid && rule.InheritOnly;

    /// <summary>The pure part of <see cref="AdministratorOnlyProblems"/> (tests feed it rules directly).</summary>
    public static IReadOnlyList<string> EvaluateRules(string ownerSid, IEnumerable<AceInfo> rules)
    {
        var problems = new List<string>();
        if (!TrustedWriters.Contains(ownerSid)) problems.Add($"owner {ownerSid} is not SYSTEM, Administrators or TrustedInstaller");
        foreach (var rule in rules)
        {
            if (!rule.Allow || TrustedWriters.Contains(rule.Sid)) continue;
            if (IsCreatorOwnerPlaceholder(rule)) continue;
            var rights = rule.Rights & WriteLike;
            if (rights != 0) problems.Add($"{rule.Sid} may {rights}{(rule.InheritOnly ? " (inherited by children)" : "")}");
        }
        return problems;
    }

    /// <summary>
    /// Makes the folder with its final DACL in the same call, so there is no moment when it carries the parent's rules: owner Administrators, the DACL protected (nothing inherited from
    /// the parent) and exactly two rules, SYSTEM and Administrators with FullControl for the folder and everything created in it. `ownerSid` is a parameter only so a test can use an account
    /// it is allowed to own things as; setup always uses Administrators. The result is read back before it is trusted.
    /// </summary>
    public static void CreateAdministratorOnlyDirectory(string path, string ownerSid = AdministratorsSid)
    {
        var security = new DirectorySecurity();
        security.SetOwner(new SecurityIdentifier(ownerSid));
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (var sid in new[] { LocalSystemSid, AdministratorsSid })
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).Create(security);
        var problems = ProtectedDaclProblems(path, ownerSid);
        if (problems.Count > 0) throw new SetupRefusal("work_not_admin_only", string.Join("; ", problems));
    }

    /// <summary>Reads the DACL back: protected, and exactly SYSTEM and Administrators, FullControl, folder and children.</summary>
    public static IReadOnlyList<string> ProtectedDaclProblems(string path, string ownerSid = AdministratorsSid)
    {
        var security = new DirectoryInfo(path).GetAccessControl();
        var problems = new List<string>();
        if (security.GetOwner(typeof(SecurityIdentifier))?.Value != ownerSid) problems.Add("owner is not the requested one");
        if (!security.AreAccessRulesProtected) problems.Add("the DACL still inherits from the parent");
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList();
        var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        var wanted = new HashSet<string> { LocalSystemSid, AdministratorsSid };
        foreach (var rule in rules)
        {
            var sid = rule.IdentityReference.Value;
            var exact = rule.AccessControlType == AccessControlType.Allow && !rule.IsInherited && rule.InheritanceFlags == inherit && rule.PropagationFlags == PropagationFlags.None
                && (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl;
            if (!wanted.Contains(sid) || !exact) problems.Add($"unexpected rule for {sid}");
            else wanted.Remove(sid);
        }
        foreach (var missing in wanted) problems.Add($"no FullControl rule for {missing}");
        return problems;
    }
}
