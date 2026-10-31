using System.Text;
using System.Text.Json;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal enum PipeRole { Submit, Approver }

// The two wire protocols. Each direction of every pipe is one frame: a 4-byte little-endian length (1..2048) then UTF-8 JSON; one request, one reply,
// then the connection ends. Requests are read with the contract's strict JSON reader (objects, strings, booleans and safe integers only; no null,
// arrays, duplicate keys or extra keys at any level the verb does not name). The verb set depends on the pipe, not on the caller's claim:
//   submit pipe   (ACE: the Control Plane SID only)  submit | status
//   approver pipe (ACE: the approver SID only)       list | decide | policy | policy_set
// Any other verb on a pipe, any malformed or unknown-key request and any peer that is not the configured SID gets {"ok":false,"code":"request_invalid"}.
// Replies are {"ok":true,...} or {"ok":false,"code":<one of AuthorityCodes>}; nothing the caller sent is ever echoed. The exact shapes are in
// docs/architecture/approval-authority.md.
internal sealed class AuthorityProtocol(AuthorityCore core)
{
    public const int Version = 1, MaxFrameBytes = 2048, ReplyBudgetBytes = 1900;

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
        if (!HasKeys(r, SubmitKeys, optional: "expectedDigest")) return Error(AuthorityCodes.RequestInvalid);
        if (r["purpose"] is not string purpose || r["operationId"] is not string operationId || r["idempotencyKey"] is not string idempotencyKey ||
            r["leaseId"] is not string leaseId || r["leaseGeneration"] is not long generation || r["brokerEpoch"] is not long epoch ||
            r["brokerChallenge"] is not string challenge || r["action"] is not IReadOnlyDictionary<string, object> action ||
            (r.TryGetValue("expectedDigest", out object? supplied) && supplied is not string)) return Error(AuthorityCodes.RequestInvalid);
        ValidatedAction dto;
        try { dto = ActionDigest.Validate(purpose, action); }
        catch (ActionDigestException) { return Error(AuthorityCodes.RequestInvalid); }
        Outcome outcome = core.Submit(new PendingRequest(purpose, operationId, idempotencyKey, leaseId, generation, epoch, challenge, dto), supplied as string);
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
        if (!HasKeys(r, ["v", "verb"], optional: "afterSeq") || (r.TryGetValue("afterSeq", out object? after) && after is not long)) return Error(AuthorityCodes.RequestInvalid);
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
                if (r["presence"] is not string presenceText || presenceText.Length > 512 || !TryFromBase64(presenceText, out proof)) return Error(AuthorityCodes.RequestInvalid);
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
        if (!HasKeys(r, ["v", "verb", "policy"], optional: "presence") || r["policy"] is not IReadOnlyDictionary<string, object> values || TierPolicy.TryFromValues(values) is not { } next) return Error(AuthorityCodes.RequestInvalid);
        byte[]? proof = null;
        if (r.TryGetValue("presence", out object? presenceValue) && (presenceValue is not string presenceText || presenceText.Length > 512 || !TryFromBase64(presenceText, out proof))) return Error(AuthorityCodes.RequestInvalid);
        Outcome outcome = core.SetPolicy(next, proof);
        if (outcome.Code is not null) return Error(outcome.Code);
        return Write(w => { w.WriteBoolean("ok", true); w.WriteString("policyVersion", next.Hash()); });
    }

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

    // Exactly the required keys plus (at most) one optional key.
    private static bool HasKeys(Dictionary<string, object> request, IReadOnlyCollection<string> required, string? optional = null) =>
        required.All(request.ContainsKey) && request.Count == required.Count + (optional is not null && request.ContainsKey(optional) ? 1 : 0);

    private static bool TryFromBase64(string text, out byte[] bytes)
    {
        bytes = new byte[(text.Length * 3 / 4) + 3];
        if (!Convert.TryFromBase64String(text, bytes, out int written)) return false;
        bytes = bytes[..written];
        return true;
    }
}
