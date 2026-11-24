using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal enum Decision { Approve, Deny, PresenceUnavailable }

/// <summary>Code null = success; Entry is the entry as it is now (null only for an unknown approvalId).</summary>
internal readonly record struct Outcome(string? Code, PendingEntry? Entry);

// The Authority's decisions, independent of any transport. The Control Plane side (Submit, Status) can only create a request and read an outcome. A receipt comes
// from exactly two places:
//   - Decide, when a human presence proof verifies over the Authority's own message (basis presence, receipt v2), and
//   - Submit, when the tier policy in force (PolicyStore, set only through SetPolicy from the approver pipe) says THIS action needs no person (basis policy, receipt v3).
// Whether a person is needed is decided from the action the Authority validated and hashed itself and from its own policy. Nothing in a submit request (it has no field for
// it, and an unknown field is request_invalid) names, lowers or chooses a tier. With no policy file the policy is careful: every action needs a person.
// The attested exceptions (issue #115 steps 3b and 4): at the standard tier environment.start and task.start need no person when the submit carries a Broker attestation of the kind that
// action needs, which (1) verifies against the key pinned in the Authority's own config, (2) says what the kind must say, (3) is bound to exactly the computerId, projectId, leaseId and
// leaseGeneration of THIS submit and to the VM and generation the action names (the `vmId` and `expectedGeneration` args: shown to the human, covered by the digest, filled in by the Control
// Plane from its own inspect), and (4) has not expired, the clock being read after the signature check. The kinds are separate (own domain, own body keys), so neither is ever read as the other:
//   environment.start  a NETWORK attestation (NetworkAttestation.cs) that says network "none";
//   task.start         a TASK-START attestation (TaskStartAttestation.cs) that says network "none" AND a Production checkpoint was taken, and is also bound to this submit's operationId and
//                      to the action digest this Authority computed itself, so one statement backs exactly one action (not a second task under the same operationId, issue #133).
// An action without a well-formed `vmId` arg is never attested. The Broker refuses to act on a VM whose own Hyper-V id differs from that arg, so an attestation for VM A cannot
// start VM B. environment.create is not attested at all (no VM exists to observe before it): it always needs a person.
// The receipt is v3 basis policy with the attestation's digest, and ends no later than the attestation does. Anything else (no key pinned, no attestation, a forged, stale, mismatched or
// "present" / "unknown" one, or a valid one whose receipt could not be signed because the signer is down) is not an error: the request queues for a person exactly as without it. An override on the action forces a prompt as ever, and nothing in the attestation
// names or lowers a tier.
// The Authority keeps no persistent log. Every receipt signed without a person and every policy change is reported to `audit` as one line made of fixed words, a fixed action name
// and ids (the service prints it to its console like the PEER lines); the entry itself stays readable through status until its receipt is over.
internal sealed class AuthorityCore(PendingStore store, IReceiptSigner signer, IHumanPresenceVerifier presence, AuthorityIdentity identity, Func<long> clock, PolicyStore? policyStore = null, Action<string>? audit = null, PinnedAttestationKey? attestationKey = null)
{
    private readonly PolicyStore policy = policyStore ?? PolicyStore.InMemory();

    /// <summary>A receipt for an attested action never outlives the attestation, and is not worth signing when less than this is left of it (the Control Plane could not claim it in time).</summary>
    public const long MinAttestedReceiptSeconds = 10;

    /// <summary>A list entry (see Protocol) must fit a 2 KiB frame together with the reply envelope; checked when the request is accepted.</summary>
    public const int MaxListEntryBytes = 1700;

