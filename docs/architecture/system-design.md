# ALBERA — System Design RFC v0.1

- **Status:** Proposed / Review required
- **Date:** 2026-10-28
- **Owners:** ALBERA project maintainers
- **Scope:** Hybrid Project Computers, Work Continuity, Verified Integration, Human Comprehension
- **Relationship to implementation:** Design proposal only; does not assert features are implemented.

## 0. Executive decision

ALBERA is a local-first **AI software engineering control plane** that coordinates coding agents across isolated project computers while preserving work, evidence, decisions and human oversight across agent and environment changes. The product **does not** compete primarily by creating a faster hypervisor. Hyper-V is the first intended environment adapter, not a mandatory architectural dependency.

**Primary outcome:** reduce time and cost to a *verified, reviewable change*, without weakening isolation or approval policy. Optimizations are judged end-to-end, not by isolated benchmark numbers.

**Critical distinction:** implementation completion, independent verification, human comprehension and approval are distinct states.

## 1. Problem, users and jobs-to-be-done

### Primary users
- Individual developer operating Codex / Claude Code / OpenCode on several tasks.
- Project manager / tech lead requiring accurate progress, architectural evidence and developer explanations.
- Later: enterprise admins managing identity, network, approved agents and audit.

### Core problems
1. CLI session status and handoffs are fragmented; work is lost across resets and agent changes.
2. Parallel agents cause filesystem, branch and semantic merge conflicts.
3. An agent's success claim is not reliable evidence that a merged change works.
4. Developers cannot always explain AI-authored changes and their operational consequences.
5. Untrusted agent execution must not receive ambient host or organizational privileges.

### Explicit non-goals for first vertical slice
- Hypervisor/kernel implementation, generalized remote cloud offering or enterprise tenancy.
- Full OS-level deterministic replay.
- Guaranteed objective measurement of human comprehension.
- Arbitrary host command execution from the existing read-only HTTP listener.
- Model training on customer source code or cross-project memory by default.

## 2. Success metrics and guardrails

North-star: **Task-to-Verified-Result** under a fixed acceptance-test suite. Report median/p95, total model cost, total compute cost, human intervention and escaped defects. Also track **Task-to-First-Useful-Action**, interruption-to-resume time, handoff loss rate, merge conflict rate, reviewer understanding results.

All targets below are **proposed, not measured**:

| Metric | Provisional goal | Test conditions |
|---|---|---|
| Scheduler-only decision p95 | < 20 ms | 100 candidates, no provider network call |
| Warm available-computer lease p95 | < 100 ms | local registry transaction only |
| Memory FTS-only p95 | < 30 ms | 100k synthetic entries, ACL-constrained |
| Canvas state propagation p95 | < 100 ms | 1000 events/sec ingress, aggregate UI updates |
| Canvas frame budget | 16.7 ms p95 | specified browser/device and visible-node count |
| Cross-project data disclosure | 0 in adversarial tests | filesystem, retrieval and network tests |
| Stale lease authorization | 0 | reboot/restore/reconnect fault injection |
| Duplicate externally visible operation | 0 for protected operations | idempotency and reconciliation tests |

Cold/warm VM boot SLOs are deferred until measured on specific Windows/Hyper-V host and Linux images. Performance targets may not relax security gates.

## 3. Architecture and trust boundaries

```text
ALBERA Canvas (unprivileged client)
   | authenticated commands / event subscriptions
Control Plane (low privilege)
   |-- Project / Task / Run registry
   |-- Durable operation journal + event log + read models
   |-- Policy / Approval / Lease service
   |-- Work Continuity + Memory + Evidence store
   |-- Scheduler + Orchestrator + Integration Coordinator
   |
   +-- Privileged Host Broker [minimal, narrow RPC, no arbitrary shell]
          |-- Hyper-V Provider (first adapter)
          |-- Container Provider (future)
          +-- Remote Provider (future)
                    |
              Isolated Project Computer
                Guest Agent / CLI / Browser / Desktop
                    |
                Git Submission + Evidence Envelope
```

**Trust rule:** guest OS, agent output, screenshots, source files, web pages, terminal logs and guest-generated memory candidates are *untrusted*. The guest must not control host policy, identity, leases or verification attestation. A full-admin guest may modify its own Guest Agent; therefore the host cannot treat guest-reported claims as trusted attestation. Independent validation occurs outside the authoring guest.

Existing Pigeonholes-derived observer/read-only HTTP server remains isolated and must not be upgraded into an unauthenticated execution API.

