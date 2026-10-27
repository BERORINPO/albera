# ADR-009 — Live Canvas, Desktop/Browser Drivers and Human Takeover

**Status:** Proposed | **Dependencies:** ADR-002/003/005/008

## Decision
A real-time graph Canvas is a **projection of canonical Control Plane state**, not an independent execution authority. It consumes revisioned read models, subscribes to diff streams, and sends authenticated commands to the separate Control API. Existing Pigeonholes/ALBERA read-only HTTP remains read-only until a separately authenticated boundary is implemented; it must never directly invoke Host Broker or Runtime Gateway.

## Views and interaction
- Project > Task/Agent/Computer graph (typed nodes and edges; DAG and project hierarchy separate from decorative edges).
- Knowledge, Harness, Comprehension graph lenses share stable IDs but distinct graph projections.
- LOD0 groups by project and alerts; LOD1 virtualizes visible task/computer nodes; LOD2 mounts inspector (terminal, browser, desktop, diff, approvals, memory/evidence).
- User edits Canvas node layout without mutating task dependency, ownership or permissions unless an explicit validated semantic command is issued.
- UI must distinguish **observed**, **stale**, **disconnected**, **unknown**, **stopped**; never infer VM shutdown from lost websocket.

## Streaming contract
`GET snapshot {revision, state, observedAt}` then `subscribe({projectId, afterRevision})`. Server publishes monotonically numbered project revisions; read-model snapshots are atomic at given revision. On gap/expired buffer/invalid message, resync snapshot. Persist execution lifecycle and approval decisions before publishing; terminal chunks are bounded with redaction and separate retention. Priority queues: safety & approval > state > output > metrics/video. Rate-limit render updates independently from event ingestion.

## Viewer authorization
Access checked on initial subscription, snapshots, each command and after ACL revision. Do not stream unauthorized computer screenshots or raw terminal contents. Signed artifact URLs short lived and scope-bound. Cross-project tabs are separate authorization contexts. Limit screenshot retention, tokenize/avoid secrets; default recording disabled unless enabled by policy.

## Driver model
`TerminalDriver`: interactive PTY session semantics + resize, bounded I/O, safe stop. `BrowserDriver`: Playwright contexts with isolation for each run; DOM, screenshot and trace. `DesktopDriver`: video frames, screenshot, mouse/keyboard and focus. Drivers execute *inside guest* and report over authenticated channel; GUI support may require a logged-in desktop session and is not implied by a running VM.

## Exclusive Human/AI control
Use desktop-control lease `{desktopSessionId, ownerType: AI|HUMAN, ownerId, generation, expiration, policyVersion}`. Handoff steps: (a) request revoke, (b) stop managed automation input and confirm drain/timeout, (c) increment generation, (d) assign new owner, (e) refresh screenshot/foreground window snapshot, (f) allow commands only with current generation. On uncertain state: lock input and require recovery, not concurrent input. A guest with root/admin could execute unmanaged input: takeover cannot be a security guarantee without OS-level isolation; isolate/stop competing processes where enforceable.

## Computer Use policy
Prefer structured CLI/tool when available; browser DOM automation when reliable; screenshot-driven desktop control when necessary. Every operation needs target Run and Computer, explicit allowed actions and purpose. Clipboard, paste, file chooser, browser credential store and password fields are controlled resources. Financial transactions, credential handling, external posting and destructive actions require host-mediated approval. Video/screen content is untrusted data and subject to prompt-injection controls.

## UI implementation strategy
First benchmark existing DOM canvas; avoid a framework rewrite as a precondition. Use viewport culling, fixed-size event diff batches, memoized node render, stable animation frames and off-main-thread layout only when measurement warrants. Inspector streams opt-in and low framerate when backgrounded. Accessibility and reduced-motion support required.

## Test plan
- Functional: select/zoom, status states, restart/backfill, revision gaps, offline, 500 visible nodes, 10k total nodes with LOD.
- Security: unauthorized subscribe, ACL change during stream, stale-lease input injection, guest malicious event, clipboard/redaction, disconnected screenshot.
- Takeover: 20 rapid transfer races, reconnect old AI, guest process refuses stop, human session closed while key held, mouse release/cancel.
- Performance: >=1k event/s synthetic ingestion with UI batching; report p50/p95 event-to-projection and frame render latency on fixed hardware (not asserted achieved).

## References
- https://playwright.dev/docs/browser-contexts
- https://developers.openai.com/blog/codex-as-a-platform