# ADR 0017: Revoke the approval host capability when its UI closes

## Status

Accepted

## Context

The Runtime composition root begins Gateway shutdown synchronously, then closes the browser-facing approval host and flushes lifecycle events before closing the Runtime API. The approval host owns a server-side API credential with the full scope set used by its proxy. Clearing browser sessions alone did not revoke that API credential, leaving a privileged capability valid during the shutdown interval.

## Decision

The approval host revokes its private API credential whenever it closes, including when it is instructed to leave API shutdown to the composition root. The composition root invokes `gateway.close()` before its first await, so new or already-authorized actions cannot reach a process after shutdown begins; Gateway cleanup and final event capture still complete before API closure.

## Consequences

- No new Runtime API request using the approval host capability is authorized after the approval host closes.
- The Runtime API can remain open briefly for trusted Gateway shutdown and event flushing.
- Read-only requests already authenticated before revocation may finish. Runtime actions that reach the Gateway after shutdown begins are rejected, and an input approved just before shutdown cannot be written after the Gateway enters closing state.
- Runtime shutdown closes the approval broker while closing the API, so pending authorizations settle without spawning a provider. The browser request may be disconnected because the approval host closes first; the journal records the terminal `failed` or `denied` phase.
- A regression test verifies that the host capability receives a successful API response before close and HTTP 401 after close while the API is still listening.
- This does not provide OS-user authentication or protect the loopback service from other processes running as the same user.
