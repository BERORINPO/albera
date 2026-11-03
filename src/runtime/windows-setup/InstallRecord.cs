using System.Globalization;
using System.Text.Json;

namespace Albera.Setup;

/// <summary>
/// The one thing setup reads from the install record that scripts/host/albera-host.ps1 keeps (<see cref="SetupLayout.InstallRecordFile"/>): the run id of the attested workflow run that built what was installed
/// (<c>setupRunId</c>, kept as a decimal string; a JSON number is accepted too). It is compared as an unsigned 64-bit number, never as text. Setup reads the record only when its folder and the file
/// pass the same "only administrators can write here" test as every other folder setup trusts: a record anyone could rewrite would let them lower the number and replay an old build, or raise it to stop updates.
/// </summary>
internal static class InstallRecord
{
    public const string RunIdProperty = "setupRunId";
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
            if (text is null || text.Length is 0 or > 20 || !text.All(char.IsAsciiDigit) || !ulong.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
                throw new SetupRefusal("install_record_invalid", $"{RunIdProperty} in the install record is not a decimal number");
            return id;
        }
        catch (JsonException)
        {
            throw new SetupRefusal("install_record_invalid", "the install record is not valid JSON");
        }
    }
}