## 4. Core domain model

| Entity | Identity / responsibility |
|---|---|
| Project | policy, repositories, authorized knowledge, owner |
| Task | objective, dependency DAG, acceptance criteria; survives retries |
| Run | one agent attempt on a task; never reused |
| Computer | instance + provider + image + security profile |
| Lease | bounded delegated authority with generation / epoch |
| Operation | idempotency key, desired state, observed state, retry status |
| Artifact | content-addressed data, Git object identifiers, provenance |
| Evidence | immutable verification result bound to commit/environment/test/policy |
| Memory Claim | scoped factual or tentative statement + source and validity |
| Integration Candidate | exact merged commit under review and verification |
| Comprehension Record | who explained or predicted what, for which change |
| Approval | explicit authorizing actor and exact target digest / policy version |

**Invariants:** No verified evidence for a different commit. No permanent state stored only in VM disk. No production privileges implied by guest administrator. No human approval manufactured by Main AI. Revoked lease does not regain validity following a VM rollback.

## 5. Computer Pool and scheduling

### Types
- **Persistent**: project-associated long-running developer workspace; recoverable but not authoritative.
- **Ephemeral**: independent task/run workspace; disposed following evidence collection.
- **Verification**: clean environment not used by the authoring agent; stricter network and credentials.

### Pool states
`REQUESTED -> PROVISIONING -> READY -> LEASED -> RELEASING -> CLEANING -> AVAILABLE`. Exceptional states: `UNKNOWN`, `QUARANTINED`, `FAILED`, `DESTROYING`, `DESTROYED`.

Do not claim an environment is cleaned from guest self-report. For cross-project reuse, re-create from trusted golden image; avoid reassigning a modified VM across tenants.

### Scheduling algorithm, initial version
1. Hard filter by project/tenant, approved provider, OS, GUI, architecture, isolation, network, capability and budget.
2. Check no conflicting lease; acquire using atomic compare-and-swap in registry, increment generation.
3. Among candidates evaluate expected readiness, remaining task duration, resource cost, predicted failure/recovery cost and downstream integration risk.
4. If no candidate fits, provision within quotas; otherwise queue with reason.
5. Use historical observations to refine estimates, not to override mandatory policy.

**Anti-thrashing:** min residency, resource hysteresis, bounded warm pool, concurrency tokens for disk-intensive clone/restore, separate model-call budget. No initial speculative autoscaling until measurements justify it.

### Lease semantics
`leaseId, computerId, projectId, runId, generation, permittedCapabilities, expiry, issuedPolicyVersion`. Operations must carry operation ID + lease generation; stale generations rejected host-side. Lease expiration is not sufficient to stop an already-running process: broker must isolate, terminate or quarantine as policy dictates.

## 6. Images, snapshots and recovery

- Trusted **Golden Image** is versioned and immutable while referenced by children; record base-image and package manifest digests.
- **Differencing VHDX** can accelerate per-task clones but parent-chain depth and disk capacity must be managed.
- **Production checkpoint** for application-consistent rollback where guest supports it; **Standard checkpoint** only for explicitly approved investigative use and never equated to a backup.
- Git commit and artifact store, not snapshots, are source of truth for project output.
- **Restore protocol**: quarantine network; close or invalidate Run/Lease; record restore operation; apply checkpoint; rotate authorization epoch and credentials; reconcile observed state; independently reauthorize outbound access.
- VM restoration never rolls back external Git pushes or API operations. Use compensation, explicit review and operation journal.
- Garbage collection must check image/checkpoint reference counts and completed artifact export first.

## 7. Durable operation journal and reconciliation

Control Plane persists **desired state** before side effects; Provider returns **observed state**. Reconciler detects and resolves drift. On timeout or unknown outcome, inspect provider state before retrying. Idempotency applies to provisioning, leasing, artifact submission and approval requests. Protect outward-facing Git publish operations with unique identifiers and explicit human confirmation as required.

Persistence baseline: SQLite WAL + bounded single-writer design for local-first mode; durable file-based content-addressed artifact store; optional PostgreSQL in future. Agent conversation logs and UI read models are not durable authority. Every event has project scope, resource identity, monotonic sequence per aggregate, UTC timestamp, correlation ID and schema version.

## 8. Work Continuity Protocol (internal v1)

