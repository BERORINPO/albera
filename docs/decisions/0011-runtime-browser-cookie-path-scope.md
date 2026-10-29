# ADR 0011: Scope Runtime browser cookies to a per-process URL prefix

## Status

Accepted

## Context

Browser cookies are scoped by host and path, not by port. The approval host listens on a loopback port, but an HttpOnly cookie scoped to `/` can still be sent by a browser to another service on the same loopback hostname and a different port. `SameSite=Strict` does not provide port isolation. [RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5) explicitly warns that cookies do not isolate mutually distrusting services on different ports; §8.6 also cautions against treating Path as a reliable security boundary.

## Decision

- Generate a fresh 128-bit random path prefix for each Runtime approval host.
- Serve its UI and fixed API proxy routes only below that prefix.
- Set the browser session cookie `Path` to the same prefix.
- Reissue the same scoped cookie on every authenticated request so the browser's idle expiry follows the server-side sliding idle TTL.
- Keep the one-time bootstrap code separate and out of the URL.
- Treat the path prefix as routing isolation, not an authentication factor. Continue to rely on the one-time code, HttpOnly session cookie, Host/Origin validation, CSRF token, and default-deny approval broker.

## Consequences

The browser will not send this cookie to ordinary paths on another loopback port, reducing accidental exposure when the sibling service does not know the random prefix. This is defense in depth only: the URL path may be observed, and cookie path scoping is not a security boundary. Runtime URLs are now per-process and should be treated as ephemeral. A local process that can observe the URL and bootstrap code, inspect the browser, or access the user session remains inside the documented local trust boundary; this does not provide OS-user authentication or protect against privileged local inspection. R-14 remains open until a stronger local identity/origin boundary is implemented.

## Verification

`test/runtime-approval-host.test.mjs` verifies the random path-scoped `Set-Cookie` attribute on bootstrap, session refresh, and authenticated API activity; refuses API routes outside the prefix; and exercises the composed approval host through the prefixed URL. The authenticated read-only screen was separately inspected in a real browser and recorded in `docs/progress.md`; this does not establish browser acceptance of approval decisions or start/input/stop action flows.
