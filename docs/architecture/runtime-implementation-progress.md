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
| 3. Durable operations and Lease generations | **PARTIAL** | `sqlite-operation-store.mjs` uses Node `node:sqlite` for a private WAL store with FULL sync, schema v2, additive migration from v1, typed operation payloads, idempotency, intent-before-provider, Computer/Lease generations, host capacity, resource reservation, event provenance and conservative UNKNOWN recovery. Ordinary task reassignment reuses the Computer epoch; restore revocation advances it, including when a Lease was already revoked for policy. The coordinator reconciles by inspect and fences old generations. Multi-process stress, crash/power-loss, macOS/Linux filesystem ACLs, Host Broker IPC, and real Provider state remain unverified. |
| 4. Scheduler / resource admission | **PARTIAL** | `computer-scheduler.mjs` performs deterministic best-fit proposals over host-registered capacity. The SQLite store revalidates compatibility, exclusive Lease and project hard quota atomically. Expired/revoked/unknown-usage leases fail closed and retain capacity. There is no authenticated policy/quota service, fairness, warm pool, automatic VM creation, or public API wiring. Multi-process contention remains unverified. |
| 5. Guest Agent communication and trust boundary | **NOT STARTED** | Define bounded versioned envelopes, host-issued identity/epoch, replay fencing and untrusted provenance. No self-reported guest success may authorize policy or verification. |
| 6. Hyper-V provider | **BLOCKED ON SAFETY GATES** | Implement typed adapter contract and mockable commands first. Real VM creation/deletion, switch/firewall changes, administrator changes and real credentials remain prohibited until explicit authorization and evidenced host/network gates. |
| 7. Cross-platform CI / fault tests / benchmarks | **PARTIAL** | Synthetic fixtures now stub injected DACL verification; gated real Windows storage ACL integration remains. CI run `40610906045` exposed a second Windows Node 24 issue: the CLI subprocess integration test waited on PowerShell DACL inspection until its 60-second fail-closed timeout. The loopback host lifecycle integration now uses the existing journal verifier injection seam rather than spawning the CLI; production CLI is unchanged and always uses the real verifier. The dedicated actual Windows DACL integration test covers storage verification. A fresh six-job run after this correction remains required. |

## Current local evidence

- Baseline gap-analysis commit: `a1a8babc22e056bc2a6829601545217156a3d4d4`.
- Baseline at `a1a8bab` on Windows Node `v24.13.0`: `npm test` 575 tests (569 passed, 6 skipped, 0 failed), `npm run arch`, `npm run smoke`, `npm run package:smoke`, and `git diff --check` passed; these predate the SQLite store.
- Current Windows Node `v24.13.0` after scheduler and Windows test-fixture corrections: `npm test` passes 587, skips 7, fails 0 (594 total); SQLite tests pass 17/17; gated real Windows ACL suite passes 10/10, including opening a temporary private SQLite store. `npm run arch` passes with 90 paths and 0 violations; `npm run smoke`, `npm run package:smoke`, `npm audit --omit=dev` (0 vulnerabilities), and `git diff --check` pass. Focused scheduler/store tests include schema v1 row preservation and hard quota failures.
- After isolating the loopback host integration from the hosted-runner PowerShell timeout, local `node --test test/runtime-entry.test.mjs` passes 1/1, full `npm test` again passes 587, skips 7, fails 0 (594 total), and the opt-in real Windows ACL suite passes 10/10 in 4.8 seconds. `npm run arch`, `npm run smoke`, `npm run package:smoke`, `npm audit --omit=dev` (0 vulnerabilities), and `git diff --check` pass. The Runtime CLI remains unchanged and uses the production ACL verifier; the test seam does not expose a CLI/environment bypass.
- Node `v22.23.4`: previous pre-scheduler full suite passed 582, skipped 6; minimum `v22.13.0` passed the previous focused SQLite suite 13/13. These results do not verify new Scheduler/schema v2 changes; the updated commit must pass hosted Node 22/24 matrices. `v22.5.0` previously failed because `node:sqlite` is not enabled by default there, so package minimum is `>=22.13`.
- Node emits an ExperimentalWarning for `node:sqlite`. This removes native compiler requirements, but API stability remains a compatibility risk. The six-job Windows/macOS/Linux Node 22/24 current-branch CI is still required; local Windows runs do not establish cross-platform behavior.
- Synthetic FULL-sync SQLite transaction and placement benchmark (40 samples, Windows x64, Node `v24.13.0`, isolated run): register Computer p50/p95 **0.899/1.277 ms**, reserve Lease **1.148/1.469 ms**, begin Operation **1.350/1.664 ms**. Pure placement over 100 synthetic candidates p50/p95 **0.479/0.957 ms**. This excludes startup ACL checks, Provider work, OS scheduling and remote I/O; it is an initial microbenchmark, not an SLO or cross-platform comparison. Atomic quota scans at maximum lease counts have not been benchmarked.

## Immediate sequence

1. Push the Windows CLI integration timeout fix and require the full Node 22/24 × Windows/macOS/Linux CI matrix to pass; treat remaining test failures as blockers.
2. Review authenticated quota-policy binding and multi-process reservation before any Control API wiring.
3. Add Guest envelope validation and Host Broker typed protocol contracts; leave privileged service/IPC and real VM operations gated.
4. Push the feature branch only after changes are reviewable, then use the resulting CI matrix as evidence. Do not change the Draft status of existing PRs or merge anything.

## Non-goals for this branch until separately approved

- Hyper-V VM create/start/stop/destroy or checkpoint operations.
- Virtual switch, firewall or network topology changes.
- Admin rights, service installation, ACL repair, credential use or external provider changes.
- Guest access to host secrets, shell/PowerShell broker calls, or unauthenticated Observer execution routes.
- Marking PR #18 acceptance criteria or Proposed ADRs as verified/accepted without matching evidence.
