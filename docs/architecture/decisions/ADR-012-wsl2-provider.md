# ADR-012 — WSL2 Provider (jobs on a PC without Hyper-V)

- **Status:** Proposed. Phase 1 is done, Phase 2 is done except the Broker's signature (see "Phase 2 results"), Phase 3 built the bridge and ran it on the machine (see "Phase 3 results"), and nothing is wired to a job. Security review required. Design review (2026-11-05): first BLOCK, then APPROVE as Proposed. Phase 0 ran on a stand-in image and Phase 1 on the real image (results below). G1 is proved for the contract and the bridge, and waits for the Broker's signature; every gate runs again once the image changes. No real token has been used.
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

## Phase 1 results (2026-11-06, real image and real sandbox, no real token)

The image is `ubuntu-base-24.04.5-base-amd64.tar.gz` (pinned by SHA-256) plus `git`, built by `src/runtime/wsl2-guest/build-image.sh` in a throwaway distribution, which also compiles the launcher and the agent from source with fixed flags: a 162 MB tar. `node scripts/wsl2-gates.mjs <image> <folder>` imports it as a throwaway distribution, talks to `albera-agent` through `enter.sh` over `wsl.exe` pipes, and removes it: 25 of 25 checks passed. That tool never runs a job without the filter.

| Gate | Result |
|---|---|
| Start | The agent answered in the real sandbox in about 0.5 s. `wsl --import` took about 2 s |
| G2, real filter | `socket(AF_VSOCK)` and `socketpair(AF_VSOCK)` refused with EPERM. **The run without seccomp was not repeated on this image**: it can stop every distribution, so it needs the owner told first. The wide scan has nothing to scan while `socket` is refused |
| G3 | The working control started a Windows program from a plain distribution (seen in 9 polls). Copied into the sandbox: 0 polls. **Weak:** a Windows program starts only from C:, and the sandbox has no C:, so the two runs differ in where the file is. It shows the file does not run there, not that the sandbox alone stopped it |
| G4 | `/` has only `bin dev etc lib lib64 opt proc sbin tmp usr work`, `/dev` only `null urandom zero`. No `/dev/dxg`, `/mnt/wslg`, `/run/WSL` or `/init`. Capabilities 0, bounding set 0, Seccomp 2. The agent holds pipes on 0, 1 and 2, the pipe of the running command, and no socket. A command gets 0, 1 and 2 only |
| G5 | TCP to the internet, the LAN and loopback closed, UDP "Network is unreachable", only `lo` |
| G6 | `/work` stopped at 2 GiB. `fork` stopped at 1020 with `pids.events` max counted. A 6 GiB allocation was killed with `oom_kill 1`, and the agent survived it. `memory.max` 4 GiB of the VM's 7.8 GiB. Nothing outlived a run |
| G7 | **Still open.** No root runs in the sandbox and the root relay does not exist yet, so nothing planted could reach root. A bundle of a repository with a planted hook, `core.fsmonitor` and symlink worked. G7 is measured with the bridge |
| G0 | `mount(2)` as the job failed for `drvfs`, `9p` and `tmpfs` (a plain user gets this without a filter too), user namespaces refused, 50 MB of random bytes through a real pipe with the same SHA-256 in about 0.3 s. **A cold start after `wsl --shutdown` was not measured**: it would stop the owner's distributions |
| R8 | Crashes in the sandbox added no dump, with the core limit attacked through both calls and `ulimit -Sc 0` (4 to 4). The control after it did (4 to 5) |
| Test builds | None in the image: it compiles its own programs, with no `-D`, and the gate looks for the `ALBERA-NOT-FOR-SHIPPING` marker |

Kernel-side helpers outside the filter, as read on this image: `core_pattern` is `|/wsl-capture-crash %t %E %p %s` (R8), `modprobe` is `/sbin/modprobe`, `hotplug` is empty, `poweroff_cmd` is `/sbin/poweroff`, and `binfmt_misc` has `WSLInterop` with interpreter `/init`, flags PF. Whether a job can trigger `modprobe` with the calls it has left was not tested.

Found on the way, all fixed:

