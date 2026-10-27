# Decision 0003: Optional Runtime API event persistence and conservative recovery

Date: 2026-10-27

## Context

The Runtime API and Gateway keep credentials, run state, and lifecycle events in memory. The optional `audit-journal.mjs` already persists redacted start/stop intent and result phases. SSE reconnect and run listing otherwise lose all history when the host process restarts.

## Decision

- Extend the same host-configured, single-writer JSONL journal with a separately typed lifecycle-event record. The journal file has one global sequence for integrity, while API event IDs increase independently per session so one session cannot infer another session's event count from cursor gaps.
- Persist only the Gateway event allowlist: session ID, run ID, provider, event type, timestamp, and optional exit code/signal. Never persist prompt, path, argv, environment, credential, process output, or PID.
- The API polls Gateway events itself while listening, so events continue to be captured without an SSE client. Events whose run owner has not yet been assigned remain in a small bounded pending map and are flushed after ownership is established.
- On API creation, replay the bounded journal into at most 64 recent run projections. Reissue credentials only for the same host-selected session ID to access that session's data. Runs without a captured terminal event become `interrupted`; a new Gateway cannot stop them and returns `409 run_not_active`.
- Any journal write failure permanently disables the API and closes the Gateway. Corrupt, incomplete, over-capacity, or unknown journal records are refused without modifying the existing file.
- Keep the journal optional and disconnected from the read-only Observer, UI, and app startup.

## Consequences and limits

- Event history and conservative run-state recovery survive ordinary API/Gateway reconstruction when the journal is available and the host reuses its session ID.
- A hard crash can occur before the next poll or durable sync; a run may be labeled `interrupted` even if it actually exited. No process is resumed. The Guardian remains responsible for stopping children when its parent disappears, with its existing failure and PID-reuse limitations.
- The journal has a finite row/byte cap, is unencrypted, and has no retention, backup, or compaction policy. Use a user-private directory. Do not enable persistent hosting until those policies, Windows ACL behavior, recovery UX, and crash tests are reviewed.
- The restart contract is currently covered by synthetic Gateway/API reconstruction tests. It does not prove real CLI recovery, app integration, or a production host lifecycle.

## Verification

See `docs/progress.md` for the exact focused and cross-platform test evidence for the implementation commit.
