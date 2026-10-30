using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal enum Decision { Approve, Deny, PresenceUnavailable }

/// <summary>Code null = success; Entry is the entry as it is now (null only for an unknown approvalId).</summary>
internal readonly record struct Outcome(string? Code, PendingEntry? Entry);

// The Authority's decisions, independent of any transport. The Control Plane side (Submit, Status) can only create a pending request and read
// an outcome; only Decide can turn a request into a receipt, and it does so only when a human presence proof verifies over the Authority's own message.
internal sealed class AuthorityCore(PendingStore store, IReceiptSigner signer, IHumanPresenceVerifier presence, AuthorityIdentity identity, Func<long> clock)
{
    /// <summary>A list entry (see Protocol) must fit a 2 KiB frame together with the reply envelope; checked when the request is accepted.</summary>
    public const int MaxListEntryBytes = 1700;

    /// <param name="expectedDigest">Optional cross-check from the Control Plane. It is never used as the digest: only compared with the Authority's own.</param>
    public Outcome Submit(PendingRequest request, string? expectedDigest)
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

        SubmitResult result = store.Submit(request, digest);
        return result.Status switch
        {
            SubmitStatus.Created or SubmitStatus.Reused => new(null, result.Entry),
            SubmitStatus.QueueFull => new(AuthorityCodes.QueueFull, null),
            _ => new(AuthorityCodes.RequestInvalid, null),
        };
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
