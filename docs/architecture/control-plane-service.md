# Control Plane service and easy setup (stage 1, subscription edition)

**Status: Proposed contract, design only, NOT VERIFIED beyond the lab run of 2026-11-03.** Nothing in this document is implemented. Later PRs (the table in section 10) are reviewed against it. Owner decisions of 2026-11-03 are marked **Decided**; everything else is the proposal those decisions leave open and is marked **Provisional** where a value or a mechanism may still change. Where a fact was not read from the repository or measured, the text says NOT VERIFIED and the item is in the measurement plan (section 11).

## 要約 (株主向け)

1. 株主の操作は 3 つだけ。(1) 導入プログラムを UAC で「はい」、(2) room の画面で資格情報を 1 回入れる、(3) 承認の窓で照合コードを 3 つの候補から押して Windows Hello。
2. サブスクで動かす。VM を操作する「手」は、ALBERA が API を呼ぶのではなく、Claude Code 本体を headless で起動して動かす。Claude Code に渡す道具は ALBERA 専用の 6 つ (画面、クリック、移動、キー、文字入力、スクロール) だけで、株主の `~/.claude` は読ませない。
3. Control Plane は専用のサービス身元 `NT SERVICE\AlberaControlPlane` で動かす。今の `albera-cp` ユーザーは廃止する。3 つのサービスは自動起動 (遅延)。
4. 費用の上限額は設けない。1 作業あたりの時間と手数で止める。導入の検証は gh.exe を版固定で同梱して、オフラインで行う。今の環境からの移行の最初の 1 回は、repo のスクリプト 1 本で行う。
5. 未確認が多い (Claude Code が MCP の画像を受け取る形式、トークンの寿命、サブスクの利用上限、サービス身元で Claude Code が起動するか、など)。第 11 節の計測を終えるまで、実装 PR は該当部分に着手しない。

## 0. Scope and decisions

| # | Item | Status | Source |
|---|---|---|---|
| D1 | The Control Plane (CP) runs as `NT SERVICE\AlberaControlPlane`; `albera-cp` is removed | Decided | owner 2026-11-03; lab PR #175 |
| D2 | The hands are Claude Code run headless on the owner's subscription; the credential is a long-lived token made by `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`); the API-key path stays as an option | Decided | owner 2026-11-03 |
| D3 | The only tools Claude Code gets are ALBERA's own MCP server's six desktop tools | Decided | owner 2026-11-03 |
| D4 | No money cap; one task is stopped by time and by number of calls | Decided | owner 2026-11-03 |
| D5 | The three services start automatically, delayed (`start= delayed-auto`) | Decided | owner 2026-11-03 (confirmed by the coordinator) |
| D6 | Attestation verification: a version-pinned `gh.exe` is bundled with setup and verifies offline (`gh attestation verify --bundle --custom-trusted-root`) | Decided | owner 2026-11-03 (external tool adoption approved) |
| D7 | The first migration from `albera-cp` is one script from the repository | Decided | owner 2026-11-03 |
| D8 | Everything else below (per-run Claude config folder, hand-written MCP server, numbers in 6.6, node hash pin, failure actions) | Provisional | this document |

Out of scope here: Guest-side work, `guest.command` actions other than `task.start`, checkpoints, the Broker's release-lease request (ADR-002 follow-up), code signing, a firewall rule, the Linux/other-OS editions, and a second user. The Broker and the Approval Authority keep their binaries, pipes and receipts (`adr-002-host-broker-trust-contract.md`, `approval-authority.md`); only the SID they are configured to trust as the Control Plane changes (section 9).

## 1. Identity

| Process | Identity | Token and rights | Must not have |
|---|---|---|---|
| CP host (`albera-control-plane-host.exe`, .NET, section 2) and everything it starts (node, helper, Claude Code, MCP server) | `NT SERVICE\AlberaControlPlane`, virtual account, `sc sidtype restricted`, `sc privs SeChangeNotifyPrivilege` only, session 0 | The lab token (2026-11-03, `cp0_token`): user = service SID, restricted with 4 restricting SIDs, not in Administrators or Hyper-V Administrators, exactly `SeChangeNotifyPrivilege` | `SeImpersonatePrivilege`, `SeCreateGlobalPrivilege`, Hyper-V Administrators, a write right on any `bin\` folder, `broker-config`, `authority`, `broker`, or `control-plane-config`; service control over the Broker or the Authority (its right on the Broker service stays `LC`, query status) |
| Approver tray and window (`AlberaApprover.exe --tray`) | The owner's account (`approverSid`), interactive session, started from HKLM Run | Unchanged from `approver-app.md`: it talks only to the approver pipe | Any right on the submit pipe, the Broker pipes or the CP's folders |
| Setup (`albera-setup.exe`) | The owner's elevated token, per UAC | Administrator, one run | Network use (verification is offline, section 8) |
| Broker, Approval Authority | Unchanged | Unchanged | Unchanged |

The service SID is derived from the service name, so it is the same after a reinstall. DPAPI keys live in the service profile (section 5), which a reinstall may or may not keep (NOT VERIFIED, M15).

## 2. Process structure

```
owner (browser) --127.0.0.1:<random port>--> node room-service  (inside the CP service, session 0)
owner (tray)    --approver pipe------------> Approval Authority
Start menu "Open ALBERA": reads ui\room.json, opens the browser

