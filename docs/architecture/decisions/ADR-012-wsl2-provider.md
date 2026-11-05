# ADR-012 — WSL2 Provider (jobs on a PC without Hyper-V)

- **Status:** Proposed. Phase 1 is in progress and nothing is wired to a job. Security review required. Design review (2026-11-05): first BLOCK, then APPROVE as Proposed. Phase 0 has run on a stand-in image (results below). Gates G1, G6, G7 and G8 have not, and every gate runs again on the real image. No real token has been used.
- **Date:** 2026-11-05
- **Depends on:** ADR-001 (Provider), ADR-002 (Trust), ADR-007 (Verified integration), `docs/architecture/no-vm-mode.md`
- **Scope:** a new class of computer for Windows Home. Hyper-V stays the stronger choice wherever it exists.

## Context

Owner request 2026-11-05: run a real job on YOSUKE-NOTE, a Windows 11 Home PC. Home has no Hyper-V, so the level is Watch. WSL2 is on this PC and costs nothing. `no-vm-mode.md` left WSL2 as a separate decision; this is that decision.

WSL2 is not a Hyper-V VM with a smaller name. All WSL2 distributions share one Linux kernel in one utility VM, and it is built to reach into Windows. Its settings live inside the guest.

**So this is for code the owner would run on this PC anyway.** It reduces accidents and the reach of a misled model. It does not contain hostile code that holds a Linux kernel exploit. ADR-002's rule stands: untrusted code needs a VM.

## Measured (YOSUKE-NOTE, WSL 2.6.3, kernel 6.6.87.2, 2026-11-05)

A throwaway distribution copied from Ubuntu's binaries, not the proposed image, so **nothing here carries over without being measured again (gate G0)**. `automount` and `interop` were off in `wsl.conf`, with a plain user `job`.

| Check | Result | How far it goes |
|---|---|---|
| `job`: `/mnt/c` | Absent | |
| `job`: mount C: | The `mount` command refused | `mount(2)` itself not tried |
| **root: C: mounted with `wsl.conf` off** | **Root listed the top of C:** | Which of two commands worked is not known. The `9p` line used file descriptors that were not open, so `drvfs` is the likely one |
| `job`: Windows host, TCP 135, 445, 3389, 5357 | Not reachable | Four TCP ports only |
| `job`: internet (1.1.1.1:443) | **Reachable** | |
| `/run/WSL/1_interop` | World-writable socket, present with interop off | |
| `job`: a Windows `.exe` it copied in | Hung until killed at 10 s. **The control failed too** | Proves nothing |
| In a sandbox (`unshare` + `setpriv`): internet, socket, processes, capabilities | No internet, socket hidden, 4 PIDs, capabilities 0, `no_new_privs` 1 | |
| In the sandbox: the same `.exe` | Exit 1, because `/init` failed to parse `/proc/1/stat` | An accident, not a guarantee |
| In the sandbox: `AF_VSOCK` | **Socket created.** Port 1024 timed out | The wrong port. WSL's own ports are around 50000 to 50006, some of them file service (gate G2) |
| Bytes through `wsl.exe` | Identical for one 96 KB file through `cmd` redirection | Not bundle size, not a real pipe |
| Cold start | 283 ms | The utility VM may have been running already |

What follows: **`wsl.conf` is not a boundary, and root in the guest reaches the owner's C: drive.** A non-root job can reach a Windows-side file server over `AF_VSOCK` unless seccomp stops it: see "Phase 0 results".

## Phase 0 results (2026-11-05, stand-in image, no real token)

**The stop condition was met: a non-root job reaches a Windows service.** Phase 1 has not started.

