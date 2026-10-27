# Acceptance Criteria

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `VERIFIED`. Every `VERIFIED` item must link to reproducible evidence in `docs/progress.md`.

## Phase 1 — Runtime Foundation

| ID | Acceptance criterion | Status | Evidence |
|---|---|---|---|
| RT-01 | Runtime Gateway is isolated; read-only HTTP server, Observer adapters and board cannot import or invoke it | VERIFIED | `npm run arch`: current tree reports runtime isolation `0 violations` |
| RT-02 | Lifecycle states and transitions are explicit, idempotent under concurrent start/stop, and race-tested | VERIFIED | `node --test test/runtime-gateway.test.mjs`: concurrent start reservation and concurrent/repeated stop cases pass |
| RT-03 | Start and stop require a host-provided approval decision; a request boolean cannot authorize execution | VERIFIED | Focused tests: default deny, caller boolean ignored, stop denial, immutable launch tuple and redacted provider environment summary; pre-approval argv and environment snapshots are reused for spawn despite caller mutation. Host UI itself is not implemented |
| RT-04 | Provider executable is resolved from a fixed provider allowlist, canonicalized, checked as executable, and never interpreted by a shell | VERIFIED | Resolver test uses a temporary executable fixture; helper integration uses injected Node executable; spawn asserts absolute path and `shell:false`; no AI CLI invoked |
| RT-05 | Working directory is canonicalized and restricted to configured roots; this scope is accurately distinguished from an OS sandbox | VERIFIED | Focused test rejects outside/missing roots and verifies a junction escape where OS permits; spec states this is not a sandbox |
| RT-06 | Arguments and environment are bounded/allowlisted; raw launch data is not logged; provider-specific safe profiles are explicit | IN_PROGRESS | The Gateway generates fixed read-only Claude Code argv, rejects caller argv, prefixes prompts against option parsing, and refuses Codex/OpenCode until external tool/configuration side effects can be excluded; profile construction and limits have focused tests. Actual Claude CLI version/behavior compatibility is still unverified and required before provider integration. |
| RT-07 | Active concurrency and run duration are bounded; OS resource-limit gaps are explicit | VERIFIED | Tests cover concurrent reservation and automatic timeout; active cap is 4, default timeout 15 minutes, maximum 60 minutes; no CPU/memory quota |
| RT-08 | Start, stop, exit and error events are bounded and redact paths, args, env and process output | VERIFIED | Focused tests verify 256 event retention, cursor paging, and omission of synthetic argv/path; local helper output is ignored |
| RT-09 | POSIX and Windows stop adapters handle process trees, escalation and repeated stop safely | VERIFIED | Local Windows helper-process tree test confirms `/T /F` stops the descendant heartbeat; Windows stop is disclosed as forceful. Draft PR #9 Actions run 40461054915 passed all six tests/architecture jobs on Windows, macOS and Linux with Node 22 and 24 |
| RT-10 | Abnormal exit, gateway shutdown/restart and orphan-process behavior are tested or explicitly blocked with a safe alternative | BLOCKED | Tests cover abnormal exit, orderly `close()`, rejection of a start awaiting approval when close begins, and rejection of new starts after close. Crash/restart orphan recovery needs platform-native process ownership. Safe alternative: keep Gateway disconnected and do not host it as a persistent service |
| RT-11 | Unit tests, OS process integration tests and architecture checks pass; fake/provider-helper results are clearly distinguished from real AI CLI checks | VERIFIED | Local Windows Node 24.13.0: 24 focused runtime tests and 436 full tests pass; arch and smoke pass locally. Draft PR #9 Actions run 40461054915 passed tests and architecture checks across Windows/macOS/Linux × Node 22/24; hosted CI omits user-data-dependent smoke; no real AI CLI was invoked |
| RT-12 | No real CLI provider is invoked without explicit user-visible approval; existing Observer behavior remains read-only | VERIFIED | Runtime module is not imported by HTTP/UI/entry; integration test launches only a synthetic local Node helper, never a real AI CLI |

## Product v1.0

| ID | Acceptance criterion | Status | Evidence |
|---|---|---|---|
| V1-01 | Real CLI launch, monitor, input and cancellation through a secure Runtime API | NOT_STARTED | — |
| V1-02 | Real Agent Canvas lifecycle projection and approved task assignment | NOT_STARTED | — |
| V1-03 | Multi-agent orchestration with dependency, retry and human approval policies | NOT_STARTED | — |
| V1-04 | Isolated Git worktree and PR workflow | NOT_STARTED | — |
| V1-05 | Knowledge, Harness and Comprehension functions backed by actual project data and evidence | NOT_STARTED | — |
| V1-06 | Cross-platform E2E, GUI acceptance, security and performance verification | NOT_STARTED | — |
| V1-07 | Install, migration and user docs ready for ALBERA v1.0 | NOT_STARTED | — |
