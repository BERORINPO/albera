# ADR 0023: ACP over stdio entry for external harnesses (`albera acp`)

Date: 2026-10-31

## Status

Proposed. Design only; nothing here is implemented. Adopting an external protocol is the owner's decision; this ADR stays Proposed until then.

## Context

ALBERA is meant to be a place where people and several AIs develop together. External agent harnesses such as Open Design and OpenHands Agent Canvas bring their own screens and launch AI CLIs themselves. Run next to ALBERA, they bypass every control ALBERA has: host approval, the audit journal, executable digest pinning, the fixed launch profile and the minimized child environment.

### Measured (2026-10-31, Open Design 0.26.1 on the owner's Windows PC)

- For every connection test and every generation, the Open Design daemon launched `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --forward-subagent-text --add-dir <bundled skills> <bundled design systems> <run inputs> --session-id <uuid> --permission-mode bypassPermissions`, with a per-project folder under the app's data directory as the working directory.
- That Claude Code loaded the user's whole configuration. It started every user-scope MCP server (4), ran every user-level hook (8) on each launch, including hooks that write under the user's configuration directory (files were added there and one was overwritten), and read the user-level CLAUDE.md: generated sample content reused names that appear only there.
- While idle, the daemon launched the claude, codex and opencode CLIs every few minutes to probe their versions and models.
- Right after start, before the consent screen, the daemon opened an HTTPS connection to a product-analytics endpoint (PostHog). The setting that sends conversation and tool content was on by default.

### Code (read on each project's default branch, 2026-10-31)

- Open Design `apps/daemon/src/runtimes/defs/claude.ts` (75693e9) appends `--permission-mode bypassPermissions`, and `externalMcpInjection: 'claude-mcp-json'` writes the user's external MCP servers into `.mcp.json` in the project cwd, which Claude Code loads at start.
- Open Design `docs/new-agent-runtime-acp.md` (f1a0b60) recommends that new agent runtimes expose an ACP over stdio CLI (`your-agent acp`) and states that Open Design auto-approves `session/request_permission`. `choosePermissionOutcome` in `apps/daemon/src/agent-protocol/acp/rpc.ts` (1af6822) picks `approve_for_session`, then `allow_always`, then `allow_once`.
- OpenHands `software-agent-sdk` `openhands-sdk/openhands/sdk/agent/acp_agent.py` (87b84dd) starts an ACP server as a child process (for example `npx -y @agentclientprotocol/claude-agent-acp`; Codex and Gemini CLI also), sets the session mode to `bypassPermissions` for claude-agent-acp and `agent-full-access` for codex-acp by default, and its `request_permission` auto-approves the first option. OpenHands Agent Canvas, its browser UI, lists these agents plus a "Custom" ACP server.

### ACP (checked against agentclientprotocol.com, protocol version 1)

JSON-RPC 2.0. stdio is the only defined transport: the client launches the agent as a subprocess, messages are newline-delimited UTF-8, the agent writes only ACP messages to stdout and may log to stderr. Client to agent: `initialize`, `authenticate`, `session/new`, `session/prompt` (required); `session/load`, `session/set_mode`, `logout` and others are optional or capability-gated; `session/cancel` is a notification. Agent to client: `session/update` notifications and the `session/request_permission` request; `fs/*`, `terminal/*` and `elicitation/create` exist only when the client advertises them. `session/request_permission` is sent by the agent and answered by the client, and the spec allows clients to answer automatically.

Both harnesses are ACP clients, so one ACP agent entry serves both.

### What the current read-only profile already covers

`src/runtime/agent-harness-adapter.mjs` generates `--restricted --safe-mode --strict-mcp-config --disallowedTools mcp__* --permission-mode plan` plus fixed print-mode flags. Per `claude --help` (2.1.310), `--restricted` ignores user, project and local settings files, removes code-running tools and WebFetch, confines file tools to the working directories and refuses `bypassPermissions`; `--safe-mode` disables CLAUDE.md, skills, plugins, hooks and MCP servers; `--strict-mcp-config` loads MCP servers only from `--mcp-config`, which is never passed.