| Gate | Result |
|---|---|
| G2, plain job | Host ports 50000, 50001, 50002 and 50005 accept a connection. A scan of 1 to 65535 with a 3 s wait found only these four at that moment; a port WSL opens later would not show |
| G2, what answers | **Port 50002 answered a 9P hello (`Rversion`, `9P2000.L`): a file server on the Windows side.** No attach was tried, so whether it opens C: is unknown, and this ADR assumes it does. 50001 closed the connection; 50000 and 50005 gave no reply |
| G2, in the sandbox without seccomp | The same four ports. Namespaces, `pivot_root` and dropped capabilities do nothing here |
| G2, in the sandbox with a seccomp filter | `socket(AF_VSOCK)` refused, 31 of 31. **seccomp is the only thing that stops this** |
| WSL stopped starting | Three times, some time after a job had connected to these ports, every distribution failed with `Wsl/Service/CreateInstance/E_UNEXPECTED` until `wsl --shutdown`, the owner's Ubuntu included. Without touching vsock it did not happen: 85 s idle with the probe running, and a stop and restart of the probe. A correlation, cause not known, and not separated by port |
| G3 | **The `.exe` route is closed, with a control in the same probe.** A Windows program starts only when both the file and the working folder are on C: (Ubuntu: file on the Linux disk, or working folder `/`, gives "Invalid argument"). With both on C:: interop on, plain job: **started (19 polls)**. Interop off, plain job, with or without `WSL_INTEROP`: 0. Sandbox, interop on: 0. Sandbox, interop off: 0. So `interop=false` works and the sandbox stops it by itself. **Limits:** in the sandbox the kernel still runs `/init` as the `.exe` handler, and it exited 1 on a parse error, so the sandbox's 0 rests partly on that accident. Speaking the interop protocol directly was not tried |
| G4 | Good: `/` has only `bin dev etc lib lib64 probe proc sbin tmp usr work`, `/dev` only `null urandom zero`, 4 PIDs, capabilities 0, `/usr` read-only. Open descriptors: 0, 1 and 2 are pipes from the WSL relay; 3 and 255 belonged to the listing shell. No socket |
| G5 | TCP to the internet, the host and the LAN refused; UDP send "Network is unreachable" |
| G0 | Root reaches C: through `drvfs` alone (51 entries). 50 MB through a real pipe, identical, 257 ms. Cold start after `wsl --shutdown` 1746 ms. `wsl --import` of the 1.7 GB stand-in 26 s. **`unshare -Ur` works under `no_new_privs`**, so the allowlist must refuse user namespaces. `drvfs` inside a user namespace: "unknown filesystem type". `mount(2)` as `job` not measured (script error) |

What this changes: R3 is no longer unknown. Without seccomp a job reaches a Windows file server. **The boundary between a job and Windows is one seccomp filter and the core limit (R8).** A mistake in either would be silent.

These are now required. Owner decision 5.

- **Proof on every run.** Before the job starts, under the same filter as the job, a fixed self-test tries `socket(AF_VSOCK)`, `socketpair(AF_VSOCK)`, `io_uring_setup`, a 32-bit and an x32 system call, `clone(CLONE_NEWUSER)`, `clone3`, `unshare` and `setns`. Anything not refused, or a filter that fails to load, ends the run. A deliberately broken filter must stop a run: that is an acceptance test.
- **Descriptors.** The agent's 0, 1 and 2 are pipes root made, nothing else. An inherited vsock descriptor would never pass through the `socket` filter.
- **The working folder and every file of the job stay off Windows drives.**

## Decision proposed

