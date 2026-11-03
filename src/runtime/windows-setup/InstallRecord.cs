using System.Globalization;
using System.Text.Json;

namespace Albera.Setup;

/// <summary>
/// The one thing setup reads from the install record that scripts/host/albera-host.ps1 keeps (<see cref="SetupLayout.InstallRecordFile"/>): the run id of the attested workflow run that built what was installed
/// (<c>setupRunId</c>, kept as a decimal string; a JSON number is accepted too). It is compared as an unsigned 64-bit number, never as text. Setup reads the record only when its folder and the file
/// pass the same "only administrators can write here" test as every other folder setup trusts: a record anyone could rewrite would let them lower the number and replay an old build, or raise it to stop updates.
/// The record goes away with an uninstall, so the bound does not live only there: HKLM\SOFTWARE\Albera\SetupRunIdFloor (a REG_SZ with a decimal number, only ever raised, never removed by uninstall) and the
/// run id of the build that made THIS setup.exe (<c>PinnedTools.BuildRunId</c>, compiled in) are floors too. <see cref="RollbackRefusal"/> compares a build with the largest of the three.
/// </summary>
internal static class InstallRecord
{
    public const string RunIdProperty = "setupRunId";
    public const string FloorKeyPath = @"SOFTWARE\Albera";
    public const string FloorValueName = "SetupRunIdFloor";
    private const int MaxBytes = 256 * 1024;

    /// <summary>
    /// The recorded run id, or null when there is nothing to compare with: no record yet (a first install), or a record without the property (made before it existed). A record that is there but cannot be
    /// trusted or understood is a refusal: this is a security check, so "could not read" never reads as "nothing recorded".
    /// </summary>
    public static ulong? ReadSetupRunId(string recordPath, Func<string, IReadOnlyList<string>> administratorOnlyProblems, Func<string, bool> pathHasReparsePoint)
    {
        var folder = Path.GetDirectoryName(recordPath) ?? string.Empty;
        if (!File.Exists(recordPath))
        {
            // no record and no folder is a first install; a folder that is there without a record is the script's business (it refuses a folder it did not make)
            return null;
        }
        if (pathHasReparsePoint(recordPath)) throw new SetupRefusal("install_record_untrusted", "the install record is reached through a link or junction");
        foreach (var path in new[] { folder, recordPath })
        {
            var problems = administratorOnlyProblems(path);
            if (problems.Count > 0) throw new SetupRefusal("install_record_untrusted", $"{Path.GetFileName(path)} can be changed by others: {string.Join("; ", problems)}");
        }
        byte[] bytes;
        try
        {
            using var stream = new FileStream(recordPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length > MaxBytes) throw new SetupRefusal("install_record_invalid", "the install record is too large");
            bytes = new byte[stream.Length];
            stream.ReadExactly(bytes);
        }
        catch (IOException error) { throw new SetupRefusal("install_record_invalid", $"the install record cannot be read ({error.GetType().Name})"); }
        return Parse(bytes);
    }

    /// <summary>The pure part: the run id in a record's bytes, or null when the record has none.</summary>
    public static ulong? Parse(byte[] json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new SetupRefusal("install_record_invalid", "the install record is not a JSON object");
            if (!document.RootElement.TryGetProperty(RunIdProperty, out var value)) return null;
            var text = value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.Number => value.GetRawText(),
                _ => null,
            };
            return ParseDecimal(text) ?? throw new SetupRefusal("install_record_invalid", $"{RunIdProperty} in the install record is not a decimal number");
        }
        catch (JsonException)
        {
            throw new SetupRefusal("install_record_invalid", "the install record is not valid JSON");
        }
    }

    /// <summary>The floor as the registry holds it (a REG_SZ with a decimal number). A value that is there but is not one is a refusal: "could not read" never reads as "no floor".</summary>
    public static ulong ParseFloor(string? text) =>
        ParseDecimal(text) ?? throw new SetupRefusal("run_id_floor_invalid", $"{FloorKeyPath}\\{FloorValueName} is not a decimal number; an administrator must correct or delete that one value");

    private static ulong? ParseDecimal(string? text)
    {
        if (text is null || text.Length is 0 or > 20 || !text.All(char.IsAsciiDigit)) return null;
        return ulong.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : null;
    }

    /// <summary>
    /// Anti-rollback: null when `runId` may be installed, otherwise the refusal text. The bound is the LARGEST of the install record's run id, the registry floor and the run id of the build that made this setup
    /// (0 for a local compile check: it bounds nothing). The same number is fine, a smaller one is refused. Pure: the flow reads the three values and the tests feed them in.
    /// </summary>
    public static string? RollbackRefusal(ulong runId, ulong? recorded, ulong? floor, ulong builtBy)
    {
        var bound = 0UL;
        var source = "none";
        if (recorded is { } r && r > bound) { bound = r; source = "the install record"; }
        if (floor is { } f && f > bound) { bound = f; source = $"the floor of this PC ({FloorKeyPath}\\{FloorValueName}, which uninstall keeps)"; }
        if (builtBy > bound) { bound = builtBy; source = "the build of this setup.exe"; }
        if (runId >= bound) return null;
        return $"this update was built by workflow run {runId}, but {source} holds run {bound}; an older build is never installed over a newer one";
    }
}
