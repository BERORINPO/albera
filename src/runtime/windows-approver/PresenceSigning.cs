using System.Text.Json;
using System.Text.RegularExpressions;
using Albera.BrokerContract;

namespace Albera.Approver;

// Which key signs presence, and the four key verbs of the wire contract (docs/architecture/approver-webauthn.md, "Wire contract").
//   - The Authority's `keys` verb lists the registered keys (public data: key id, kind, credential id). When it lists a WebAuthn key, WebAuthn signs, with allowCredentials = those credential ids.
//   - Windows Hello (KeyCredentialManager) signs only when no WebAuthn key is registered AND the session is not remote (SM_REMOTESESSION): Hello does not work over Remote Desktop.
//   - A remote session with no WebAuthn key stops with `remote_session` before anything is asked or sent.
//   - Without a WebAuthn kit (unit tests, a test-faults build with no software authenticator) there is no `keys` call and Hello always signs: exactly the behaviour before WebAuthn.

/// <summary>One entry of the Authority's `keys` reply. <see cref="CredentialId"/> is set for WebAuthn keys only.</summary>
internal sealed record RegisteredKey(string KeyId, string Kind, byte[]? CredentialId)
{
    public bool IsWebAuthn => Kind == ApproverKeyRecord.WebAuthnKind;
}

/// <summary>The Authority answered {"ok":false,"code":...} with a code the contract knows.</summary>
internal sealed class AuthorityRefusal(string code) : Exception(code)
{
    public string Code { get; } = code;
}

/// <summary>The reply of `key_remove`: the keys left, and whether the policy went back to careful because the removed key had signed it.</summary>
internal sealed record RemoveResult(IReadOnlyList<RegisteredKey> Keys, bool PolicyReset);

internal enum RouteKind { Hello, WebAuthn, RemoteNoKey }

internal sealed record SigningRoute(RouteKind Kind, IReadOnlyList<byte[]> CredentialIds)
{
    public static SigningRoute UsingHello { get; } = new(RouteKind.Hello, []);

    /// <summary>The rule above, as data: any registered WebAuthn key wins; otherwise Hello on a local session; otherwise nothing can sign.</summary>
    public static SigningRoute Choose(IReadOnlyList<RegisteredKey> keys, bool remoteSession)
    {
        List<byte[]> credentials = [.. keys.Where(k => k.IsWebAuthn && k.CredentialId is not null).Select(k => k.CredentialId!)];
        if (credentials.Count > 0) return new SigningRoute(RouteKind.WebAuthn, credentials);
        return remoteSession ? new SigningRoute(RouteKind.RemoteNoKey, []) : UsingHello;
    }
}

internal sealed class PresenceSigning(IApproverChannel channel, IPresenceSigner hello, WebAuthnKit? kit)
{
    public const string RemoteSessionCode = "remote_session";
    public const string RemoteSessionHint = "hint: Windows Hello does not work over Remote Desktop for this key. Make a WebAuthn key with AlberaApprover.exe enroll --webauthn --accept-unattested "
        + "and add it with the elevated set-approver step (albera-host.ps1 -Mode set-approver -ApproverKeyFile <the record file enroll prints>). Nothing was asked or sent";

    /// <summary>The route for a signature made now. Asks the Authority for its key list when WebAuthn is wired; an Authority from before WebAuthn (it does not know the verb) has Hello keys only.</summary>
    public async Task<SigningRoute> ChooseAsync()
    {
        if (kit is null) return SigningRoute.UsingHello;
        IReadOnlyList<RegisteredKey> keys;
        try { keys = await new KeyDirectory(channel).ListAsync(); }
        catch (AuthorityRefusal refusal) when (refusal.Code == "request_invalid") { keys = []; }
        return SigningRoute.Choose(keys, kit.IsRemoteSession()); // read now, not at start: the session may have changed since the tray started
    }

