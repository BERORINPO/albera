using System.Text;
using System.Text.Json;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal enum PipeRole { Submit, Approver }

// The two wire protocols. Each direction of every pipe is one frame: a 4-byte little-endian length (1..2048) then UTF-8 JSON; one request, one reply,
// then the connection ends. Requests are read with the contract's strict JSON reader (objects, strings, booleans and safe integers only; no null,
// arrays, duplicate keys or extra keys at any level the verb does not name). The verb set depends on the pipe, not on the caller's claim:
//   submit pipe   (ACE: the Control Plane SID only)  submit | status
//   approver pipe (ACE: the approver SID only)       list | decide | policy | policy_set | keys | key_challenge | key_add | key_remove
// Any other verb on a pipe, any malformed or unknown-key request and any peer that is not the configured SID gets {"ok":false,"code":"request_invalid"}.
// Replies are {"ok":true,...} or {"ok":false,"code":<one of AuthorityCodes>}; nothing the caller sent is ever echoed. The exact shapes are in
// docs/architecture/approval-authority.md.
internal sealed class AuthorityProtocol(AuthorityCore core)
{
    public const int Version = 1, MaxFrameBytes = 2048, ReplyBudgetBytes = 1900, MaxChallengeText = 64;

    private static readonly string[] SubmitKeys = ["v", "verb", "purpose", "operationId", "idempotencyKey", "leaseId", "leaseGeneration", "brokerEpoch", "brokerChallenge", "action"];

