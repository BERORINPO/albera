# Runtime API (Phase 2, isolated prototype)

## Status

`src/runtime/api.mjs` is an authenticated loopback API module. It is not wired to the existing read-only Observer, its HTTP server, its UI, or application startup. A trusted host must create the API and inject a Runtime Gateway. The API does not supply or weaken Gateway authorization; the Gateway's default-deny callback remains authoritative. This prototype is not a user-facing or persistent service.

## Network boundary

- `listen()` binds only to IPv4 `127.0.0.1`; callers cannot choose a public interface. Port `0` is the default.
- The trusted creator can mint up to 256 random 256-bit bearer credentials per session with `health`, `runs:read`, `events:read`, `runs:start`, and `runs:stop` scopes. Each credential is memory-only, expires within 24 hours (one hour by default), and can be revoked independently. Closing the API clears all credentials. The API has no credential-minting route.
- Every route requires `Authorization: Bearer <credential>` with its matching scope. Token hashes are compared in constant time. API authorization grants only the scoped local API access; it does not authorize a process start or stop.
- Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`. If an Origin header is present, it must be the matching HTTP loopback origin. No CORS permission is returned.
- JSON responses use `no-store`, `nosniff`, `no-referrer`, a restrictive CSP and same-origin resource policy. Errors expose stable codes, not exception messages.

## Routes

| Method and route | Behavior |
|---|---|
| `GET /v1/health` | Returns only `{status:"ok"}` |
| `GET /v1/runs` | Returns Gateway run projections with an explicit field allowlist |
| `GET /v1/events?after=&limit=` | Returns bounded lifecycle event projections |
| `GET /v1/events/stream?after=` | Authenticated SSE; up to four clients, 250 ms default polling, 60 second maximum lifetime, and 64 KiB write-buffer cap |
| `POST /v1/runs` | Accepts only `provider`, `cwd`, `prompt`, and optional `profile`; Gateway host authorization still decides whether to start |
| `POST /v1/runs/:id/stop` | Requests a stop through the Gateway, which independently requires host authorization |

Request bodies are JSON and capped at 20 KiB. Output, prompt, paths, argv, and environment are not projected into run/event responses. There is no route for arbitrary argv, caller-supplied confirmation, provider stdin, or filesystem operations.

## Security limits and unfinished work

- Loopback plus a bearer token is not OS-user authentication. A local process that obtains the in-memory credential can use the API. HTTP is not encrypted against privileged local packet inspection. Do not expose or persist the token, and keep the module disconnected from application startup until an explicit host/approval design is reviewed.
- No GUI approval flow, event/audit persistence, reconnection/recovery, provider input, or Runtime API integration tests with real CLIs exist yet.
- The API does not supervise Gateway crashes or establish OS-level process ownership. Phase 1 RT-10 remains blocked; the API must not be run as a persistent service.
- API tests use a fake Gateway and the default-deny real Gateway. No AI CLI is invoked.
