using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal enum SigningProvider { Software, Tpm }

// The Authority's service configuration: one small JSON file written by the installer, read once when the service starts, never written by the
// Authority. Exactly these keys, all strings, nothing else:
//   { "pipeRoot": "ALBERA\\ApprovalAuthority", "controlPlaneSid": "S-1-5-80-...", "approverSid": "S-1-5-21-...",
//     "signingKeyName": "AlberaApprovalAuthority-2026-10", "signingKeyProvider": "tpm" | "software",
//     "kid": "authority-key-2026-10", "approverKeyId": "hello-key-yosuke-01", "approverPublicKey": "<base64 SPKI, RSA-2048>",
//     "audience": "albera-host-broker", "policyVersion": "policy-2026-10",
//     "attestationKeyId": "broker-attest-2026-10", "attestationPublicKey": "<base64 SPKI, ECDSA P-256>" }   (the last two are optional, and only together)
// attestationKeyId + attestationPublicKey pin the Broker's network attestation key (issue #115 step 3b). Without them no attestation is ever accepted and environment.start /
// environment.create always need a person (unknown means prompt), so an existing config keeps working and loosens nothing. One without the other, or a key that is not a named
// ECDSA P-256 public key, is `config_keys` / `attestation_key_id` / `attestation_public_key`: never a silent fallback.
// The pipes are <pipeRoot>\submit\v1 (Control Plane only) and <pipeRoot>\approver\v1 (the approver only). audience and policyVersion are what the
// Broker validates a receipt against (policyVersion: a v2 receipt, i.e. one a person approved; a v3 policy receipt carries the hash of the tier policy in force instead, see PolicyStore.cs), so the
// Authority takes them from trusted config and never from a request. Every rejected value maps to one
// fixed reason word (never the value itself). Production (strictSeparation) also refuses a Control Plane SID that equals the approver SID or the
// service's own SID: the two pipes must belong to different principals. The config file must be owned and writable only by trusted principals.
internal sealed record AuthorityConfig(string PipeRoot, string ControlPlaneSid, string ApproverSid, string SigningKeyName, SigningProvider SigningProvider,
    string Kid, string ApproverKeyId, byte[] ApproverPublicKey, string Audience, string PolicyVersion, string? AttestationKeyId = null, byte[]? AttestationPublicKey = null)
{
    private const int MaxFileBytes = 4096, MaxPathLength = 240, MaxPublicKeyBytes = 512;
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];
    private static readonly string[] Keys = ["pipeRoot", "controlPlaneSid", "approverSid", "signingKeyName", "signingKeyProvider", "kid", "approverKeyId", "approverPublicKey", "audience", "policyVersion"];
    private static readonly string[] AttestationKeys = ["attestationKeyId", "attestationPublicKey"];
    private static readonly Regex IdRegex = ActionDigest.FromEcma(ActionDigest.IdPattern);
    private static readonly Regex AudienceRegex = ActionDigest.FromEcma("^[a-z][a-z0-9-]{0,63}$");
    private static readonly Regex KeyNameRegex = ActionDigest.FromEcma("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    private static readonly Regex PipeRootRegex = ActionDigest.FromEcma(@"^ALBERA(\\[A-Za-z0-9][A-Za-z0-9._-]{0,31}){1,3}$");

    public string SubmitPipe => PipeRoot + @"\submit\v1";
    public string ApproverPipe => PipeRoot + @"\approver\v1";

    // The only reason words ever printed (SERVICE_CONFIG=invalid:<reason>).
    internal static class Reason
    {
        public const string ConfigPath = "config_path", Unreadable = "config_unreadable", TooLarge = "config_too_large", Syntax = "config_syntax",
            Keys = "config_keys", PipeRoot = "pipe_root", ControlPlaneSid = "control_plane_sid", ApproverSid = "approver_sid", SidsNotDistinct = "sids_not_distinct",
            SigningKey = "signing_key", SigningProvider = "signing_provider", Kid = "kid", ApproverKeyId = "approver_key_id", ApproverPublicKey = "approver_public_key",
            Audience = "audience", PolicyVersion = "policy_version", AttestationKeyId = "attestation_key_id", AttestationPublicKey = "attestation_public_key", ConfigUntrusted = "config_untrusted", ConfigFolderUntrusted = "config_folder_untrusted";
    }

    public static AuthorityConfig? TryLoad(string configPath, bool strictSeparation, out string reason)
    {
        reason = Reason.ConfigPath;
        if (!IsPlainAbsolutePath(configPath)) return null;
        byte[] bytes;
        try
        {
            using FileStream file = new(configPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (!ServicePathGuard.IsTrustedConfigFile(configPath, file)) { reason = Reason.ConfigUntrusted; return null; }
            // Whoever can create files in this folder could have pre-created policy.json (or the config) before the service ever ran: the folder is trusted before anything else here is read.
            if (!ServicePathGuard.IsTrustedConfigFolder(Path.GetDirectoryName(configPath)!)) { reason = Reason.ConfigFolderUntrusted; return null; }
            if (file.Length > MaxFileBytes) { reason = Reason.TooLarge; return null; }
            bytes = new byte[file.Length];
            file.ReadExactly(bytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            reason = Reason.Unreadable;
            return null;
        }
        return TryParse(bytes, strictSeparation, out reason);
    }

    internal static AuthorityConfig? TryParse(byte[] json, bool strictSeparation, out string reason)
    {
        reason = Reason.Syntax;
        ReadOnlyMemory<byte> text = json.AsSpan().StartsWith(Utf8Bom) ? json.AsMemory(Utf8Bom.Length) : json;
        JsonDocument document;
        try { document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 2 }); }
        catch (JsonException) { return null; }
        using (document)
        {
            JsonElement root = document.RootElement;
            reason = Reason.Keys;
            if (root.ValueKind != JsonValueKind.Object) return null;
            HashSet<string> seen = new(StringComparer.Ordinal);
            foreach (JsonProperty property in root.EnumerateObject())
                if (property.Value.ValueKind != JsonValueKind.String || !seen.Add(property.Name)) return null; // all strings; a repeated key is ambiguous
            int pinned = AttestationKeys.Count(seen.Contains);
            if (pinned is not (0 or 2) || seen.Count != Keys.Length + pinned || !Keys.All(seen.Contains)) return null; // the attestation key is both keys or neither
            string Get(string name) => root.GetProperty(name).GetString()!;

            string pipeRoot = Get("pipeRoot"), cpSid = Get("controlPlaneSid"), approverSid = Get("approverSid");
            reason = Reason.PipeRoot;
            if (pipeRoot.Length > 128 || !PipeRootRegex.IsMatch(pipeRoot)) return null;
            reason = Reason.ControlPlaneSid;
            if (SidRules.TryParse(cpSid, allowVirtualAccount: true) is null) return null;
            reason = Reason.ApproverSid;
            if (SidRules.TryParse(approverSid, allowVirtualAccount: false) is null) return null;
            reason = Reason.SidsNotDistinct;
            if (strictSeparation && (cpSid == approverSid || IsOwnSid(cpSid) || IsOwnSid(approverSid))) return null;
            reason = Reason.SigningKey;
            if (!KeyNameRegex.IsMatch(Get("signingKeyName"))) return null;
            reason = Reason.SigningProvider;
            if (Get("signingKeyProvider") is not ("software" or "tpm")) return null;
            reason = Reason.Kid;
            if (!IdRegex.IsMatch(Get("kid"))) return null;
            reason = Reason.ApproverKeyId;
            if (!IdRegex.IsMatch(Get("approverKeyId"))) return null;
            reason = Reason.ApproverPublicKey;
            if (DecodeApproverKey(Get("approverPublicKey")) is not { } approverKey) return null;
            reason = Reason.Audience;
            if (!AudienceRegex.IsMatch(Get("audience"))) return null;
            reason = Reason.PolicyVersion;
            if (!IdRegex.IsMatch(Get("policyVersion"))) return null;

            string? attestationKeyId = null;
            byte[]? attestationKey = null;
            if (pinned == 2)
            {
                reason = Reason.AttestationKeyId;
                if (!IdRegex.IsMatch(Get("attestationKeyId"))) return null;
                reason = Reason.AttestationPublicKey;
                if (DecodeAttestationKey(Get("attestationKeyId"), Get("attestationPublicKey")) is not { } decoded) return null;
                (attestationKeyId, attestationKey) = (Get("attestationKeyId"), decoded);
            }

            reason = "";
            return new AuthorityConfig(pipeRoot, cpSid, approverSid, Get("signingKeyName"), Get("signingKeyProvider") == "tpm" ? SigningProvider.Tpm : SigningProvider.Software,
                Get("kid"), Get("approverKeyId"), approverKey, Get("audience"), Get("policyVersion"), attestationKeyId, attestationKey);
        }
    }

    private static bool IsOwnSid(string sid)
    {
        using System.Security.Principal.WindowsIdentity identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        return identity.User?.Value == sid;
    }

    // The same rule as IsPlainAbsolutePath in the Broker: "C:\dir\file", already in the form GetFullPath returns (no relative, UNC, device, '..',
    // '/', doubled separators, trailing dots, streams or wildcards), so the file is opened exactly as written.
    internal static bool IsPlainAbsolutePath(string path)
    {
        if (path.Length is < 4 or > MaxPathLength || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
        if (path[^1] == '\\' || path.IndexOf(':', 2) >= 0 || path.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || path.IndexOfAny(['*', '?']) >= 0) return false;
        try { return string.Equals(Path.GetFullPath(path), path, StringComparison.Ordinal); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException) { return false; }
    }

    private static byte[]? DecodeAttestationKey(string keyId, string text)
    {
        try
        {
            byte[] key = Convert.FromBase64String(text);
            using PinnedAttestationKey? pinned = PinnedAttestationKey.TryCreate(keyId, key);
            return pinned is null ? null : key;
        }
        catch (FormatException) { return null; }
    }

    private static byte[]? DecodeApproverKey(string text)
    {
        try
        {
            byte[] key = Convert.FromBase64String(text);
            if (key.Length is 0 or > MaxPublicKeyBytes) return null;
            using RsaPresenceVerifier? verifier = RsaPresenceVerifier.TryCreate(key);
            return verifier is null ? null : key;
        }
        catch (FormatException) { return null; }
    }
}
