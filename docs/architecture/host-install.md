# Host install: the Broker and the Approval Authority on the owner's PC

**Status: written, NOT RUN.** `scripts/host/albera-host.ps1` was run in plan mode and its logic was tested with fakes and a temp folder (`test/host-install.test.mjs`). No install, service, account, ACL or machine key was ever created by it, and the disposable-VM run (`test/windows-service-lab/lab-host-install-check.ps1`) has not happened. Treat the first real run as the first run. The optional `-GrantHyperVToBroker` (below) is covered the same way: unit tests with fakes, a lab hook pass that has not run yet, and nothing on a real host.

Goal: put the two services on the owner's PC so the first real Windows Hello approval can happen (`approver-app.md`, steps 4 to 8). Related: `approval-authority.md` ("Needs the VM lab or the owner", "Preconditions before production"), `approval-tiers.md` ("Room start approval").

## What it installs

| Object | Where | Notes |
|---|---|---|
| Builds of the Broker, the Authority and the pipe client helper | `C:\Program Files\Albera\bin\{broker,authority,pipe-client}` | copied from the publish outputs (`npm run build:windows-broker`, `npm run build:approval-authority`) into the administrator-only `bin` folder FIRST; then the COPIES of all three are hashed and their one tree hash must equal the `-ExpectedTreeHash` you typed (any missing, extra, moved or changed file deletes all copies and stops). The exe SHA-256 and a folder hash of each go into the manifest |
| Services `AlberaHostBroker`, `AlberaApprovalAuthority` | SCM | exactly as `lab-guest.ps1`: own process, `obj= "NT SERVICE\<name>"`, `sc sidtype restricted`, `sc privs SeChangeNotifyPrivilege`, `start= demand`. The Broker's service ACL gives SYSTEM and Administrators everything and the Control Plane account only `LC` (SERVICE_QUERY_STATUS, 0x4). **Install does not start them.** |
| Data folders | `C:\ProgramData\Albera\{broker-config,broker,authority,control-plane}` | inheritance removed; SYSTEM and Administrators full. Broker SID: read on `broker-config`, Modify on `broker` (its journal). Authority SID: Modify on `authority` (its config and `policy.json`). Control Plane account: full control on `control-plane` (the Runtime journal refuses a folder where its own user lacks full control; found 2026-11-02 on the first real `approval-check`, which failed with `journal_unavailable` under Modify). The root gives each of the three read on that one folder only |
| Authority signing key `AlberaApprovalAuthority-host-1` | machine key store (Software KSP) | ECDSA P-256, Export Policy none, DACL SYSTEM, Administrators and the Authority's service SID only; read back from a fresh open and checked like the Authority's start-up guard; one sign/verify round trip; only the public key (SPKI) is exported, into the Broker config |
| Local user `albera-cp` | SAM | standard user (BUILTIN\Users only). You type the password at install time |
| Broker config, Authority config | `broker-config\AlberaHostBroker.service.json`, `authority\AlberaApprovalAuthority.service.json` | key sets read from the C# parsers (a test compares them); `policyVersion` is the same in both; kid `albera-authority-1`, audience `albera-host-broker`, lease `albera-host-lease-1`, generation 1, `signingKeyProvider` `software` |
| Control Plane settings | `control-plane\albera.approval.json` | `examples/albera.approval.example.json` with `attestation: null`; one computer (`-VmName`, `-ComputerId`, default `albera-clone-01` -> `clone-01`, only `approval-check` reads the first one). Journal path `control-plane\operations.sqlite`. With `-GrantHyperVToBroker` it also gets the `desktop` block the gated room requires (see "Giving the Broker Hyper-V") |
| `C:\ProgramData\Albera\install-manifest.json` | | lists exactly what the script created; uninstall removes only that |

No `policy.json` is written, so the Authority starts at tier `careful`: a person approves every action.