    /// <param name="expectedDigest">Optional cross-check from the Control Plane. It is never used as the digest: only compared with the Authority's own.</param>
    /// <param name="attestation">Optional Broker attestation envelope as the strict reader parsed it (unchecked; the kind the action needs, see the header). Only ever used to skip a person at the standard tier.</param>
    public Outcome Submit(PendingRequest request, string? expectedDigest, object? attestation = null)
    {
        string digest;
        try { digest = ActionDigest.Compute(request.Purpose, ReceiptBuilder.DtoOf(request.Dto)); }
        catch (ActionDigestException) { return new(AuthorityCodes.RequestInvalid, null); }
        if (expectedDigest is not null && !string.Equals(expectedDigest, digest, StringComparison.Ordinal)) return new(AuthorityCodes.RequestInvalid, null);

        // The contract must accept the receipt this request would become, and the human must be shown it in one frame.
        PendingEntry probe = new(long.MaxValue, Ids.NewUuid(), request, digest, Ids.NewBits128(), 0, 0, 0, EntryState.Pending);
        long now = clock();
        byte[] sample = ReceiptBuilder.Build(probe, identity, signer.Issuer, Ids.NewUuid(), Ids.NewBits128(), now);
        if (!ReceiptBuilder.Check(sample, request, identity, signer.Issuer, now).Ok) return new(AuthorityCodes.RequestInvalid, null);
        if (AuthorityProtocol.ListEntry(probe).Length > MaxListEntryBytes) return new(AuthorityCodes.RequestInvalid, null);

        // The policy cannot change between the decision and the signature: both happen under its lock.
        SubmitResult result = policy.With(current =>
        {
            if (!current.NeedsPerson(request.Dto.Action)) return store.Submit(request, digest, (entry, now) => SignByPolicy(entry, current.Hash(), now));
            if (current.CanSkipWithAttestation(request.Dto.Action) && ProvenBy(request, attestation, digest) is { } proven)
                return store.Submit(request, digest, (entry, now) => proven.ExpiresAt - now >= MinAttestedReceiptSeconds ? SignAttested(entry, current.Hash(), now, proven) : entry);
            return store.Submit(request, digest);
        });
        return result.Status switch
        {
            SubmitStatus.Created or SubmitStatus.Reused => new(null, result.Entry),
            SubmitStatus.QueueFull => new(AuthorityCodes.QueueFull, null),
            SubmitStatus.Failed => new(AuthorityCodes.AuthorityUnavailable, null),
            _ => new(AuthorityCodes.RequestInvalid, null),
        };
    }

    private sealed record Proven(string Digest, long ExpiresAt);

    /// <summary>The digest and expiry of the attestation when it proves what this action needs for exactly this request; otherwise null (and a fixed-word audit line saying why, unless none was sent).</summary>
    private Proven? ProvenBy(PendingRequest request, object? attestation, string actionDigest)
    {
        if (attestation is null) return null;
        if (request.Dto.Args.ContainsKey("isolation")) return Refused("isolation_needs_a_person"); // ADR-012, decision 4: a wsl2 task.start asks a person at every tier
        if (attestationKey is null) return Refused("no_key_pinned");
        if (request.Dto.Args.GetValueOrDefault("expectedGeneration") is not long generation || generation < 1) return Refused("generation_missing");
        if (request.Dto.Args.GetValueOrDefault("vmId") is not string vmId || !NetworkAttestation.IsVmId(vmId)) return Refused("vm_id_missing");
        return request.Dto.Action == TaskStartAction ? ProvenTaskStart(request, attestation, vmId, generation, actionDigest) : ProvenNone(request, attestation, vmId, generation);
    }

    private const string TaskStartAction = "task.start";

    private Proven? ProvenNone(PendingRequest request, object attestation, string vmId, long generation)
    {
        AttestationExpected expected = new(request.Dto.ComputerId, vmId, generation, request.Dto.ProjectId, request.LeaseId, request.LeaseGeneration);
        AttestationVerdict verdict = NetworkAttestation.Verify(attestation, clock, attestationKey!.Verify, expected);
        if (!verdict.Ok) return Refused(verdict.Field is null ? verdict.Code! : $"{verdict.Code}:{verdict.Field}");
        if (verdict.Value!.Network != NetworkAttestation.None) return Refused($"network_{verdict.Value.Network}");
        return new Proven(verdict.Digest!, verdict.Value.ExpiresAt);
    }

    private Proven? ProvenTaskStart(PendingRequest request, object attestation, string vmId, long generation, string actionDigest)
    {
        // actionDigest is the one this Authority computed itself from the DTO it would sign (Submit): one statement backs exactly one action (issue #133).
        TaskStartExpected expected = new(request.Dto.ComputerId, vmId, generation, request.Dto.ProjectId, request.LeaseId, request.LeaseGeneration, request.OperationId, actionDigest);
        TaskStartVerdict verdict = TaskStartAttestation.Verify(attestation, clock, attestationKey!.Verify, expected);
        if (!verdict.Ok) return Refused(verdict.Field is null ? verdict.Code! : $"{verdict.Code}:{verdict.Field}");
        if (verdict.Value!.Network != TaskStartAttestation.None) return Refused($"network_{verdict.Value.Network}");
        if (!TaskStartAttestation.ProvesCheckpointedNoNetwork(verdict.Value)) return Refused($"checkpoint_{verdict.Value.CheckpointType}");
        return new Proven(verdict.Digest!, verdict.Value.ExpiresAt);
    }

