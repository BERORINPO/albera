// The owner's approval-tier policy (docs/architecture/approval-tiers.md, issue #115 step 3) and the message a policy change is signed over. BCL only, net10.0.
// Shared by the Approval Authority (loads, applies and stores it) and the approver app (builds a change and signs it): both must hash the same bytes.
//
//   file      { "v": 1, "rev": <integer >= 0>, "tier": "careful" | "standard", "overrides": { "<action>": "prompt", ... } }   exactly these keys, strict JSON
//   careful   every action needs a person (today's behaviour, and the default when there is no file)
//   standard  the actions in ReceiptV3.PolicyBasisActions need no person; environment.start and task.start (ReceiptV3.AttestedPolicyBasisActions; never create) need none ONLY when
//             the Authority holds a valid Broker attestation of the right kind: a network attestation that says "none" for start (step 3b), a task-start attestation (no network AND a
//             Production checkpoint) for task.start (step 4); everything else needs a person
//   overrides can only ADD prompts: the one allowed value is "prompt", and it names an action that must then be approved by a person at any tier
//   rev       counts policy changes (the default has rev 0). A change must carry rev + 1, so a signature for one change can never be applied twice or onto another policy
//   hash      "sha256:" + hex SHA-256 of  UTF8("albera.policy-hash.v3") 0x00 decimal(rev) 0x00 tier { 0x00 override-action }  with the overrides sorted, ordinal
//   change    UTF8("albera.policy.v1") 0x00 kid 0x00 audience 0x00 hash-of-the-complete-new-policy, signed by the approver's Windows Hello key. kid and audience are the
//             Authority's own trusted config values. Distinct from "albera.presence.v1" and "albera.selfcheck.v1", so no signature made for one purpose is valid for another.
//   The Authority's policy.json wraps a policy with the signature that authorized it (PolicyStore.cs); this file defines only the policy itself.
// Whether a change needs that signature is decided by its effect (TierPolicy.Loosens), never by the tier names. The effect counts every action a policy could skip a person for, with
// or without an attestation (SkippableActions). The hash domain is v3 since step 4 made "standard" mean more again (attested task.start; v2 was step 3b's attested start): a standard policy
// signed under v2 does not verify, so the larger set is never taken from an older signature.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Albera.BrokerContract;

public sealed class TierPolicy
{
    public const int FormatVersion = 1;
    public const string Careful = "careful", Standard = "standard", PromptWord = "prompt";
    public const string HashDomain = "albera.policy-hash.v3";
    public const int MaxFileBytes = 1024;

    public static IReadOnlyList<string> Tiers { get; } = [Careful, Standard];

    /// <summary>What applies when there is no policy file: careful, no overrides, revision 0.</summary>
    public static TierPolicy Default { get; } = new(0, Careful, []);

    public long Revision { get; }
    public string Tier { get; }

    /// <summary>The actions that always need a person, sorted (ordinal) and without duplicates.</summary>
    public IReadOnlyList<string> Prompts { get; }

    private TierPolicy(long revision, string tier, IReadOnlyList<string> prompts)
    {
        Revision = revision;
        Tier = tier;
        Prompts = prompts;
    }

    private static readonly string[] KnownActions = ActionDigest.Purposes.SelectMany(ActionDigest.ActionsFor).Distinct().ToArray();

    /// <summary>null unless the tier is known, the revision is a non-negative safe integer, and every prompt names a known action.</summary>
    public static TierPolicy? TryCreate(long revision, string tier, IEnumerable<string> prompts)
    {
        if (revision < 0 || revision > StrictJson.MaxSafeInteger || !Tiers.Contains(tier)) return null;
        string[] sorted = [.. prompts.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];
        return sorted.All(action => KnownActions.Contains(action)) ? new TierPolicy(revision, tier, sorted) : null;
    }

    /// <summary>Reads the file form. null (never an exception) for anything that is not exactly the documented shape: extra or missing keys, another version, a value other
    /// than "prompt", an unknown action or tier, duplicate keys, a BOM, null, arrays, more than <see cref="MaxFileBytes"/> bytes.</summary>
    public static TierPolicy? TryParse(ReadOnlySpan<byte> json)
    {
        if (json.Length == 0 || json.Length > MaxFileBytes) return null;
        try { return TryFromValues(StrictJson.Parse(json, 2)); }
        catch (StrictJsonException) { return null; }
    }

