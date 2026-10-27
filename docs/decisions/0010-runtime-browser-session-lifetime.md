# ADR 0010: Bounded Runtime browser session lifetime

Date: 2026-10-27

## Status

Accepted by the user; implementation and cross-platform verification in progress.

## Context

The Runtime approval screen polls authenticated API routes to refresh runs and approvals. A fixed short browser-session timeout would invalidate a screen that remains in use. Renewing on every authenticated request without a maximum lifetime would let the page's background polling preserve the session indefinitely.

## Decision

- Keep a 20-minute idle timeout and refresh it only after an authenticated, valid same-origin request passes the Host/Origin and, for mutations, CSRF checks.
- Apply an eight-hour absolute maximum from browser bootstrap. Activity cannot extend the session beyond this limit.
- Set the HttpOnly cookie `Max-Age` to the remaining idle time, capped by the remaining absolute lifetime.
- Give the server-only Runtime API capability an eight-hour lifetime. It is never returned to the browser or persisted.
- After absolute expiry, the operator must restart the Runtime host to receive a fresh one-time bootstrap code; closing the host invalidates browser sessions and API credentials.

The user explicitly selected the 20-minute idle timeout plus eight-hour absolute cap. Background UI polling counts as authenticated activity, but the absolute cap prevents indefinite renewal.

## Consequences

- An active UI remains usable beyond 20 minutes without removing the idle timeout.
- A left-open UI cannot remain authenticated beyond eight hours from bootstrap.
- Runtime restart remains the recovery path after absolute expiry; active provider processes are not restored by restart.
- Loopback still does not authenticate OS users or protect against privileged local packet inspection.

## Verification

Synthetic HTTP tests use a controlled clock to verify active idle renewal, cookie `Max-Age` capping at the absolute limit, expiry after inactivity, expiry at the eight-hour maximum, and no renewal on invalid CSRF/Origin. No real provider process is used. Cross-platform CI evidence will be appended after the implementation commit completes its matrix.
