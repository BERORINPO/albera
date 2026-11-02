# ALBERA v1.0 Roadmap

**Updated:** 2026-11-02 (main at `bf72258`, PR #150). Rewritten to match the work since 2026-10-28; the earlier Codex-era table described a host-local Runtime that is now only phase 1.

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `VERIFIED`. A phase is `VERIFIED` only with concrete test and acceptance evidence in `docs/progress.md`. All 20 acceptance IDs in `docs/architecture/acceptance-criteria.json` are still `NOT_VERIFIED`: none has an end-to-end run on the owner's host yet.

## Where to look

| Question | File |
|---|---|
| What happened last, what is next | `docs/architecture/runtime-implementation-progress.md` (newest at the end) |
| What waits on Yosuke | "Waiting on Yosuke" at the top of the same file |
| Why a choice was made | `spec/architecture.md` section 4 (one line per decision) |
| What the finished product looks like | `docs/design/target-picture-v08b.html` |

## Phases

| # | Phase | What exists | What is missing | Acceptance IDs | Status |
|---|---|---|---|---|---|
| 1 | Runtime foundation | Host-local gateway: provider allowlist, approval, executable identity, stop adapters, bounded events, audit journal, backup/recover-tail | OS sandbox (superseded by VMs in phase 2) | — | VERIFIED |
| 2 | Hyper-V environments | `create` without a network adapter, golden-disk clones, start/stop/destroy with reply-loss reconciliation, `retire`/`purge`, task-start checkpoints, person-approved `restore_checkpoint`, durable SQLite operation store with lease generations | Run through the installed Broker service on the owner's host | DUR-01, DUR-02, SEC-02, CMP-02 | IN_PROGRESS |
| 3 | Approval chain | Windows Broker and Approval Authority services (.NET, named pipes refusing remote clients), receipt v2/v3, Windows Hello approver app (key enrolled 2026-10-31), tiers careful/standard, attested `environment.start` and `task.start` without a person, disposable-VM lab (`lab-vm.ps1`) incl. #23 isolation runs | Host install of both services and the first real approval | SEC-01, ORC-01 | BLOCKED (owner card) |
| 4 | Control room | Read-only VM wall, agent fleet with AI cursors, `albera-runtime room` v0.8 with rule-based Bero, decision cards and ledger, `--require-start-approval` wiring to the real Broker/Authority | Bero wording by an LLM, human/AI input takeover lease, the full v08b picture | UI-01, UI-02 | IN_PROGRESS |
| 5 | AI hands and real CLIs | Desktop agent loop (Computer Use, Haiku by default) with step/cost/time caps and person stop; Claude read-only launch profile verified | Codex / Claude Code / OpenCode running inside the guest as task agents | ORC-02 | IN_PROGRESS |
| 6 | Git integration | Candidate contract, host quarantine from git bundles, target-tip fetch, fast-forward CAS promotion, Integration Service on the durable journal (#143–#150) | A real guest submission and an independent verifier runner wired in | INT-01, INT-02 | IN_PROGRESS |
| 7 | Orchestration | Journal, lease and scheduler primitives only | Goal decomposition, dispatch, retry, VM-A → VM-B handoff | CMP-01 | NOT_STARTED |
| 8 | Memory and knowledge | — | Scoped project memory with provenance, search without cross-project leaks | MEM-01, MEM-02, SEC-03 | NOT_STARTED |
| 9 | Comprehension | — | Evidence that the developer understood a change, not only an AI summary | CMPH-01 | NOT_STARTED |
| 10 | Physical machines | Design only (ADR-011, `physical-ssh` provider) | Implementation | CMP-03, SEC-04 | NOT_STARTED |
| 11 | Integration and release | Store and placement benchmarks on the reference machine | E2E on the owner's host, performance gates, packaging, docs | PERF-01, PERF-02 | NOT_STARTED |

## Next

1. Owner card: install the Broker and Approval Authority services and make the first real approval (phase 3). This unblocks the first end-to-end evidence for phases 2–4.
2. Wire the Integration Service to a real guest submission and verifier runner (phase 6).
3. Run a real CLI agent inside a guest under `task.start` approval (phase 5).

## Boundaries that do not change

The default `albera` command stays a read-only local dashboard and never imports Runtime execution code (`npm run arch` rule 2e). Execution lives behind `albera-runtime` (loopback only, one-time code → HttpOnly cookie, Origin/CSRF checks, text-only rendering) and, for VMs, behind the Broker and Approval Authority services. A guest never decides its own policy or approval, and an AI's "done" is recorded as a claim, not as a pass.
