// The desktop lease the Broker holds for the room (ADR-002 "Amendment 2026-11-03", "Desktop lease (held by the Broker)"; Proposed / NOT VERIFIED). An `act` session on the desktop pipe
// (input, and capture) needs it; a `view` session does not. The rules, all of them here and nowhere else:
//   * A lease exists only because the Broker recorded a `task.start` claim (BrokerRequests.cs calls Grant right after the journal row is written, and not for a replay): desktopSessionId =
//     that claim's operationId, the computer comes from the claimed DTO, generation = the previous generation for that computer + 1 (1 for the first), expiry = the Broker's clock at the claim
//     + the lifetime (at most 60 minutes). Nothing a client sends can create one.
//   * One lease per computer. A newer claim for the same computer replaces it, and every act session that held the older one is closed (its token is cancelled).
//   * It lives in this object, in memory, and nowhere else: a Broker restart is a new process with a new, empty table, so input stops until a new task.start is approved (fail closed).
//     The generation counter is lost with it; that cannot revive anything, because an open must also name the operationId of the lease that is current.
//   * A computer that is not in the config gets no lease (the table is bounded by the config's computers).
// This file knows nothing of pipes or of Hyper-V. The generation here is the desktop lease's own; it is not the claim pipe's `leaseGeneration` fence value.
internal sealed class DesktopLeases
{
    /// <summary>The contract's upper bound: expiry = claim time + at most 60 minutes.</summary>
    internal const long MaxLifetimeSeconds = 60 * 60;

    internal static class Deny
    {
        public const string Unknown = "lease_unknown", Generation = "lease_generation", Expired = "lease_expired", Revoked = "lease_revoked";
    }

    private readonly IReadOnlyList<ComputerBinding> _computers;
    private readonly Func<long> _now;
    private readonly long _lifetimeSeconds;
    private readonly object _gate = new();
    private readonly Dictionary<string, Lease> _byComputer = new(StringComparer.Ordinal); // also keeps an expired lease: its generation is what the next one counts from

    /// <param name="now">The Broker's clock, Unix seconds.</param>
    /// <param name="lifetimeSeconds">1..MaxLifetimeSeconds. The shipped Broker always passes MaxLifetimeSeconds; only the test build can pass less (DesktopPipe.cs).</param>
    internal DesktopLeases(IReadOnlyList<ComputerBinding> computers, Func<long> now, long lifetimeSeconds = MaxLifetimeSeconds)
    {
        if (lifetimeSeconds is < 1 or > MaxLifetimeSeconds) throw new ArgumentOutOfRangeException(nameof(lifetimeSeconds));
        _computers = computers;
        _now = now;
        _lifetimeSeconds = lifetimeSeconds;
    }

    /// <summary>A task.start claim for `operationId` was just recorded for `computerId`. Returns the new generation, or null when the computer is not configured (no lease is made).</summary>
    internal long? Grant(string computerId, string operationId)
    {
        if (!_computers.Any(c => string.Equals(c.ComputerId, computerId, StringComparison.Ordinal))) return null;
        List<LeaseSession> closing;
        long generation;
        lock (_gate)
        {
            _byComputer.TryGetValue(computerId, out Lease? previous);
            generation = (previous?.Generation ?? 0) + 1;
            closing = previous?.Retire() ?? [];
            _byComputer[computerId] = new Lease(computerId, operationId, generation, _now() + _lifetimeSeconds);
        }
        foreach (LeaseSession session in closing) session.Close(); // outside the lock: cancelling runs the waiting readers' continuations
        return generation;
    }

    /// <summary>
    /// An act session's open: the session when `operationId` and `generation` name the current, unexpired lease of `computerId`; otherwise null with the reason word in `refusal`.
    /// The session's Token is cancelled when the lease is replaced or expires.
    /// </summary>
    internal LeaseSession? TryOpen(string computerId, string operationId, long generation, out string refusal)
    {
        refusal = "";
        lock (_gate)
        {
            if (!_byComputer.TryGetValue(computerId, out Lease? lease) || !string.Equals(lease.OperationId, operationId, StringComparison.Ordinal)) { refusal = Deny.Unknown; return null; }
            if (lease.Generation != generation) { refusal = Deny.Generation; return null; }
            long remaining = lease.ExpiresAt - _now();
            if (remaining <= 0) { refusal = Deny.Expired; return null; }
            LeaseSession session = new(this, lease, TimeSpan.FromSeconds(remaining));
            lease.Sessions.Add(session);
            return session;
        }
    }

    // Null while the lease still stands (it is the current one for its computer and has not expired); otherwise the reason word.
    private string? Check(Lease lease)
    {
        lock (_gate)
        {
            if (!_byComputer.TryGetValue(lease.ComputerId, out Lease? current) || !ReferenceEquals(current, lease)) return Deny.Revoked;
            return _now() >= lease.ExpiresAt ? Deny.Expired : null;
        }
    }

    private void Detach(Lease lease, LeaseSession session)
    {
        lock (_gate) lease.Sessions.Remove(session);
    }

    internal sealed class Lease(string computerId, string operationId, long generation, long expiresAt)
    {
        public string ComputerId { get; } = computerId;
        public string OperationId { get; } = operationId;
        public long Generation { get; } = generation;
        public long ExpiresAt { get; } = expiresAt;
        public List<LeaseSession> Sessions { get; } = [];

        // The sessions that held this lease, taken away (the caller closes them).
        public List<LeaseSession> Retire()
        {
            List<LeaseSession> sessions = [.. Sessions];
            Sessions.Clear();
            return sessions;
        }
    }

    /// <summary>One act session's hold on a lease. Dispose it when the session ends.</summary>
    internal sealed class LeaseSession : IDisposable
    {
        private readonly DesktopLeases _owner;
        private readonly Lease _lease;
        private readonly CancellationTokenSource _closed = new();

        internal LeaseSession(DesktopLeases owner, Lease lease, TimeSpan untilExpiry)
        {
            _owner = owner;
            _lease = lease;
            Token = _closed.Token; // kept: reading it from the source after Dispose would throw
            _closed.CancelAfter(untilExpiry); // the Broker's clock counts whole seconds rounded down, so this never fires before the lease is expired by the check below
        }

        /// <summary>Cancelled when a newer claim replaces the lease, or the lease expires.</summary>
        public CancellationToken Token { get; }

        /// <summary>Null while the lease still stands; otherwise the reason word. Asked before every input, because the token can lag behind the clock.</summary>
        public string? Refusal() => _owner.Check(_lease);

        internal void Close()
        {
            try { _closed.Cancel(); }
            catch (ObjectDisposedException) { /* the session ended in the meantime */ }
        }

        public void Dispose()
        {
            _owner.Detach(_lease, this);
            _closed.Dispose();
        }
    }
}