## Run it (you, elevated)

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1                                    # plan: numbered steps, changes nothing, no admin needed
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode install -ExpectedTreeHash <64 hex> -ApproverKeyId hello-... -ApproverPublicKey <spki> -ApproverSid S-1-5-21-...   # elevated console of YOUR account
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode status
Start-Service AlberaHostBroker; Start-Service AlberaApprovalAuthority             # when ready
```

Before install (all in a NORMAL console of your account, so nothing from the repository runs elevated): `npm run build:windows-broker`, `npm run build:approval-authority`, `npm run build:approver`; `AlberaApprover.exe enroll --show` prints the three public values to pass as `-ApproverKeyId`, `-ApproverPublicKey`, `-ApproverSid` (they must equal what your own first `enroll` printed; `enroll` + `enroll --check` were done 2026-10-31). The script checks them (key id grammar, RSA-2048 SPKI, an S-1-5-21 user SID that is not `albera-cp`'s) and never starts the approver program. Start every command as shown, with the full path of `powershell.exe` (`cmd.exe` prefers a `powershell.exe` in the current folder, so a bare `powershell` can be someone else's program). `-NoProfile` skips profiles only; it does **not** keep user modules out: Windows PowerShell 5.1 searches `~\Documents\WindowsPowerShell\Modules` and `HKCU\Environment` `PSModulePath` before its own folder, and loads `CimCmdlets`, `LocalAccounts`, `Security`, `Utility` and `Management` lazily on first use (a fake `CimCmdlets` returning "HIJACKED" was reproduced). So the script protects itself: its first statements turn auto-loading off, reset `PSModulePath` to `$PSHOME\Modules` and import those five modules by the full path of their manifests, and it refuses unless `$PSHOME` is `C:\Windows\System32\WindowsPowerShell\v1.0` (a 32-bit PowerShell is refused). Install refuses unless the console is elevated and never elevates itself. Re-running a completed install checks it and changes nothing; a partial install continues from where it stopped, or stops with the reason (anything that exists and is not in the manifest is never adopted). `-StartCheck` starts each installed service once and stops it again (the only real test of the configs, see below).

### Where `-ExpectedTreeHash` comes from (read this)

The builds live in the working tree, which a non-admin process (an agent running as you) can rewrite, together with their sidecar `.manifest.json` files and any hash file you keep next to them (Downloads included). A hash computed from that tree proves nothing, and so does a file: so install takes **one value that you type** (`-ExpectedTreeHash <64 lowercase hex>`) from the log of a CI run of the reviewed commit:

1. On github.com, Actions, workflow **Host build hashes**, Run workflow **on the branch `main`** (it runs only when you start it, and its job refuses any other branch; Windows minutes cost money). It builds on a clean runner (`npm run build:windows-broker`, `npm run build:approval-authority`) and runs `scripts/host/albera-host.ps1 -Mode hashes`.
2. Open the run on github.com. **Check two things on the run page before you read a hash:** the branch badge under the run title says `main`, and the commit SHA shown there (also printed as `commit=` and `ref=` in the log) equals the merge commit of PR #148 that you reviewed. Then read the line `ALBERA_HOST_TREE_HASH=<hex>` in the log (also in the run summary). The per-file JSON is attached as the artifact `build-hashes` for diagnosis; install does not read it. **A branch can edit the workflow file it runs from, including the `main` condition, so that check of branch + SHA by you is the real control; the condition is only a guard against a mistaken dispatch.**
3. Build locally in a normal console, then pass the value to install: `-ExpectedTreeHash <hex>`.

**The format** (one function, `Get-CanonicalTreeHash`, used by `-Mode hashes` and by install): for each component in the fixed order `broker`, `authority`, `pipe-client`, and inside it for each published file sorted by ordinal comparison of its relative path (written with `/`), one line `<component>/<relative path> TAB <SHA-256 of the file, 64 lowercase hex> LF` (TAB 0x09, LF 0x0A, no BOM, no other whitespace). The tree hash is the lowercase hex SHA-256 of the UTF-8 bytes of all lines concatenated. A file renamed, moved to another component, added, dropped or changed gives another value. Install computes it over the **copies** in the administrator-only `bin` folder and refuses (deleting the copies) unless it equals the typed value.

**Limit, stated plainly:** the value only matches if the build is reproducible across machines (the runner's .NET SDK, the NuGet restore and the paths must give byte-identical output). The builds are self-contained, so the .NET SDK decides the runtime files, the apphost and the compiler output: the build scripts refuse any SDK but `HOST_BUILD_SDK` in `scripts/dotnet-build-env.mjs` (10.0.403), and both workflows install exactly that one. **Measured 2026-11-02 on `main` 86ade4c:** with SDK 10.0.302 here every exe differed from the runner; after installing 10.0.403 here (`winget install --id Microsoft.DotNet.SDK.10 --version 10.0.403`), the tree hash and both script hashes here equalled the Host build hashes run. A mismatch is still the safe outcome (nothing is installed); the per-file JSON artifact against `-Mode hashes` on this PC shows which files differ. Running `-Mode hashes` on your own PC and typing its value defeats the check (the lab hook does exactly that, labelled lab-only). The script itself is run only as a hashed copy in an administrator-only folder (next section).

### The elevated console: clean environment, copied script (required)

An agent in your session can prepare the elevated console before the script's first line runs: `HKCU\Environment` values reach every new process, elevated or not (`COR_ENABLE_PROFILING` + `COR_PROFILER` + `COR_PROFILER_PATH` load any DLL into `powershell.exe` as it starts), and `HKCU\Software\Microsoft\Command Processor` `AutoRun` runs a command in every `cmd.exe` that starts without `/d`. And the script files sit in a tree it can rewrite, also between a hash check and the moment PowerShell reads them. So install and uninstall are run only like this (every step, in this order):

1. Open the console: Win+R, type `cmd /d`, press **Ctrl+Shift+Enter** (elevated, AutoRun skipped). Run everything below in that window.
2. The environment must be clean. Each of these must print `Environment variable ... not defined`; if one prints a value, stop (do not install) and remove it from `HKCU\Environment` first:
   ```
   set COR_
   set COMPLUS_
   set CORECLR_
   ```
   and this must print `ERROR: The system was unable to find the specified registry key or value`:
   ```
   C:\Windows\System32\reg.exe query "HKCU\Software\Microsoft\Command Processor" /v AutoRun
   ```
3. Copy the two script files into a folder only administrators can write, then check the COPIES:
   ```
   mkdir "C:\Program Files\AlberaSetup"
   copy /Y <repo>\scripts\host\albera-host.ps1 "C:\Program Files\AlberaSetup\"
   copy /Y <repo>\scripts\host\albera-host-lib.ps1 "C:\Program Files\AlberaSetup\"
   C:\Windows\System32\certutil.exe -hashfile "C:\Program Files\AlberaSetup\albera-host.ps1" SHA256
   C:\Windows\System32\certutil.exe -hashfile "C:\Program Files\AlberaSetup\albera-host-lib.ps1" SHA256
   ```
   Both values must equal the lines `ALBERA_HOST_SCRIPT_SHA256=<hex> albera-host.ps1` / `... albera-host-lib.ps1` in the log of the Host build hashes run on `main` for the reviewed commit (the same two checks on the run page as for the tree hash). A new folder under `C:\Program Files` inherits Users: read and execute only, so nobody but an administrator can change the copies after you hashed them. (`mkdir` fails if the folder already exists: then delete it first, it is not yours.)
4. Run the copy, naming the repository for the builds:
   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -RepoRoot <repo> -Mode install -ExpectedTreeHash <64 hex> -ApproverKeyId hello-... -ApproverPublicKey <spki> -ApproverSid S-1-5-21-...
   ```
