# ADR 0002: Parent-Liveness Guardian for Runtime Child Processes

## Status

Implemented as a containment layer; its helper-process and architecture matrix passed on Windows/macOS/Linux × Node 22/24 (Actions run 40465491826). Stronger OS-level ownership remains pending.

## Context

`RuntimeGateway` previously spawned provider processes directly. A Gateway crash closes ordinary parent-child bookkeeping but does not, by itself, guarantee descendant cleanup. Node documents that detached processes can continue after their parent exits and that POSIX detached children start a new process group/session. Windows Job Objects provide a stronger kernel-owned process group and can terminate associated processes when the last job handle closes.

## Decision

The default Gateway spawn path starts a fixed local Node guardian and sends the approved executable, argv, cwd and child environment over a private stdin pipe. The pipe remains open only while the Gateway is alive. If it reaches EOF, the guardian terminates the provider process group/tree and exits. The provider still receives the already-authorized launch tuple, uses `shell: false`, and writes no output to ALBERA.

This adds no runtime package dependency and does not connect the Gateway to the Observer, UI or application startup. The Guardian receives only a minimized process environment; provider credentials and prompt data are sent through the private pipe, not its argv or environment.

## Limits

- This verifies containment when the Gateway host disappears, not when the Guardian itself is forcibly terminated or crashes.
- POSIX cleanup uses process groups; descendants that deliberately create a new session can escape that group.
- Windows tree termination uses `taskkill /T /F`; the Guardian now checks its exit status and attempts to kill the direct child if taskkill fails. This cannot prove descendant cleanup after a failed tree kill. PID reuse and forceful termination remain risks; a native Job Object helper with controlled process creation is still needed for stronger guarantees.
- Run/event state is memory-only. The Guardian kills an active provider after parent loss; it does not restore a run or audit history after restart.
- The API remains disconnected and must not be hosted persistently.

## Evidence

`test/process-supervisor.test.mjs` kills a separate RuntimeGateway host running a synthetic local Node helper and verifies that its heartbeat stops. Existing orderly stop and descendant-stop integration tests also cover the normal termination path. Actions run 40465491826 passed tests and architecture checks for Windows/macOS/Linux × Node 22/24; local Windows Node 24.13.0 `npm test` passed 446/446. These tests never invoke a real AI CLI. RT-10 is verified for this contained, disconnected prototype; persistent restart recovery and stronger process ownership remain blocked and are not claimed.

## References

- [Node.js child process documentation](https://nodejs.org/api/child_process.html#optionsdetached)
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Linux PR_SET_PDEATHSIG](https://www.man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)
