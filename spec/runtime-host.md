# ALBERA Runtime Host (prototype)

## Purpose and separation

`albera-runtime` starts an opt-in local execution host. It is a separate entry point from `albera`, which continues to start the read-only Claude session dashboard. The Observer, its HTTP handler, adapters, and product canvas do not import or serve Runtime code.

The Runtime process composes `RuntimeGateway`, the default-deny approval broker, the authenticated loopback Runtime API, the redacted JSONL journal, and a separate browser host. The API listens on an ephemeral IPv4 loopback port and keeps its random bearer capability in the server process. The browser host proxies a fixed allowlist of API routes; it never returns the bearer capability to JavaScript.

## Start

The command requires one or more absolute project roots and an absolute audit-journal path:

```text
albera-runtime --root <absolute-project-directory> --journal <absolute-jsonl-path> [--root <another-directory>] [--port <0-65535>]
```

The default port is `0` (an OS-selected free port). The command prints the local URL and a one-time bootstrap code. Enter that code in the screen to mint a short-lived browser session. The code is held only in memory, can be used once, is not put in the URL, and is not written to the journal. The browser cookie is HttpOnly, SameSite=Strict and host-only; its companion CSRF token stays in page memory. Authenticated same-origin API activity refreshes the 20-minute idle expiry and cookie lifetime; an inactive session expires. Browser sessions have an absolute eight-hour lifetime from bootstrap, which API activity cannot extend. The server-only API capability has a matching eight-hour lifetime. After the browser session reaches its absolute limit, restart the Runtime process to issue a new one-time bootstrap code. Closing the Runtime process invalidates its sessions and denies pending approvals.

The CLI requires a journal so accepted/denied control decisions and captured lifecycle events are audited. The journal creates its parent directory with private POSIX mode and a file with mode `0600`. On Windows it reads the directory and existing file DACLs before storage access; startup fails closed if inspection fails, the DACL is absent or contains deny entries, the current user lacks Full Control, or another principal receives data/ACL rights. It never repairs ACLs or modifies existing data during verification. A sibling `<journal>.session-id` file stores a random, non-secret 128-bit API session identity with mode `0600` on POSIX and the same DACL check on Windows. The journal is append-only, bounded, unencrypted, and never stores prompts, paths, argv, environment values, bearer tokens, or provider output. Windows DACL policy and its integration step passed all six Windows/macOS/Linux × Node 22/24 jobs in Actions run 40487083932; this does not establish OS-user authentication or production storage recovery. See decision 0005.

## Browser boundary

- Both servers bind to `127.0.0.1`; the API port and credential are not displayed.
- The approval URL has a random per-process path prefix, and the HttpOnly browser cookie is scoped to that path. Browsers do not scope cookies by port, so this reduces cookie delivery to ordinary routes on sibling loopback services. Cookie Path is defense in depth, not a security boundary or authentication factor ([RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5)); the bootstrap code remains separate.
- The browser host accepts only `127.0.0.1:<port>` or `localhost:<port>` Host values, rejects cross-site fetches, and requires an exact Origin plus a per-session CSRF token for mutations.
- The browser session uses a random cookie token stored as a hash by the host. The API bearer is separate and server-side. The browser has no credential minting, arbitrary proxy, file, shell, or raw argv route.
- `Content-Security-Policy` permits only same-origin scripts/styles/connections. Request content is rendered with DOM `textContent` and element creation; no HTML-string insertion is used.
- Run start, input, and stop requests wait for the broker decision. The screen shows exact prompt/input and the projected executable, working root, fixed arguments, resource caps, endpoint host/protocol, and environment variable names before approval. Start/input screens and each approval card disclose that approved text may be sent to an external provider and may incur charges; Runtime cannot identify the configured account or estimate cost.
- Lifecycle events are relayed as bounded SSE. Process stdout/stderr and model responses are discarded; the UI cannot show provider replies. Follow-up input therefore may be sent only when the user independently knows the provider is ready.

## Current limits

- This prototype has synthetic process tests, not browser GUI acceptance or a real CLI compatibility test. Claude is the only profile constructed; Codex and OpenCode remain unavailable.
- The configured project roots are an allowlist for the working directory only. They do not sandbox the CLI or stop it accessing other files under the current OS account.
- The standard read-only Claude profile places the prompt in the provider argument vector, which may be visible to same-user process inspection. The streaming profile keeps initial input out of argv, but its installed CLI compatibility is unverified.
- The screen selects Japanese or English from the browser language and falls back to English. This is code-tested with a synthetic DOM, not manually accepted in a browser. It does not identify the configured provider account or estimate API cost.
- The stable session identity lets the API replay journaled run/event projections after restart. `test/runtime-approval-host.test.mjs` now exercises the composed host across journal close/reopen: a synthetic run is stopped during host shutdown, and the next host restores the completed run and its lifecycle events. Active process recovery is not implemented; runs without captured terminal events return as `interrupted`, and the Guardian is expected to stop child trees when the host exits.
- Loopback HTTP is not OS-user authentication or protection from privileged local packet inspection. A local process that can read the terminal bootstrap code can unlock the browser host.
- This Runtime command does not join the regular Observer or canvas, and it is not a persistent service or production package integration.
