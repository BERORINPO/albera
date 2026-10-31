using System.Security.Cryptography;
using Albera.BrokerContract;

namespace Albera.ApprovalAuthority;

internal enum EntryState { Pending, Approved, Denied, PresenceMismatch, PresenceUnavailable, Failed, Expired }

/// <summary>What the Control Plane submitted, already validated. The action digest is NOT part of it: the Authority computes that itself.</summary>
internal sealed record PendingRequest(string Purpose, string OperationId, string IdempotencyKey, string LeaseId, long LeaseGeneration, long BrokerEpoch, string BrokerChallenge, ValidatedAction Dto);

internal sealed record PendingEntry(long Seq, string ApprovalId, PendingRequest Request, string ActionDigest, string Challenge, long CreatedAt, long ExpiresAt, long RetainUntil,
    EntryState State, byte[]? Receipt = null, byte[]? Signature = null);

internal enum SubmitStatus { Created, Reused, QueueFull, Conflict, Failed }

internal readonly record struct SubmitResult(SubmitStatus Status, PendingEntry? Entry);

// The Authority's only state: requests waiting for a human, plus the recent outcomes the Control Plane polls for. Memory only (a restart forgets every
// pending request, which is safe: the Control Plane resubmits and the human approves again). One lock; every operation first applies the clock:
//   - a Pending entry whose TTL has passed becomes Expired (still answered as request_expired for ExpiredVisibleSeconds),
//   - an entry past RetainUntil is dropped.
// Limits (ADR: "Pending store: max 32, TTL 120 s"): at most MaxPending requests waiting, at most MaxEntries entries in total (pending + remembered
// outcomes), otherwise Submit says QueueFull. A second Submit with the same operationId + idempotencyKey while the first is still pending or approved
// returns the first (Reused) instead of asking the human twice (an approved one only while its receipt is still valid; ExpiresAt of an approved
// entry is the receipt's `exp`); the same key with different content is a Conflict.
internal sealed class PendingStore
{
    public const int MaxPending = 32, MaxEntries = 64, DefaultTtlSeconds = 120, ExpiredVisibleSeconds = 60, DecidedRetentionSeconds = 120;

    private readonly object gate = new();
    private readonly Dictionary<string, PendingEntry> entries = new(StringComparer.Ordinal);
    private readonly Func<long> clock;
    private readonly int ttlSeconds;
    private long nextSeq = 1;

    public PendingStore(Func<long> clock, int ttlSeconds = DefaultTtlSeconds)
    {
        if (ttlSeconds < 1) throw new ArgumentOutOfRangeException(nameof(ttlSeconds));
        this.clock = clock;
        this.ttlSeconds = ttlSeconds;
    }

    public SubmitResult Submit(PendingRequest request, string actionDigest) => Submit(request, actionDigest, null);

    /// <summary>
    /// As <see cref="Submit(PendingRequest, string)"/>, but when a NEW entry has to be made <paramref name="decideNow"/> may turn it into its final state in the same step (the tier
    /// policy needs no person for it): it gets the new Pending entry and the time and returns the entry to store, or null when it cannot (nothing is stored then, Failed).
    /// The same dedupe and limits apply; a request that is already pending or approved is returned as it is.
    /// </summary>
    public SubmitResult Submit(PendingRequest request, string actionDigest, Func<PendingEntry, long, PendingEntry?>? decideNow)
    {
        lock (gate)
        {
            long now = Refresh();
            PendingEntry? same = entries.Values.FirstOrDefault(e => (e.State == EntryState.Pending || (e.State == EntryState.Approved && now < e.ExpiresAt)) &&
                e.Request.OperationId == request.OperationId && e.Request.IdempotencyKey == request.IdempotencyKey);
            if (same is not null) return IsSameRequest(same, request, actionDigest) ? new(SubmitStatus.Reused, same) : new(SubmitStatus.Conflict, null);
            if (entries.Values.Count(e => e.State == EntryState.Pending) >= MaxPending || entries.Count >= MaxEntries) return new(SubmitStatus.QueueFull, null);
            PendingEntry created = new(nextSeq++, Ids.NewUuid(), request, actionDigest, Ids.NewBits128(), now, now + ttlSeconds, now + ttlSeconds + ExpiredVisibleSeconds, EntryState.Pending);
            if (decideNow is not null)
            {
                PendingEntry? decided = decideNow(created, now);
                if (decided is null) return new(SubmitStatus.Failed, null);
                created = decided;
            }
            entries[created.ApprovalId] = created;
            return new(SubmitStatus.Created, created);
        }
    }

    public PendingEntry? Get(string approvalId)
    {
        lock (gate)
        {
            Refresh();
            return entries.GetValueOrDefault(approvalId);
        }
    }

    /// <summary>Entries still waiting for a human, oldest first, with Seq greater than <paramref name="afterSeq"/>.</summary>
    public IReadOnlyList<PendingEntry> ListPending(long afterSeq)
    {
        lock (gate)
        {
            Refresh();
            return entries.Values.Where(e => e.State == EntryState.Pending && e.Seq > afterSeq).OrderBy(e => e.Seq).ToList();
        }
    }

    /// <summary>
    /// Runs <paramref name="decide"/> on one entry under the lock (so two decisions can never both win) with the current time. It returns the entry to
    /// store and an error code (null = success). An unknown id is request_invalid. The decision only counts if the entry is still Pending.
    /// </summary>
    public (string? Code, PendingEntry? Entry) Decide(string approvalId, Func<PendingEntry, long, (PendingEntry Next, string? Code)> decide)
    {
        lock (gate)
        {
            long now = Refresh();
            if (!entries.TryGetValue(approvalId, out PendingEntry? current)) return (AuthorityCodes.RequestInvalid, null);
            if (current.State == EntryState.Expired) return (AuthorityCodes.RequestExpired, current);
            if (current.State != EntryState.Pending) return (AuthorityCodes.RequestInvalid, current);
            (PendingEntry next, string? code) = decide(current, now);
            entries[approvalId] = next;
            return (code, next);
        }
    }

    public int Count
    {
        get { lock (gate) { Refresh(); return entries.Count; } }
    }

    private static bool IsSameRequest(PendingEntry existing, PendingRequest request, string actionDigest) =>
        existing.ActionDigest == actionDigest && existing.Request.Purpose == request.Purpose && existing.Request.LeaseId == request.LeaseId &&
        existing.Request.LeaseGeneration == request.LeaseGeneration && existing.Request.BrokerEpoch == request.BrokerEpoch && existing.Request.BrokerChallenge == request.BrokerChallenge;

    private long Refresh()
    {
        long now = clock();
        foreach (PendingEntry entry in entries.Values.ToList())
        {
            if (now >= entry.RetainUntil) entries.Remove(entry.ApprovalId);
            else if (entry.State == EntryState.Pending && now >= entry.ExpiresAt) entries[entry.ApprovalId] = entry with { State = EntryState.Expired };
        }
        return now;
    }
}

internal static class Ids
{
    /// <summary>A lowercase version-4 UUID (the receipt grammar wants [1-8] version and [89ab] variant nibbles).</summary>
    public static string NewUuid() => Guid.NewGuid().ToString("D");

    /// <summary>128 random bits as unpadded base64url: 22 characters, the last one in A Q g w (canonical).</summary>
    public static string NewBits128() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