1. **New provider `wsl2`, its own isolation class.** Capabilities report `isolation: "wsl2"`, never `"vm"`. A task that requires `isolation=vm` is never placed here (ADR-001: never downgrade silently). The owner adds a WSL2 computer on purpose.
2. **The AI stays out of the guest, and the token with it.** `claude -p` runs where it runs today (the Control Plane identity, `--tools ""`, the token in the child's environment only). Its hands change: instead of six desktop tools it gets a new MCP server, `albera_shell`, whose tools act in the sandbox. The guest needs no network.
3. **The Control Plane never runs `wsl.exe`.** A guest that gets out through `wsl.exe` would hold the identity of whoever started it. The Control Plane's identity opens the DPAPI token and the Broker's pipe, so it must never be that identity. An arch rule enforces this. Only the **WSL bridge** (below) runs `wsl.exe`.
4. **Approval binds the target, and the Broker's role is not dropped.** The action's args gain `isolation`, `repositoryId` and `baseOid`, so they are in the digest the owner approves. `ServiceConfig.cs` requires a `vmId` today, so the Broker learns a second kind of computer, `{ computerId, kind: "wsl2" }`. For an approved `task.start` it signs a **run lease** with its existing key under its own domain string, `albera.wsl2-run-lease.v1`, so a lease can never be read as an attestation or the other way round. The lease names `operationId`, `computerId`, `isolation`, `repositoryId`, `baseOid`, the expiry and the call limit. The bridge pins the Broker's public key, refuses a run without a valid lease, and counts calls itself. The bridge makes the input bundle itself from the repository the settings map to `repositoryId`, because the Control Plane's account may not be able to read it, and refuses a head that is not `baseOid`. So the check is outside the low-privilege Control Plane, as ADR-002 asks. `vmMatches` in `room-service-hands.mjs` must refuse a `wsl2` computer whose action lacks these fields. A `wsl2` `task.start` always asks a person, at every tier: no attestation can stand in for one.
5. **The approval window says what it means.** "WSL2. Weaker than a VM. A Linux kernel bug here would let the job act as you on this PC." The text is fixed and keyed on `isolation`, which is in the digest.
6. **A new distribution for every run.** The bridge checks the image's SHA-256 on the Windows side, runs `wsl --import` as `albera-run-<id>`, and unregisters it afterwards. The guest's word about itself is never the check (ADR-001 section 6, ADR-002). Never the owner's Ubuntu.
7. **Root only relays bytes.** Root's whole part is a fixed script that builds the sandbox and starts the agent. It never opens a path, reads a file, or runs git in anything the job can touch. Every file operation and the bundle are done inside the sandbox, as `job`.
8. **The sandbox.** Namespaces: net, mount, pid, ipc, uts, cgroup, with a fresh `/proc`. `pivot_root` into a minimal root with a minimal `/dev`: no `/run/WSL`, `/mnt` or `/dev/dxg`. `/init` is gone from the root, but the kernel still runs it as the `.exe` handler (measured), so it is not counted as removed. `close_range` closes inherited descriptors. `setpriv` to `job` with no capabilities, an empty bounding set and `no_new_privs`. A cgroup limits memory and PIDs. The hard core limit is 1 (R8). The launcher checks from the inside that it is the first process of its PID namespace, with no capabilities, only loopback, and pipes for stdio, and stops otherwise. Then a seccomp **allowlist**, with the architecture pinned so that the 32-bit ABI is refused. It does not allow `AF_VSOCK`, `io_uring`, user namespaces, `mount` or `fsopen`, `bpf`, `ptrace`, `keyctl`. `clone3` answers `ENOSYS`, because seccomp cannot read its flags.
9. **One resident agent per run.** An unprivileged `albera-agent` inside the sandbox, started once, takes `run`, `read`, `write` and `bundle` over stdin and stdout, with framing and size limits. Nobody enters the namespaces from outside, so no root `nsenter`.
10. **Code goes in and out as git bundles.** The result goes through `git-quarantine.mjs` (ADR-007), with a size limit before import. **The result is `agent_reported`, never `trusted_verified`:** there is no independent verification here. The room shows the diff as untrusted text, escaped. The quarantine has no check for secrets or LFS, and the page says so.
11. **Nothing from the host goes in but the task, the bundle and the commands.** `WSLENV` empty, no credential, no Windows path.
12. **A minimum kernel.** The bridge reads the WSL version on the Windows side and refuses a run below the floor in its config. The floor has an expiry date, and past that date the bridge refuses too, so a forgotten floor cannot go stale in silence. A job is arbitrary code by design, so a known kernel bug is the whole risk (R1).
13. **Stop.** Normal stop: `wsl --terminate` of that distribution, then unregister. Suspected escape: `wsl --shutdown`, which restarts the kernel and also stops the owner's Ubuntu and Docker, so the page says so first.
14. **The level.** A third level **Work (WSL2)**, in Japanese **任せる (WSL2)**, appears only when the bridge answers and the kernel is above the floor. `host-capabilities.mjs` still grants nothing. `no-vm-mode.md` rule 2 is amended: it covers Watch, and a WSL2 computer is an explicit, separate grant.

```
 Room ── task ──> Control Plane ── task.start ──> Authority ── Hello ──> owner
                       │                              │ claimed
                       │                            Broker ── signs run lease
                       v
                  claude -p (Windows side, no built-in tools, holds the token)
                       │ MCP: run / read / write
                       v
                  albera_shell ── pipe + lease ──> WSL bridge (owner's session; the only wsl.exe caller)
                                                     │ checks lease, image hash, kernel floor, call count
                                                     v
                                     albera-run-<id> (new distribution)
                                       root: builds the sandbox, then relays bytes only
                                       job:  albera-agent, no network, no capabilities, seccomp
   owner reads the diff <── git-quarantine <── bundle <──┘
```

## The WSL bridge

WSL distributions belong to a Windows user, so a small process in the owner's session runs `wsl.exe`, started the same way as the approval tray. Its verbs are fixed: `begin`, `exec`, `put`, `get`, `end`, `stop`. It takes a lease, a run id and bytes, never a Windows command line. It limits the size of `put`, `get` and the output of `run`, because the job can take over the agent and the agent's limits count for nothing.

The bridge runs without elevation. Its program, its config and the image are writable by administrators only, so the file it checked is the file it imports.

The pipe's ACL names the Control Plane SID. The bridge also creates it with `FILE_FLAG_FIRST_PIPE_INSTANCE` and checks the caller's SID. The Control Plane checks the server's SID before it sends anything.

The bridge runs as the owner. That is not a new weakness: a guest that escapes is already the owner (R1).

## What this does not protect against

The docs and the approval window must say these plainly.

| # | Risk | What it means | What limits it |
|---|---|---|---|
| R1 | **A Linux kernel bug in the guest.** The job then runs code as the owner: files, the network, and the approval tray, which runs as the owner too, so a later approval on this PC can no longer be trusted | The whole sandbox, the network block included, sits in that same kernel. On Hyper-V this would take a hypervisor escape | Kernel floor, seccomp allowlist, no capabilities. **These lower the odds. Once it happens, nothing here stops it** |
| R2 | The same bug reaches the owner's other distributions, Docker's included | Same kernel | Same as R1 |
| R3 | `AF_VSOCK` reaches a Windows file server (assume it opens C:), and port 50000, which WSL uses for its own start-up (what a job could do there is not tested). WSL stopped starting after such connections | **Measured without seccomp.** The seccomp filter is the whole boundary for this route | seccomp allowlist, proved on every run |
| R4 | Text in the repository steers the model | It can run more commands in the sandbox, and put bad code in the bundle | The quarantine, and the owner reads the diff |
| R5 | Secrets in the repository are visible to the model and its provider | The same as a VM job | The owner picks the repository |
| R6 | WSL's shared settings: `.wslconfig` `guiApplications` and `gpuSupport` apply to every distribution | Turning them off changes the owner's Ubuntu | Owner decision 2 |
| R8 | **Routes that do not pass through the job's filter.** A crash: WSL pipes the dump to a root helper that sends it to Windows over vsock, with content the job controls. Measured: a crash of a plain job added a file to `%TEMP%\wsl-crashes` | Closed for this route: the launcher sets the hard core limit to 1. Measured: two crashes in the sandbox, one after trying to raise the limit, added nothing. Other kernel-side helpers were not looked for | The limit, and review |
| R7 | The disk: a VHD can grow to the default limit on the owner's C: | Fills the drive | `put` and `get` limits, a disk quota to be measured (G6) |

## Gates: all must pass before any real token is used

| # | Gate | How |
|---|---|---|
| G0 | Every row of "Measured", again, on the real image and sandbox: `mount(2)` directly, each mount path separately, a cold start after `wsl --shutdown`, a bundle of realistic size through a real pipe, the time for `wsl --import` | Throwaway script |
| G1 | The Broker, the lease and the bridge refuse a missing, expired, reused or wrong-target lease, and a bundle whose head is not `baseOid`, one test each. A `wsl2` `task.start` asks a person at every tier | Unit tests |
| G2 | **Pass means under the real allowlist.** A non-root job connecting to `AF_VSOCK` is refused: ports 50000 to 50006, then a wide scan, because WSL may also use ports it picks at run time. **With and without seccomp, so we know what seccomp is holding back** | Script from inside |
| G3 | A Windows program started from the sandbox never runs | Watch Windows process creation, with a **working control** |
| G4 | What is visible in the sandbox: `/dev`, `/proc`, open descriptors, nothing of `/dev/dxg` or `/mnt/wslg` | Script from inside |
| G5 | Nothing leaves: TCP, UDP, DNS, to the host, the LAN and the internet | Script from inside |
| G6 | Limits hold: memory, PIDs, disk, bundle size. A job cannot outlive `stop` | Fork loop, then count |
| G7 | Root never touches a job path: a planted `.git/config`, hook and symlink do nothing as root | Planted faults |
| G8 | Zaku's review of this ADR and of each security-tier PR | Before merge |

Also before any real token, from the code review of the launcher:

- Crash again in a plain job after the sandbox test, so the dump counter is shown to be still working (the control so far ran only before it).
- G6 reads the `max` counters in `pids.events` and `memory.events`, and `memory.max` is checked to be below the VM's memory.
- List and check the other kernel-side helpers that run outside the filter, such as `request_module` and `binfmt`.
- A machine check that no shipped image holds an `ALBERA_BROKEN` or `ALBERA_TEST_BUILD` build.

A job that reaches its limits ends the run: the agent is the first process of the PID namespace, and when it dies the namespace goes with it.

## Rejected

- **Claude inside WSL.** It would need the token and the network in the guest.
- **`wsl.exe` from the Control Plane.** Decision 3.
- **Trusting `wsl.conf`, or a start check run in the guest.** Measured, and ADR-002.
- **A reused distribution.** ADR-001 section 6.
- **A seccomp deny list.** Too much slips past it: `io_uring`, 32-bit `socketcall`, user namespaces.
- **Docker Desktop.** The same kind of shared kernel, plus a privileged daemon and a licence that depends on the user.
- **Running on the host with CLI flags.** Rejected in `no-vm-mode.md`.
- **Network with an allowlist in v1.** It needs a proxy outside the namespace and its own review.

## Phases

| Phase | Content | Merge tier | Who |
|---|---|---|---|
| 0 | G0, G2, G3, G4 as throwaway scripts on a stand-in image, run again on the real image after Phase 1. Stop condition: a non-root job reaches a Windows service. **It was met, and owner decision 5 continues past it** | None | AI |
| 1 | Image, sandbox script, `albera-agent`, seccomp allowlist | Security boundary | AI |
| 2 | Action fields, the Broker's second kind of computer, the run lease | Security boundary | AI |
| 3 | The bridge, `albera_shell`, the driver's tool set made a parameter | Security boundary | AI |
| 4 | Bundles in and out, the diff in the room, the level, the approval text | Security boundary | AI |
| 5 | Install on YOSUKE-NOTE and the first real job | Owner action | Owner, about 30 minutes |

The repository's security tier also asks for a disposable VM, and this PC has no Hyper-V. A throwaway distribution is the nearest thing here, and it does not prove the same things. Owner decision 3.

## Later

Package installs through an allowlisted proxy. Desktop work (WSLg is a different boundary and is not offered).

## Owner decisions

1. **Accept R1 on this PC?** A kernel bug in WSL2 would let a job act as you, including on the approval tray. **Decided 2026-11-05: accepted by the owner**, for repositories whose code the owner would run on this PC anyway. Not for untrusted code.
2. **Turn off `guiApplications` and `gpuSupport` in `.wslconfig`?** It also affects your Ubuntu. Recommended: decide after G4 shows whether it is needed.
3. **Accept a throwaway distribution instead of a disposable VM for review on this PC?** **Decided 2026-11-05: yes, by the owner**, for WSL2 PRs only. It does not prove the same things as a VM.
4. **Install the services on YOSUKE-NOTE at Phase 5?** It needs an administrator and a native `claude.exe`. Recommended: yes.

5. **Continue with one seccomp filter as the boundary, or stop and use Windows Pro?** Phase 0 met the stop condition. **Decided 2026-11-05: continue, by the owner.** The per-run proof is required. The reasoning given at the time was that a bypass needs a kernel bug or a filter mistake. **That was incomplete:** code review found a route outside the filter (R8), and there may be others of that kind. The per-run proof lowers the chance of a filter mistake; it does not rule one out.

## Decision line (after adoption)

`2026-11-05 wsl2-provider | Home PCs get a WSL2 computer with its own isolation class, for code the owner would run anyway: the AI and the token stay on the Windows side, a run lease from the Broker binds the target, the job is a non-root, no-network sandbox in a new distribution, and returns a git bundle | wsl.conf is not a boundary (measured), and a shared kernel must never be called a VM`
