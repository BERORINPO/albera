# Runtime Gateway (Phase 1 foundation)

## Scope and status

`src/runtime/gateway.mjs` is an isolated, in-memory process lifecycle foundation. The existing local dashboard remains a read-only Claude Code session observer. No Observer layer, HTTP route, UI control, persistence layer or orchestration code imports this module. Tests use fakes and a local Node.js helper process; no AI CLI is invoked.

This module is not yet a user-facing Runtime feature and is not an OS sandbox. It is not ready to expose through an API.

## Launch contract

- A trusted host must inject an `authorize` callback. The default callback denies. A request field such as `confirmed: true` cannot authorize a launch or stop.
- For a start decision, the callback receives an immutable tuple containing the action, fixed provider ID, canonical executable path, canonical working directory and exact argv array. The host must show that tuple to the user and bind approval to that exact request. The module has no route or UI that implements this host contract yet.
- Provider IDs are fixed to `claude`, `codex` and `opencode`. A provider selects its command name; callers cannot choose an executable.
- The command is resolved from PATH, canonicalized, and checked as a file with executable permission on POSIX. Windows accepts `.exe` only. `.cmd` and `.bat` shims are rejected; no shell is used.
- The working directory must resolve to an existing directory inside one of the configured absolute roots. This constrains only the selected working directory, not filesystem access by the child.
- Arguments are argv entries, capped at 128 entries and 32 KiB, and reject NUL. The host must approve the exact arguments. Provider-specific safe argument profiles are not implemented; this is a remaining gate before any provider integration.
- Child environment inherits only a small OS allowlist plus a provider-specific credential/configuration allowlist. The host authorization callback receives a frozen summary of provider-variable names and endpoint protocol/host; it never receives credential values or endpoint userinfo, path, query or fragment. Arguments and the exact child-environment snapshot are copied before authorization and reused for spawn, so caller mutation during an asynchronous approval cannot change the approved launch. Environment values and arguments are never returned, persisted or included in lifecycle events.
- At most four runs are active; run duration is capped at 60 minutes (default 15 minutes). Run records are capped at 64 and lifecycle events at 256 in memory. These limits are not CPU or memory quotas.

## Lifecycle and cleanup

The Gateway reports `starting`, `running`, `stopping`, `stopped`, `exited` and `failed`. Events are fixed lifecycle records only; they contain generated run IDs, allowlisted provider IDs, timestamps, and an exit code or signal when available. Output, prompt, arguments, paths, environment, and raw OS error text are excluded.

An authorized stop sends `SIGTERM` to the POSIX process group. Windows uses `taskkill.exe` with fixed numeric PID arguments, `/T` and `/F`, without a shell: Node documents Windows `SIGTERM` as abrupt, and `taskkill /T` alone can fail to terminate descendants. The host callback receives `force: true` for Windows stops so the user can be told before approval. The Gateway escalates again after three seconds if the process has not closed. The snapshot's `treeStopConfirmed` is `true` only after the process-tree adapter succeeds, `false` when only direct-child cleanup can be attempted or the parent has already exited, and `null` when no tree signal was needed. If tree cleanup is uncertain, the run ends as `failed` and a trusted host's bounded `close()` includes its ID in the unresolved list. Before signaling by PID, the Gateway checks the child exit fields to avoid signaling a reused PID after the direct process has exited.

## Security limits and deferred gates

- The child runs with the current OS user's privileges. The allowed-root check is not filesystem isolation. Do not expose this Gateway until an OS-level sandbox/policy is designed and verified on each supported platform.
- PATH resolution verifies file type and executable permission, but does not attest vendor identity or prevent replacement between validation and spawn.
- Provider-specific safe argument profiles, prompt/input transport, output parsing, secret redaction, authentication, local API authorization, audit persistence and resource quotas are not implemented.
- `close()` handles orderly shutdown only. A Gateway crash/restart can orphan descendants or lose active-run state; this Phase 1 limitation is blocked on a process supervisor with platform-native ownership (for example, Windows Job Objects and POSIX service/cgroup policy). Until then, keep this module disconnected and do not run it as a persistent user-facing service.
- Windows `.cmd` and `.bat` providers are rejected. Supporting them requires a separately reviewed fixed adapter; do not enable `shell: true` or construct command strings from argv.
- Real Claude Code, Codex CLI and OpenCode compatibility, account cost, outbound data handling, GUI approval, and GUI acceptance have not been verified.

Reproducible local verification is recorded in `docs/progress.md`; Phase 1 acceptance status is in `docs/acceptance-criteria.md`.
