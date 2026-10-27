# ADR 0009: Prompt Runtime lifecycle event capture

Date: 2026-10-27

## Status

Implemented; GitHub Actions run 40486837838 passed all six Windows/macOS/Linux × Node 22/24 jobs on `d1d83ef`.

## Context

The Runtime API previously discovered lifecycle events only by polling the Gateway's bounded event ring. A short-lived terminal event could be lost if the host crashed after emission and before the next poll. Polling also delayed persistence and UI availability by up to the poll interval.

## Decision

- The Gateway supports a bounded set of trusted lifecycle subscribers and notifies them synchronously after placing an immutable event in its existing bounded ring.
- The API subscribes when created and immediately captures from the Gateway ring when notified. It keeps periodic polling as a safety net for missed notifications and custom Gateway implementations.
- API start handling performs another capture pass after assigning the run's owning session, covering the race where `started` is emitted while the accepted-start audit record is still being written.
- API close unsubscribes. Listener exceptions cannot interrupt Gateway lifecycle transitions.
- Notifications carry only the same allowlisted lifecycle event projection; they never include prompt/input text, executable, path, argv, environment or process output.

## Consequences and limits

- Journal capture starts on the same event turn rather than waiting for the polling interval. Each append now writes the complete record and synchronously calls `fsync` before returning its Promise, so the API's `await` does not yield before the flush attempt completes.
- Gateway event storage remains bounded and the existing poll remains as a recovery backstop.
- A host or system crash during the write/flush can still leave a partial or non-durable tail. Startup preserves and refuses an incomplete journal rather than truncating it. Synchronous flush can block the Runtime event loop on slow storage. This change does not recover or relaunch active processes.
- API-03 remains in progress until crash ownership, durable event capture limits, GUI acceptance, backup/retention policy, and packaging are addressed.

## Verification

Verification: `test/runtime-audit-journal.test.mjs` proves record bytes are present and the injected sync operation has completed before `append()` returns its Promise; API event-capture tests verify notification-driven persistence before the safety poll. Latest cross-platform evidence for the earlier async implementation is Actions run 40486837838; the synchronous durability change requires a new matrix run. No AI CLI was invoked.
