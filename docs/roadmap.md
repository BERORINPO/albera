# ALBERA v1.0 Roadmap

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `VERIFIED`. A phase is `VERIFIED` only with concrete test and acceptance evidence in `docs/progress.md`.

| Phase | Scope | Depends on | Status |
|---|---|---|---|
| 1. Runtime Foundation | Isolated process lifecycle, approval, executable validation, platform stop adapters, bounded events, resource caps and tests | Current main / read-only Observer | IN_PROGRESS |
| 2. Secure Runtime API | Separate authenticated service, authorization, streaming, input/cancel, audit and recovery | Phase 1 | IN_PROGRESS |
| 3. Real CLI Integration | Codex, Claude Code, OpenCode provider adapters and documented capabilities | Phases 1–2 | NOT_STARTED |
| 4. Live Agent Canvas | Real lifecycle projection, nodes, task assignment and approved controls | Phases 2–3; existing canvas work remains in its own PR chain | NOT_STARTED |
| 5. Orchestration | Goal decomposition, dependencies, dispatch, concurrency, retry, handoff, human intervention and verification | Phases 2–4 | NOT_STARTED |
| 6. Git Integration | Worktrees, branches, diffs, conflicts, test results and PR support | Phases 2–5 | NOT_STARTED |
| 7. Knowledge & Harness | Scoped project knowledge, sources, CLI capabilities, Skills/MCP/Hooks visibility | Phases 3–6 | NOT_STARTED |
| 8. Comprehension | Explain diffs/decisions/dependencies and record evidence of developer understanding | Phases 4–7 | NOT_STARTED |
| 9. Integration & Release | E2E, security, GUI, cross-platform, performance, install/migration/docs and v1.0 gates | Phases 1–8 | NOT_STARTED |

The current product remains a read-only local dashboard. Phase 2 has an isolated authenticated loopback API prototype, but Phase 1 RT-10 process ownership is still blocked; the API is not connected to application startup and must not be hosted persistently until that gate and the remaining Phase 2 controls are met.
