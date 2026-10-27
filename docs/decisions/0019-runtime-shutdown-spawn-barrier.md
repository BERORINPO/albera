# ADR 0019: Recheck Gateway shutdown immediately before spawning

Date: 2026-10-28

## Status

Implemented; Actions run 40587255056 passed all six Windows/macOS/Linux × Node 22/24 jobs.

## Context

`RuntimeGateway.start()` performs asynchronous work after host approval: a bounded provider version probe and final executable type/identity checks. Shutdown can complete while one of these operations is pending. Checks performed earlier in `start()` do not prevent a delayed continuation from spawning after `close()` has returned.

## Decision

Check the Gateway closing state after the final asynchronous executable identity validation and immediately before `spawn()`, with no intervening `await`. If shutdown has begun, reject with `gateway_closed` and do not create a run.

## Consequences

- A trusted host can finish shutdown while a version probe is pending; when it resolves, the start request cannot spawn afterward.
- The executable identity checks remain in place. This change only closes the lifecycle race and does not remove the OS-level replacement race between the last identity check and `spawn()`.
- A synthetic regression holds the version probe, awaits completed Gateway shutdown, releases the probe, and verifies a `gateway_closed` result, zero spawn calls, and no run records.
- Windows Node 24.13.0: `npm test` 558 passed / 6 skipped, `npm run arch`, `npm run smoke`, `npm run package:smoke`, and `git diff --check` passed. Actions run [40587255056](https://github.com/BERORINPO/pigeonholes/actions/runs/40587255056) passed all six Windows/macOS/Linux × Node 22/24 jobs, including Windows Runtime storage ACL integration.