| Source the Open Design launch loaded | Blocked by | Evidence |
|---|---|---|
| Hooks, `.mcp.json`, `apiKeyHelper` in the cwd (where Open Design injects MCP) | all three flags | measured: 0 of 5 markers (`docs/claude-cli-readonly-profile-verification.md`, run 3); opt-in real-CLI contract test |
| User-level settings hooks | `--restricted`, `--safe-mode` | CLI help only; not measured |
| User-scope MCP servers | `--strict-mcp-config` (`--safe-mode`, `--disallowedTools mcp__*` as further layers) | CLI help only; not measured |
| User-level CLAUDE.md | `--safe-mode` | CLI help only; not measured |
| Auto memory | not named in `--safe-mode`'s help (only `--bare` names auto-memory) | unknown |
| `--add-dir`, `bypassPermissions` | never generated; `--restricted` refuses `bypassPermissions` | unit test forbids config-loading flags |
| The user's configuration directory as config root | not blocked: the Gateway passes `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_*` and `CLAUDE_CONFIG_DIR` through, which the CLI also uses to find OAuth credentials | the approval screen names these variables without values (unit test) |

`test/runtime-claude-readonly-profile.test.mjs` pins the argv (the three flags, no `--mcp-config` `--settings` `--setting-sources` `--add-dir` `--plugin-dir` `--agents` `--bare` `--allowedTools` `--tools` `--dangerously-skip-permissions`, only verified options, `plan` mode) and the 2.1.310 floor. So the profile blocks every mechanism seen in the measurement by documented flag semantics, but only the repository scope is measured, memory is unknown, and the child still reads the user's configuration directory. Managed (admin) settings apply by design.

## Decision (proposed): A, expose ALBERA as an ACP agent