    /// <summary>Asks the key of <paramref name="route"/> to sign. <paramref name="window"/> is the parent of the WebAuthn prompt (default: the console); Hello takes none.</summary>
    public SignResult Sign(SigningRoute route, byte[] message, IntPtr window = default) => route.Kind switch
    {
        RouteKind.WebAuthn when kit is not null => new WebAuthnSigner(kit.Authenticator).Sign(message, route.CredentialIds, window),
        RouteKind.Hello => hello.Sign(message),
        _ => SignResult.NotReady, // RemoteNoKey is stopped by the caller before any signing; a WebAuthn route without a kit cannot be made
    };

    /// <summary>The JSON value of a "presence" / "by" field: the quoted base64 RSA signature of a Hello key, or the WebAuthn proof object.</summary>
    public static string PresenceJson(SignResult signed) => signed.Proof is { } proof ? proof.ToJson() : $"\"{Convert.ToBase64String(signed.Signature!)}\"";

    /// <summary>The line printed after the typed yes and before the prompt. Neither prompt shows the action, so the person is told to rely on what is on screen.</summary>
    public static string AskNotice(SigningRoute route, string what) => route.Kind == RouteKind.WebAuthn
        ? $"Windows will ask you to verify with a registered WebAuthn key now (over Remote Desktop: on the PC you connected from). It shows only the app name: {what} is what you approve.\n"
        : $"Windows Hello will ask you to verify now. It shows only the app name: {what} is what you approve.\n";

    /// <summary>The key exists but gave no proof (cancelled, locked, timed out): the same meaning for both kinds, with the code that names the kind.</summary>
    public static string NoProofCode(SigningRoute route) => route.Kind == RouteKind.WebAuthn ? "webauthn_no_proof" : "hello_no_proof";

    public static string NoProofHint(SigningRoute route) => route.Kind == RouteKind.WebAuthn
        ? "hint: Windows did not verify you with a WebAuthn key (cancelled or timed out); run the command again. Nothing was sent"
        : "hint: Windows Hello did not verify you (cancelled or locked); run the command again. Nothing was sent";

    public static string NotReadyHint(SigningRoute route, SignResult result) => route.Kind == RouteKind.WebAuthn
        ? $"hint: Windows WebAuthn gave no signature ({result.Detail ?? "not available"}). Nothing was sent; the request stays pending"
        : "hint: run AlberaApprover.exe enroll (Windows Hello key missing or Hello not set up); nothing was sent";
}

// The three key verbs: `keys`, `key_challenge` (op remove only) and `key_remove`. There is no key_add: keys are added only by the elevated `set-approver` (docs/architecture/approver-webauthn.md, "Adding a key").
// One call each: a request frame out, one reply frame back. A reply is accepted only in the exact shape of the contract; anything else is an invalid response (outcome unknown, exit 68).
// Everything pasted into a request is either a constant, a key id from the contract's grammar, a challenge in its base64url grammar, or JSON this app built (a proof object).
internal sealed class KeyDirectory(IApproverChannel channel)
{
    public const int MaxKeys = 16;
    private static readonly string[] Codes = ["authority_unavailable", "request_invalid", "request_expired", "human_denied", "presence_unavailable", "presence_mismatch", "queue_full",
        "challenge_unknown", "challenge_expired", "key_unknown", "last_key", "too_many_keys"];
    private static readonly Regex KeyId = ActionDigest.FromEcma(ActionDigest.IdPattern);
    private static readonly Regex WebAuthnKeyId = ActionDigest.FromEcma("^webauthn-[0-9a-f]{16}$");
    private static readonly Regex Challenge = ActionDigest.FromEcma("^[A-Za-z0-9_-]{22}$");

    public async Task<IReadOnlyList<RegisteredKey>> ListAsync() => ParseKeys(await CallAsync("{\"v\":1,\"verb\":\"keys\"}"));

    /// <returns>the challenge (22 base64url characters) for removing <paramref name="keyId"/></returns>
    public async Task<string> RemoveChallengeAsync(string keyId)
    {
        if (!KeyId.IsMatch(keyId)) throw new ArgumentException("not in the contract grammar");
        JsonElement reply = await CallAsync($"{{\"v\":1,\"verb\":\"key_challenge\",\"op\":\"remove\",\"keyId\":\"{keyId}\"}}");
        if (reply.EnumerateObject().Count() == 3 && reply.TryGetProperty("challenge", out JsonElement challenge) && challenge.ValueKind == JsonValueKind.String && challenge.GetString() is { } text && Challenge.IsMatch(text)
            && reply.TryGetProperty("expiresAt", out JsonElement expires) && expires.ValueKind == JsonValueKind.Number && expires.TryGetInt64(out _)) return text;
        throw Invalid();
    }

