using System.Text.Json;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

/// <summary>The error codes the Control Plane (and the approver) can ever see. Nothing else is ever sent, and never attacker text.</summary>
internal static class AuthorityCodes
{
    public const string AuthorityUnavailable = "authority_unavailable", RequestInvalid = "request_invalid", RequestExpired = "request_expired",
        HumanDenied = "human_denied", PresenceUnavailable = "presence_unavailable", PresenceMismatch = "presence_mismatch", QueueFull = "queue_full";
}

/// <summary>The trusted values the Authority itself supplies (config), as opposed to the ones the Control Plane submitted.</summary>
internal sealed record AuthorityIdentity(string Kid, string Audience, string PolicyVersion, string ApproverKeyId);

// Builds the receipt bytes (v2 for a receipt a person approved, v3 with basis "policy" for one the tier policy signs without a person) in the order of the contract's field
// table and checks them with the contract's own validator. brokerEpoch, brokerChallenge,
// leaseGeneration, leaseId, operationId and idempotencyKey come from the submit request (the Broker is the one that validates them); audience,
// policyVersion, kid and approverKeyId from config; everything about the action (action, projectId, computerId, actionDigest) from the DTO the Authority
// resolved itself. Check() is run twice: when the request is accepted (so a request the contract would reject never reaches a human) and again right
// before signing.
internal static class ReceiptBuilder
{
    public static byte[] Build(PendingEntry entry, AuthorityIdentity identity, string issuer, string receiptId, string nonce, long iat) =>
        Write(ReceiptV2.Fields, Values(entry, identity, issuer, receiptId, nonce, iat, ReceiptV2.Version, identity.PolicyVersion));

    /// <summary>A v3 receipt with basis policy: no person signed this action, the Authority's tier policy (named by its hash) said none was needed. approverKeyId names the approver key that owns the policy.
    /// <paramref name="attestationDigest"/> is set exactly when the rule relied on a Broker network attestation (environment.start); <paramref name="ttlSeconds"/> then ends
    /// no later than that attestation does.</summary>
    public static byte[] BuildPolicy(PendingEntry entry, AuthorityIdentity identity, string issuer, string receiptId, string nonce, long iat, string policyHash,
        string? attestationDigest = null, long ttlSeconds = ReceiptV2.DefaultTtlSeconds)
    {
        Dictionary<string, object> values = Values(entry, identity, issuer, receiptId, nonce, iat, ReceiptV3.Version, policyHash, ttlSeconds);
        values["basis"] = ReceiptV3.BasisPolicy;
        if (attestationDigest is not null) values[ReceiptV3.AttestationDigestField] = attestationDigest;
        return Write(ReceiptV3.Fields, ReceiptV3.OptionalFields, values);
    }

    private static Dictionary<string, object> Values(PendingEntry entry, AuthorityIdentity identity, string issuer, string receiptId, string nonce, long iat, int version, string policyVersion,
        long ttlSeconds = ReceiptV2.DefaultTtlSeconds)
    {
        PendingRequest r = entry.Request;
        return new(StringComparer.Ordinal)
        {
            ["v"] = (long)version, ["kid"] = identity.Kid, ["issuer"] = issuer, ["audience"] = identity.Audience, ["purpose"] = r.Purpose,
            ["approvalId"] = entry.ApprovalId, ["receiptId"] = receiptId, ["nonce"] = nonce, ["operationId"] = r.OperationId, ["idempotencyKey"] = r.IdempotencyKey,
            ["action"] = r.Dto.Action, ["actionDigest"] = entry.ActionDigest, ["projectId"] = r.Dto.ProjectId, ["computerId"] = r.Dto.ComputerId, ["leaseId"] = r.LeaseId,
            ["leaseGeneration"] = r.LeaseGeneration, ["brokerEpoch"] = r.BrokerEpoch, ["brokerChallenge"] = r.BrokerChallenge, ["policyVersion"] = policyVersion,
            ["approverKeyId"] = identity.ApproverKeyId, ["iat"] = iat, ["exp"] = iat + ttlSeconds,
        };
    }

    private static byte[] Write(IReadOnlyList<FieldSpec> fields, Dictionary<string, object> values) => Write(fields, [], values);

    // The required fields in the contract's order, then the optional ones that are present.
    private static byte[] Write(IReadOnlyList<FieldSpec> fields, IReadOnlyList<FieldSpec> optional, Dictionary<string, object> values)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            foreach (FieldSpec field in fields.Concat(optional.Where(o => values.ContainsKey(o.Name))))
            {
                if (values[field.Name] is long number) writer.WriteNumber(field.Name, number);
                else writer.WriteString(field.Name, (string)values[field.Name]);
            }
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }

    /// <summary>The contract's full verdict for <paramref name="receipt"/> (either version) against what the Authority knows (the same checks the Broker will run).</summary>
    public static ReceiptVerdict Check(byte[] receipt, PendingRequest r, AuthorityIdentity identity, string issuer, long now)
    {
        Dictionary<string, object> expected = new(StringComparer.Ordinal)
        {
            ["audience"] = identity.Audience, ["purpose"] = r.Purpose, ["operationId"] = r.OperationId, ["idempotencyKey"] = r.IdempotencyKey, ["leaseId"] = r.LeaseId,
            ["leaseGeneration"] = r.LeaseGeneration, ["brokerEpoch"] = r.BrokerEpoch, ["brokerChallenge"] = r.BrokerChallenge, ["policyVersion"] = identity.PolicyVersion,
        };
        return Receipts.Validate(receipt, new ReceiptContext(() => now, issuer == ReceiptV2.Issuer ? "production" : "test", expected, DtoOf(r.Dto)));
    }

    public static Dictionary<string, object> DtoOf(ValidatedAction dto) =>
        new(StringComparer.Ordinal) { ["action"] = dto.Action, ["projectId"] = dto.ProjectId, ["computerId"] = dto.ComputerId, ["args"] = dto.Args };
}