1. **Roles.** The harness becomes a screen and ACP client. It launches `albera acp` and is configured not to launch provider CLIs itself. `albera acp` is a thin, per-connection translator: an ACP agent on stdio and a client of an already running, owner-started `albera-runtime` host through the loopback Runtime API (`spec/runtime-api.md`). It never resolves, launches or talks to a provider CLI, never holds provider credentials and has no approval scope. Process launch, approval, the audit journal, executable pinning, fixed profiles, the environment allowlist and the Guardian stay in the Runtime Gateway host unchanged. No path lets a harness start Claude Code directly through ALBERA.
2. **`albera acp` does not host the Gateway.** If it did, the harness would be the parent of the runtime and would receive its terminal output, including the approval host's one-time bootstrap code, and could approve its own requests. Approval must stay on a surface the harness neither launches nor reads.
3. **Credential.** `albera acp` uses a Runtime API credential limited to `runs:start`, `runs:input`, `runs:stop`, `runs:read` and `events:read`. A same-user harness can read it; it only lets the harness propose runs that still need ALBERA approval and stop its own runs.
4. **Approval belongs to ALBERA.** Start and every input go through the Gateway's injected authorizer: the approval broker and loopback approval screen today, and the Windows Hello-backed Approval Authority once it is wired to Gateway actions (it is not yet). `albera acp` does not send `session/request_permission` for Gateway actions and never treats a harness answer as approval. While a decision is pending it reports a `tool_call` (`kind: other`, `status: pending`, title "Waiting for approval in ALBERA") and completes or fails it with the decision. If a later harness needs `session/request_permission`, it is display only: a harness `reject_*` or `cancelled` can deny, an `allow_*` changes nothing, and `allow_always` / `approve_for_session` are never offered. Permission prompts from the provider (writable profile, item 9) go to ALBERA approval, never to the harness.
5. **Configuration source fixed by the profile.** Profiles stay the only launch form. In addition, the Gateway gives the child an ALBERA-owned, per-profile configuration directory (for Claude, `CLAUDE_CONFIG_DIR` pointing at a private folder under Runtime storage) instead of passing the user's through, with authentication from a login made into that folder or an API key variable named on the approval screen. The real-CLI contract test gains user-scope markers (settings hooks, user MCP, user CLAUDE.md, a memory file) that must stay at 0. Until both land, user-scope isolation rests on documented flag semantics only. This also hardens the existing read-only profiles, independent of ACP.
6. **Harness MCP servers are not connected.** `session/new.mcpServers` is not passed to the Gateway. ACP says agents SHOULD connect to them; this is a deliberate deviation, since a stdio entry is an arbitrary `command` + `args` + `env` run as the user. The approval screen shows their count and names only.
7. **Output leaves ALBERA.** Whatever is projected into `session/update` reaches the harness, which may send it elsewhere (Open Design's content-sharing setting was on by default). The approval screen names the client from `clientInfo` (self-reported) and says output goes to it. The projection omits `rawInput` and `rawOutput`; the journal still stores no output.

### Method mapping

| ACP | ALBERA | Approval |
|---|---|---|
| `initialize` | Answer `protocolVersion` 1 (per the spec's negotiation, a client that cannot use 1 closes). Advertise `loadSession: false`, all `promptCapabilities` false (text and the `resource_link` baseline; links are passed as text, never fetched), `mcpCapabilities` http/sse false, no `authMethods`, no modes. Ignore client `fs` / `terminal` capabilities. Check that the Runtime API answers with the configured credential | none |
| `authenticate`, `logout` | Not offered. Provider credentials stay with the Gateway | — |
| `session/new` | Record `cwd` (must be absolute); the Gateway's allowed-root and cwd identity checks decide at start (ADR 0021). Refuse `additionalDirectories`. Do not connect `mcpServers` (item 6). Return a session ID generated by `albera acp`; nothing starts | none |
| `session/prompt`, no live run | `POST /v1/runs` with provider `claude` and a profile chosen by the owner's configuration, never by the harness (`read-only-streaming` until item 9 exists); text blocks joined into the prompt (16 KiB cap) | Gateway start: exact executable digest, cwd, argv, prompt, environment names |
| `session/prompt`, live run | `POST /v1/runs/:id/input` | Gateway input: exact text |
| `session/prompt` response | `stopReason` from the provider result (item 8). A denied or expired approval returns `refusal`. A failed run returns a JSON-RPC error with a stable code only | — |
| `session/cancel` | `POST /v1/runs/:id/stop` (manual stop, ADR 0022), then answer the open prompt with `cancelled`. The next prompt starts a new run and needs a new approval; context is not kept (`--no-session-persistence`). The broker has no requester-side withdraw today: a request still pending stays on the approval screen until it expires (120 s default) or is approved, in which case `albera acp` stops the run at once. Adding a withdraw is part of the work | none (stop) |
| `session/update` | Provider output projection (item 8) and the approval-pending `tool_call` | — |
| `session/request_permission` | Not used for approval (item 4) | ALBERA decides |
| `session/load` | Unsupported (`loadSession: false`) | — |
| `session/set_mode`, `session/set_model`, `session/set_config_option` | Refused. Profile, permission mode and model are fixed by the Gateway; a harness cannot select `bypassPermissions` (and `--restricted` refuses it) | — |
| `fs/*`, `terminal/*`, `elicitation/*` | Never called | — |
| stdin closes | Stop every run of this credential session, then exit. If `albera acp` is killed instead, its runs continue until the run timeout (default 15 min) or the owner stops them on the control screen | none (stop) |

### What ALBERA lacks for this

8. **Provider output to `session/update`** (not implemented; `spec/runtime-gateway.md` says provider stdout/stderr are discarded and events are lifecycle-only). A pure, bounded function maps Claude stream-json output to ACP: assistant text to `agent_message_chunk`, thinking to `agent_thought_chunk`, `tool_use` to `tool_call` (`kind` from the tool name: read, edit, search, fetch, else other; title from the tool name and a safe target as in the activity labels; `locations` only inside the cwd), `tool_result` to `tool_call_update` (`completed` / `failed`), and the final result to a `stopReason` (for example `end_turn`, or `max_turn_requests` when the turn cap is hit). Provider output is untrusted input: size-capped, control characters removed, never written to the journal. Fixtures come from real CLI output with a provenance header.
9. **A writable profile** (not implemented). Open Design writes prototype files into the project folder, so `--permission-mode plan` profiles cannot serve it. A fixed `workspace-write` profile would keep `--restricted` (no Bash, PowerShell or WebFetch; file tools confined to the cwd), `--safe-mode` and `--strict-mcp-config`, replace `plan` with a mode in which edits prompt, and use `--permission-prompts host` so each prompt reaches the Gateway over the private pipe and goes through ALBERA approval. It needs its own marker verification and version floor, and its approval granularity depends on the approval-tiers proposal (#115). It gets its own ADR.
10. **Credential handoff** (not implemented). The Runtime API has no minting route and keeps credentials in memory, so an external `albera acp` process cannot get one today. `albera-runtime` would mint the item 3 credential into a user-private file that the owner points `albera acp` at.

Read-only profiles plus items 8 and 10 are enough for an OpenHands Agent Canvas "Custom" agent that reads and answers. Open Design also needs item 9.

## Rejected alternatives

- **B. Pass the harness's MCP servers through with a per-profile allowlist.** Rejected for now: the read-only profiles deny MCP by design, and a harness-supplied stdio server is an arbitrary command run as the user, so an allowlist would need the same pinning and approval display as provider executables plus a per-profile `--mcp-config` that ALBERA writes. Kept as an option to add on top of A; it is not a substitute, because without A no harness launch passes through ALBERA approval at all.
- **C. Wrap the whole harness in a VM (Computer Pool).** Rejected as the main path: control becomes VM-wide. ALBERA would see the VM, not each launch, prompt or write; inside, the harness still runs `bypassPermissions` and auto-approves; approval collapses to "run this VM"; the journal and executable pinning do not apply inside; and egress (analytics included) is unrestricted until ADR-002 egress control exists. It stays a containment option for an untrusted harness, orthogonal to A.
- **`albera acp` hosting the Gateway in-process.** Rejected by item 2.
- **Patching harness runtime definitions to pass ALBERA's flags.** Rejected: the harness owns the argv (Open Design appends `bypassPermissions`), auto-approves, and runs outside ALBERA's approval and journal.

## Name collision

ALBERA's roadmap phase 4 "Live Agent Canvas" (`docs/roadmap.md`) and acceptance criterion V1-02 ("Real Agent Canvas lifecycle projection and approved task assignment", `docs/acceptance-criteria.md`) share the name of OpenHands' product "Agent Canvas". This ADR writes "OpenHands Agent Canvas" for the product. Whether to rename ALBERA's canvas is left to the owner.

## Consequences

- One entry serves every ACP client. Approval, journal, pinning and profile stay in ALBERA, and the harness never handles provider credentials.
- Not a sandbox. ALBERA cannot stop a same-user harness from launching provider CLIs on its own (Open Design probes claude, codex and opencode on PATH and has a built-in Claude runtime). The owner has to choose `albera` as the harness's agent and turn the others off; ALBERA governs only the path through it.
- Every prompt becomes an approval (start and each input). How harness timeouts interact with pending approvals is unverified.
- Cancel loses the conversation context.
- Output shown in the harness may leave the machine through the harness's own telemetry.
- Harnesses that run agents in a container or a remote sandbox cannot reach the loopback-only Runtime API; only a harness that launches `albera acp` on the same host is supported. The API is not opened further.
- ACP version 1 is pinned. Contract tests replay recorded client traffic from Open Design and OpenHands.
- Nothing here is verified: no harness has been pointed at `albera acp`, and items 5, 8, 9 and 10 do not exist.

## Order of work if accepted

1. Credential handoff (item 10) and a requester-side approval withdraw.
2. Output projection (item 8).
3. `albera acp` itself: framing, the mapping table, stdin-close cleanup, contract tests from recorded harness traffic.
4. Configuration directory and user-scope markers (item 5); useful for the existing profiles even without ACP.
5. Writable profile (item 9, separate ADR after #115).
6. Then B as an option.