- **The core limit could be lowered (Zaku, CRITICAL).** The kernel skips a piped dump only while the soft limit is exactly 1, and a job may lower its own soft limit with no privilege. Measured before the fix: `ulimit -Sc 0` then a crash got a dump to Windows, past the filter (3 to 4). The earlier checks only tried to raise it. seccomp now refuses any change to `RLIMIT_CORE` through `setrlimit` and `prlimit64`, the launcher proves that on every run, and a broken build of this rule stops at the self-test.
- **The cgroup tree is shared and outlives a distribution.** A group named with `$$` collided with the one a removed distribution left behind, and the run stopped. `enter.sh` now uses a random name and removes empty leftovers.
- **A `.tar` built from a `mktemp` folder keeps mode 700 on `/`.** Inside the sandbox this does not show. Outside it no user could start, which made the crash control fail for the wrong reason.
- **The sandbox's `/etc` has no `alternatives`**, so `awk` and other such links dangled. The image points them straight at the programs. A gate that used `awk` had passed on empty output before this was seen. Zaku also found gates that could not fail (G7, and G3 as a proof about the sandbox); they are labelled for what they show.

What this means for owner decision 2: G4 shows neither `/dev/dxg` nor `/mnt/wslg` in the sandbox with the owner's settings unchanged, so `.wslconfig` does not need changing for the sandbox.

## Phase 2 results (2026-11-06, no real token, no real key)

