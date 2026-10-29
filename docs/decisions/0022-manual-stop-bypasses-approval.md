# ADR 0022: Manual stop bypasses approval

Date: 2026-10-29

## Status

Accepted.

## Context

Manual stop used the same approval broker as launch and provider input. If the approval UI was unavailable or denied the request, an active or runaway run could not be stopped through the control UI. Gateway timeouts and orderly host shutdown already stop without approval.

## Decision

Manual stop proceeds immediately after the session-scoped Runtime API authorizes access to that run. It does not call or wait for the host approval callback. Start and provider input continue to require explicit approval. The `stop_requested` lifecycle event records `force: true` on Windows and `false` on other platforms; the API and audit journal preserve that field. The control UI states that stop is immediate and Windows terminates the process tree forcefully.

This is fail-safe for runaway execution: cancellation reduces risk and must remain available when the approval UI is unavailable. The lifecycle event is the host notification; it does not block the stop path.

## Consequences and residual concern

- Stop approval requests are no longer accepted or shown by the approval broker/UI. Scoped API authorization, CSRF checks, and the audit journal remain in place.
- A stop can accidentally terminate a legitimate run. The UI labels the action as immediate, and Windows forceful termination is disclosed and recorded.
- Provider start and input still wait for explicit host approval.