    private Proven? Refused(string reason)
    {
        audit?.Invoke($"ATTESTATION_REFUSED={reason}"); // fixed words only; the statement itself is never echoed
        return null;
    }

    /// <summary>The policy in force, or null when the store is faulted (see PolicyStore).</summary>
    public TierPolicy? Policy() => policy.IsFaulted ? null : policy.Current;

    /// <summary>The Authority's own trusted values (kid, audience, ...): what a policy signature must be bound to.</summary>
    public AuthorityIdentity Identity => identity;

    /// <summary>Replace the policy. <paramref name="proof"/> is the approver's signature over PolicyChange.Message(next, kid, audience); it is only looked at when the change lets an action skip a person.</summary>
    public Outcome SetPolicy(TierPolicy next, byte[]? proof)
    {
        string? code = policy.Change(next, proof, VerifyPolicyChange);
        if (code is null) audit?.Invoke($"POLICY_CHANGED={next.Revision} {next.Tier} {next.Hash()}");
        return new(code, null);
    }

    private PresenceResult VerifyPolicyChange(TierPolicy next, byte[] proof)
    {
        try { return presence.Verify(PolicyChange.Message(next, identity.Kid, identity.Audience), proof); }
        catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or InvalidOperationException) { return PresenceResult.Unavailable; }
    }

    // The approver key list (approver-webauthn.md). The verifier that holds the registered keys (ApproverKeySet) also changes them; the single pinned key and the test fake do not, so a
    // build or a test with one of those has no key verbs (request_invalid) and an empty key list.
    /// <summary>The registered keys' public data, for `keys`.</summary>
    public IReadOnlyList<ApproverKey> ApproverKeys() => presence is ApproverKeySet keys ? keys.Keys : [];

    /// <summary>A challenge for removing <paramref name="keyId"/>. There is no verb that adds a key: only the elevated installer does.</summary>
    public KeyOutcome KeyChallenge(string keyId) => presence is ApproverKeySet keys ? keys.IssueChallenge(keyId) : new(AuthorityCodes.RequestInvalid);

    /// <param name="by">a proof by any registered key over KeyMessages.Remove(keyId, challenge)</param>
    // A removal that takes away the only key able to vouch for the policy in force resets that policy to careful FIRST (PolicyStore.ResetIfSignerGone), then removes the key: a crash between the two writes leaves
    // a careful policy and the key still registered, which starts. The policy lock is taken before the key set's, the order PolicyStore.Change uses too.
    public KeyOutcome KeyRemove(string keyId, string challenge, byte[] by)
    {
        if (presence is not ApproverKeySet keys) return new(AuthorityCodes.RequestInvalid);
        TierPolicy? reset = null;
        KeyOutcome outcome = policy.With(_ => keys.Remove(keyId, challenge, by, remaining =>
        {
            (string? code, reset) = policy.ResetIfSignerGone(remaining);
            return code;
        }));
        if (reset is not null) audit?.Invoke($"POLICY_CHANGED={reset.Revision} {reset.Tier} {reset.Hash()}");
        if (outcome.Code is null) audit?.Invoke($"APPROVER_KEY_REMOVED={keyId}");
        return outcome with { PolicyReset = outcome.Code is null && reset is not null };
    }

    public Outcome Status(string approvalId)
    {
        PendingEntry? entry = store.Get(approvalId);
        return entry is null ? new(AuthorityCodes.RequestInvalid, null) : new(CodeFor(entry.State), entry);
    }

    public IReadOnlyList<PendingEntry> List(long afterSeq) => store.ListPending(afterSeq);

    /// <param name="proof">the approver's signature over PresenceMessage; required for Approve, ignored otherwise</param>
    public Outcome Decide(string approvalId, Decision decision, byte[]? proof)
    {
        (string? code, PendingEntry? entry) = store.Decide(approvalId, (current, now) => decision switch
        {
            Decision.Deny => (Finish(current, EntryState.Denied, now), null),
            Decision.PresenceUnavailable => (Finish(current, EntryState.PresenceUnavailable, now), AuthorityCodes.PresenceUnavailable),
            _ => Approve(current, now, proof ?? []),
        });
        return new(code, entry);
    }

    private (PendingEntry Next, string? Code) Approve(PendingEntry entry, long now, byte[] proof)
    {
        PresenceResult presenceResult;
        string? signerKeyId = null;
        try { presenceResult = presence.Verify(PresenceMessage.Build(entry.ApprovalId, entry.ActionDigest, entry.Challenge), proof, out signerKeyId); }
        catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or InvalidOperationException) { presenceResult = PresenceResult.Unavailable; }
        if (presenceResult == PresenceResult.Unavailable) return (Finish(entry, EntryState.PresenceUnavailable, now), AuthorityCodes.PresenceUnavailable);
        if (presenceResult != PresenceResult.Verified) return (Finish(entry, EntryState.PresenceMismatch, now), AuthorityCodes.PresenceMismatch);

        // The receipt names the key that signed. A verifier that has no key ids (the single pinned key) leaves the approverKeyId the config names.
        AuthorityIdentity signedBy = signerKeyId is null ? identity : identity with { ApproverKeyId = signerKeyId };
        byte[] receipt = ReceiptBuilder.Build(entry, signedBy, signer.Issuer, Ids.NewUuid(), Ids.NewBits128(), now);
        if (!ReceiptBuilder.Check(receipt, entry.Request, identity, signer.Issuer, now).Ok) return (Finish(entry, EntryState.Failed, now), AuthorityCodes.AuthorityUnavailable);
        byte[] signature;
        try { signature = signer.Sign(receipt); }
        catch (SignerUnavailableException) { return (Finish(entry, EntryState.Failed, now), AuthorityCodes.AuthorityUnavailable); }
        // ExpiresAt of an approved entry is the receipt's exp: the entry is only reused (and its receipt only worth fetching) until then.
        return (entry with { State = EntryState.Approved, Receipt = receipt, Signature = signature, ExpiresAt = now + ReceiptV2.DefaultTtlSeconds, RetainUntil = now + PendingStore.DecidedRetentionSeconds }, null);
    }

    private static PendingEntry Finish(PendingEntry entry, EntryState state, long now) => entry with { State = state, RetainUntil = now + PendingStore.DecidedRetentionSeconds };

    // The second signing site: only reached from Submit, only for an action the policy in force lets through without a person. The receipt is v3 with basis policy and the
    // policy's hash; the contract's validator (which also caps what a policy may skip) must accept it before it is signed. null = could not be signed (authority_unavailable).
    private PendingEntry? SignByPolicy(PendingEntry entry, string policyHash, long now, Proven? proven = null)
    {
        long ttl = proven is null ? ReceiptV2.DefaultTtlSeconds : Math.Min(ReceiptV2.DefaultTtlSeconds, proven.ExpiresAt - now); // never outlives the evidence it rests on
        byte[] receipt = ReceiptBuilder.BuildPolicy(entry, identity, signer.Issuer, Ids.NewUuid(), Ids.NewBits128(), now, policyHash, proven?.Digest, ttl);
        if (!ReceiptBuilder.Check(receipt, entry.Request, identity, signer.Issuer, now).Ok) return null;
        byte[] signature;
        try { signature = signer.Sign(receipt); }
        catch (SignerUnavailableException) { return null; }
        audit?.Invoke($"POLICY_SIGNED={entry.Request.Dto.Action} {entry.ApprovalId}" + (proven is null ? "" : $" ATTESTED={proven.Digest}"));
        return entry with { State = EntryState.Approved, Receipt = receipt, Signature = signature, ExpiresAt = now + ttl, RetainUntil = now + PendingStore.DecidedRetentionSeconds };
    }

    // An attested request that could not be signed (the contract refused the receipt, or the signer is down) is not an Authority failure: every refusal of the attested shortcut queues for a
    // person, as with a bad attestation. The entry stays Pending, no receipt exists, and the reason goes to the audit line in fixed words.
    private PendingEntry SignAttested(PendingEntry entry, string policyHash, long now, Proven proven)
    {
        PendingEntry? signed = SignByPolicy(entry, policyHash, now, proven);
        if (signed is not null) return signed;
        audit?.Invoke("ATTESTATION_REFUSED=sign_failed");
        return entry;
    }

    private static string? CodeFor(EntryState state) => state switch
    {
        EntryState.Pending or EntryState.Approved => null,
        EntryState.Denied => AuthorityCodes.HumanDenied,
        EntryState.PresenceMismatch => AuthorityCodes.PresenceMismatch,
        EntryState.PresenceUnavailable => AuthorityCodes.PresenceUnavailable,
        EntryState.Expired => AuthorityCodes.RequestExpired,
        _ => AuthorityCodes.AuthorityUnavailable,
    };
}