    /// <summary>The same rules for an object the strict reader has already parsed (the Authority reads the policy of a change request out of its frame).</summary>
    public static TierPolicy? TryFromValues(IReadOnlyDictionary<string, object> root)
    {
        string[] keys = ["v", "rev", "tier", "overrides"];
        if (root.Count != keys.Length || keys.Any(k => !root.ContainsKey(k))) return null;
        if (root["v"] is not long version || version != FormatVersion || root["rev"] is not long revision || root["tier"] is not string tier) return null;
        if (root["overrides"] is not IReadOnlyDictionary<string, object> overrides || overrides.Values.Any(v => v is not string word || word != PromptWord)) return null;
        return TryCreate(revision, tier, overrides.Keys);
    }

    /// <summary>The compact file form (keys in the documented order, overrides sorted). <see cref="TryParse"/> of it gives the same policy and the same hash.</summary>
    public byte[] ToJson()
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            WriteFields(writer);
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }

    /// <summary>Writes the four properties (v, rev, tier, overrides) into an object the caller has started, so a file can wrap a policy with more keys.</summary>
    public void WriteFields(Utf8JsonWriter writer)
    {
        writer.WriteNumber("v", FormatVersion);
        writer.WriteNumber("rev", Revision);
        writer.WriteString("tier", Tier);
        writer.WriteStartObject("overrides");
        foreach (string action in Prompts) writer.WriteString(action, PromptWord);
        writer.WriteEndObject();
    }

    /// <returns>"sha256:" + 64 lowercase hex characters; the receipt v3 `policyVersion`</returns>
    public string Hash()
    {
        StringBuilder preimage = new(HashDomain);
        preimage.Append('\0').Append(Revision.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append('\0').Append(Tier);
        foreach (string action in Prompts) preimage.Append('\0').Append(action);
        return "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(preimage.ToString())));
    }

    private IReadOnlySet<string> Skippable(IReadOnlyList<string> candidates) =>
        Tier == Standard ? candidates.Where(a => !Prompts.Contains(a)).ToHashSet(StringComparer.Ordinal) : new HashSet<string>(StringComparer.Ordinal);

    /// <summary>The actions this policy lets the Authority sign without a person and without anything else. Always a subset of <see cref="ReceiptV3.PolicyBasisActions"/>.</summary>
    public IReadOnlySet<string> NoPromptActions() => Skippable(ReceiptV3.PolicyBasisActions);

    /// <summary>The actions this policy lets the Authority sign without a person only when it holds a valid Broker attestation (network none; for task.start also a Production checkpoint). Always a subset of
    /// <see cref="ReceiptV3.AttestedPolicyBasisActions"/>.</summary>
    public IReadOnlySet<string> AttestedNoPromptActions() => Skippable(ReceiptV3.AttestedPolicyBasisActions);

    /// <summary>Every action this policy could ever sign without a person (with or without an attestation): the set a change is judged by.</summary>
    public IReadOnlySet<string> SkippableActions() => NoPromptActions().Union(AttestedNoPromptActions()).ToHashSet(StringComparer.Ordinal);

    /// <summary>True when a person is needed whatever the Authority holds: the action is not in <see cref="NoPromptActions"/>. An attested action is still true here; see <see cref="CanSkipWithAttestation"/>.</summary>
    public bool NeedsPerson(string action) => !NoPromptActions().Contains(action);

    /// <summary>True when a valid Broker attestation (of the kind the action needs) is enough to sign this action without a person.</summary>
    public bool CanSkipWithAttestation(string action) => AttestedNoPromptActions().Contains(action);

    /// <summary>True when switching from <paramref name="current"/> to this policy lets at least one action skip the person that could not before (with or without an attestation).
    /// This (never the tier names) is what makes a change need a presence signature.</summary>
    public bool Loosens(TierPolicy current) => !SkippableActions().IsSubsetOf(current.SkippableActions());
}

/// <summary>The bytes the approver's Hello key signs to loosen the policy, bound to ONE Authority by its signing key id and audience (its trusted config), so a signature made for
/// one Authority is no good on another that pins the same approver key.</summary>
public static class PolicyChange
{
    public const string Domain = "albera.policy.v1";

    public static byte[] Message(TierPolicy newPolicy, string kid, string audience) => Encoding.UTF8.GetBytes($"{Domain}\0{kid}\0{audience}\0{newPolicy.Hash()}");
}