Built: the run lease (`wsl2-run-lease.mjs`, its C# twin, and shared vectors), the action's three new args, the Broker's second kind of computer, and the rule that such an action always has a person.

- **A wsl2 computer and a VM cannot stand in for each other.** The Broker takes only `{ task, isolation, repositoryId, baseOid }` for a computer the config names `kind: "wsl2"`, and refuses that form for any other computer. The hands make the same check against their settings, in both directions. A wsl2 computer makes no desktop lease, and a config with only wsl2 computers opens no desktop pipe.
- **A person at every tier.** A receipt with basis `policy` is refused when its action names `isolation`, in both twins, and the Authority does not look at an attestation for such an action. This holds even with a VM and a genuine attestation beside it.
- **The hands refuse a wsl2 computer** (`wsl2_hands_missing`) until Phase 3: today they drive a Hyper-V desktop.

**Before `room-service-config` reads a wsl2 computer, decision 5's text must be in the approval window** (Zaku): today it would call the computer a VM.

**Not built: the Broker's signature.** The design said "its existing key", which was wrong. The production Broker has no key and no request that signs anything (ADR-002, Amendment 2026-11-04), and issuing one is owner decision AGM-2, before which that amendment says nothing may be built. A lease can be made and checked only with a test key today. So G1 is proved for the contract and the claim, and not for the Broker signing a lease.

## Phase 3 results (2026-11-06, real image, real wsl.exe, no real token, no real key)

Built: `src/runtime/windows-wsl-bridge/` (C#, BCL only, no package), the only code that starts `wsl.exe` (arch rule 13). Verbs `begin exec put get end stop`, one request per pipe connection, four pipe instances so a `stop` can arrive during an `exec`. Wire format: the header comment of `Wire.cs`. It takes no Windows path, no Windows command line and no distribution name; the `exec` command is bytes for `bash -c` inside the sandbox and goes through the agent's stdin, never through `wsl.exe`'s arguments.

- **Order of `begin`:** the lease is proved first (`Authenticate`: shape, digest, signature, time), and only then is its `repositoryId` looked up in the config and the head read by the bridge itself (hardened git, as `git-process.mjs`). The end of the lease is looked at again after the read. Then `RequireBinding` (own computer, base head, operation, repository, and the generation floor, read at that moment from its own admin-only file). Then the operation id is written to a file and flushed (a failed write refuses the run), then the image SHA-256 with the file held open, then WSL version and kernel floor and its expiry, the end of the lease once more, `wsl --import albera-run-<id>`, the agent, and the input bundle (the bridge's own, its header checked against `baseOid`, cloned inside the sandbox as the job user). The end of the lease is read a last time before the answer. From the import on, every way out that is not a registered run discards the distribution and the agent, whatever the exception was.
- **Revoking on a running bridge:** the floor is the file named by `leaseFloorPath` in the config: one ASCII number, written by an administrator. The bridge reads it at every `begin` and every reaper tick, through the admin guard for the file and for its folder, so the runbook's step is to rewrite that file, with no restart. A floor that is missing, in use, loosely protected or not a number refuses every `begin` (`lease_floor_unreadable`) and stops the start; it is never read as "no limit". A run whose generation is below the floor is normally ended by the reaper within one tick (5 s); a retry of a failed teardown runs inside the tick, so a hung `wsl.exe` can delay it by up to 90 s per name. A floor the reaper cannot read ends nothing: such a run lasts until its lease ends. A compromised Control Plane that can read the floor could hold it open with no sharing and cause exactly that, so the installer (Phase 5, required) must limit reading the floor to Administrators and the bridge's owner; until then the answer is to stop the bridge, which ends every run, and its restart is refused until the floor can be read. There is no high-water mark: an administrator can lower the floor again.
- **Ending things that fail to end:** a teardown failure is logged as a fixed word with the run id, the name goes on a pending list and the reaper tries again every tick, in memory only (after a restart the start-up sweep does it). A distribution that is already unregistered is not unregistered twice, and a folder left behind is collected too. `stop` or `end` during a `begin` kills the agent and the run is never registered; the end of the process waits for a `begin` in flight.
- **The pipe:** a client that leaves, at any point, costs no instance: the instance is reset for the next client, as in the Broker and the Authority. An instance that cannot be reset ends the bridge with every run stopped (`BRIDGE_FATAL=pipe_slot`).
- **Who may run it:** an elevated start and a Control Plane SID equal to the bridge's own are refused at start (`BRIDGE_FATAL=elevated`, `control_plane_is_self`). The test seam, which does not exist in the published build, is the only exception to the second.
- **The bridge counts, not the agent:** every `exec`, `put` and `get` reads the lease's end and counts against `maxCalls`; the count and the used operation ids are in a file kept until `expiresAt + 30 s`, across restarts, and a failed save refuses. An `exec` is told at most the time left and is cut off at `expiresAt` (plus a 3 s grace); a timer also ends a run whose lease has run out, in the middle of a command too. Put, get, output, command and request frame sizes are capped by the bridge before anything is buffered; an agent answer over its cap, a late answer, or a dead agent ends the run.
- **Only `albera-run-` names:** `RunName` and `WslArgs` are the only places a name is made or accepted. A start-up sweep removes leftover `albera-run-*` distributions and nothing else. There is no `--shutdown` anywhere in the code (arch rule 13d).

G1, bridge part (`test/runtime-wsl-bridge.test.mjs`, in-process with a fake `wsl.exe`, agent and repository; 84 checks including a lease signed by the Node twin): no lease, expired lease, reused lease (across a restart and with another signature), wrong computer, wrong repository, wrong operation, generation below the floor, wrong signer, tampered body, head that is not `baseOid`, and a bundle whose head is not `baseOid`: one check each. Each leaves nothing imported or, where it got that far, unregistered.

On the machine (`node scripts/wsl2-bridge-gates.mjs <image> <folder>`, image `254b9c088ed2f83206bfba03c361f5a6a0732dd38c36e4f38abb566b8303e516`, WSL 2.6.3.0, kernel 6.6.87.2): 34 of 34, on a build with the `trust-sid` seam and with the Control Plane SID equal to the owner's (see below). `begin` takes about 2.8 s. The refusals above, the 1 MiB `put`/`get` with equal SHA-256, `stop` during `sleep 300` (the command ends, the distribution is gone), the file over the get cap ending the run, the lease running out with nobody calling, reuse after a restart of the bridge, a leftover `albera-run-orphan1` swept while `albera-decoy` stayed, `stop` arriving after 8 clients left without a word and after 8 that read and closed, the floor file rewritten under a running bridge (the next `begin` refused, the run below the floor ended, a lease of the new generation accepted, a missing file refused), and the owner's Ubuntu and docker-desktop unchanged (still Stopped). The gates unregister only names they made, and stop before making anything if an `albera-*` distribution is already there. The planted `core.fsmonitor` and hook ran under plain git (control) and not under the bridge's git. Inside the sandbox the job is uid 1000, no `WSLENV`, no Windows variable, no `/mnt`.

Found on the way, fixed: a child process of the bridge (git) hung for good while another thread of the bridge was blocked in a read of the bridge's own stdin, because the child inherited that synchronous handle. Children now get their own stdin, closed at once. The in-process tests cannot show it (no such read there); only the machine run did. And `git clone` prints advice before the object id, so the id is the last line.

**Not done, and where this differs:**
- Nothing starts the bridge (the installer, "started the same way as the approval tray") or talks to it: no `albera_shell`, no Control Plane client with the server-SID check, no wiring in the hands (they still refuse a wsl2 computer). Phase 4 and 5.
- The bridge's own pipe, owner, `FIRST_PIPE_INSTANCE` and caller-SID check are tested in-process (`peer_denied`, a squatter stops the start). The remote-client refusal rests on `LocalPipe.cs` and its lab check (u6), as for the Broker.
- G7 is only partly measured: a planted hook ran as uid 1000 in the sandbox and no file there is root's, but root's relay is still only `enter.sh`, so there was no root code path to attack. The result bundle is not extracted yet (Phase 4): a result can be fetched file by file with `get`.
- The kernel floor reads `wsl --version`, the installed WSL kernel, not the kernel of a running utility VM. The labels in that text are localized, so only the numbers at the end of the first two lines are read.
- A distribution name must be plain lowercase (`[a-z0-9-]`, 48 characters): an operation id with an uppercase letter, dot or colon is refused (`run_name`), not renamed.
- The ledger file is compacted only at start (entries past their margin are dropped then) and refuses past 100,000 entries.
- `stop` of a run that is still in `begin` answers Ok meaning "will be removed", not "removed": the removal follows, and the `begin` answers `run_stopped`. A client waits for that answer.
- On a PC with UAC turned off the owner is always elevated, so the bridge refuses to start (`elevated`). That is the closed side and is accepted.
- The Phase 5 install steps must start the bridge once with a config whose Control Plane is the owner and see exit 77, because no real start has shown that refusal.
- The 34 of 34 is the seam build with the Control Plane as the owner. So a Control Plane on another account has never connected: the allow path for it, and the ACE branch at `PipeServer.OwnedBySelf`, are not exercised by a real client. `peer_denied` is the only cross-account result, and it comes from naming another SID in the config, not from another account calling.
- The refusals at start (`elevated`, `control_plane_is_self`) are tested as one function; the lines in `Program.cs` that call it were built but never saw a refusal on a real start, because the seam allows the second and this account is not elevated.
- `PathGuard` without the seam has not been run against a real install path: every result above trusts the signed-in user as if it were an administrator.
- `PathGuard` does not look at the ACLs of parent folders, apart from the one folder above the image and above the lease floor. A writable folder further up can still rename what is below it (the reparse check only sees links, not a swapped folder).
- The bridge does not check its own program at run time. Nothing tests that `albera-wsl-bridge.exe` is admin-only: that rests on the installer, which does not exist yet.
- After AGM-2, check that the Broker issues exactly one lease per operation. The bridge refuses a second `begin` of an operation id, so it counts on that, and it cannot see a Broker that signs two operations for one approval.
- `npm run build:wsl-bridge` could not be run here: it pins .NET SDK 10.0.403 and this PC has 10.0.102. The test build (with the `trust-sid` seam) is what ran.

## Decision proposed

1. **New provider `wsl2`, its own isolation class.** Capabilities report `isolation: "wsl2"`, never `"vm"`. A task that requires `isolation=vm` is never placed here (ADR-001: never downgrade silently). The owner adds a WSL2 computer on purpose.
2. **The AI stays out of the guest, and the token with it.** `claude -p` runs where it runs today (the Control Plane identity, `--tools ""`, the token in the child's environment only). Its hands change: instead of six desktop tools it gets a new MCP server, `albera_shell`, whose tools act in the sandbox. The guest needs no network.
3. **The Control Plane never runs `wsl.exe`.** A guest that gets out through `wsl.exe` would hold the identity of whoever started it. The Control Plane's identity opens the DPAPI token and the Broker's pipe, so it must never be that identity. An arch rule enforces this. Only the **WSL bridge** (below) runs `wsl.exe`.
4. **Approval binds the target, and the Broker's role is not dropped.** The action's args gain `isolation`, `repositoryId` and `baseOid`, so they are in the digest the owner approves. `ServiceConfig.cs` requires a `vmId` today, so the Broker learns a second kind of computer, `{ computerId, kind: "wsl2" }`. For an approved `task.start` it signs a **run lease** with its attestation key (ADR-002 AGM-2: **the production Broker has no key yet**, so this signature waits for that decision) under its own domain string, `albera.wsl2-run-lease.v1`, so a lease can never be read as an attestation or the other way round. The lease names `operationId`, `computerId`, `isolation`, `repositoryId`, `baseOid`, the issue time, the expiry and the call limit (at most 3600 s and 10,000 calls), the Broker's `leaseGeneration` and the `actionDigest` of the approved action. The bridge authenticates a lease first and only then reads its target, keeps every `operationId` and call count on disk until the lease is over, and refuses a generation below its own floor, because a lease is a bearer statement that a Broker restart does not revoke. Revoking a Control Plane therefore means raising both the Broker's `generation` and the bridge's floor: raising only one warns nobody, so the runbook must name both and the bridge reads its floor at every `begin`, from an admin-only file of its own, so a raise needs no restart. The bridge pins the Broker's public key, refuses a run without a valid lease, and counts calls itself. The bridge makes the input bundle itself from the repository the settings map to `repositoryId`, because the Control Plane's account may not be able to read it, and refuses a head that is not `baseOid`. So the check is outside the low-privilege Control Plane, as ADR-002 asks. `vmMatches` in `room-service-hands.mjs` must refuse a `wsl2` computer whose action lacks these fields. A `wsl2` `task.start` always asks a person, at every tier: no attestation can stand in for one.
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

The bridge runs without elevation, and refuses to start elevated. Its program, its config, the lease floor and the image are meant to be writable by administrators only. For the config, the floor and the image the bridge checks that itself (`PathGuard`), and the image is hashed with the file held open until the import ends, so the bytes it checked are the bytes it imports. For its own program there is no check at run time: that is the installer's job. `PathGuard` does not read the ACLs of parent folders beyond the one above the image and above the floor.

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
| R8 | **Routes that do not pass through the job's filter.** A crash: WSL pipes the dump to a root helper that sends it to Windows over vsock, with content the job controls. Measured: a crash of a plain job added a file to `%TEMP%\wsl-crashes` | Closed for this route: the launcher sets the core limit to 1, and seccomp refuses any change to it, up or down. Measured with both attacked. Other kernel-side helpers are listed under "Phase 1 results"; whether a job can trigger `modprobe` was not tested | The limit, the filter, and review |
| R7 | The disk: a VHD can grow to the default limit on the owner's C: | Fills the drive | `put` and `get` limits, a disk quota to be measured (G6) |

## Gates: all must pass before any real token is used

| # | Gate | How |
|---|---|---|
| G0 | Every row of "Measured", again, on the real image and sandbox: `mount(2)` directly, each mount path separately, a cold start after `wsl --shutdown`, a bundle of realistic size through a real pipe, the time for `wsl --import` | Throwaway script |
| G1 | The Broker, the lease and the bridge refuse a missing, expired, reused or wrong-target lease, a generation below the bridge's floor, and a bundle whose head is not `baseOid`, one test each. "Reused" is tested across a restart of the bridge, and `begin` checks the expiry again after reading the head. A `wsl2` `task.start` asks a person at every tier | Unit tests |
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
- Measure whether `socket(AF_INET, ...)` with an unknown protocol makes the kernel run `/sbin/modprobe` as root, outside the filter (Zaku, inferred and not measured), and narrow the filter to protocol 0 if so. Only numbers cross that route, and no harm has been shown.

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
