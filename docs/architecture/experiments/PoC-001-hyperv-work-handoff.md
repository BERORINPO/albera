# PoC-001 — Disposable Computer, Persistent Verified Work

- **Status:** Ready for controlled implementation, not executed
- **Date:** 2026-10-28
- **Purpose:** Validate ALBERA can replace an isolated computer while preserving code, evidence and task context without inheriting revoked permissions.
- **Design dependencies:** RFC v0.1, ADR-001/002/003/004

## Hypotheses
H1: Authoring VM-A can be destroyed; a new VM-B can continue the same task from **Git + host-side Handoff Manifest + Project Memory**, with no VM-local state dependency.
H2: Old lease/guest credentials are rejected after VM-A destruction and after restoring a checkpoint on VM-B.
H3: A third Verification VM can reproduce the combined result from immutable repository commit and pinned environment/image.
H4: Ambiguous Hyper-V provisioning and host-process crashes do not cause silently duplicated resources or task runs.

## Environment prerequisites / explicit gates
- Windows host with supported Hyper-V installation, virtualization enabled and sufficient resources verified *before* test. Do not assume host edition or rights.
- Isolated virtual switch/network with default-deny egress. Only scoped, logged Git and model endpoints are allowed if needed. No access to host network shares, personal credentials, sensitive repositories or corporate LAN.
- Ubuntu guest OS and image pinned by version and digest. Guest Agent preinstalled via reproducible image build, no durable credentials embedded.
- **Disposable synthetic demo repository** containing a small Node.js app and tests; never point destructive tests at the user's production VM/repository.
- Token/network use must be explicitly authorized: preferred first pass uses a simulated CLI runner; **real Codex CLI** pass requires available authentication, spend limit and explicit consent to AI execution. No bypassing the CLI's permission mechanisms.
- Host-side privileged Broker and unprivileged Controller run as distinct identities with distinct sockets/ACLs; observer HTTP port has no mutation path.
- Collect environment fingerprint: Windows build, Hyper-V version, CPU, RAM, available disk, storage type, guest image ID and SHA-256, versions of tools.

## Experiment stages
### Stage A — Preflight and baseline
1. Run existing `npm test`, `npm run arch`, `npm run smoke`; capture exact commits and output; smoke remains non-mutating.
2. Validate host Hyper-V capabilities, privilege boundaries and virtual switch via `inspect`-only calls.
3. Confirm trust policy denies unapproved VM operations, outside-network calls and unregistered image paths.
4. Measure baseline boot, ready, idle RAM, disk consumption with 5 repetitions; record p50 and range (p95 requires a larger sample).

### Stage B — Provision VM-A and run partial task
1. Journal `create` with unique operationId, stable native identity marker and generation.
2. Create VM-A with differencing disk from immutable Ubuntu image; inspect actual VM state.
3. Bootstrap one-time guest identity and constrained execution lease; verify READY state.
4. Clone the synthetic Git repository at pinned base commit. Start a runner (initially deterministic stub; then approved Codex CLI) to implement an incremental change with one known failing test.
5. Commit the valid partial code to task branch, export it through an allowlisted Git transfer mechanism; capture test output as bounded untrusted evidence and record artifacts with digests.
6. Create host-side Handoff Manifest with taskId/runId, base and result commit, completed/open criteria, relevant memory/evidence references; exclude raw secrets, unverified guest privileges and unsafe commands.
7. Confirm host persists manifest before VM-A deletion. Revoke lease, terminate/inspect guest execution, destroy VM-A and verify no orphan disk/VM.

### Stage C — Resume on VM-B
1. Provision fresh VM-B from the same pinned image, **new identity and fencing generation**.
2. Validate manifest integrity, provenance, policy version, commit availability and project ACL.
3. Fetch task branch by Git commit rather than sharing VM-A's writable disk. Issue a new scoped lease; supply only permitted context and verified memories.
4. Resume task with a fresh runner or a different authorized agent; finish failing test and create second commit.
5. Verify no remaining dependency on VM-A filesystem, SSH config, process ID or old credentials.

### Stage D — Independent Verification VM-C
1. Create clean VM-C from approved immutable image with no model secrets and no write-back authority.
2. Checkout final full commit; install pinned dependencies through controlled egress/cache.
3. Run unit tests and designated integration tests; capture exact commands, tool versions, environment fingerprint and outputs.
4. Submit signed/authenticated verifier record bound to commit + image + test suite + policy version. Guest log alone is not evidence of independent verification.
5. Mark implementation SUBMITTED, verification VERIFIED if tests pass, human comprehension/approval PENDING; do not auto-merge into main.

