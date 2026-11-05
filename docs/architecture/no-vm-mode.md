# No-VM mode: use ALBERA on a PC without Hyper-V, and say what is missing

**Status: Proposed, NOT IMPLEMENTED.** Owner request 2026-11-05: on a PC without Hyper-V, offer the features that work without it and make the limit explicit, instead of "ALBERA cannot run here".

## Why

Hyper-V exists only on Windows Pro and above. Windows Home, macOS and Linux cannot run the VM features, and the MIT local edition is the part meant to spread (open core, 2026-10-29).

Measured on a Windows 11 Home PC (YOSUKE-NOTE, 2026-11-05):

| Command | What happens today |
|---|---|
| `albera` (session board) | Works |
| `albera-runtime room --demo` | Works |
| `albera-runtime room` | Stops with the code `runtime_fleet_job_required`. It does not say that this PC has no Hyper-V |
| `albera-runtime wall --vm nosuchvm` | Starts and listens, with a VM that cannot exist. Nothing says why no screen will come |

So the features exist, but nothing tells a person which ones this PC can use.

## What this is not

- **Not a way to run AI on the host.** No level here starts an AI. See "Ask: not offered yet".
- **Not a replacement for stage 1.** It does not move M4 or M14.
- **Not a new isolation provider.** Containers and WSL2 stay under ADR-001 and are a separate decision.

## Two levels

| Level | Needs | What a person gets | Does an AI run |
|---|---|---|---|
| **Watch** | Node.js 22 | The session board, the room demo | No |
| **Work** | Hyper-V and the installed services | Jobs in VMs, cameras, hands, checkpoints | Yes, in a VM |

## Ask: not offered yet

A third level, an AI on the host that reads and answers, looks free because `albera-runtime` exists. It is not ready, and the page must not offer it:

- **It cannot answer.** The supervisor discards provider output, and the Runtime screen says so ("Provider output is discarded"). Showing output needs its own design, including secrets in the output and HTML in it.
- **Read-only does not mean "this folder".** The `read-only` profile is CLI flags (`--restricted`, `--safe-mode`, `--permission-mode plan`), not an OS boundary, and it does not limit reads to the working folder. A read of `~/.ssh` could reach the provider (not tested on a real CLI). Approval would have to say: every file your account can read, and where the content goes.
- **The prompt is in the process arguments** with `read-only`. Only `read-only-streaming` avoids that.
- **`spec/runtime-gateway.md` says not to expose the Gateway** until an OS sandbox is designed and verified. Offering Ask means changing that, on purpose.
- **Real CLI compatibility is unverified**, and Windows resolution accepts `.exe` only. An npm install of Claude Code (`claude.cmd`, as on this PC) is not found.

Ask stays out until all five are closed. That is a security-tier epic of its own and an owner decision.

## Rules

A change that breaks one needs a security-tier review.

1. **No silent downgrade.** A job for a computer is never moved to the host. With no VM it is refused with a new code, `vm_unavailable`. ADR-001 already says this for `isolation=vm`.
2. **No AI on the host from this mode.** No writable profile, no tools, no MCP, and no start path.
3. **The probe grants nothing.** It decides only what the page shows. No start path reads it: the Broker, the Authority and the receipts decide as before.
4. **Unknown means not available.** If the probe fails or times out, Work shows as unavailable with the reason `unknown`.
5. **Every unavailable feature says why** and what would change it, in one line. No dead buttons.

## The probe

`src/runtime/host-capabilities.mjs`, split in two: a pure `classify(facts)` and an adapter that gathers the facts. It never needs an administrator.

| Fact | Windows source | Use |
|---|---|---|
| Hyper-V service present | `sc.exe query vmms`, absolute path under `System32`, fixed arguments, no shell | 1060 means the service is not there (measured). This alone decides whether Hyper-V is here |
| Edition | `EditionID` through `reg.exe query`, absolute path, fixed arguments | Only picks the hint text: "this edition cannot" or "turn the role on". `Core` measured on Home, and every `Core*` value counts as Home. A wrong value gives a wrong hint, never a wrong level |
| ALBERA services installed | The same query for the Control Plane service (arch rule 10a keeps the Authority's name out of runtime modules) | Tells Work from "Hyper-V is here, ALBERA is not installed" |

**Do not use `Win32_ComputerSystem.HypervisorPresent`.** It is `True` on this Home PC, because WSL2 runs a hypervisor, while Hyper-V management does not exist there. Do not use `root\virtualization\v2` either: it needs an administrator.

On macOS and Linux the result is fixed: no Hyper-V, reason `platform`.

```
{ level: 'watch' | 'work',
  work: { available: boolean, reason: 'home_edition' | 'role_off' | 'not_installed' | 'platform' | 'unknown' | null } }
```

The result holds no paths, account names or versions, so the page and a feedback report can show it as it is.

## What a person sees

**In the terminal.** A new read-only `albera-runtime doctor` prints the level and the reason, then on Windows lists everything Work needs at once (what it cannot read without an administrator, Windows Hello and the VMs, says "check yourself", never "ok"; Node.js and Claude Code are listed only until the services are there, because the install copies them; the list ends by saying it is no promise). `room` without a job and `wall` print the same lines when Work is unavailable, before they stop or start. Exit codes do not change.

**In the room.** `albera-runtime room --no-vm` starts a room with no cameras, which needs no job. The top bar shows the level. The canvas shows one sheet: what works here, what does not and why, with a link to the demo. Jobs is disabled with its reason.

**Who reaches this.** `package.json` publishes `src/entry`, `src/core`, `src/adapters`, `src/shared` and `public`, and `bin` has only `albera`. `src/runtime` is not in the package, so `doctor` and `room --no-vm` reach people through a clone or the demo exe, not `npx albera`. Publishing the Runtime is a separate decision (decision 3).

## Phases

| Phase | Content | Merge tier | Rough size |
|---|---|---|---|
| 1 | `host-capabilities.mjs`, `doctor`, clear lines from `room` and `wall` | Normal | Small |
| 2 | `room --no-vm`, level in the top bar, the sheet, Jobs disabled with a reason | Normal | Medium |
| 3 | README: what each level needs. It still describes the old read-only board and the old clone URL | Docs | Small |

None of these starts an AI or changes an approval path.

## Tests

- `classify`: every row of facts, including a failed probe, gives the expected level and reason.
- A hypervisor present with no `vmms` never gives Work.
- Rule 1: a job with no VM is refused with `vm_unavailable`, and no process is started on the host.
- Rule 3: no start path imports `host-capabilities.mjs` (arch check). With the probe faked to Work on a PC without the services, nothing starts.
- Arch check: the probe spawns only by absolute path, without a shell.
- Real runs: Windows Home (this PC), Windows Pro with Hyper-V, CI on macOS and Linux for `doctor`.

## Open questions

- Whether `sc.exe query` gives the same answers under the Control Plane's virtual account. Not measured, and only matters on an installed PC.

## Owner decisions

1. **No AI on the host in this mode?** Recommended: yes. AI work stays in a VM.
2. **Leave Ask for later, as its own epic?** Recommended: yes.
3. **Publish the Runtime to npm?** Recommended: not now. Decide with the first release.
4. **Names.** Recommended: Watch / Work, shown in Japanese as 見る / 任せる.

## Decision line (after adoption)

`2026-11-05 no-vm-mode | a PC without Hyper-V gets the level Watch, says why Work is missing, and never moves a job to the host | the local edition must run on Home, macOS and Linux without weakening what isolated means`