5. Afterwards: `rmdir /S /Q "C:\Program Files\AlberaSetup"` (uninstall later: the same steps 1 to 4 with `-Mode uninstall`).

The `script albera-host.ps1 sha256 ...` lines that install and uninstall print are information only: a replaced script can print anything, so they detect nothing. **Residual limit, stated plainly:** the comparisons are by you and by eye; `cmd.exe`, `certutil.exe`, `reg.exe` and the Run dialog are trusted as part of Windows; an attacker who is already an administrator is out of scope. The CI hashes cover the line endings the repository checks out (`.gitattributes`: `eol=lf`).

### Checking a build with `gh attestation verify` (extra check; install does not use it)

Each Host build hashes run on `main` also signs a GitHub artifact attestation (SLSA build provenance, `actions/attest-build-provenance`) for six files: the three exe files, `albera-host.ps1`, `albera-host-lib.ps1` and `build-hashes.json`. It says "a file with exactly these bytes was produced by `.github/workflows/host-build-hashes.yml` in BERORINPO/albera at commit X on ref Y", signed with a short-lived Sigstore certificate. Check a file with:

```
gh attestation verify <file> --repo BERORINPO/albera --signer-workflow BERORINPO/albera/.github/workflows/host-build-hashes.yml --deny-self-hosted-runners
```

