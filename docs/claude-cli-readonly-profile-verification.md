# Claude CLI read-only profile verification (Issue #35)

Date: 2026-10-30. Installed CLI: Claude Code `2.1.310` (`claude --version`), Windows 11, Node 22+.

## Why

`claude --print` skips the workspace trust dialog (`claude --help`: "The workspace trust dialog is skipped when Claude is run in non-interactive mode ... Only use this in directories you trust"). The Runtime launches Claude with the approved cwd as the working directory, so repo-supplied `.claude/settings.json` (hooks, `apiKeyHelper`) and `.mcp.json` (MCP servers) could run code even when the approved argv is safe.

## Flags (from `claude --help`, 2.1.310)

| Flag | Exists | Documented effect used here |
|---|---|---|
| `--restricted` | yes | removes code-running tools and WebFetch; ignores user, project and local settings files (managed settings and `--settings` still apply); says to add `--strict-mcp-config` to skip MCP servers too |
| `--safe-mode` | yes | disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands/agents (admin-managed settings still apply) |
| `--strict-mcp-config` | yes | only MCP servers from `--mcp-config`, ignoring all other MCP configurations |
| `--permission-prompts none` | yes | used by the streaming profile only |
| `--setting-sources` | yes | not added: `--restricted` already ignores all three sources, so there is nothing left to restrict |
| `--bare` | yes | rejected: it never reads OAuth/keychain, so it needs an API key |

The previous worry that `--restricted` might not exist is resolved: it exists in this version and behaves as documented.

## Marker-file experiment

Throwaway directory (outside any repo) containing:
`.claude/settings.json` with `apiKeyHelper` and `SessionStart` / `UserPromptSubmit` / `Stop` hooks, and `.mcp.json` with one stdio server. Each command runs `node marker.js <name>`, which writes `<name>.marker` and nothing else. Prompt: one word. Three `claude -p` runs in total.

| Run | argv (before the prompt) | Markers written |
|---|---|---|
| 1. no safety flags | `--max-turns 1 --no-session-persistence` | all 5: `apikeyhelper`, `hook-sessionstart`, `hook-userprompt`, `hook-stop`, `mcp` |
| 2. previous ALBERA profile | `--restricted --safe-mode --disallowedTools mcp__* --permission-mode plan --print --max-turns 1 --no-session-persistence` | none |
| 3. new ALBERA profile | `--restricted --safe-mode --strict-mcp-config --disallowedTools mcp__* --permission-mode plan --print --max-turns 1 --no-session-persistence` | none |

Runs 2 and 3 answered normally, so authentication (OAuth) was unaffected and the `apiKeyHelper` in the repo was not consulted.

## What changed

- `--strict-mcp-config` was added (before the variadic `--disallowedTools`). Per `--help`, `--restricted` alone does not skip MCP servers; before this change the MCP block depended on `--safe-mode` alone.
- Both profiles now require Claude Code `>= 2.1.310`, the only version on which the whole flag set was run. Older or unreadable versions fail closed with `cli_version_unavailable` before the task process starts. This supersedes the 2.1.248 / 2.1.259 floors in ADR 0013 and 0014.
- The approval summary now names `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` (when set) in addition to `CLAUDE_CONFIG_DIR` and the other provider variables. Names only; values are never in the summary.
- Opt-in real-CLI contract test: `ALBERA_REAL_CLAUDE_CONTRACT=1 node --test test/runtime-claude-readonly-contract.test.mjs` repeats run 3 against a synthetic repo (one paid one-word call). It is skipped by default.

## Not verified

- The streaming profile (`--input-format stream-json`) was not run; it shares the same safety flags.
- Managed (admin) settings still apply by design and are outside this check.
- Behavior of versions other than 2.1.310; they are refused rather than assumed.
- `--disallowedTools mcp__*` glob semantics were not tested; it is a secondary layer.
