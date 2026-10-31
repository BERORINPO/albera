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
//   task.start         a TASK-START attestation (TaskStartAttestation.cs) that says network "none" AND a Production checkpoint was taken, and is also bound to this submit's operationId.
// An action without a well-formed `vmId` arg is never attested. The Broker refuses to act on a VM whose own Hyper-V id differs from that arg, so an attestation for VM A cannot
// start VM B. environment.create is not attested at all (no VM exists to observe before it): it always needs a person.
// The receipt is v3 basis policy with the attestation's digest, and ends no later than the attestation does. Anything else (no key pinned, no attestation, a forged, stale, mismatched or
// "present" / "unknown" one) is not an error: the request queues for a person exactly as without it. An override on the action forces a prompt as ever, and nothing in the attestation
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
            if (current.CanSkipWithAttestation(request.Dto.Action) && ProvenBy(request, attestation) is { } proven)
                return store.Submit(request, digest, (entry, now) => proven.ExpiresAt - now >= MinAttestedReceiptSeconds ? SignByPolicy(entry, current.Hash(), now, proven) : entry);
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
    private Proven? ProvenBy(PendingRequest request, object? attestation)
    {
        if (attestation is null) return null;
        if (attestationKey is null) return Refused("no_key_pinned");
        if (request.Dto.Args.GetValueOrDefault("expectedGeneration") is not long generation || generation < 1) return Refused("generation_missing");
        if (request.Dto.Args.GetValueOrDefault("vmId") is not string vmId || !NetworkAttestation.IsVmId(vmId)) return Refused("vm_id_missing");
        return request.Dto.Action == TaskStartAction ? ProvenTaskStart(request, attestation, vmId, generation) : ProvenNone(request, attestation, vmId, generation);
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

    private Proven? ProvenTaskStart(PendingRequest request, object attestation, string vmId, long generation)
    {
        TaskStartExpected expected = new(request.Dto.ComputerId, vmId, generation, request.Dto.ProjectId, request.LeaseId, request.LeaseGeneration, request.OperationId);
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
        try { presenceResult = presence.Verify(PresenceMessage.Build(entry.ApprovalId, entry.ActionDigest, entry.Challenge), proof); }
        catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or InvalidOperationException) { presenceResult = PresenceResult.Unavailable; }
        if (presenceResult == PresenceResult.Unavailable) return (Finish(entry, EntryState.PresenceUnavailable, now), AuthorityCodes.PresenceUnavailable);
        if (presenceResult != PresenceResult.Verified) return (Finish(entry, EntryState.PresenceMismatch, now), AuthorityCodes.PresenceMismatch);

        byte[] receipt = ReceiptBuilder.Build(entry, identity, signer.Issuer, Ids.NewUuid(), Ids.NewBits128(), now);
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