It must say `Verification succeeded`, and the commit and ref it prints must be the reviewed merge commit and `refs/heads/main` (`--signer-workflow` pins the workflow, not the branch; `--cert-identity https://github.com/BERORINPO/albera/.github/workflows/host-build-hashes.yml@refs/heads/main` in its place pins both). Check the script copies in `C:\Program Files\AlberaSetup` and `build-hashes.json` from the run's `build-hashes` artifact: its `treeHash` is the value for `-ExpectedTreeHash`, and its per-file list covers the DLLs. An exe alone proves little, because the builds are self-contained and not single-file: the exe is the .NET apphost launcher and the code is in the DLLs next to it.

What it does **not** do, stated plainly:

- **It is not Windows code signing.** The files carry no Authenticode signature, so UAC and SmartScreen still show an unknown publisher, and Windows itself checks nothing.
- **It does not replace `-ExpectedTreeHash` yet.** The installer does not read attestations; it trusts only the value you type and the script hashes you compare by eye. Making the installer consume attestations is a separate security change (Zaku review and a VM run first).
- **It does not make `gh` trusted.** `gh.exe` and its configuration live in your profile, which an agent in your session can change, so a `Verification succeeded` printed there is a second opinion, not the control. The control is still your check of branch and SHA on the run page.
- **It says where a file came from, not that the code is safe.** A reviewed-but-wrong commit on `main` gets a valid attestation too.

## Giving the Broker Hyper-V (`-GrantHyperVToBroker`, optional)

Why it exists: the gated room needs the Broker to take screenshots of a VM and press keys in it (`adr-002-host-broker-trust-contract.md`, "Amendment 2026-11-03"; owner decision 2026-11-03). Windows has no narrower grant than membership of `BUILTIN\Hyper-V Administrators` (`S-1-5-32-578`), and Hyper-V refuses a restricted token even for a member (measured 2026-11-03). **Without the option nothing changes**: the same services, the same restricted SID type, the same configs, the same manifest, the same plan.

With `-GrantHyperVToBroker -VmName <the VM's exact name>` (and `-ComputerId`, default `clone-01`, the id the room uses for it) install does these five extra things:

1. **Looks up the VM's GUID** right after the argument checks, read only, before anything is created. Exactly one VM must carry that name, otherwise the run stops with nothing changed. The GUID (lowercase) goes into the Broker config as `computers: [{ "computerId": "<-ComputerId>", "vmId": "<guid>" }]`; that key is also what makes the Broker open its desktop pipe. The Broker queries by GUID and never by name.
2. **Creates the Broker with `sc sidtype unrestricted`** (the Authority stays `restricted`). Both services still have `SeChangeNotifyPrivilege` only. The drift check that used to be `sid_type_not_restricted` now follows the install record: the Broker is expected unrestricted exactly when the record says the grant was made (`sid_type_not_unrestricted` is the other direction); the Authority is always restricted.
3. **Adds only the Broker's service SID** (`NT SERVICE\AlberaHostBroker`, `S-1-5-80-...`, shown in the plan) to `S-1-5-32-578`. `albera-cp` and the Authority are never added: the script takes the group and the member from one function that can only return the Broker's own derived SID, and `-Mode status` reads the group every time (install record or not) and fails if `albera-cp` or the Authority is ever found in it, or the Broker is found in it without a record (an install without the option shows no Hyper-V line while the group is clean). The install step "hyperv" counts as done only when the record is there and the member list has nothing to report.
4. **Records it.** The record `created.hyperVGrant` (group, Broker SID, computer id, VM GUID) is saved to `install-manifest.json` BEFORE the member is added, and the membership is read back afterwards. A manifest whose record names any other SID or group is not one this script wrote and is refused.
5. **Writes the gated room's `desktop` block into the Control Plane settings** (`control-plane\albera.approval.json`), so nobody edits that file by hand. The block is `"desktop": { "helperPath": "C:\\Program Files\\Albera\\bin\\pipe-client\\albera-windows-broker-pipe-client.exe", "helperSha256": "<SHA-256 of that installed exe>" }`, placed between `computers` and `attestation` (the shape of `examples/albera.approval.example.json`). `helperPath` is the install layout's pipe client path. `helperSha256` is the hash of the exe as it sits in the administrator-only `bin` folder at the moment the configs are written, and it must equal the exe hash the install record took when the copies were verified against `-ExpectedTreeHash`; if the two differ, nothing is written and the run stops. Both values are public (a path and a hash). The rest of the file is what it always was: `broker.expect` is the service name only, `attestation` is `null`, and `computers` maps `-VmName` to `-ComputerId`, the same id the Broker config pairs with the VM GUID. The step "configs" is not done for a settings file without this block or with another helper path or hash, so an install begun without the option and finished with it rewrites the file. **Without the option the settings file is exactly what it was before: no `desktop` key.**

