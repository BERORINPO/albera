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
| 3. Durable operations and Lease generations | **PARTIAL** | `sqlite-operation-store.mjs` uses Node `node:sqlite` for a private WAL store with FULL sync, schema v1, typed operation payloads, idempotency, intent-before-provider, Computer/Lease generations, event provenance and conservative UNKNOWN recovery. Ordinary task reassignment reuses the Computer epoch; restore revocation advances it, including when a Lease was already revoked for policy. The coordinator reconciles by inspect and fences old generations. Local tests pass on Node 22.13/22.23 and 24.13. Multi-process stress, crash/power-loss, macOS/Linux filesystem ACLs, Host Broker IPC, and real Provider state remain unverified. |
| 4. Scheduler / resource admission | **NOT STARTED** | Depends on durable Computer/Lease registry. Implement only deterministic eligibility and reservation with hard quotas; no warm pool or automatic VM creation. |
| 5. Guest Agent communication and trust boundary | **NOT STARTED** | Define bounded versioned envelopes, host-issued identity/epoch, replay fencing and untrusted provenance. No self-reported guest success may authorize policy or verification. |
| 6. Hyper-V provider | **BLOCKED ON SAFETY GATES** | Implement typed adapter contract and mockable commands first. Real VM creation/deletion, switch/firewall changes, administrator changes and real credentials remain prohibited until explicit authorization and evidenced host/network gates. |
| 7. Cross-platform CI / fault tests / benchmarks | **PARTIAL** | Parent commit CI run `40597900869` passed six OS/Node jobs; this branch has not run CI. Local full suites pass on Node 22.23.4 and 24.13.0; SQLite focus passes on minimum Node 22.13.0. A reproducible synthetic SQLite transaction benchmark is now available and was run on this Windows host. Hosted Windows/macOS/Linux matrix, minimum-minor full suite, and end-to-end performance remain unverified. |

## Current local evidence

- Baseline gap-analysis commit: `a1a8babc22e056bc2a6829601545217156a3d4d4`.
- Baseline at `a1a8bab` on Windows Node `v24.13.0`: `npm test` 575 tests (569 passed, 6 skipped, 0 failed), `npm run arch`, `npm run smoke`, `npm run package:smoke`, and `git diff --check` passed; these predate the SQLite store.
- Current Windows Node `v24.13.0`: `npm ci` succeeds with zero external dependencies; focused SQLite tests pass 13/13; full `npm test` passes 582, skips 6, fails 0 (588 total); `npm run arch`, `npm run smoke`, `npm run package:smoke`, `npm audit --omit=dev` (0 vulnerabilities), and `git diff --check` pass.
- Node `v22.23.4`: full suite passes 582, skips 6, fails 0 (588 total); `npm run arch` passes. Minimum `v22.13.0` passes the focused SQLite suite 13/13. `v22.5.0` failed because `node:sqlite` is not enabled by default there, so package minimum is set to `>=22.13`.
- Node emits an ExperimentalWarning for `node:sqlite`. This removes native compiler requirements, but API stability remains a compatibility risk. The six-job Windows/macOS/Linux Node 22/24 current-branch CI is still required; local Windows runs do not establish cross-platform behavior.
- Synthetic FULL-sync SQLite transaction benchmark (40 samples, Windows x64): latest Node `v24.13.0` run register Computer p50/p95 **0.889/1.191 ms**, reserve Lease **1.099/1.411 ms**, begin Operation **1.288/1.703 ms**; Node `v22.23.4` run: **0.887/1.128 ms**, **1.101/1.426 ms**, **1.315/1.945 ms** respectively. A previous Node 24 run varied by less than 0.5 ms at p95. This excludes startup ACL checks, Provider work, OS scheduling and remote I/O; it is an initial microbenchmark, not an SLO or cross-platform comparison.

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
