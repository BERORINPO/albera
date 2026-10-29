# ADR 0015: Fall back to the OS process-tree adapter when Guardian control fails

## Status

Implemented as a legacy cleanup adapter; it never provides process-tree confirmation. PID identity and native process ownership are handled by ADR 0020 for Windows Job-managed runs.

## Context

The Runtime Gateway asks the Guardian to stop the approved provider tree and waits for an explicit result. If the private control pipe or its acknowledgement fails, signaling only the Guardian may leave the provider running. A direct PID-based fallback also has a stale-ID risk after the provider exits.

## Decision

- When a supervised child's Guardian stop request fails, try the platform process-tree adapter using the provider PID only while the supervisor still reports the provider live and the Guardian process open.
- Treat a POSIX process-group adapter result according to its own group signal evidence. On Windows, taskkill success is only a cleanup request and is not tree-stop confirmation; only ADR 0020's Job Object active-process count can confirm a Windows tree.
- If the Guardian has already reported provider exit, do not use its PID for the OS fallback. Preserve an uncertain stop result because descendants cannot be proven gone and the PID may be reused.
- Manual stop bypasses approval under ADR 0022; preserve Windows forceful-stop disclosure in the control UI and lifecycle event. No caller-supplied PID or signal is accepted.

## Consequences and remaining risks

The Windows taskkill adapter can still issue a PID-based request on legacy non-Job paths. It has a PID reuse race and cannot contain or prove the state of descendants. Job-managed Windows launches never use this fallback. Synthetic tests cover the Gateway branch and a separate real Windows Job integration covers the implemented Job boundary; service hosting and all supported outer-job configurations are not verified.

## Evidence

`test/runtime-gateway.test.mjs` covers injected fallback success/failure and skipping PID fallback after provider exit. `test/windows-tree-termination.test.mjs` verifies taskkill success remains unconfirmed. The actual Windows Job evidence and current CI run are recorded in `docs/progress.md`. No real provider was launched.
