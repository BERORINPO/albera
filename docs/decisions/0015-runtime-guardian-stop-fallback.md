# ADR 0015: Fall back to the OS process-tree adapter when Guardian control fails

## Status

Implemented for the local Runtime prototype; PID identity and native process ownership remain open.

## Context

The Runtime Gateway asks the Guardian to stop the approved provider tree and waits for an explicit result. If the private control pipe or its acknowledgement fails, signaling only the Guardian may leave the provider running. A direct PID-based fallback also has a stale-ID risk after the provider exits.

## Decision

- When a supervised child's Guardian stop request fails, try the platform process-tree adapter using the provider PID only while the supervisor still reports the provider live and the Guardian process open.
- Treat a successful OS adapter result as tree-stop confirmation. If both the Guardian and OS paths fail, keep `treeStopConfirmed` false and continue cleanup without claiming success.
- If the Guardian has already reported provider exit, do not use its PID for the OS fallback. Preserve an uncertain stop result because descendants cannot be proven gone and the PID may be reused.
- Keep manual stop authorization and existing Windows forceful-stop disclosure unchanged. No caller-supplied PID or signal is accepted.

## Consequences and remaining risks

The OS adapter provides an independent cleanup attempt when the Guardian channel fails. It does not remove the PID reuse race between the liveness check and the OS call, contain breakaway descendants, or guarantee cleanup if both paths fail. Native process handles/Windows Job Objects remain required before treating this as a production-grade boundary. Synthetic tests prove Gateway branching only; they do not simulate a real Guardian pipe failure on each OS.

## Evidence

`test/runtime-gateway.test.mjs` covers a successful injected fallback, both paths failing with an unconfirmed result, skipping the fallback after a provider exit is reported, and an actual OS tree-adapter stop of a synthetic local Node helper when its Guardian stop method is injected to fail. This does not reproduce a real Guardian pipe failure or launch a provider. Cross-platform CI evidence is recorded in `docs/progress.md` after the implementation commit.