A task survives changes of Run, Agent and Computer. Its **Handoff Manifest** binds:
- objective + acceptance criteria and remaining work;
- repository identity + base and result commit OIDs;
- exact relevant approved memory claims and their scope;
- unresolved errors with reproducible evidence;
- artifact and test-report references;
- current policy version and required approvals;
- explicit statement of uncertain/unverified assumptions.

**Handoff sequence:** commit/persist work -> gather host-validated references -> mint immutable manifest -> initialize new Run/Lease -> resolve claims under current ACL -> revalidate base commit/branch -> continue. Never copy old VM credentials or infer successor has predecessor permissions.

## 9. Agent Memory and retrieval

### Memory layers
- L0: per-run working context (ephemeral; critical checkpoints exported).
- L1: task handoff state.
- L2: project technical knowledge and decisions.
- L3: approved organization knowledge, explicitly scoped.

A claim has `{claimId, subject, predicate, value, projectId, commitScope, sourceEvidence, author, reviewStatus, validity, supersedes, ACL}`. Do not promote prompt-injected source text into governing instructions.

### Retrieval initial architecture
1. Enforce project/user ACL **before** retrieval and caching.
2. Exact/FTS5 search for error codes, symbols, names and commit IDs.
3. Optional vector retrieval for semantic queries after a measured baseline.
4. Deduplicate, rank provenance and commit validity, flag contradictions.
5. Return a bounded, cited Context Pack; record token budget and cache version.

Do **not** assert that a Strata-derived algorithm will meet upstream benchmarks on ALBERA data. Evaluate candidate OSS against simple SQLite baseline using license, maintainability, retrieval quality, latency, memory and token use.

## 10. Parallel work and verified integration

- Same filesystem: worktrees permitted under one trusted coordinator.
- Separate VM: prefer independent clones + Git commits / Git bundle or approved transport; don't share writable `.git` across untrusted guests.
- Identify file/path overlap and API/schema dependencies *before* scheduling parallel tasks.
- Build integration candidate in separate trusted workspace, exact Git commit OID.
- Validate secrets, changed-file policy, tests, supply-chain rules and conflict resolution.
- Verification computer reproduces build/tests from fixed commit, lockfiles and image digest; high-risk changes require independent review.

**Evidence binding** includes full commit OID, test suite digest, image digest, dependency lock digest, config/policy version, time and runner identity. Reuse only where policy and determinism allow; report cached evidence as cached, not newly executed.

**Completion facets:** implementation-submitted, independently-verified, comprehension-reviewed, human-approved. Each may be pending/failed independently. Only a policy-configured gate may transition a change to integrated.

## 11. Intelligence Plane and optimal orchestration

Task DAG stores typed dependency edges. **Fast path** (event updates/retries), **decision path** (deterministic scheduling/risk thresholds) and **reasoning path** (LLM planning/conflict diagnosis) are separate. Avoid calling Main AI for every log line. Optimize verified completion time and total cost, not number of simultaneously running agents.

Initially use conservative scheduling: avoid parallel tasks sharing migration/schema/auth hotspots; enforce per-project agent count, token, disk and RAM limits. Historical estimates are versioned and uncertainty-aware. Do not use private customer activity to train a global optimizer without informed opt-in.

## 12. Canvas performance and interaction

Canvas renders a **materialized read model**, not raw event replay for every frame. Publish coalesced deltas with revision, watermark and heartbeat; urgent security/approval transitions bypass visual batching. On reconnect, replay from revision or fetch snapshot.

LOD0 = project overview; LOD1 = Task/Agent graph; LOD2 = Computer Inspector with terminal/desktop/video. Virtualize off-screen nodes, throttle metrics, only stream/high-rate encode selected desktops. Human takeover obtains exclusive scoped input lease with generation fencing; stale AI desktop actions rejected by the broker. If an agent can automate the desktop outside the broker, it must be stopped or isolated before takeover.

Do not migrate current lightweight DOM frontend to a new framework without comparative measurements and an incremental migration plan.

## 13. Performance and benchmarking plan

Capture machine CPU, host and guest RAM, disk model and free capacity, Windows edition, Hyper-V version, guest image digest, model/provider version, code commit, workload seed, warm/cold condition and run count.

Benchmark suites: `bench-compute`, `bench-memory`, `bench-orchestration`, `bench-canvas`, `bench-integration`, `bench-recovery`. Include isolated subsystem measures and end-to-end Task-to-Verified-Result. Baselines use single-agent local CLI, plain Git worktrees, simple FTS5 and current read-only canvas. Report p50/p95/p99, confidence intervals, cost and failure counts; avoid claiming measured improvements from design alone.