### Stage E — Restore and failure injection
- **F1:** Kill controller immediately after journal commit but before create; reconcile without duplicate.
- **F2:** Simulate provider timeout after actual VM creation; locate VM by stable tag and do not create another.
- **F3:** Re-submit same idempotency key with same payload (same op); different payload (409/conflict).
- **F4:** Deliver outdated lease command after VM-B restore; deny at broker even if guest agent says valid.
- **F5:** Interrupt artifact transfer; block VM deletion until transfer hash verified or explicit discard approved.
- **F6:** Disconnect Guest Agent mid-run; show UNKNOWN and reconcile before any retry.
- **F7:** Force low disk while snapshotting; fail safely, report/quarantine and do not manipulate AVHDX files directly.
- **F8:** Demonstrate cross-project leakage attempt blocked (network, storage, identity). No real secrets used.
- **F9:** Restart controller with an active operation; rehydrate durable state and event stream; Canvas gets snapshot+delta with no lost critical state transitions.

## Acceptance criteria (binary with recorded proof)
| ID | Must pass | Evidence required |
|---|---|---|
| AC-01 | VM-A eliminated after verified partial export | Provider inspect, Git OIDs, exported artifact digests |
| AC-02 | VM-B resumes same task from external state | Task/run linkage, new VM ID, continuation commit and passing tests |
| AC-03 | Old lease/credential unusable | Negative auth/epoch tests and broker log |
| AC-04 | VM-C independently verifies final exact commit | Clean image fingerprint, full Git OID, test output, verifier identity |
| AC-05 | Ambiguous create causes no duplicate | Journal and provider inventory after F1/F2/F3 |
| AC-06 | Provider outage never treated as confirmed stop | UNKNOWN observation and deferred safe reconciliation |
| AC-07 | No unapproved egress/host secrets | Network-deny tests, host broker access tests |
| AC-08 | Critical events survive control restart | Event sequence replay, audit references, projection rebuild |
| AC-09 | Restore invalidates prior authorization | Host-side fencing generation and negative commands |
| AC-10 | Resource cleanup leaves no uncontrolled VM/disk | Before/after VM and disk inventory |

Any failure => PoC **NOT VERIFIED**, with logs, reproduction steps and ownership; a demo video is not acceptance evidence by itself. Windows/Ubuntu versions, provider support, actual network rules and OSS licensing are environment-specific and must be recorded.

## Measurements
- Time: provision, guest-ready, first-useful-action, handoff creation, resume-to-first-change, verification, cleanup.
- Compute: host/guest CPU, RSS/committed RAM, disk bytes and IOPS, checkpoint chain depth, network bytes.
- Work continuity: missing mandatory handoff facts, invalid memory references, duplicate runs, failed evidence bindings.
- Comparison: full cold start vs reuse from image; manual context paste vs structured handoff (same task and model, randomized trials later).
- Recording: at least 5 baseline runs; later >=30 repeated runs for meaningful p95 analysis. Include cold/warm definition and cache state.

## Execution safety and responsibilities
Control operator approves host VM creation, bounded model usage and any network exception before execution. Human reviewer approves PR/merge. AI can propose work and modify only guest synthetic repo. Host Broker executes only typed pre-approved operations; no freeform powershell/host command argument from AI.

## Out-of-scope for PoC-001
Real enterprise SSO, live multiuser collaboration, Windows guest GUI, complex Kubernetes scheduling, production GitHub repository write, full deterministic process replay, arbitrary public web automation.

## Artifact checklist
- `reports/poc-001/preflight.json`
- `reports/poc-001/operations.jsonl` (redacted)
- `reports/poc-001/computers.json` (provider inventory)
- `reports/poc-001/handoff.json`
- `reports/poc-001/git-revisions.json`
- `reports/poc-001/verification.json`
- `reports/poc-001/failure-injection.md`
- `reports/poc-001/metrics.json`
- `reports/poc-001/conclusion.md` (each AC passed/failed with evidence URI)

## Work split with ongoing Codex branch
Do not alter the existing uncommitted Runtime Gateway changes without explicit synchronization. First implement a provider-neutral fake/fixture and contract tests in a separate reviewed PR, then broker/provisioning tests on a disposable VM. No host Hyper-V mutation should occur simply from reading these design documents.