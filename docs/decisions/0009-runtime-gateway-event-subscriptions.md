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

- Journal capture normally starts on the same event turn rather than waiting for the polling interval.
- Gateway event storage remains bounded and the existing poll remains as a recovery backstop.
- Capture and journal append are asynchronous. A hard host crash before the append completes can still lose the final event, and this change does not recover or relaunch active processes.
- API-03 remains in progress until crash ownership, durable event capture limits, GUI acceptance, backup/retention policy, and packaging are addressed.

## Verification

Local Windows Node 24.13.0: `node --test test/runtime-api.test.mjs test/runtime-gateway.test.mjs` passed 59/59; full `npm test` passed 501 with 3 skips; `npm run arch` reported 82 paths and 0 violations; `npm run smoke` passed; `git diff --check` passed. GitHub Actions run 40486837838 passed all six Windows/macOS/Linux × Node 22/24 test and architecture jobs on `d1d83ef`. The journal-capture test uses a synthetic Gateway notification and confirms persistence before its 1-second safety poll. No AI CLI was invoked.