AlberaControlPlane service
  albera-control-plane-host.exe   .NET; SCM entry point; Job object (kill on close); no decisions, no network
    node.exe  (C:\Program Files\nodejs)   entry.mjs room-service   app tree: bin\control-plane\app (in the tree hash)
      helper (windows-broker-pipe-client)  claim / submit / desktop pipes; "secret" mode = DPAPI
      per approved task:  claude.exe  (bin\claude, pinned copy)
                            node.exe entry.mjs desktop-mcp   (ALBERA MCP server, stdio)  --> helper desktop mode --> Broker desktop pipe
```

| Rule | Detail | Status |
|---|---|---|
| Why a .NET host | Node cannot register with the SCM. Same shape as the Broker's ServiceHost. nssm / winsw and a Node single-executable were rejected | Decided (plan) |
| Why a helper for secrets | Node has no DPAPI binding; a native addon needs a build toolchain not available here; a PowerShell child costs a 22 s module cache | Decided (plan) |
| Start | `start= delayed-auto`. No SCM dependency on the Broker or the Authority: the CP's pipe clients already answer `broker_unavailable` and the room shows it. `sc failure`: restart after 5 s, twice, then leave stopped | D5 decided; failure actions Provisional |
| Stop | Job object kill-on-close ends node, the helper, Claude Code and the MCP server together. A single task is ended by killing only the PID the driver itself started | Provisional |
| node | `node.exe` path and SHA-256 sit in `control-plane-config\AlberaControlPlane.service.json` (written by setup, from the node the owner has under `C:\Program Files\nodejs`); the host refuses to start node when the hash differs. The lab used a copy of node 24.13.0 | Provisional |
| Listener | `127.0.0.1`, port 0 at every start; the port and node PID go to `ui\room.json` and the file is deleted on stop | Decided (plan) |
| Resident job entry | Today `room` is a CLI with `--job`; stage 1 adds a resident `room-service` command whose jobs come from the UI form (section 4) | Decided (plan) |

## 3. Files and ACLs

All folders are created by setup with their final owner and protected DACL in one call and read back (the existing installer rule, `host-install.md`). "CP" is the CP service SID, "owner" is `approverSid`.

| Item | Path | ACL (inheritance removed) | Notes |
|---|---|---|---|
| Builds | `C:\Program Files\Albera\bin\{broker,authority,pipe-client,approver,setup,control-plane,claude}` | Program Files default: administrators write, Users read and execute | `claude` holds the pinned Claude Code copy (section 8). `setup` holds `albera-setup.exe` and the bundled `gh.exe` |
| CP working data | `C:\ProgramData\Albera\control-plane\` | SYSTEM and Administrators full; CP full control | The Runtime journal refuses a folder where its own user lacks full control (found 2026-11-02). `claude-run\<runId>\{config,work,tmp}` is made empty per task and deleted after it; the CP host sweeps leftovers at start |
| CP settings (moved) | `C:\ProgramData\Albera\control-plane-config\albera.approval.json` and `AlberaControlPlane.service.json` | SYSTEM and Administrators full; CP **read only** | Closes the known limit `2026-11-03+cp-settings-pin-scope` (ADR-002): the CP can no longer rewrite the helper pin or the `desktop` block. Gains the `claude` block (section 6.1) |
| Secrets | `C:\ProgramData\Albera\secrets\<name>.dpapi` | SYSTEM and Administrators full; CP Modify; nobody else (not the owner) | DPAPI blobs, and beside each a `<name>.meta` with the first 8 hex of the value's SHA-256 and the save time (no plaintext; section 5) |
| UI bootstrap | `C:\ProgramData\Albera\ui\room.json` = `{port, code, pid, writtenAt}` | SYSTEM and Administrators full; CP Modify; owner Read | The file is created by node in the folder and inherits exactly this list |
| Install record | `C:\ProgramData\Albera\install-manifest.json` | Unchanged | Gains `controlPlane` (service SID, node hash), `claude` (version string, SHA-256, source path), `setupRunId` (section 8) |

Measured 2026-11-03 (`cp6_programdata_acl`): a file the service created in ProgramData with a protected DACL of two ACEs (service SID Modify, shareholder SID Read) was opened for read by the shareholder, refused for write, and refused for another virtual account. In the lab the parent still gave Users read to the new file before the service replaced the DACL; the `ui\` and `secrets\` folders here do not include Users at all, so nothing is inherited that way.

## 4. UI authentication (the room)

Measured 2026-11-03 (`cp5_tcp_loopback_other_user`): another local user and an administrator both connected to the service's `127.0.0.1` port. The port is therefore not a boundary; the UI authenticates itself.

| Concern | Rule | Status |
|---|---|---|
| Who gets a session | Only the holder of the bootstrap code. The code is in `ui\room.json`, which only the owner SID, CP, SYSTEM and Administrators can read (a kernel check, not a convention) | Decided (plan) |
| Opening | Start menu "Open ALBERA" (runs as the owner) reads `ui\room.json`, checks that the service is RUNNING and that `pid` owns the port, then opens `http://127.0.0.1:<port>/room/#b=<code>`. The fragment is never sent to the server; the page posts it to `/api/session` | Decided (plan) |
| Code lifetime | A new code at every CP start; rotated after one use and every 10 minutes. `/api/session` is limited to 10 per minute | Decided (plan) |
| Cookie | `HttpOnly; SameSite=Strict; Path=/room/`; name unique per host instance; sliding idle 20 min, absolute 8 h (as `room-host.mjs` today) | Existing behavior |
| Other local users and RDP sessions | They reach the TCP port and get static files and `401` | Decided (plan) |
| Other tabs | Existing `Host` check (DNS rebinding), `Origin` required on writes with `Sec-Fetch-Site` same-origin, CSP, CORP/COOP | Existing behavior |
| Hole found by the plan | Another port on `127.0.0.1` is same-site, so a no-cors GET to a read API would carry the cookie. Read APIs therefore also refuse a request whose `Sec-Fetch-Site` header is present and not `same-origin` or `none`. A request without the header (no browser) still needs the cookie | Decided (plan); browser behavior NOT VERIFIED (M16) |
| Port squatting | A squatter would need the port before the CP and also the code; "Open ALBERA" checks PID ownership of the port | Decided (plan) |
| Not defended | Processes of the owner's own account and browser extensions are trusted (the existing known limit). Administrators and SYSTEM are out of the threat model | Existing limit |

