using System.Text.Json;

namespace Albera.Setup;

/// <summary>What one verified attestation says about where a file was built: the commit and the Actions run id (from the certificate, which the workflow cannot choose).</summary>
internal sealed record AttestationFacts(string Commit, ulong RunId);

/// <summary>
/// The second lock after gh: gh checks the signature, the transparency proof and (with --repo and --cert-identity) the repository and workflow; this reads the JSON gh prints
/// with --format json and pins the certificate fields again, by itself, so a gh that is lenient about one of them still cannot let a wrong build through.
/// Only <c>verificationResult.signature.certificate</c>, <c>verificationResult.verifiedTimestamps</c> and the subject digests are read; the predicate is attacker-controlled text and is ignored.
/// Every entry gh returns has to satisfy every pin.
/// </summary>
internal static class AttestationPolicy
{
    public const int MaxEntries = 64;
    private const string RunPrefix = SetupLayout.RepositoryUrl + "/actions/runs/";

    public static IReadOnlyList<AttestationFacts> Evaluate(string ghJson, string fileSha256)
    {
        JsonDocument document;
        try { document = JsonDocument.Parse(ghJson); }
        catch (JsonException) { throw Refuse("gh did not print one JSON document"); }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Array || root.GetArrayLength() == 0) throw Refuse("gh printed no verified attestation");
            if (root.GetArrayLength() > MaxEntries) throw Refuse($"more than {MaxEntries} attestations");
            var facts = new List<AttestationFacts>();
            foreach (var entry in root.EnumerateArray()) facts.Add(CheckEntry(entry, fileSha256));
            return facts;
        }
    }

    private static AttestationFacts CheckEntry(JsonElement entry, string fileSha256)
    {
        var result = Child(entry, "verificationResult") ?? throw Refuse("verificationResult missing");
        CheckStatement(Child(result, "statement") ?? throw Refuse("statement missing"), fileSha256);
        if (Child(result, "verifiedTimestamps") is not { ValueKind: JsonValueKind.Array } stamps || stamps.GetArrayLength() == 0) throw Refuse("no verified timestamp (no transparency log or timestamp authority proof)");
        var certificate = Child(Child(result, "signature") ?? throw Refuse("signature missing"), "certificate") ?? throw Refuse("certificate missing");

        Require(certificate, "subjectAlternativeName", SetupLayout.CertificateIdentity);
        Require(certificate, "issuer", SetupLayout.OidcIssuer);
        Require(certificate, "sourceRepositoryURI", SetupLayout.RepositoryUrl);
        Require(certificate, "sourceRepositoryIdentifier", SetupLayout.RepositoryId);
        Require(certificate, "sourceRepositoryOwnerIdentifier", SetupLayout.OwnerId);
        Require(certificate, "sourceRepositoryRef", SetupLayout.SourceRef);
        Require(certificate, "githubWorkflowRepository", SetupLayout.Repository);
        Require(certificate, "githubWorkflowRef", SetupLayout.SourceRef);
        Require(certificate, "buildSignerURI", SetupLayout.CertificateIdentity);
        Require(certificate, "runnerEnvironment", SetupLayout.HostedRunner);
        var commit = Text(certificate, "sourceRepositoryDigest");
        if (!IsCommit(commit)) throw Refuse("sourceRepositoryDigest is not a 40-hex commit");
        if (!string.Equals(Text(certificate, "buildSignerDigest"), commit, StringComparison.Ordinal)) throw Refuse("the workflow file was read at another commit than the source (buildSignerDigest)");
        return new AttestationFacts(commit!, ParseRunId(Text(certificate, "runInvocationURI")));
    }

    private static void CheckStatement(JsonElement statement, string fileSha256)
    {
        if (!string.Equals(Text(statement, "predicateType"), SetupLayout.ProvenancePredicate, StringComparison.Ordinal)) throw Refuse("not a SLSA provenance v1 attestation");
        if (Child(statement, "subject") is not { ValueKind: JsonValueKind.Array } subjects) throw Refuse("subject list missing");
        var named = subjects.EnumerateArray().Any(s => Child(s, "digest") is { } digest && string.Equals(Text(digest, "sha256"), fileSha256, StringComparison.Ordinal));
        if (!named) throw Refuse("the attestation does not name this file's SHA-256");
    }

    /// <summary>https://github.com/BERORINPO/albera/actions/runs/&lt;id&gt;[/attempts/&lt;n&gt;]</summary>
    public static ulong ParseRunId(string? uri)
    {
        if (uri is null || !uri.StartsWith(RunPrefix, StringComparison.Ordinal)) throw Refuse("runInvocationURI is not a run of this repository");
        var parts = uri[RunPrefix.Length..].Split('/');
        var shapeOk = parts.Length == 1 || (parts.Length == 3 && parts[1] == "attempts" && IsNumber(parts[2], 6));
        if (!shapeOk || !IsNumber(parts[0], 18) || !ulong.TryParse(parts[0], out var id)) throw Refuse("runInvocationURI has an unexpected shape");
        return id;
    }

    private static bool IsNumber(string text, int maxDigits) =>
        text.Length > 0 && text.Length <= maxDigits && text[0] != '0' && text.All(c => c is >= '0' and <= '9');

    private static bool IsCommit(string? value) => value is { Length: 40 } && value.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    private static void Require(JsonElement certificate, string field, string expected)
    {
        var actual = Text(certificate, field);
        if (!string.Equals(actual, expected, StringComparison.Ordinal)) throw Refuse($"certificate {field} is {Describe(actual)}, expected {expected}");
    }

    private static string Describe(string? value) => value is null ? "missing" : $"\"{Clean(value)}\"";

    private static string Clean(string value) => new(value.Where(c => c >= ' ' && c != '\u007f').Take(200).ToArray());

    private static JsonElement? Child(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var child) ? child : null;

    private static string? Text(JsonElement parent, string name) => Child(parent, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static SetupRefusal Refuse(string why) => new("attestation_policy", why);
}
