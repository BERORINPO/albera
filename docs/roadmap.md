# ALBERA v1.0 Roadmap

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `VERIFIED`. A phase is `VERIFIED` only with concrete test and acceptance evidence in `docs/progress.md`.

| Phase | Scope | Depends on | Status |
|---|---|---|---|
| 1. Runtime Foundation | Isolated process lifecycle, approval, executable validation, platform stop adapters, bounded events, resource caps and tests | Current main / read-only Observer | VERIFIED |
| 2. Secure Runtime API | Separate authenticated service, authorization, streaming, input/cancel, audit and recovery | Phase 1 | IN_PROGRESS |
| 3. Real CLI Integration | Codex, Claude Code, OpenCode provider adapters and documented capabilities | Phases 1–2 | NOT_STARTED |
| 4. Live Agent Canvas | Real lifecycle projection, nodes, task assignment and approved controls | Phases 2–3; existing canvas work remains in its own PR chain | NOT_STARTED |
| 5. Orchestration | Goal decomposition, dependencies, dispatch, concurrency, retry, handoff, human intervention and verification | Phases 2–4 | NOT_STARTED |
| 6. Git Integration | Worktrees, branches, diffs, conflicts, test results and PR support | Phases 2–5 | NOT_STARTED |
| 7. Knowledge & Harness | Scoped project knowledge, sources, CLI capabilities, Skills/MCP/Hooks visibility | Phases 3–6 | NOT_STARTED |
| 8. Comprehension | Explain diffs/decisions/dependencies and record evidence of developer understanding | Phases 4–7 | NOT_STARTED |
| 9. Integration & Release | E2E, security, GUI, cross-platform, performance, install/migration/docs and v1.0 gates | Phases 1–8 | NOT_STARTED |

The default `albera` command remains a read-only local dashboard. An opt-in `albera-runtime` command starts a separate loopback Runtime host, broker, scoped API, redacted audit journal, and dedicated approval/control screen; execution capability is not imported into or served by the Observer. The browser host uses a one-time terminal code, HttpOnly/SameSite cookie, CSRF/Origin checks, server-side API bearer credentials, and text-only rendering. Journal storage refuses unsafe Windows DACLs, POSIX ownership/modes, and hard-linked journal/lock files without repairing existing paths. A journal-specific non-secret session ID sidecar enables run/event projection replay across host restarts; active processes remain unrestored and are shown as interrupted. Journal retention is append-only and bounded: capacity refusal preserves prior records and stops Runtime, and no automatic pruning occurs. A manual offline backup/restore command encrypts the journal and session identity, requires Runtime to be stopped for backup, and creates new destinations without overwriting. The offline `recover-tail` command copies a validated complete-record prefix from an incomplete journal to a new file under the normal writer lock, preserving the original and its tail; it cannot recover a possibly lost final event or active process. This local prototype is not yet a packaged or OS-authenticated production host. Guardian-failure/PID-reuse containment, crash-time event capture, actual browser/CLI acceptance, production backup/key-recovery and retention policy, and broader storage verification remain incomplete. Phase 3 remains NOT_STARTED until Phase 2's host, recovery, and cross-platform acceptance gaps close.
