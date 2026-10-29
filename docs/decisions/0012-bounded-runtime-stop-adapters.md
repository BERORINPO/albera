# ADR 0012: Bound Runtime stop-adapter waits

Date: 2026-10-28

## Status

Accepted

## Context

The Windows Runtime stop adapter waits for `taskkill.exe` to close. A stalled helper could leave an explicit stop request pending, and Gateway shutdown previously awaited stop requests before starting its configured close timeout. That made `close({ timeoutMs })` ineffective when a stop adapter never returned.

## Decision

- Bound `taskkill.exe` completion to five seconds in both the Guardian and Gateway OS fallback paths.
- On timeout, attempt to kill the helper process, then fall back to signaling only the direct provider child.
- Report that fallback as unconfirmed for descendants; do not treat helper termination or direct-child acceptance as proof of process-tree cleanup.
- Start shutdown stop requests immediately, but apply the caller's timeout across both stop-adapter and process-close waits.

## Consequences

Stop and shutdown callers now return within a finite bound even if the OS helper stalls. A timeout does not prove that the taskkill helper exited or that descendants stopped; the Gateway returns active run IDs as uncertain when its timeout expires. Native Windows Job Objects and process-handle identity remain necessary before persistent hosting.

## Verification

Synthetic regressions cover a taskkill timeout, helper kill attempt, direct-child fallback classification, Gateway close while a stop adapter remains unresolved, and a child close arriving before that adapter returns. Windows Node 24.13.0 focused Runtime tests: 62/62; full `npm test`: 537 passed / 5 skipped (542 total); `npm run arch`: 83 paths / 0 violations; `npm run smoke` and `npm run package:smoke` passed. Cross-platform Actions verification is pending for the current code change. No provider CLI was launched.