Routes added to the room: credential (section 5), `POST /api/jobs {computerId, task}` (task 1 to 256 bytes, the gate's existing safe-character rules; the reply carries `approvalId` and the 4-digit match code the room displays), "stop all", and an **approval test** button that submits one fixed `synthetic.noop` (the CP identity cannot run `approval-check` by hand). Form text reaches the AI only if it is exactly the approved `task.start` text (the existing `task-start-gate` rule). The room computes the action digest itself with `broker-contract/action-digest.mjs`, sends it as `expectedDigest`, and computes the match code from that digest and the `approvalId` the Authority returned (the submit reply carries no digest: `approval-authority.md`). A lying CP would only show a code that does not match the window, which the owner answers with Deny.

## 5. Secret storage

| Concern | Rule | Status |
|---|---|---|
| Scope | DPAPI `CurrentUser` as the CP virtual account, with entropy `albera.<name>.v1`. Names: `claude-oauth-token` (default), `anthropic-api-key` (option) | Decided (plan) |
| Evidence | Lab 2026-11-03 (`cp3`, `cp4`): protect and unprotect round-trip with entropy, wrong entropy refused, and the blob refused to Administrator, a plain local user and another virtual account | Measured |
| Where it runs | The helper in "secret" mode (a child with the same token) protects and unprotects over stdin and stdout; Node never holds a DPAPI binding. The plaintext exists in Node only for the duration of one spawn call (6.2) | Decided (plan) |
| Status and check | Save writes `<name>.meta` (hash prefix and date, no plaintext) after the blob; the room's status reads only that file and never decrypts. Whether this account can still open the blob is an explicit `verify(name)` (one helper run). Erase deletes both files. The names are the two above and nothing else (a frozen list) | Decided (plan) |
| Known limit: helper pin | The helper is not a single-file publish, so the SHA-256 pin (`helperPath` and `helperSha256` are required by the secret store, as in the room's `desktop` settings) covers the exe only, not the dll files beside it. Setup's tree hash covers the whole `bin\pipe-client` folder at install time and `bin` is writable only by administrators (outside the threat model). Single-file publish is a later task (ADR-002, decision `2026-11-03+cp-helper-pin-scope`) | Known limit |
| Entry | One password field in the room, write-only API, body at most 1 KiB, never returned or logged, never in a URL. After save the room shows only the first 8 hex of its SHA-256 and the date. The page tries to clear the clipboard (best effort; failure is silent and the page says so) | Decided (plan) |
| Check on save | Format only (printable ASCII, no whitespace, 1 to 1024 bytes). A live check is a measurement item (`claude auth status` with the token in the environment, M3) so that saving never spends a model call | Provisional |
| Erase | The UI deletes the blob; uninstall deletes the folder. Real revocation is at the provider; where a `setup-token` token is revoked is NOT VERIFIED (M2) | Decided (plan) |
| One credential kind | Exactly one of the two names is selected in `AlberaControlPlane.service.json`; the child environment never carries both | Provisional |
| Rejected | LocalMachine scope, DPAPI-NG with `SID=` (needs AD), environment variables or files for storage (the leak path of 2026-11-03), a native addon | Decided (plan) |

`claude setup-token` is run by the owner in the owner's own terminal and its output is pasted into the room. That is one more action than the three the owner decided on, hidden inside "enter the credential once": the room screen must say so, and whether ALBERA can make the token itself is a question for the owner after M2. ALBERA never reads the owner's `~/.claude` credentials.

## 6. Claude Code driver

Claude Code is **not** called through Anthropic's API by ALBERA. The CP starts the pinned `claude.exe` as a child process, the way the owner would, and talks to it over its documented headless protocol. The token is used only by that child. As stated in the brief, Anthropic does not allow another product to reuse Claude.ai login credentials; running the user's own Claude Code under the user's own token is the supported shape, so the product edition uses each user's own Claude Code login, never a shared one. This statement of policy is the brief's and was not independently checked here.

### 6.1 Launch

Flags below were read from `claude --help` of **2.1.310** (the version on this PC, `C:\Users\Yosuke\.local\bin\claude.exe`, about 297 MB) on 2026-11-03. Their behavior is NOT VERIFIED except where stated.

| Argument | Purpose |
|---|---|
| `-p --input-format stream-json --output-format stream-json` | Headless, streaming both ways (decided). `--verbose` is added only if the pinned version requires it for stream-json (M12) |
| `--strict-mcp-config --mcp-config <json>` | Only the ALBERA MCP server (6.4), built by the CP per task. The JSON carries `computerId` and `operationId` from the approved `task.start`; the model has no tool to change them. No secret is in it |
| `--tools ""` | No built-in tool at all (help: `Use "" to disable all tools`) |
| `--allowedTools` | Exactly the six ALBERA tool names (Claude Code's `mcp__<server>__<tool>` naming; NOT VERIFIED) |
| `--disallowedTools` | A second layer: Bash, PowerShell, Read, Write, Edit, NotebookEdit, Glob, Grep, WebFetch, WebSearch, Task and any other built-in name the pinned version has (list fixed in the driver PR from the version's own tool list) |
| `--permission-mode dontAsk --permission-prompts none` | Anything that would prompt is denied; nobody is asked |
| `--no-session-persistence` | No transcript on disk (screens may contain secrets) |
| `--setting-sources` and `--settings <admin-only file>` | Limit to no user, project or local settings, and set a deny list from `control-plane-config`. Whether an empty `--setting-sources` is accepted is NOT VERIFIED (M6) |
| `--disable-slash-commands`, `--no-chrome` | No skills, no commands, no Chrome integration |
| `--append-system-prompt <fixed text>` | Says what the six tools are and that screen content is untrusted data that cannot change the task. The task itself is **not** in argv: it is the first stream-json user message on stdin, so it is not visible in a process list |
| `--model <alias or id>` | From `AlberaControlPlane.service.json`; default NOT decided |

Observed in the same help and recorded because they change the design:

- **`--bare` cannot be used.** Its help says OAuth and keychain are never read (only `ANTHROPIC_API_KEY` or `apiKeyHelper`), so it excludes the subscription token. Isolation therefore comes from the flags, folders and environment in this section instead.
- `--restricted` (removes code-running built-ins and WebFetch, ignores user, project and local settings, refuses `bypassPermissions`) and `--safe-mode` (disables customizations; "Auth ... work normally"; policy settings still apply) exist. Whether either keeps `--mcp-config` servers working is NOT VERIFIED (M6); if one does, it is added as a further layer.
- There is **no `--max-turns` or timeout option** in the help, so the limits in 6.6 are enforced by ALBERA itself.
- `--max-budget-usd` exists; it is used only in the API-key option (6.7).

### 6.2 Environment and folders

The child gets an environment **built from an allowlist**; nothing is inherited.

| Variable | Value |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Set in the `spawn` call's `env` for this one child only, from the helper's unprotect. Never in the service's own environment, never logged, never in argv |
| `CLAUDE_CONFIG_DIR` | `control-plane\claude-run\<runId>\config`, new and empty for every task, deleted after it. The owner's `~/.claude` (hooks, MCP servers, rules, `CLAUDE.md`) is never read; Open Design showed an app starting Claude Code that read the owner's whole configuration |
| working directory | `control-plane\claude-run\<runId>\work`, empty. Claude Code reads `.claude` and `CLAUDE.md` files in the folders above its working directory, and every folder above this one is administrator-only or the CP's own empty tree |
| `TEMP`, `TMP` | `control-plane\claude-run\<runId>\tmp` |
| `SystemRoot`, `windir`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOME` | System values and the service profile (measured: `C:\WINDOWS\ServiceProfiles\AlberaControlPlane`) |
| `PATH` | `C:\Windows\System32` only |
| Absent by rule | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` (the names `gateway.mjs` already treats as Claude provider variables), proxy variables, and everything not listed |

A fresh configuration folder per task keeps one task's content from persisting into the next; its startup cost is measured in M4. Whether the token reaches the MCP server child (a grandchild) is NOT VERIFIED (M11); the MCP server needs none and must not read one.

### 6.3 Start-up self-check

The driver reads the first stream-json messages and requires that the tool list is **exactly** the six ALBERA tools and that exactly one MCP server is connected; otherwise it kills its child and reports `driver_unexpected_tools`. Whether the init message carries this list is NOT VERIFIED (M6); if it does not, the check becomes a measurement gate instead of a runtime check.

### 6.4 MCP server (`entry.mjs desktop-mcp`)

A stdio MCP server started by Claude Code from the `--mcp-config`. It is zero-dependency and hand-written (the repository has no npm dependencies; the official SDK would be an external-library adoption and needs the owner). It has no network access, no file access beyond its own bundle, no environment secrets, and one backend: `windows-desktop-broker-client.mjs` (`captureVmScreen` and `sendVmInput`) with the helper pinned by `desktop.helperSha256`, speaking to the Broker's desktop pipe under the lease the approved `task.start` claim made. The operation id is the lease's `desktopSessionId`; the generation is left out, as in the gated room today. Conformance with Claude Code's MCP client is NOT VERIFIED (M1, M12).

| Tool | Arguments (strict: any other key is an error) | Maps to `desktop-control.mjs` | Result |
|---|---|---|---|
| `screenshot` | none | capture at the VM's size, within 64..1920 and 1920 x 1080 | one `image/png` content item, at most 8 MiB |
| `click` | `x`, `y` (integers); `button` `left` (default), `right`, `middle`; `count` 1 (default), 2, 3; `modifiers` (optional, up to 3 of `ctrl alt shift super`) | `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` | text `ok` |
| `move` | `x`, `y` | `mouse_move` | text `ok` |
| `key` | `key` (a name or single key from the existing allowlist); `repeat` 1..10 | `key` | text `ok` |
| `type` | `text`, printable ASCII, 1..512 characters | `type` | text `ok` |
| `scroll` | `direction` `up` or `down`; `amount` 1..10 (default 3); `x`, `y` and `modifiers` optional | `scroll` | text `ok` |

Every call is validated by `validateDesktopAction` and the client's own checks before it leaves the process; the Broker validates again. A failure is a fixed text code (`denied`, `lease_expired`, `limit_reached`, `invalid_arguments`), never a path, message or Broker reason. The result of an input tool says nothing about the screen. The scaling between the coordinates the model sees in the PNG and the Broker's `0..4095` position range follows the existing agent loop's convention and is NOT VERIFIED for this client (M13). Not offered: drag, hold key, mouse down or up, wait, and any other tool.

### 6.5 Events and claims

The driver turns Claude Code's stream into the **same event shape** `desktop-agent-loop.mjs` emits, so the board, the ledger and the director need no change: it reports the tool name and the step count, never screen bytes, typed text or key names. The final assistant text is a **claim** (`claimed_done` or `claimed_failed`, cut to 200 characters), never a pass. `usd` is 0 in the subscription edition; whether the result message carries a meaningful figure is NOT VERIFIED (M5).

### 6.6 Limits (D4: no money cap)

| Limit | Default | Ceiling | Enforced by |
|---|---|---|---|
| Wall-clock time per task | 15 minutes (today's room default) | 55 minutes, below the Broker's 60-minute lease | The driver's timer kills its own child by PID; the MCP server also stops answering at the same deadline |
| Desktop tool calls per task (screenshots count) | 120 (about 40 actions, each followed by a screenshot) | 400 | The MCP server counts and answers `limit_reached`; the driver kills the child 10 s later if it keeps going |
| Concurrent tasks | 1 per VM; total bounded by the room's existing fleet | the room's limit | Existing `agent-fleet` rules |
| Stop | A person's `stop` on a decision card, "stop all", CP stop | | Kills the recorded PID; the MCP server ends on stdin end. The Broker's lease for that operation still lives until a newer claim or its deadline (the ADR-002 follow-up) |

The numbers are Provisional. What the subscription's own usage limits do to a headless run is NOT VERIFIED (M5); the driver maps any authentication or rate-limit end to a fixed code and never retries in a loop.

### 6.7 API-key option

Same driver, same flags, same folders; the child environment carries `ANTHROPIC_API_KEY` from the secret `anthropic-api-key` instead of the token, and `--max-budget-usd` from the room's existing per-VM cap is added. This is the path the existing `ANTHROPIC_API_KEY` room uses without Claude Code; it is kept as an option and not changed by this contract.

## 7. Approval GUI (`AlberaApprover.exe --tray`)

One tray process per owner session (HKLM Run, `bin\approver`). It reuses the approver's pipe client with server verification, the digest recomputation, `SafeText` and the Hello signer (`approver-app.md`); the command-line `approve` stays as the fallback. It polls `list` every 2 seconds and exits quietly for any account that is not `approverSid`.

| Rule | Detail |
|---|---|
| One window per request | The tray shows "N more" for the rest. The window shows the purpose and the action in Japanese, the exact task text, the VM, the expiry, and the result of the digest recomputation. A non-ASCII character is highlighted. A control, bidi or zero-width character, or a digest mismatch, leaves no Approve path |
| Match code | The room shows 4 digits (`broker-contract/match-code.mjs`, merged in #174, `match-code-vectors.json` pins the C# twin). The window computes the code from the `approvalId` and the digest **it** recomputed and offers three candidates (`computeMatchChoices`). Decoys come only from the same hash. The owner clicks the one the room shows |
| Wrong pick | One wrong pick shows a warning and lets the owner pick again; the second wrong pick sends Deny |
| Right pick | Starts the Windows Hello signature over the presence message (the existing `albera.presence.v1` bytes). Hello is the only approval |
| No focus steal | `ShowWithoutActivation` and a taskbar flash. No default button; Enter and Space do nothing. All buttons are disabled for 1 second after the window is shown and when the request expires |
| No automation | There is no "approve all", "remember" or "approve on timeout". `decide approve` is sent only from the click handler (source guard, tested like the existing "no `--yes`") |
| Hello window handle | Use `IKeyCredentialManagerInterop` with the window handle. This is the open point in `approver-app.md` and can be verified only on the owner's PC (M14). Under RDP the window says to approve at the PC |
| Toolkit | Not decided here; it must support `ShowWithoutActivation` and run self-contained like the console approver |
| Rejected | A single Approve button (habituation), typing the code (paste risk), a toast (COM registration for an unpackaged app; backlog) |

## 8. Setup and verification

Start menu "ALBERA update" (All Users, administrator-writable) runs `C:\Program Files\Albera\bin\setup\albera-setup.exe` with a `requireAdministrator` manifest: UAC is the owner's first action.

| Step | Rule | Status |
|---|---|---|
| Build | NativeAOT, so no CoreCLR starts in the elevated process and `COR_*` / `CORECLR_*` / `COMPlus_*` variables set in `HKCU\Environment` do nothing to it. The linker is not available here, so the setup bytes come **only from CI** and are attested. Whether a `runtimeconfig` can switch CoreCLR profilers and startup hooks off, which would allow a locally reproducible build, is NOT VERIFIED (M17) | Decided (plan); build detail Provisional |
| Environment | Setup rebuilds the environment from an allowlist (`SystemRoot`, `windir`, `ProgramFiles`, `ProgramData`, a fresh administrator-only `TEMP`, `PATH` = System32) and starts `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` with that block (CreateProcess `lpEnvironment`). It replaces the manual `cmd /d`, `set COR_`, `reg query AutoRun` and `certutil` steps of `host-install.md` | Decided (plan) |
| Copy first | The update folder (a downloaded Actions artifact set or a local build) is copied into an administrator-only folder, and everything is verified on the **copies** | Decided (plan); how a later update folder reaches the owner (owner-placed vs fetched by setup) is NOT decided |
| Attestation (D6) | The bundled, version-pinned `gh.exe` runs `gh attestation verify <file> --bundle <bundle> --custom-trusted-root <Sigstore trust root embedded in setup> --repo BERORINPO/albera ...` for every file and for `build-hashes.json`, pinning the workflow `host-build-hashes.yml` at `refs/heads/main` and refusing self-hosted runners (the shape `host-install.md` already describes). Offline: the bundle includes the Rekor inclusion proof. `gh.exe` sits in the administrator-only `bin\setup` and its hash is in setup's own attested build. Exact offline flags and behavior with the pinned version are NOT VERIFIED (M8) | Decided |
| Tree hash | The attested `build-hashes.json` carries `treeHash`; setup recomputes it over the copies with the existing `Get-CanonicalTreeHash` rule and passes it to `albera-host.ps1 -ExpectedTreeHash`. Nothing is typed. This replaces the owner's branch-and-SHA check and the script `certutil` checks | Decided (plan) |
| Rollback | The run id of the attestation is stored in the install record (`setupRunId`) and a smaller one is refused, so an old but validly attested build cannot be replayed. How to read the run id from `gh` output is NOT VERIFIED (M8) | Decided (plan) |
| Claude Code pin | Setup copies the owner's per-user `claude.exe` into `bin\claude`, resolved from the owner SID's profile path (not from an environment variable; refused if the elevated SID is not `approverSid` in the record), records its `--version` string and SHA-256, and ALBERA never downloads or ships Claude Code. The CP hashes the copy at start and before each launch (about 297 MB; cost measured in M4). Auto-update must be off; the administrator-only folder is the backstop, the switch itself is NOT VERIFIED (M9). A refresh is an explicit second action, not part of every update | Provisional |
| Services | Creates `AlberaControlPlane` beside the Broker and the Authority, all three `start= delayed-auto` (D5), with `sc privs SeChangeNotifyPrivilege` and the sid types of `host-install.md`. The Start menu "Open ALBERA" shortcut and the HKLM Run entry for the tray are created here | Decided |

**What stays trust, stated plainly.** UAC will show an unknown publisher until code signing exists, so the owner's eye check is the program location `C:\Program Files\Albera\bin\setup\`. "Reviewed" rests on the protection of `main` and the merge tiers. An attestation says where a file was built, not that the code is safe. The pinned `claude.exe` is not ours and has no attestation: its trust is the owner's PC at the moment of copy, its Authenticode state is NOT VERIFIED (M10), and a program planted in the owner's profile before the copy would run as the CP identity during an approved task (bounded by the lease and the approval, not stronger than the existing same-user trust).

## 9. Migration from `albera-cp` (D7)

The first run is **one script from the repository** (`scripts/host/`, name fixed in PR7), run by the owner in an elevated console. It trades the owner's eye check of the hashes for a script, as the uncommitted `go.cmd` did on 2026-11-03 (`runtime-implementation-progress.md`); that trade-off applies to this one run only, because every later run goes through attested setup.

| Step | Detail |
|---|---|
| 1 | Read the existing install record, the Authority config and the Broker config; carry over `approverKeyId`, `approverPublicKey`, `approverSid`, the VM GUID, `computerId`, and the Hyper-V grant choice |
| 2 | Stop the `albera-cp` processes by PID (enumerated by owner SID); never by image name. Stop the services; run the existing uninstall (it removes the Broker's SID from Hyper-V Administrators first) |
| 3 | Install the new layout (sections 3 and 8): the CP service with no user account, `controlPlaneSid` in both configs becomes the CP `S-1-5-80-...` SID, the Hyper-V grant for the Broker only, then start the services and open the room |
| 4 | Delete the `albera-cp` account and its profile (`C:\Users\albera-cp`) |

Lost, by design: the CP journal and the Broker journal (one `synthetic.noop` and one unapproved `task.start`), and the Authority's signing key (regenerated, and the new SPKI goes into the Broker config). Kept: the Windows Hello key and its three public values. The migration closes the ADR-002 known gap that the configured Control Plane SID was an ordinary user.

## 10. PR split and dependencies

| PR | Purpose | Main files | Tier | Depends on |
|---|---|---|---|---|
| PR0a | This contract and the ADR-002 amendment | `docs/architecture/control-plane-service.md`, ADR-002 | docs | none |
| PR0b | Match code v1 (merged, #174) | `broker-contract/match-code.*` | normal | none |
| PR1 | Service lab (merged, #175) | `test/windows-service-lab` | test tool | none |
| PR1b | Lab measurements M1 to M13 that need Claude Code (section 11), with evidence JSON | lab scripts, `benchmarks/` | test tool | PR0a |
| PR2 | CP host and app-tree build | `src/runtime/windows-control-plane-host/**`, publish script | security | PR0a, PR1 |
| PR3 | Helper secret mode, secret store adapter and Fake | `windows-broker-pipe-client/SecretMode.cs`, `control-plane-secret-store.mjs` | security | PR0a, PR1 |
| PR4a | Room auth: bootstrap rotation and file, strict GET, route hook | `room-host.mjs`, `room-bootstrap-file.mjs` + Fake, `room-ui/index.html` | security | PR0a |
| PR4b | Credential field | `room-settings-routes.mjs`, `room-ui/settings.mjs` | security | PR4a |
| PR4c | Job form, match code display, stop all, approval test | `room-job-routes.mjs`, `room-ui/jobs.mjs`, `room-starts.mjs` | security | PR4a, PR0b |
| PR4e | Claude Code driver and desktop MCP server | `claude-code-driver.mjs`, `desktop-mcp-server.mjs` + Fakes | security | PR0a, PR1b gates M1, M4, M6 |
| PR4d | `room-service` command and wiring | `entry.mjs`, `room-service-wiring.mjs` | normal | PR3, PR4a, PR4b, PR4c, PR4e |
| PR5 | Approval GUI (tray, window, Hello with HWND) | `src/runtime/windows-approver/**` | security | PR0b |
| PR6 | Setup (NativeAOT), bundled `gh.exe`, verifier, workflow targets | `src/runtime/windows-setup/**`, `host-build-hashes.yml`, attestation fixtures | security | PR0a, M8, M17 |
| PR7 | Installer: CP service, migration script, folders, shortcuts, HKLM Run, delayed start, Claude pin | `scripts/host/albera-host{,-lib}.ps1`, tests, lab install check | security | PR2, PR3, PR5, PR6 |
| PR8 | Operations docs and ledger | `host-install.md`, `approver-app.md`, ledger | docs | PR7 |

Shared files with a fixed merge order: `scripts/arch-check.mjs`, `package.json`. `spec/architecture.md` decision lines are added by the lead, not by these PRs. The plan also listed a `host-install.md` plan section in PR0a; this PR leaves that file alone and PR8 owns it. Waves: (1) PR0a, PR0b, PR1, PR1b. (2) PR2, PR3, PR4a then PR4b and PR4c, PR4e, PR5, PR6. (3) PR4d, PR7. (4) PR8, then one owner run. Virtual-machine lab runs are serial (8 GB free). External AI review (not done) is wanted before PR4a and PR6: offline Sigstore bundle verification pitfalls, holes in the bootstrap-file scheme, whether NativeAOT ignores profiler variables.

## 11. Measurement plan and NOT VERIFIED items

Measured on 2026-11-03 (lab PR #175, `benchmarks/control-plane-service-lab-2026-11-03.json`, 6 PASS, 2 MEASURED, 1 BLOCKED as expected): the restricted CP token shape; node 24.13.0 and `node:sqlite` WAL; the pipe helper starting as the service child; DPAPI `CurrentUser` round trip and refusal for other identities; ProgramData DACL behavior; loopback reachable by other local users. The one BLOCKED item is outbound HTTPS (the lab guest has no network).

| ID | Not verified | How and where | Blocks |
|---|---|---|---|
| M1 | Whether an MCP tool result with an `image` content item (PNG, up to 8 MiB) reaches the model in Claude Code 2.1.310 as an image, and any size limit or re-encoding | A real headless run with a stub MCP server; owner PC or networked lab VM | PR4e (go / no-go for the whole subscription path) |
| M2 | Lifetime and expiry behavior of the `setup-token` token; where it is revoked; whether ALBERA could create it | Owner, one `setup-token` and a later reuse | PR4b wording, runbook |
| M3 | Whether `claude auth status` works with the token in the environment and does not spend a model call (the live check on save) | Same | PR4b |
| M4 | `claude.exe` starts as the restricted CP identity with the allowlisted environment, an empty config folder and no other program (for example a shell) installed; startup time, memory, hashing cost | Networked lab VM | PR4e, PR2 |
| M5 | Subscription usage limits in headless mode and the error shape at the limit; whether the result message carries a usable cost or usage figure | Owner | PR4e event mapping |
| M6 | The init message lists the tools and MCP servers; `--tools ""` plus `--allowedTools` leave exactly the six; empty `--setting-sources`; whether `--restricted` or `--safe-mode` keep `--mcp-config` servers | Stub run | PR4e |
| M7 | Outbound HTTPS from the restricted CP identity to Anthropic's hosts, with the real Windows Firewall; the host list | Networked lab VM | PR4e |
| M8 | Offline `gh attestation verify --bundle --custom-trusted-root` with the pinned `gh.exe` (flags, Rekor proof, reading the run id) | Lab VM without network | PR6 |
| M9 | How to turn Claude Code's auto-update off, and what it does in a folder it cannot write | Stub run | PR7 |
| M10 | Authenticode signature and publisher of `claude.exe` | Owner PC | PR6 |
| M11 | Whether the token environment variable reaches the MCP server grandchild; that killing the recorded PID ends the MCP server | Stub run under the Job object | PR4e |
| M12 | The exact stream-json messages (input shape, tool events, final result, end of stream), whether `--verbose` is required, and the hand-written MCP server's protocol conformance with this client | Stub run | PR4e |
| M13 | Screenshot pixel to Broker `0..4095` coordinate mapping for this client | First end-to-end run with a guest OS (ADR-002 also lists mouse input against a guest as open) | PR4e |
| M14 | Windows Hello prompt with the window handle (`IKeyCredentialManagerInterop`) | Owner PC | PR5 |
| M15 | Whether DPAPI blobs survive a service uninstall and reinstall (the service profile folder) | Lab VM | PR7 (else re-enter the credential after reinstall) |
| M16 | `Sec-Fetch-Site` values the owner's browsers send for a cross-port no-cors GET | Browser test | PR4a |
| M17 | Whether a `runtimeconfig` can switch off CoreCLR profilers and startup hooks reliably | Local | PR6 build choice |

Other items not verified: Hello provenance and the window-handle open points already listed in `approver-app.md` and `approval-authority.md`; adapter mouse input against a VM with a guest OS (ADR-002); the Broker, Authority and CP starting together under delayed start on the owner's PC; the Anthropic policy statement in section 6.

## 12. Rejected alternatives

| Alternative | Why not |
|---|---|
| Keep `albera-cp` | Needs an ordinary-user password, leaves the ADR-002 gap (an ordinary user's SID configured as the Control Plane), and cannot use DPAPI scoped to a service |
| nssm, winsw, a Node single executable | Not an SCM-native host with a Job object we control and review |
| Calling Anthropic's API with the subscription token from ALBERA | The brief states this is not allowed; only the user's own Claude Code uses the token |
| `claude --bare` | It never reads OAuth, so it excludes the subscription |
| Giving Claude Code built-in tools (Bash, Read, Edit, WebFetch) or the owner's MCP servers | Any of them is host authority; the six desktop tools are the whole interface |
| Reading the owner's `~/.claude` login state | The CP identity cannot, and ALBERA must not copy credentials |
| One persistent `CLAUDE_CONFIG_DIR` | State from one task would reach the next |
| MCP SDK package | External library adoption; the repository has no dependencies |
| SSPI, a named pipe, client certificates or a fixed port for the room | No Node support, browsers cannot use a pipe, and a fixed port invites squatting |
| LocalMachine DPAPI, DPAPI-NG, environment variables for storage | Readable by any local process, needs AD, or the 2026-11-03 leak path |
| A cost cap in dollars | Meaningless on a subscription; time and call count replace it |
| Typing `-ExpectedTreeHash` | Replaced by the attested `build-hashes.json` |
| An online GitHub API check, an elevated update task | Needs authentication for artifacts; a standing elevated task is a bigger target |
| Toast approval, a single Approve button, typing the match code | COM registration for an unpackaged app, habituation, paste risk |
