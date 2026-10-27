# Decision 0001: Keep Runtime Gateway outside the Observer

- Date: 2026-10-27
- Status: Accepted for Phase 1

## Decision

Implement process lifecycle in `src/runtime/` as a separate boundary. The current read-only server, adapters, board and UI cannot import it. Phase 1 does not add HTTP routes, UI controls, persistence, or real provider invocation. Authorization is a host-injected callback that defaults to deny and receives an immutable exact launch tuple plus a redacted snapshot of provider environment metadata; request-supplied confirmation booleans are not accepted. Arguments and the child environment are snapshotted before authorization and reused for spawn so caller mutation or a changing parent environment cannot alter the approved launch.

## Rationale

The existing server is a read-only observer of local Claude session files. Adding process authority to its request surface would expand a security boundary and make the existing read-only guarantee misleading. A separately reviewable runtime foundation allows provider launch/stop policy to be tested without altering the Observer.

## Consequences

- The approval UI/API and provider-specific safe argument profiles must be completed before real CLI integration. Approval metadata may identify provider environment variable names and endpoint protocol/host, but never contains credentials, endpoint paths, queries or fragments.
- The executable resolver accepts only fixed provider IDs, resolves an absolute path, and checks the file and executable bit on POSIX; executable identity and replacement races remain open.
- Process ownership, OS sandboxing, Windows command shims and restart recovery remain open or deferred risks in `docs/risks.md`.
- Phase 2 may define a separate authenticated Runtime service; it must not reuse Observer routes as an execution API.