Run it (plan first; a plan without admin rights says "unknown" for the VM lookup because the VM list needs an elevated console):

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode plan -GrantHyperVToBroker -VmName <the VM's exact name>
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -RepoRoot <repo> -Mode install -GrantHyperVToBroker -VmName <the VM's exact name> -ExpectedTreeHash <64 hex> -ApproverKeyId hello-... -ApproverPublicKey <spki> -ApproverSid S-1-5-21-...
```

The second line is the install command of "The elevated console" with the option added; everything else there (clean `cmd /d`, hashed copies of the scripts) is unchanged. The VM must exist already, so the Hyper-V role has to be on.

An install that is already complete is not changed: run with the option, it says so and grants nothing. To add the grant later: uninstall, then install again with the option (the same rule as any other change). `-Mode status` needs no option; it follows the record and adds three lines (the group membership, the Broker config's `computers`, and the Control Plane settings' `desktop` block against the helper hash the install recorded). The Broker's SID type follows the option of the run in both directions: an install begun with the option and finished without it puts the Broker back to `restricted` (an unrestricted Broker is never left behind without the grant).

**What it gives away, stated plainly.** Hyper-V Administrators is all-or-nothing and effectively host-administrator (ADR-002). From then on the only thing that limits the Broker is its own code: a fixed allowlist of screen capture and keyboard/mouse calls on the VMs in its config. The Control Plane gets nothing: `albera-cp` stays a standard user and its right on the Broker service stays `LC` (query status) only.

**Undo.** `-Mode uninstall` needs no option; the install record decides. Its first step removes the Broker's SID from the group, reads the membership back, and stops (the services are NOT deleted) if the SID is still there. The order matters: a deleted service leaves its SID in the group, and the next service with that name would inherit the right. If you ever need to do it by hand: `Remove-LocalGroupMember -SID S-1-5-32-578 -Member <the Broker SID from the plan>`. Nobody else in the group is touched, and a group that no longer exists is skipped.

**Lab.** `-VmId <lowercase GUID>` replaces the lookup and is refused unless `ALBERA_LAB_VM` is `1`, exactly like `-ControlPlanePassword`. The second pass of `lab-host-install-check.ps1` installs with the option and checks, independently of the installer's own read-back, that the Broker SID is in the group (via `net localgroup`), that `albera-cp` and the Authority are not, the SID types (`UNRESTRICTED` and `RESTRICTED`), the privileges, the `computers` entry, the `desktop` block of the Control Plane settings (against a hash the hook takes itself with `Get-FileHash`; the default pass checks that a plain install writes none), the install record, a second install that changes nothing, and an uninstall that leaves the group as it was. It is BLOCKED, not passed, when the guest has no Hyper-V Administrators group, and it uses a fixed GUID, so the name lookup is not part of it.

**Not verified.** Nothing here has run on a real host or in the VM lab. In particular: `Add-LocalGroupMember` / `Remove-LocalGroupMember` with a service SID given as a string (the nested lab used `net.exe`, which this script may not start); reading the group's member list when one member is a service's virtual account (the script falls back to the member's WinNT path); the VM lookup against a real VM (`Msvm_ComputerSystem` by `ElementName`, then `Name`); a Broker started with a `computers` config as an unrestricted service on the owner's PC; and, from ADR-002, adapter mouse input against a VM with a guest OS.

## First approval (`approver-app.md` steps 6 and 7)

`albera-runtime approval-check` sends ONE `broker.operation` / `synthetic.noop` (the Broker only records the claim; nothing moves) through fence, submit, wait, claim, and prints the approval id. Only the Control Plane account can reach the two submit pipes, so run it as `albera-cp`:

1. As `albera-cp` (for example `runas /user:.\albera-cp powershell.exe`, then in that window): `node <repo>\src\runtime\entry.mjs approval-check --approval C:\ProgramData\Albera\control-plane\albera.approval.json --helper "C:\Program Files\Albera\bin\pipe-client\albera-windows-broker-pipe-client.exe"`. It prints `approvalId: <uuid>` and waits (the request lasts 120 s).
2. In your own normal console: `AlberaApprover.exe list` (check the fields and `digest check: OK`), then `AlberaApprover.exe approve <approvalId>`, type `yes`, verify with Hello. The first window ends with `status: claimed` and exit 0.

`albera-cp` must be able to read `node.exe` and your checkout; the installer grants it nothing there.

## The Control Plane account (PROVISIONAL)

The Authority refuses one SID for both pipes (`sids_not_distinct`), and the approver SID is your own account, so the Control Plane cannot be you. Decision (`2026-11-02+host-install` in `spec/architecture.md`): a dedicated local standard user `albera-cp`, created by the script, password typed by you, never stored. Its SID is `controlPlaneSid` in both configs. Rejected: a virtual service account (nothing runs the Control Plane as a service yet); a second administrator (a bigger target than needed); adding `albera-cp` to Hyper-V Administrators (see below).

**Known consequence, answered by the optional grant below:** the gated `room` used the same-user Hyper-V prototype, which needs Hyper-V Administrators. Running `room` as `albera-cp` therefore cannot work, and `albera-cp` still never gets the group. The owner decided on 2026-11-03 that the Broker performs those operations instead, which is what "Giving the Broker Hyper-V" installs. `approval-check` does not need Hyper-V. This is why the account choice stays provisional.

## Trust model (what a non-admin agent cannot do through this script)

Attacker: an AI agent in your non-admin session. It can pre-create `C:\ProgramData\Albera` (Users may create there), plant a manifest or a junction in it, and rewrite every file in the repository tree (builds, sidecar manifests, even this script's folder).

| Attack | What the script does |
|---|---|
| Plants `install-manifest.json` (valid shape) and makes `control-plane` a junction to another vendor's SYSTEM service folder | Nothing existing is trusted: `C:\ProgramData\Albera` and the manifest must be owned by SYSTEM or Administrators, protected, writable by no one else, and reached through no link (the path and every parent are checked by attribute, nothing is followed). Otherwise install and uninstall stop with "delete it as an administrator". Every planned folder gets the same check before any ACL is touched, and `icacls` runs with `/L` |
| A pre-existing `albera.approval.json` or config (even identical) | Must pass the same checks, and is then overwritten, never skipped |
| Forges `created.user = {name: "Yosuke", sid: ...}` (or another service, key or folder) | The manifest shape allows only the two service names, the one key name, the one account name and no other entry. Uninstall removes the account only if its name is exactly `albera-cp`, its description is the one install set, and its SID is the recorded one |
| Replaces a build and its sidecar `.manifest.json`, or the hash file next to it | The script never reads a sidecar and takes no hash file. The build is copied into the already administrator-only `bin` folder and the tree hash of the **copies** must equal the value you typed from the CI log |
| Makes the elevated script run its program | The only programs started are `sc.exe` and `icacls.exe`, by full path (a test pins this); nothing is found through PATH. `AlberaApprover.exe enroll --show` and `service-check` are no longer run; the installed services run only copies that matched the tree hash |
| Sets `SystemRoot`, `ProgramFiles` or `ProgramData` in `HKCU\Environment` (an elevated console started from that session inherits it) | No environment variable decides a path. `sc.exe`, `icacls.exe` and the install roots come from `[Environment]::SystemDirectory` / `GetFolderPath`, and the script refuses unless they are `C:\Windows\System32`, `C:\Program Files` and `C:\ProgramData` |
| Puts a fake module (`CimCmdlets`, `LocalAccounts`, ...) in `~\Documents\WindowsPowerShell\Modules` or `HKCU\Environment` `PSModulePath` | The script\'s first statements disable module auto-loading, reset `PSModulePath` to `C:\Windows\System32\WindowsPowerShell\v1.0\Modules` and import the five system modules by manifest path (a test runs the script with a fake `CimCmdlets` first in `PSModulePath` and asserts it is never loaded) |
| Races a folder between creation and `icacls` | Folders are created with their final owner and protected DACL in one call, and every creation is read back (owner, protected, exact accounts, no link) and re-checked with the installer's trust test before any later step; `DirectoryInfo.Create` succeeds silently on a folder someone made a moment earlier, which the read-back catches |

Not covered: an attacker who is already an administrator; a wrong `-ExpectedTreeHash` (typed from something other than the CI log of `main`); the script files being edited between your check and the run (below).

## Uninstall

`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode uninstall` (elevated; `-Mode plan -PlanFor uninstall` first). It stops and deletes the two services (a service whose command line is not the one it wrote is left alone), deletes the machine key, removes the install folder and the data folders, removes `albera-cp` (only if the manifest says it created it and the SID still matches; its profile folder, if it ever logged in, stays), and last the manifest and the data root. A folder that holds a file the script does not know, or a link/junction, is not deleted. This deletes the Broker journal and the Control Plane journal.

If the install record shows the Hyper-V grant, the first step removes the Broker's SID from Hyper-V Administrators, before the service is deleted ("Giving the Broker Hyper-V").

To update a build: uninstall, rebuild, install (an existing copy that differs is refused).

## VM lab hook (lab only)

`-ControlPlanePassword <SecureString>` makes install non-interactive and is refused unless the environment variable `ALBERA_LAB_VM` is `1` (the lab driver sets it inside the disposable VM; never set it on a real PC). The approver values are passed as the normal parameters (a throw-away public key in place of Hello). `test/windows-service-lab/lab-host-install-check.ps1 -HostScriptDir <folder with albera-host*.ps1> -RepoRoot <folder with the build outputs>` (also run by `lab-vm.ps1 -HostInstall`) computes the `-ExpectedTreeHash` in the guest from the very folders it copied (LAB ONLY: that proves nothing about provenance, it only exercises the path), then runs, as Administrator: install with `-StartCheck`, status, a second install (must say "already complete" and leave the manifest byte-identical), uninstall, and a final status; it prints one JSON evidence object and exits 1 unless everything passed. It refuses to run if either Albera folder already exists.

## Not verified

- **Verified in the disposable VM, not on your PC.** `lab-vm.ps1 -HostInstall` (2026-11-02, third run, Windows Server 2025 golden image, offline guest, script at the commit that fixed the status count): install completed all 10 steps with `-StartCheck` (both services reached Running, exit 0, and stopped again), the three copied builds matched the tree hash, the machine key read back non-exportable with only SYSTEM / Administrators / the Authority SID, status reported all 17 items ok, a second install said already complete and left the manifest byte-identical, uninstall removed services, key, `albera-cp` and both folders, and the final status said not installed. Earlier runs found two first-run defects, both fixed: a 57-character account description (limit 48) and an empty Broker SDDL result counted as one failure. In the VM the tree hash was computed in the guest from the same folders (path check only, no provenance), the approver key was a throw-away public key, and no approval was asked. Since then the Host build hashes workflow ran on `main` and its tree hash equalled a build on this PC with the same SDK (above). Still not run anywhere: install on your PC, a real approval.
- **`service-check` is not run at all.** The shipped Broker and Authority trust a config file only when the process token carries the per-service SID (`ServicePathGuard`), so from an elevated console it always answers `SERVICE_CONFIG=invalid:config_untrusted` before it looks at the content, and it would start a build while elevated. The script validates the configs with its own mirror of the C# rules (a test compares the key sets with the C# parsers) and relies on the first start of each service (`-StartCheck`, or your `Start-Service`) as the real test. Exit codes: 73 config or folder, 77 and 78 signing key, 79 policy.
- A restricted-SID service token opening the machine key (the Authority guard accepts the DACL; opening under that token is lab-only, as `approval-authority.md` says). The Authority guard against this key, and the Broker/Authority start under the SCM with this layout.
- Windows Hello provenance: the enrolled key is `NotSupported` for attestation on this PC (`approver-app.md`), so the "Hello provenance" precondition in `approval-authority.md` stays open. The script cannot prove the three approver values you pass came from your own `enroll`; compare them with what you saw.
- Whether the parent folder rule holds on this PC: `C:\ProgramData` lets Users create folders, so the script refuses a pre-existing `C:\ProgramData\Albera` and creates it itself, born with its final ACL (`DirectoryInfo.Create(DirectorySecurity)`, not created and fixed afterwards). That creation call, `icacls /L`, and the trust read-backs on a real administrator-owned tree have only been exercised on user-owned temp folders and synthetic ACL summaries.
- Not changed: Broker or Authority C# code, tiers, the Hello approval, the room. No dependency added.