    /// <param name="by">the proof (JSON) by a registered key</param>
    public async Task<RemoveResult> RemoveAsync(string keyId, string challenge, string by)
    {
        if (!KeyId.IsMatch(keyId) || !Challenge.IsMatch(challenge)) throw new ArgumentException("not in the contract grammar");
        JsonElement reply = await CallAsync($"{{\"v\":1,\"verb\":\"key_remove\",\"keyId\":\"{keyId}\",\"challenge\":\"{challenge}\",\"by\":{by}}}");
        bool policyReset = reply.TryGetProperty("policyReset", out JsonElement flag); // only ever `true`: the removed key had signed the policy in force, and the policy is back to careful
        if (policyReset && flag.ValueKind != JsonValueKind.True) throw Invalid();
        return new RemoveResult(ParseKeys(reply, policyReset ? 3 : 2), policyReset);
    }

    private static IReadOnlyList<RegisteredKey> ParseKeys(JsonElement reply, int properties = 2)
    {
        if (reply.EnumerateObject().Count() != properties || !reply.TryGetProperty("keys", out JsonElement array) || array.ValueKind != JsonValueKind.Array || array.GetArrayLength() > MaxKeys) throw Invalid();
        List<RegisteredKey> keys = [.. array.EnumerateArray().Select(ParseEntry)];
        bool unique = keys.Select(k => k.KeyId).Distinct().Count() == keys.Count && keys.Where(k => k.CredentialId is not null).Select(k => Convert.ToBase64String(k.CredentialId!)).Distinct().Count() == keys.Count(k => k.CredentialId is not null);
        return unique ? keys : throw Invalid();
    }

    // {"keyId","kind","credentialId"} for a WebAuthn key (its id in the derived form), {"keyId","kind"} for a Hello key (any id in the Authority's id grammar: the legacy config pair can carry a chosen one).
    private static RegisteredKey ParseEntry(JsonElement entry)
    {
        if (entry.ValueKind != JsonValueKind.Object || Text(entry, "keyId") is not { } keyId || Text(entry, "kind") is not { } kind) throw Invalid();
        int properties = entry.EnumerateObject().Count();
        if (kind == ApproverKeyRecord.HelloKind && properties == 2 && KeyId.IsMatch(keyId)) return new RegisteredKey(keyId, kind, null);
        if (kind == ApproverKeyRecord.WebAuthnKind && properties == 3 && WebAuthnKeyId.IsMatch(keyId) && Text(entry, "credentialId") is { } credential && B64.TryFromUrl(credential) is { Length: >= 1 and <= ApproverKeyRecord.MaxCredentialIdBytes } id)
            return new RegisteredKey(keyId, kind, id);
        throw Invalid();
    }

    private static string? Text(JsonElement entry, string name) => entry.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static ChannelException Invalid() => new(ChannelCodes.InvalidResponse, sent: true);

    /// <summary>One call; returns the reply object of an {"ok":true,...}, throws AuthorityRefusal for {"ok":false,"code"} with a known code and an invalid response for anything else.</summary>
    private async Task<JsonElement> CallAsync(string request)
    {
        string text = await channel.CallAsync(request);
        try
        {
            using JsonDocument document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
            JsonElement root = document.RootElement.Clone();
            if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ok", out JsonElement ok))
            {
                if (ok.ValueKind == JsonValueKind.True) return root;
                if (ok.ValueKind == JsonValueKind.False && root.TryGetProperty("code", out JsonElement code) && code.ValueKind == JsonValueKind.String
                    && Codes.Contains(code.GetString()) && root.EnumerateObject().Count() == 2) throw new AuthorityRefusal(code.GetString()!);
            }
        }
        catch (JsonException) { }
        throw Invalid();
    }
}
