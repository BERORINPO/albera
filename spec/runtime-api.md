# Runtime API (Phase 2, isolated prototype)

## Status

`src/runtime/api.mjs` is an authenticated loopback API module. It is not wired to the existing read-only Observer, its HTTP server, its UI, or application startup. A trusted host must create the API and inject a Runtime Gateway. The API does not supply or weaken Gateway authorization; the Gateway's default-deny callback remains authoritative. This prototype is not a user-facing or persistent service.

## Network boundary

- `listen()` binds only to IPv4 `127.0.0.1`; callers cannot choose a public interface. Port `0` is the default.
- The trusted creator can mint up to 256 random 256-bit bearer credentials with `health`, `runs:read`, `events:read`, `runs:start`, and `runs:stop` scopes. By default, each credential receives its own private, in-memory session boundary; runs started by that session and their events are visible only to it. A trusted host may intentionally reuse a validated 32-character session ID for multiple credentials in one process. Other sessions cannot list those runs, read their events/SSE, or stop them (foreign run IDs return 404). Credentials expire within 24 hours (one hour by default), can be revoked independently, and are cleared when the API closes. The API has no credential-minting route.
- The host may inject an `audit-journal.mjs` instance, and must provide a Gateway with `close()` so the API can fail closed. When present, API start/stop requests write a requested phase before calling the Gateway and an accepted/denied/failed result afterward. The API also polls and persists allowlisted lifecycle events (`started`, stop transitions, `stopped`, `exited`, `failed`) with monotonically increasing, per-session event IDs. Records contain only session/request IDs, action/phase or event type, timestamp, provider, run ID and stable error/result metadata; never credential values, prompts, paths, argv, environment or process output. Any journal write failure permanently disables the API and closes the Gateway.
- Every route requires `Authorization: Bearer <credential>` with its matching scope. Token hashes are compared in constant time. API authorization grants only the scoped local API access; it does not authorize a process start or stop.
- Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`. If an Origin header is present, it must be the matching HTTP loopback origin. No CORS permission is returned.
- JSON responses use `no-store`, `nosniff`, `no-referrer`, a restrictive CSP and same-origin resource policy. Errors expose stable codes, not exception messages.

## Routes

| Method and route | Behavior |
|---|---|
| `GET /v1/health` | Returns only `{status:"ok"}` |
| `GET /v1/runs` | Returns Gateway run projections with an explicit field allowlist |
| `GET /v1/events?after=&limit=` | Returns bounded lifecycle event projections |
| `GET /v1/events/stream?after=` | Authenticated SSE; resumes from a validated `Last-Event-ID` header (which takes precedence over `after`), up to four clients, 250 ms default polling, 60 second maximum lifetime, and 64 KiB write-buffer cap |
| `POST /v1/runs` | Accepts only `provider`, `cwd`, `prompt`, and optional `profile`; Gateway host authorization still decides whether to start |
| `POST /v1/runs/:id/stop` | Requests a stop through the Gateway, which independently requires host authorization |

Request bodies are JSON and capped at 20 KiB. Output, prompt, paths, argv, and environment are not projected into run/event responses. Runs created outside the API or under another API credential are not visible to a session. There is no route for arbitrary argv, caller-supplied confirmation, provider stdin, or filesystem operations.

## Security limits and unfinished work

- Loopback plus a bearer token is not OS-user authentication. A local process that obtains the in-memory credential can use the API. HTTP is not encrypted against privileged local packet inspection. Do not expose or persist the token, and keep the module disconnected from application startup until an explicit host/approval design is reviewed.
- The optional journal persists API start/stop decisions and captured lifecycle events. On API/Gateway restart, it replays events for the same host-reissued session ID and restores up to 64 recent run projections; any run without a captured terminal event is conservatively marked `interrupted` and cannot be stopped through the new Gateway instance. Per-session event IDs do not expose other sessions' event counts. Events are collected by the API poller and can be missed if the host crashes before a poll; this does not restore a running process. Retention/backup policy and long-term compaction are not implemented. The journal is single-writer, append-only, bounded, validates all existing records, and refuses corrupt/incomplete data without changing it. Use a user-private directory; the journal is not encrypted. It is not connected to application startup. No GUI approval flow, provider input, or Runtime API integration tests with real CLIs exist yet.
- The Gateway default spawn path has a parent-liveness guardian. Phase 1 RT-10 is verified for the disconnected prototype's tested crash/stop contract; Guardian failure, Windows PID reuse, durable event history and run-state recovery remain unresolved. The API must not be run as a persistent service.
- API tests use a fake Gateway and the default-deny real Gateway. No AI CLI is invoked.