    public byte[] Handle(PipeRole role, byte[] frame)
    {
        try
        {
            Dictionary<string, object> request = StrictJson.Parse(frame, 3);
            if (request.GetValueOrDefault("v") is not long version || version != Version || request.GetValueOrDefault("verb") is not string verb) return Error(AuthorityCodes.RequestInvalid);
            return (role, verb) switch
            {
                (PipeRole.Submit, "submit") => Submit(request),
                (PipeRole.Submit, "status") => Status(request),
                (PipeRole.Approver, "list") => List(request),
                (PipeRole.Approver, "decide") => Decide(request),
                (PipeRole.Approver, "policy") => Policy(request),
                (PipeRole.Approver, "policy_set") => PolicySet(request),
                (PipeRole.Approver, "keys") => Keys(request),
                (PipeRole.Approver, "key_challenge") => KeyChallenge(request),
                (PipeRole.Approver, "key_add") => KeyAdd(request),
                (PipeRole.Approver, "key_remove") => KeyRemove(request),
                _ => Error(AuthorityCodes.RequestInvalid),
            };
        }
        catch (StrictJsonException) { return Error(AuthorityCodes.RequestInvalid); }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Console.WriteLine("AUTHORITY=handler_failed"); // fixed word: the exception text could carry request content
            return Error(AuthorityCodes.AuthorityUnavailable);
        }
    }

    private byte[] Submit(Dictionary<string, object> r)
    {
        if (!HasKeys(r, SubmitKeys, optional: ["expectedDigest", "attestation"])) return Error(AuthorityCodes.RequestInvalid);
        if (r["purpose"] is not string purpose || r["operationId"] is not string operationId || r["idempotencyKey"] is not string idempotencyKey ||
            r["leaseId"] is not string leaseId || r["leaseGeneration"] is not long generation || r["brokerEpoch"] is not long epoch ||
            r["brokerChallenge"] is not string challenge || r["action"] is not IReadOnlyDictionary<string, object> action ||
            (r.TryGetValue("expectedDigest", out object? supplied) && supplied is not string)) return Error(AuthorityCodes.RequestInvalid);
        ValidatedAction dto;
        try { dto = ActionDigest.Validate(purpose, action); }
        catch (ActionDigestException) { return Error(AuthorityCodes.RequestInvalid); }
        // `attestation` is optional and never makes the request invalid by itself: whatever it holds is checked by the core, and anything wrong with it means "ask a person".
        Outcome outcome = core.Submit(new PendingRequest(purpose, operationId, idempotencyKey, leaseId, generation, epoch, challenge, dto), supplied as string, r.GetValueOrDefault("attestation"));
        if (outcome.Code is not null) return Error(outcome.Code);
        return Write(w =>
        {
            w.WriteBoolean("ok", true);
            w.WriteString("approvalId", outcome.Entry!.ApprovalId);
            w.WriteString("state", outcome.Entry.State == EntryState.Approved ? "approved" : "pending");
            w.WriteNumber("expiresAt", outcome.Entry.ExpiresAt);
        });
    }

    private byte[] Status(Dictionary<string, object> r)
    {
        if (!HasKeys(r, ["v", "verb", "approvalId"]) || r["approvalId"] is not string approvalId) return Error(AuthorityCodes.RequestInvalid);
        Outcome outcome = core.Status(approvalId);
        if (outcome.Code is not null) return Error(outcome.Code);
        PendingEntry entry = outcome.Entry!;
        byte[] reply = Write(w =>
        {
            w.WriteBoolean("ok", true);
            w.WriteString("state", entry.State == EntryState.Approved ? "approved" : "pending");
            if (entry.State == EntryState.Approved)
            {
                w.WriteString("receipt", Convert.ToBase64String(entry.Receipt!));
                w.WriteString("signature", Convert.ToBase64String(entry.Signature!));
            }
            else w.WriteNumber("expiresAt", entry.ExpiresAt);
        });
        return reply.Length <= MaxFrameBytes ? reply : Error(AuthorityCodes.AuthorityUnavailable);
    }

    // Oldest first, as many entries as fit one frame. `more` says there are further entries; ask again with afterSeq = lastSeq.
    private byte[] List(Dictionary<string, object> r)
    {
        if (!HasKeys(r, ["v", "verb"], optional: ["afterSeq"]) || (r.TryGetValue("afterSeq", out object? after) && after is not long)) return Error(AuthorityCodes.RequestInvalid);
        long afterSeq = after as long? ?? 0;
        if (afterSeq < 0) return Error(AuthorityCodes.RequestInvalid);
        List<byte[]> fitted = [];
        int used = 0;
        IReadOnlyList<PendingEntry> pending = core.List(afterSeq);
        long lastSeq = afterSeq;
        foreach (PendingEntry entry in pending)
        {
            byte[] item = ListEntry(entry);
            if (used + item.Length + 1 > ReplyBudgetBytes - 96) break;
            fitted.Add(item);
            used += item.Length + 1;
            lastSeq = entry.Seq;
        }
        StringBuilder text = new("{\"ok\":true,\"pending\":[");
        text.Append(string.Join(',', fitted.Select(item => Encoding.UTF8.GetString(item))));
        text.Append("],\"more\":").Append(fitted.Count < pending.Count ? "true" : "false").Append(",\"lastSeq\":").Append(lastSeq).Append('}');
        return Encoding.UTF8.GetBytes(text.ToString());
    }

    private byte[] Decide(Dictionary<string, object> r)
    {
        if (r.GetValueOrDefault("decision") is not string decisionText || r.GetValueOrDefault("approvalId") is not string approvalId) return Error(AuthorityCodes.RequestInvalid);
        bool approve = decisionText == "approve";
        if (!HasKeys(r, approve ? ["v", "verb", "approvalId", "decision", "presence"] : ["v", "verb", "approvalId", "decision"])) return Error(AuthorityCodes.RequestInvalid);
        Decision decision;
        byte[]? proof = null;
        switch (decisionText)
        {
            case "approve":
                if (!TryReadProof(r["presence"], out proof)) return Error(AuthorityCodes.RequestInvalid);
                decision = Decision.Approve;
                break;
            case "deny": decision = Decision.Deny; break;
            case "presence_unavailable": decision = Decision.PresenceUnavailable; break; // the approver's UI could not get a Hello proof
            default: return Error(AuthorityCodes.RequestInvalid);
        }
        Outcome outcome = core.Decide(approvalId, decision, proof);
        if (outcome.Code is not null) return Error(outcome.Code);
        return Write(w => { w.WriteBoolean("ok", true); w.WriteString("state", decision == Decision.Deny ? "denied" : "approved"); });
    }

    // The tier policy in force: { "ok": true, "policy": { v, rev, tier, overrides }, "policyVersion": "sha256:...", "kid": ..., "audience": ... }. Read only; kid and audience are what a policy signature is bound to. A faulted store (PolicyStore) says authority_unavailable.
    private byte[] Policy(Dictionary<string, object> r)
    {
        if (!HasKeys(r, ["v", "verb"])) return Error(AuthorityCodes.RequestInvalid);
        if (core.Policy() is not { } policy) return Error(AuthorityCodes.AuthorityUnavailable);
        return Write(w =>
        {
            w.WriteBoolean("ok", true);
            w.WritePropertyName("policy");
            w.WriteRawValue(policy.ToJson());
            w.WriteString("policyVersion", policy.Hash());
            w.WriteString("kid", core.Identity.Kid);
            w.WriteString("audience", core.Identity.Audience);
        });
    }

    // Replace the policy with the COMPLETE new one: { v, verb: "policy_set", policy: { v, rev, tier, overrides }, presence?: <base64 signature> }. presence is the approver's signature over
    // PolicyChange.Message(policy, kid, audience) (albera.policy.v1 + this Authority's kid and audience + the hash of this policy); it is required exactly when the change lets an action skip a person (the core decides, by effect).
    // Replies { "ok": true, "policyVersion": "sha256:..." } or an error code (a wrong revision, a malformed policy: request_invalid; no / wrong signature: presence_mismatch).
    private byte[] PolicySet(Dictionary<string, object> r)
    {
        if (!HasKeys(r, ["v", "verb", "policy"], optional: ["presence"]) || r["policy"] is not IReadOnlyDictionary<string, object> values || TierPolicy.TryFromValues(values) is not { } next) return Error(AuthorityCodes.RequestInvalid);
        byte[]? proof = null;
        if (r.TryGetValue("presence", out object? presenceValue) && !TryReadProof(presenceValue, out proof)) return Error(AuthorityCodes.RequestInvalid);
        Outcome outcome = core.SetPolicy(next, proof);
        if (outcome.Code is not null) return Error(outcome.Code);
        return Write(w => { w.WriteBoolean("ok", true); w.WriteString("policyVersion", next.Hash()); });
    }

    // keys -> { ok, keys: [{keyId, kind, credentialId?}] }: the registered approver keys' public data (credentialId for a webauthn key only), what the approver needs for allowCredentials. Nothing else about a key.
    private byte[] Keys(Dictionary<string, object> r) => !HasKeys(r, ["v", "verb"]) ? Error(AuthorityCodes.RequestInvalid) : KeysReply(core.ApproverKeys());

    // The reply of keys, key_add and key_remove. The list is capped (ApproverKeyRules.MaxMetadataBytes) so that this always fits a frame.
    private static byte[] KeysReply(IReadOnlyList<ApproverKey> keys) => Write(w =>
    {
        w.WriteBoolean("ok", true);
        w.WritePropertyName("keys");
        w.WriteRawValue(ApproverKeyRules.MetadataJson(keys));
    });

    // key_challenge { op: "add" | "remove", keyId } -> { ok, challenge, expiresAt }: a fresh single-use challenge (128 random bits, 120 s) for adding or removing that key. A new one replaces the one before.
    private byte[] KeyChallenge(Dictionary<string, object> r)
    {
        if (!HasKeys(r, ["v", "verb", "op", "keyId"]) || r["op"] is not string opText || r["keyId"] is not string keyId || KeyOpOf(opText) is not { } op) return Error(AuthorityCodes.RequestInvalid);
        KeyOutcome outcome = core.KeyChallenge(op, keyId);
        if (outcome.Code is not null) return Error(outcome.Code);
        return Write(w => { w.WriteBoolean("ok", true); w.WriteString("challenge", outcome.Challenge); w.WriteNumber("expiresAt", outcome.ExpiresAt); });
    }

    // key_add { key: <record>, challenge, by: <proof by a registered key>, newKey: <proof by the new key> }, both proofs over KeyMessages.Add(key, challenge) -> keys.
    private byte[] KeyAdd(Dictionary<string, object> r)
    {
        if (!HasKeys(r, ["v", "verb", "key", "challenge", "by", "newKey"]) || r["challenge"] is not string challenge || challenge.Length > MaxChallengeText ||
            r["key"] is not IReadOnlyDictionary<string, object> keyFields || ApproverKeyRules.TryRead(keyFields) is not { } candidate ||
            !TryReadProof(r["by"], out byte[] by) || !TryReadProof(r["newKey"], out byte[] newKey)) return Error(AuthorityCodes.RequestInvalid);
        KeyOutcome outcome = core.KeyAdd(candidate, challenge, by, newKey);
        return outcome.Code is not null ? Error(outcome.Code) : KeysReply(outcome.Keys!);
    }

    // key_remove { keyId, challenge, by: <proof by any registered key> } over KeyMessages.Remove(key, challenge) -> keys. The last key is never removed.
    private byte[] KeyRemove(Dictionary<string, object> r)
    {
        if (!HasKeys(r, ["v", "verb", "keyId", "challenge", "by"]) || r["keyId"] is not string keyId || r["challenge"] is not string challenge || challenge.Length > MaxChallengeText ||
            !TryReadProof(r["by"], out byte[] by)) return Error(AuthorityCodes.RequestInvalid);
        KeyOutcome outcome = core.KeyRemove(keyId, challenge, by);
        return outcome.Code is not null ? Error(outcome.Code) : KeysReply(outcome.Keys!);
    }

    private static KeyOp? KeyOpOf(string text) => text switch { "add" => KeyOp.Add, "remove" => KeyOp.Remove, _ => null };

    /// <summary>One list entry: everything a human needs to see the exact action, plus what must be signed. Also used to size-check a submit.</summary>
    internal static byte[] ListEntry(PendingEntry entry) => Write(w =>
    {
        w.WriteNumber("seq", entry.Seq);
        w.WriteString("approvalId", entry.ApprovalId);
        w.WriteString("purpose", entry.Request.Purpose);
        w.WriteString("operationId", entry.Request.OperationId);
        w.WriteString("actionDigest", entry.ActionDigest);
        w.WriteString("challenge", entry.Challenge);
        w.WriteNumber("expiresAt", entry.ExpiresAt);
        w.WriteStartObject("action");
        w.WriteString("action", entry.Request.Dto.Action);
        w.WriteString("projectId", entry.Request.Dto.ProjectId);
        w.WriteString("computerId", entry.Request.Dto.ComputerId);
        w.WriteStartObject("args");
        foreach ((string name, object value) in entry.Request.Dto.Args.OrderBy(a => a.Key, StringComparer.Ordinal))
        {
            switch (value)
            {
                case string s: w.WriteString(name, s); break;
                case long n: w.WriteNumber(name, n); break;
                case bool b: w.WriteBoolean(name, b); break;
            }
        }
        w.WriteEndObject();
        w.WriteEndObject();
    });

    internal static byte[] Error(string code) => Write(w => { w.WriteBoolean("ok", false); w.WriteString("code", code); });

    private static byte[] Write(Action<Utf8JsonWriter> body)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            body(writer);
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }

    // Exactly the required keys plus any of the optional ones (and no other key).
    private static bool HasKeys(Dictionary<string, object> request, IReadOnlyCollection<string> required, IReadOnlyCollection<string>? optional = null) =>
        required.All(request.ContainsKey) && request.Count == required.Count + (optional?.Count(request.ContainsKey) ?? 0);

    // A presence proof is the RSA form (a base64 string: the raw signature, as ever) or a webauthn object (WebAuthnWire). Anything else is a shape error.
    private static bool TryReadProof(object value, out byte[] proof)
    {
        proof = [];
        if (value is IReadOnlyDictionary<string, object> assertion) return WebAuthnWire.TryRead(assertion, out proof);
        return value is string text && text.Length <= 512 && TryFromBase64(text, out proof);
    }

    private static bool TryFromBase64(string text, out byte[] bytes)
    {
        bytes = new byte[(text.Length * 3 / 4) + 3];
        if (!Convert.TryFromBase64String(text, bytes, out int written)) return false;
        bytes = bytes[..written];
        return true;
    }
}
