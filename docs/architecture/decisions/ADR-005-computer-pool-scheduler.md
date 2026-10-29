# ADR-005 — Computer Pool Scheduler, Admission Control and Resource Budgets

- **Status:** Proposed — benchmark and fault-injection evidence required
- **Date:** 2026-10-28
- **Depends on:** ADR-001 (Provider), ADR-002 (Trust), ADR-003 (Durable Operations), ADR-004 (Images)
- **Scope:** allocation decisions and resource admission; not a hypervisor implementation

## 1. Context
A project may own a persistent computer while task runs use ephemeral computers and verification uses clean computers. These are distinct roles, not interchangeable security profiles. A scheduler must minimize task-to-useful-action and task-to-verified-result without increasing cross-project leakage, cost, or duplicate execution.

## 2. Decision
Implement a **policy-first, capability-based scheduler** in the Control Plane. The scheduler makes *placement proposals*. A durable host operation reserves resources and issues a generation-fenced lease before a Provider receives a create/start command. The Control Plane is authoritative; Provider inventory is observed and potentially stale.

Use three computer roles:
- `persistent`: project-bound, long-lived, mutable; never shared across projects.
- `ephemeral`: task/run-bound, disposable; freshly cloned or securely reprovisioned.
- `verification`: independent environment, no developer-agent mutations, fresh checkout by pinned commit.

Use resource-aware cold/warm/hot capacity, but distinguish **ready-to-assign** from **booted**: a stopped VM is not equivalent to a pre-initialized running VM. In v1, avoid cross-project hot reuse.

## 3. Admission and placement algorithm
For each requested Run:
1. Validate identity, project ACL, task state, policy version, idempotency key and explicit approval requirements.
2. Normalize `EnvironmentSpec` to provider-neutral requirements (OS, architecture, desktop, browser, isolation, resource minima, network policy, data locality, trusted image digest, persistence).
3. Filter candidate providers/computers by **hard constraints**: project ownership, required isolation, OS capabilities, provider health, policy and budget.
4. Reserve resource capacity transactionally in the Registry (CPU reservation, guest-memory cap, disk quota, network policy, API budget) and allocate `(computerId, leaseGeneration)`. Do not treat CPU oversubscription and memory overcommit as identical.
5. Rank feasible placements using calibrated estimates for readiness, run time, transfer, risk of retry and resource cost. Initial weights are documented defaults, not learned truth.
6. Persist operation intent + reservation before side effect (ADR-003), execute through Host Broker (ADR-002), reconcile actual state. Reservation expiry triggers re-evaluation, not blind duplicate VM creation.
7. Release capacity only after authoritative stop/destroy observation or explicit quarantine accounting.

### Cost model (only after eligibility)
`J = a * E[ready_ms] + b * E[run_ms] + c * estimated_resource_cost + d * E[recovery_ms] + e * expected_merge_delay`.
Calibration uses per-hardware, image, task type, provider profiles; unknown values produce conservative estimates with confidence bounds.

### Fairness and quotas
- Project-level weighted fair queues; reserved capacity for urgent human takeover/stop/approval operations.
- Hard caps: per-owner/project concurrent VMs, memory budget, disk quota, pending clone count, API/model cost ceiling.
- Anti-starvation: queued task age increases priority, without breaking security and quota hard limits.
- Backpressure: disk-heavy clone and checkpoint operations have independent concurrency limits.
- VM can enter `QUARANTINED`; quarantined resources remain counted until verified cleanup.

## 4. Minimal contracts
```ts
type ComputerRole = "persistent" | "ephemeral" | "verification";
type LeaseStatus = "RESERVED" | "ACTIVE" | "REVOKING" | "RELEASED" | "EXPIRED" | "QUARANTINED";
interface EnvironmentRequest {
  projectId: string; taskId: string; runId: string;
  role: ComputerRole;
  requirements: {
    os: "linux" | "windows"; arch: "x64" | "arm64";
    isolation: "vm" | "container";
    desktop: boolean; browser: boolean;
    minimumMemoryMiB: number; vcpus: number;
    networkPolicyId: string; imageDigest: string;
  };
  idempotencyKey: string; policyVersion: number;
}
interface PlacementDecision {
  decisionId: string; providerId: string; computerId: string;
  leaseId: string; generation: number;
  reservationId: string; reasonCodes: string[];
}
```
Contracts are illustrative: production types also require actor identity, tenant, deadline, version, quota snapshot, trace IDs, and authenticated command envelope.

## 5. Pool strategy
- `HOT`: already powered on, initialized and assigned to an allowed project trust domain; zero unverified credentials remain from prior Run.
- `WARM`: ready image/disk/provisioning artifacts; power state and credential state recorded explicitly.
- `COLD`: create from immutable approved image and fresh unique identity.
- `REMOTE`: remote provider only with explicit data egress, region and billing policy.

Initial simple policy: no cross-tenant hot reuse, 0-1 prewarmed Linux project-specific VM if memory headroom exceeds host reserve, scheduled image prefetch rather than always-on multi-VM pool. Tune using arrival rate, measured initialization times and idle-cost budget; avoid assuming Little's Law-style estimates are optimal for bursts.

## 6. Correctness / adversarial conditions
- Two simultaneous claims for one Computer -> one active generation only.
- Expired lease does **not** imply process stopped; recovery fences and verifies state.
- Host restart between operation intent and VM creation -> discover by deterministic provider tag/ID before reissue.
- Provider returns timeout after successful creation -> reconcile by tagged native ID, never create second VM blindly.
- VM guest reports self "clean" -> treat as untrusted; clean state must follow controlled image reconstruction.
- Host resource pressure -> prioritize durable operation log, stop/kill safety path and guest isolation over new work.
- Policy becomes stricter while lease active -> revoke, isolate, reconcile, then apply new placement.
- Independently expose `desiredState`, `observedState`, `lastObservedAt`, `confidence` to Canvas.

## 7. Evaluation
**Metrics:** scheduling-only p50/p95/p99, task-to-first-useful-action, allocation wait p95/p99, guest RAM peak, disk IOPS, queue starvation, wasted warm capacity, cold/warm reuse hit rate, verified throughput and total cost. Compare cold-only, fixed-warm and adaptive under identical arrival traces.
**Proposed targets, not results:** placement computation p95 <20ms at 100 candidates (excluding SQLite commit and Provider latency); no double-active generation under 10,000 fault-injected allocations; no cross-project reuse without reprovisioning.
**Fault tests:** racing reservations, timeout-after-success, power loss at every durable transition, inconsistent provider health, invalid image, disk full, network isolated, VM not stoppable, host reboot.
**Exit gate:** repeatable property tests plus an end-to-end Hyper-V PoC with reproducible machine profile; document the measured hardware-specific boot percentiles before setting boot SLOs.

## 8. Alternatives / revisit
- **Direct `startVM` in Main AI:** rejected; bypasses quotas/authorization.
- **One persistent VM per agent:** rejected as default; wasteful and difficult for independent verification.
- **Always-full warm pool:** deferred pending real traces.
- **Kubernetes scheduler:** deferred; adds significant operational complexity for Windows-local-first deployment.
Revisit after >=100 real local task runs and benchmark comparisons.

## 9. Open questions
Host RAM reserve policy; supported Hyper-V editions/versions; VM GPU requirements; per-project retention/idle timeout; tenant and corporate data jurisdiction; charging/showback model.