## 14. OSS adoption / dependency policy

For each candidate (E2B/Daytona, OpenHands, Strata Memory, Temporal, OpenTelemetry, React Flow, Playwright, Git) produce a short **Adopt / Adapt / Fork / Build** record. Required checks: exact repository and version, license and transitive obligations, maintenance/health, security boundary, data egress/credential handling, startup overhead, resource consumption, replacement API and benchmark comparison.

Prefer stable SDK/API integration. Fork only when necessary and sustainable. OSS code reuse must comply with licensing/attribution; avoid blind copying. Hyper-V provider should use documented management APIs via a narrow privileged broker.

## 15. Security review and failure experiments

Threats: malicious source/issue text, guest administrator compromise, guest agent spoofing, network exfiltration, host broker confused deputy, replay after snapshot restoration, poisoned memory, stale evidence, GUI control races, compromised images, privilege escalation through Git hooks/build scripts.

Required fault-injection: network partition; host reboot; guest crash; lease timeout; restore with old token; duplicate operation request; failed checkpoint merge; disk full; corrupted memory index; conflicting Git commits; unauthorized cross-project memory request. Define expected denied action and measurable proof for each. Run development fixtures with fake credentials; keep production secrets out of VM images/checkpoints.

## 16. Sequencing and decision gates

| Gate | Experiment | Acceptance evidence |
|---|---|---|
| G0 | Existing Runtime Gateway review | test suite, process lifecycle and boundary tests, no untrusted command path |
| G1 | Durable registry, operation journal and lease | simulated crash/retry, no stale or duplicate authority |
| G2 | Hyper-V Ubuntu VM PoC | provision, execute, inspect, stop, destroy, network negative tests |
| G3 | Disposable computer -> persistent work | VM-A destroyed, VM-B continues from Git + manifest without secrets |
| G4 | Multi-agent integration | 2 agents, separate environments, exact integration commit and clean verification |
| G5 | Live Canvas | real provider events, reconnect, bounded resource use, takeover test |
| G6 | Memory & comprehension | source-grounded handoff + developer explanation/evidence exercise |
| G7 | Benchmark and threat review | independent reruns, SLO report, unresolved risks accepted or blocked |

Start with G0 and G1. Do not enlarge features before demonstrating G3. Each experiment has a rollback plan. The current Codex branch remains unaffected by this RFC until a separate approved implementation ticket is prepared.

## 17. ADR queue

- ADR-001 Environment Provider contract (Hyper-V first, adapters replaceable).
- ADR-002 Control Plane vs privileged host broker security boundary.
- ADR-003 Local SQLite event journal and operation reconciliation.
- ADR-004 Immutable golden images vs checkpoint-based reuse.
- ADR-005 Guest identity, lease generations and snapshot revocation.
- ADR-006 Git-per-VM submissions and verified integration policy.
- ADR-007 ACL-scoped memory claims and contradiction management.
- ADR-008 Canvas read model and event consistency.
- ADR-009 Local-first packaging and optional external OSS services.

## 18. Unresolved decisions requiring experiments or explicit product choices

1. Exact target machines: Windows edition, physical RAM, disk and CPU; realistic simultaneous VM budgets.
2. Should v1 support one developer only or local multi-user? Changes broker/auth architecture.
3. Which guest OS first: Ubuntu headless only or desktop from first slice?
4. Network baseline: fully offline except model gateway? Allowed package registries and Git remote?
5. Which CLI authentications can be safely delegated without copying host secrets?
6. Does Comprehension Gate block all integration, only high-risk files, or selected project policy?
7. Required artifact retention, privacy, encryption and deletion guarantees.
8. Maximum supported project / agent / VM counts, and pricing/budget ceiling.
9. Which external providers (Daytona/E2B) are acceptable, considering data residency and cost?
10. Evidence caching policy for nondeterministic / externally dependent tests.

## 19. Immediate next actions

- Document baseline machine resources and representative task workloads.
- Create RFC review issues for trust boundary, restore semantics and Git evidence contract.
- Write tests for current `src/runtime/gateway.mjs` before adding orchestration.
- Implement a provider-independent in-memory fake for state machine and fault injection.
- Measure one end-to-end task with the existing CLI before optimizing or introducing a framework.

---

**Review status:** No source code or GitHub branches were modified by this document. All benchmarks and algorithms marked as proposals must be validated before they are described as product capabilities.