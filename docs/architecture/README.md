# ALBERA — Architecture Design Package v4 (review-ready)

**2026-10-28 — DESIGN PROPOSAL, NOT IMPLEMENTATION OR TEST EVIDENCE**

This release collects the existing RFC and ADR-001 through ADR-007, plus the newly authored ADR-008 (Main AI), ADR-009 (Canvas/Computer Use), ADR-010 (performance/OSS) and implementation validation artifacts. Existing pre-v4 ADRs are preserved unchanged to retain their review provenance. The documents are intended for human review and Codex planning, not a mandate to merge or run privileged Hyper-V operations.

## Read in this order
1. [System Design RFC](system-design.md) — goals, users, baseline assumptions.
2. [ADR-002-control-guest-trust.md](decisions/ADR-002-control-guest-trust.md), [ADR-003-event-store-reconciliation.md](decisions/ADR-003-event-store-reconciliation.md) — security and durable state.
3. [ADR-001-environment-provider.md](decisions/ADR-001-environment-provider.md), [ADR-004-image-snapshot-lifecycle.md](decisions/ADR-004-image-snapshot-lifecycle.md), [ADR-005-computer-pool-scheduler.md](decisions/ADR-005-computer-pool-scheduler.md) — Compute.
4. [ADR-006-agent-memory-handoff.md](decisions/ADR-006-agent-memory-handoff.md), [ADR-007-verified-integration.md](decisions/ADR-007-verified-integration.md) — durable work, memory and verification.
5. [ADR-008-main-ai-orchestration.md](decisions/ADR-008-main-ai-orchestration.md) — delegation and safe bounded autonomy.
6. [ADR-009-canvas-computer-use.md](decisions/ADR-009-canvas-computer-use.md) — observability, GUI, human takeover.
7. [ADR-010-performance-observability-oss.md](decisions/ADR-010-performance-observability-oss.md) — optimization and adoption.
8. [PoC-001](experiments/PoC-001-hyperv-work-handoff.md), [Benchmark Spec](experiments/benchmark-spec.md) — executable hypotheses.
9. [Acceptance Criteria](acceptance-criteria.md), [Machine-readable Acceptance Criteria](acceptance-criteria.json), [Implementation Roadmap](implementation-roadmap.md), [OSS Research](oss-research.md) — release and engineering contracts.

## Review record
[Architecture Review — 2026-10-28](architecture-review-2026-10-28.md) documents blockers, review boundaries, and required implementation evidence. All high-risk items remain OPEN.

## Design status and decision gates
All ADRs remain **Proposed** pending reviews. Hyper-V PoC is **NOT_RUN**. All acceptance criteria are **NOT_VERIFIED** until linked evidence exists. Do not reinterpret example JSON or draft SLOs as existing production behavior.

## Decision log — Runtime implementation deltas
| date+topic | decision | reason and rejected alternative | lint promotion |
|---|---|---|---|
| 2026-10-29 IPC (R-11) | ADR-002 names restricted-ACL named pipes; the current stack uses loopback HTTP with a bearer token | Records the current stack boundary without implying the ADR transport is implemented. Rejected for this interim record: describing named pipes as current behavior. | no |
| 2026-10-29 storage (R-12) | ADR-003 specifies SQLite; the current stack uses a JSONL live journal | Records the implementation delta without claiming SQLite durability. Rejected for this interim record: describing SQLite as implemented. | no |
| 2026-10-29 interim mode | Runtime Gateway runs provider CLIs on the host as the current user without VM isolation; untrusted code is prohibited until Hyper-V provider and ADR-required egress enforcement | Makes the current trust boundary explicit. Rejected: treating host-direct execution as isolated or suitable for untrusted code. | no |

## Immediate engineering handoff
1. Reconcile with up-to-date source and uncommitted local changes; do not overwrite Codex's runtime branch.
2. Review ADR-002 trust model, then confirm ADR-003 lifecycle and operation journal.
3. Implement MockProvider and fault injection before live Hyper-V operations.
4. Execute PoC-001 on disposable assets with explicitly approved host privileges.
5. Advance only criteria with reproducible evidence; measure baseline before optimizing.

## External reference pointers
Codex SDK https://learn.chatgpt.com/docs/codex-sdk ; Git merge-tree https://git-scm.com/docs/git-merge-tree ; Playwright contexts https://playwright.dev/docs/browser-contexts ; OpenTelemetry https://opentelemetry.io/docs/ ; SQLite https://www.sqlite.org/ . License and feature claims require re-verification at implementation time.
