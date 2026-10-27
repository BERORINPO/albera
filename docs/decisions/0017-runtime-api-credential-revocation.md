# ADR 0017: Revoke the approval host capability when its UI closes

## Status

Accepted

## Context

The Runtime composition root closes the browser-facing approval host first, then stops the Gateway and flushes lifecycle events before closing the Runtime API. The approval host owns a server-side API credential with the full scope set used by its proxy. Clearing browser sessions alone did not revoke that API credential, leaving a privileged capability valid during the shutdown interval.

## Decision

The approval host revokes its private API credential whenever it closes, including when it is instructed to leave API shutdown to the composition root. The composition root remains responsible for shutting down the API after Gateway cleanup and final event capture.

## Consequences

- No new Runtime API request using the approval host capability is authorized after the approval host closes.
- The Runtime API can remain open briefly for trusted Gateway shutdown and event flushing.
- Requests already authenticated before revocation are not canceled by credential revocation; API shutdown remains the final barrier.
- A regression test verifies that the host capability receives a successful API response before close and HTTP 401 after close while the API is still listening.
- This does not provide OS-user authentication or protect the loopback service from other processes running as the same user.
