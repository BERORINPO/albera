# 0004 — Host-controlled Runtime approval broker

- Status: Accepted for the isolated Runtime prototype
- Date: 2026-10-27

## Context

`RuntimeGateway` requires a trusted host callback and defaults to denial. The current product UI and read-only HTTP server are intentionally disconnected from it. An approval UI needs an asynchronous way to present an immutable launch/input/stop request, wait for a human choice, and ensure that task credentials cannot make that choice themselves.

## Decision

Add an in-process approval broker that can be passed as the Gateway's `authorize` callback. It projects only the provider, action, canonical executable and working directory, fixed arguments, exact initial/follow-up input, redacted environment names and endpoint metadata, resource caps, and stop context needed for a decision. Each request has a random one-use ID, a bounded queue, a maximum five-minute lifetime (two minutes by default), and a default-deny result on timeout, queue overflow, broker close, invalid request, or ID collision.

The broker's `decide` method remains a trusted-host capability. It must not be exposed through a run-control credential or any caller-supplied confirmation field. The Runtime API now exposes pending requests and decisions through separately minted `approvals:read` and `approvals:decide` scopes. A product host must reserve those capabilities for its trusted approval UI, never share them with task clients, and display exact prompt/input and provider account/endpoint context before approving.

## Consequences

- The Gateway can now wait on a human-controlled host decision without weakening its default-deny boundary; the loopback API can deliver that request to a separately authorized approval client.
- Unit and Gateway integration tests exercise both explicit approval and denial without invoking a real CLI.
- The broker and approval routes are not yet wired to the local application server or product UI; therefore they do not enable product launches or satisfy approval UX acceptance criteria.
- Approval requests contain task content for display. A future UI must render it as text, keep tokens out of persistent storage, expire/revoke its decision capability, and preserve exact request identity.
