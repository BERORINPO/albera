# ADR-003 — Durable Event Store, Operations and Reconciliation

- **Status:** Proposed; pending fault-injection tests
- **Date:** 2026-10-28
- **Depends on:** RFC v0.1; ADR-001 provider contract; ADR-002 host/guest trust boundary
- **Implementation:** design only; not evidence that current Runtime Gateway has persistence

## Context and decision
VM creation, process launches, Git pushes and checkpoint restores span multiple systems; there is **no atomic transaction** between SQLite and Hyper-V or external Git hosts. Guest events may arrive late, be duplicated or fabricated. UI events must never be treated as authoritative execution state.

**Decision:** locally authoritative SQLite state and transactional operation journal; desired/observed states kept separately; reconciler polls/observes providers and converges safely. One durable host-side operation is created before any side effect. Do not automatically replay uncertain non-idempotent actions.

SQLite WAL on a *local disk* supports concurrent readers and a serialized writer. Use `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;` for high-value operation and approval durability. WAL must not be placed on a network filesystem. `FULL` reduces power-loss durability risk; assess latency by measurement and batch unrelated telemetry separately. Back up with SQLite's supported backup mechanisms, not a raw copy of an active database without the WAL.

## Concepts and data contracts
- **Intent:** authenticated, authorized user or delegated request; authorization references stored server-side.
- **DesiredState:** host record of requested outcome, versioned by optimistic concurrency.
- **ObservedState:** provider report, includes observation timestamp and source; may be stale.
- **Operation:** durable command with `operationId`, idempotency key, subject, generation, action digest, policy version, status, attempt count, deadline, and error category.
- **Lease:** binds project/task/run/computer, expiry and monotonic fencing generation. Lease expiry is *not* proof an existing guest process stopped.
- **Event:** append-only, versioned domain record with stable event ID, aggregate ID, aggregate sequence, operation ID, causation/correlation IDs, timestamp and payload digest. Guest events carry explicit provenance `untrusted_guest`.
- **Audit:** separate append-only log for identity, approval, policy and privileged operation outcomes. Database administrators can tamper with a local log; cryptographic tamper-evidence and off-host replication are future hardening, not already guaranteed.

### Minimal SQLite schema sketch
```sql
CREATE TABLE computers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  native_id TEXT,
  desired_state TEXT NOT NULL,
  observed_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  generation INTEGER NOT NULL DEFAULT 1,
  row_version INTEGER NOT NULL DEFAULT 1,
  observed_at TEXT,
  UNIQUE(provider, native_id)
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES computers(id),
  generation INTEGER NOT NULL,
  action TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  deadline_at TEXT,
  last_error TEXT,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  aggregate_seq INTEGER NOT NULL,
  operation_id TEXT REFERENCES operations(id),
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(aggregate_id, aggregate_seq)
);
CREATE INDEX events_aggregate_idx ON events(aggregate_id, aggregate_seq);
CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL REFERENCES computers(id),
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  action_digest TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL
);
```
Additional production schema: tenants/ACL, provider identity uniqueness when `native_id` null, source-specific event inbox, audit chain, schema migrations, outbox, retention, lease one-active constraint enforced transactionally, snapshot/read model cursors.

## Operation protocol
1. Validate request/identity, resolve immutable target and current generation, evaluate policy.
2. **Within a single database transaction:** check idempotency key payload match, create or reference approval, append operation and intended-state event, increment version by compare-and-swap, enqueue outbox action. Commit before provider call.
3. Broker fetches trusted authorization and validates action digest, generation, VM ownership, network profile, resource quota.
4. Broker invokes *typed* provider operation with stable provider correlation/identity markers where supported.
5. Persist observed outcome; reconcile via `inspect` before declaring success. A timeout means **UNKNOWN**, not FAILED and not permission to duplicate a create/launch.
6. Materialize UI read model from committed events. Resumable subscriptions use sequence cursors; gaps require a fresh snapshot and event replay.

Idempotency keys are scoped to principal/project/action contract; repeat with different payload is a conflict. For unknown operations: inspect by stable native tag before deciding whether to retry. When provider cannot identify an operation or guarantee safe retry, quarantine / ask for operator intervention.

## Reconciler algorithm (pseudocode)
```text
for each due computer/operation:
  acquire DB ownership lease (fence generation; single active controller)
  observed = provider.inspect(stableNativeIdOrTag)
  persist observed with source/time
  if ownership mismatch or missing identity: quarantine
  else if uncertain operation: resolve from observed + provider correlation marker
  else if desired != observed:
    if safe, authorized, retryable transition: plan new journaled action
    else quarantine and emit review-required event
  renew/release controller lease; update projection cursor
```
No guarantee of exactly-once effects for external systems; aim for **at-least-once event processing with idempotent state transitions**, and an explicit reconciliation path for ambiguous side effects.

## Retention and ordering
- Append audit and key lifecycle events durably; bulky CLI/desktop streams are separately bounded and redacted, with manifest references in event log.
- Order guaranteed per aggregate, not globally; cross-aggregate dependencies rely on causation IDs.
- Schema-version each event and include upcasters for replay. Projections rebuild from trusted records, not guest self-report.
- Queue backpressure: bounded buffers and dropping/coalescing only for noncritical telemetry; never silently drop approval, security, lease, provider or integration transitions.

## Failure acceptance tests
1. Crash before commit: no provider call; operation absent.
2. Crash after journal commit before side effect: operation found and safely resumed.
3. Timeout after VM create but before response: reconciliation locates existing tagged VM; **no second VM**.
4. Process killed after request to stop: subsequent observer reports actual status; do not claim stopped without inspection.
5. Duplicate/out-of-order guest events: no duplicate transitions or policy elevation.
6. Old-generation command after restore: broker rejects.
7. SQLite WAL growth and slow readers: bounded checkpointing without missing journal entries.
8. Power interruption and backup/restore drill: committed operations recovered per documented durability guarantees; report losses instead of fabricating status.
9. Approvals cannot be reused across changed action digest or policy revision.
10. Provider unreachable: state becomes UNKNOWN/DEGRADED, no blind replay.

## Trade-offs and deferred topics
SQLite fits a single local control node. Clustered controllers or cross-host active-active operation will require consensus/leader election and usually a remote transactional database; do not claim SQLite alone supports distributed ownership. Event journal is append-only at application level, not an immutable storage guarantee. Precisely-once side effects are not promised.

## References
- https://www.sqlite.org/wal.html
- https://www.sqlite.org/pragma.html