namespace Albera.Setup;

internal enum SetupMode { Install, Verify }

/// <summary>The values the owner passes on for the installer script. Each is checked for its character set only; scripts/host/albera-host.ps1 does the real validation.</summary>
internal sealed record EngineOptions(string? ApproverKeyId, string? ApproverPublicKey, string? ApproverSid, bool GrantHyperVToBroker, string? VmName, string? ComputerId);

internal sealed record SetupOptions(SetupMode Mode, string UpdateFolder, bool NoPause, EngineOptions Engine)
{
    public const string Usage =
        "usage: albera-setup.exe --update <folder> [--mode install|verify] [--no-pause]\r\n"
        + "         [--approver-key-id <id> --approver-public-key <base64 spki> --approver-sid <S-1-5-21-...>]\r\n"
        + "         [--grant-hyperv-to-broker --vm-name <name> [--computer-id <id>]]\r\n"
        + "  install (default): verify the update folder, then run the installer script. verify: verify only, change nothing.";

    private const int MaxValueLength = 2048;

    public static SetupOptions Parse(IReadOnlyList<string> args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var flags = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Count; i++)
        {
            var name = args[i];
            if (name is "--no-pause" or "--grant-hyperv-to-broker")
            {
                if (!flags.Add(name)) throw new SetupUsageException($"{name} given twice");
                continue;
            }
            if (!Known.Contains(name)) throw new SetupUsageException($"unknown argument {Show(name)}");
            if (i + 1 >= args.Count) throw new SetupUsageException($"{name} needs a value");
            if (!values.TryAdd(name, args[++i])) throw new SetupUsageException($"{name} given twice");
        }

        var mode = values.GetValueOrDefault("--mode", "install") switch
        {
            "install" => SetupMode.Install,
            "verify" => SetupMode.Verify,
            var other => throw new SetupUsageException($"--mode must be install or verify, not {Show(other)}"),
        };
        if (!values.TryGetValue("--update", out var update) || update.Length == 0) throw new SetupUsageException("--update <folder> is required");
        if (!Path.IsPathFullyQualified(update) || update.Contains('\0') || update.Length > 400) throw new SetupUsageException("--update must be a full path");

        var engine = new EngineOptions(
            Checked(values, "--approver-key-id", IsKeyIdChar), Checked(values, "--approver-public-key", IsBase64Char), Checked(values, "--approver-sid", IsSidChar),
            flags.Contains("--grant-hyperv-to-broker"), Checked(values, "--vm-name", IsNameChar), Checked(values, "--computer-id", IsIdChar));
        if (mode == SetupMode.Verify && (engine.ApproverKeyId, engine.ApproverPublicKey, engine.ApproverSid, engine.VmName, engine.ComputerId) != (null, null, null, null, null))
            throw new SetupUsageException("installer values make no sense with --mode verify");
        if ((engine.VmName is not null || engine.ComputerId is not null) && !engine.GrantHyperVToBroker) throw new SetupUsageException("--vm-name and --computer-id need --grant-hyperv-to-broker");
        return new SetupOptions(mode, update.TrimEnd('\\'), flags.Contains("--no-pause"), engine);
    }

    private static readonly HashSet<string> Known = new(StringComparer.Ordinal)
    {
        "--mode", "--update", "--approver-key-id", "--approver-public-key", "--approver-sid", "--vm-name", "--computer-id",
    };

    private static string? Checked(Dictionary<string, string> values, string name, Func<char, bool> allowed)
    {
        if (!values.TryGetValue(name, out var value)) return null;
        if (value.Length == 0 || value.Length > MaxValueLength || value[0] == '-' || !value.All(allowed)) throw new SetupUsageException($"{name} has an unusable value");
        return value;
    }

    private static bool IsKeyIdChar(char c) => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or ':' or '-';
    private static bool IsBase64Char(char c) => char.IsAsciiLetterOrDigit(c) || c is '+' or '/' or '=';
    private static bool IsSidChar(char c) => c is 'S' or '-' || char.IsAsciiDigit(c);
    private static bool IsIdChar(char c) => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-';
    private static bool IsNameChar(char c) => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-' or ' ';

    private static string Show(string text) => new(text.Where(c => c >= ' ' && c != '\u007f').Take(60).ToArray());
}
