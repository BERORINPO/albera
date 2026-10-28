# Runtime Architecture Implementation Progress

**Updated:** 2026-10-28
**Working branch:** `codex/runtime-architecture-alignment`
**Code base:** PR #17 head `8a829d116e39ca10f273594f409f38315f20570f`; analysis is in `runtime-gap-analysis.md`.
**Architecture source:** PR #18 head `b7684740322bda5a4e2d1233299bca251d95ed6c` (Proposed).

This file is the continuation ledger. `VERIFIED` refers only to the stated evidence and scope; it does not imply that a Proposed ADR has been accepted.

## Checkpoints

| Checkpoint | State | Evidence / remaining work |
|---|---|---|
| 0. Preserve baseline and compare ADR-001..010 | **VERIFIED** | Dedicated worktree created from the latest local Runtime branch. Pre-existing `work/` and its branch were left untouched. Current code, PR #18 docs and architecture review are recorded in `runtime-gap-analysis.md`. |
| 1. Existing Runtime Gateway P0 | **PARTIAL** | Fixed provider allowlist, `shell:false`, bounded argv/cwd/env, explicit approval, lifecycle-only events, timeout and process-tree supervision are present and covered by tests. This remains a host-local process, not an OS/VM sandbox; Guardian/PID reuse/breakaway and crash ownership remain open. |
| 2. Responsibility seams | **PARTIAL** | `AgentHarnessAdapter` and `EnvironmentProvider` contract plus no-op-for-host MockProvider exist. Control API is still the local prototype. A separately privileged OS Host Broker and authenticated IPC are not implemented. |
| 3. Durable operations and Lease generations | **PARTIAL** | `sqlite-operation-store.mjs` implements a private SQLite WAL store with FULL sync, schema v1, typed operation payloads, idempotency, intent-before-provider, Computer/Lease generations, provider/control-plane event provenance, and conservative UNKNOWN recovery. The coordinator reconciles by inspect and fences old generations. Focused test cases were added; four corrected focused cases passed before the install attempt, while the complete suite has not passed on the final state. Multi-process stress, crash/power-loss, macOS/Linux filesystem ACLs, Host Broker IPC, and real provider state remain unverified. |
| 4. Scheduler / resource admission | **NOT STARTED** | Depends on durable Computer/Lease registry. Implement only deterministic eligibility and reservation with hard quotas; no warm pool or automatic VM creation. |
| 5. Guest Agent communication and trust boundary | **NOT STARTED** | Define bounded versioned envelopes, host-issued identity/epoch, replay fencing and untrusted provenance. No self-reported guest success may authorize policy or verification. |
| 6. Hyper-V provider | **BLOCKED ON SAFETY GATES** | Implement typed adapter contract and mockable commands first. Real VM creation/deletion, switch/firewall changes, administrator changes and real credentials remain prohibited until explicit authorization and evidenced host/network gates. |
| 7. Cross-platform CI / fault tests / benchmarks | **PARTIAL** | The branch adds lockfile installation (`npm ci`) to the existing Node 22/24 × Windows/macOS/Linux matrix. Parent commit CI run `40597900869` passed six OS/Node jobs; this branch has not run CI. Current Windows Node 24.13 checks: `npm run arch`, `npm run smoke`, `npm run package:smoke`, `npm audit --omit=dev`, and `git diff --check` pass. `npm ci` fails before compilation because this machine has no Visual C++ toolset; consequently `npm test` has 569 passed, 6 skipped and 1 failed test-file import (`better-sqlite3` unavailable). Four focused SQLite tests passed before that cleanup. No end-to-end performance benchmark has been measured. |

## Current local evidence

- Baseline gap-analysis commit: `a1a8babc22e056bc2a6829601545217156a3d4d4`.
- Baseline at `a1a8bab` on Windows Node `v24.13.0`: `npm test` 575 tests (569 passed, 6 skipped, 0 failed), `npm run arch`, `npm run smoke`, `npm run package:smoke`, and `git diff --check` passed; these predate the SQLite store.
- Current after SQLite edits: `npm run arch` passes with 0 violations; `npm run smoke` passes; `npm run package:smoke` passes; `npm audit --omit=dev` reports 0 vulnerabilities; `git diff --check` passes. Current `npm test` reports 576 tests (569 passed, 6 skipped, 1 failed) because importing the new store fails after local dependency installation failed.
- `npm ci` requires a Visual C++ toolset to build `better-sqlite3@13.0.3`; this Windows machine has Visual Studio but no VC++ toolset. The failure is environmental and blocks a fresh local SQLite/full-suite rerun. Do not count parent CI as current-branch evidence; require the six-job hosted matrix to validate the pinned native dependency on Node 22/24 and Windows/macOS/Linux.

## Immediate sequence

1. Finish local durability/fault tests and all repository checks; treat remaining test failures as blockers.
2. Once this checkpoint is committed, add deterministic scheduler admission only after the current Lease/operation contract receives review.
3. Add Guest envelope validation and Host Broker typed protocol contracts; leave privileged service/IPC and real VM operations gated.
4. Push the feature branch only after changes are reviewable, then use the resulting CI matrix as evidence. Do not change the Draft status of existing PRs or merge anything.

## Non-goals for this branch until separately approved

- Hyper-V VM create/start/stop/destroy or checkpoint operations.
- Virtual switch, firewall or network topology changes.
- Admin rights, service installation, ACL repair, credential use or external provider changes.
- Guest access to host secrets, shell/PowerShell broker calls, or unauthenticated Observer execution routes.
- Marking PR #18 acceptance criteria or Proposed ADRs as verified/accepted without matching evidence.
