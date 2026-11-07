# Host install: the Broker, the Approval Authority and the Control Plane service on the owner's PC

**Status: stage 1 ("easy setup", subscription edition), written against `main` at PR #191. Mostly NOT RUN on a real PC.** What ran, and where:

- `albera-setup.exe` in verify mode on CI: Host build hashes run 41644370640 (`main` ffa648c) verified its update folder offline and printed `ALBERA_SETUP_VERIFIED`.
- The installer script in the disposable VM (`lab-vm.ps1 -Build -HostInstall`, PR #190: default pass 16/16, Hyper-V grant pass 18/18; the lab gives the script its own node.exe and a stand-in claude.exe and does not use setup).
- `-Mode migrate` in the disposable VM (`lab-vm.ps1 -HostMigrate -LegacyRef 303ec40`): a first-layout install made by the installer of commit 303ec40, then plan, migrate, status and uninstall of the current one, 34 of 34 checks. Its first run found that migrate refused every real first-layout install (the legacy Authority config carries the Authority's own write right); fixed in the same PR. What that lab does not show is listed under "Not verified".
- The script's logic with fakes and temp folders (`test/host-install.test.mjs`).

**Not run anywhere:** setup's install mode, `-Mode migrate` on a real PC, the Control Plane service on a real PC, `claude.exe` as the service identity, a real approval through the tray window, and the Host build hashes workflow since PR #190 (its last run is older). Treat the first real run as the first run. The full list is under "Not verified"; the dated record is `runtime-implementation-progress.md` (2026-11-04).

Goal: the owner does three things (`control-plane-service.md`, summary): say yes to UAC for setup, enter the Claude Code token once in the room, and pick the match code in the approval window and verify with Windows Hello. This file is the runbook for the owner and the operator. The contract and the reasons are in `control-plane-service.md` (sections 3, 8 and 9); related: `approver-app.md`, `approval-authority.md`, `approval-tiers.md`.

## What it installs

| Object | Where | Notes |
|---|---|---|
| Builds (five components) | `C:\Program Files\Albera\bin\{broker,authority,pipe-client,control-plane,approver}` | copied from the update folder (setup) or from the publish outputs (direct run) into the administrator-only `bin` folder FIRST; then the COPIES of all five are hashed and their one tree hash must equal the attested value (setup) or the `-ExpectedTreeHash` you typed (direct run). Any missing, extra, moved or changed file deletes all copies and stops. `control-plane` holds the service host and its app tree; the pinned `node\` folder inside it is left out of that hash |
| Pinned programs | `bin\control-plane\node\node.exe`, `bin\claude\claude.exe` | copies of `C:\Program Files\nodejs\node.exe` and of YOUR `<profile>\.local\bin\claude.exe` (found from the approver SID's profile; refused unless the elevated account is the approver). Each copy is made from one open handle whose final path is checked; its SHA-256 (and claude's file version) goes into the install record. The installer starts neither; ALBERA never downloads Node or Claude Code |
| Services `AlberaHostBroker`, `AlberaApprovalAuthority`, `AlberaControlPlane` | SCM | own process, `obj= "NT SERVICE\<name>"`, `sc sidtype restricted` (the Broker is `unrestricted` only with `-GrantHyperVToBroker`), `sc privs SeChangeNotifyPrivilege`, `start= delayed-auto`. The Control Plane also gets `sc failure`: restart after 5 s, twice, then stay stopped. The Broker's service ACL gives SYSTEM and Administrators everything and the Control Plane's SERVICE SID only `LC` (SERVICE_QUERY_STATUS, 0x4). The Control Plane is registered only after `launch-check` of the installed host answers 0. **Install does not start them** |
| Data folders | `C:\ProgramData\Albera\{broker-config,broker,authority,control-plane,control-plane\logs,control-plane-config,secrets,ui}` | inheritance removed; SYSTEM and Administrators full. Broker SID: read on `broker-config`, Modify on `broker`. Authority SID: Modify on `authority`. Control Plane SID: full control on `control-plane` and `control-plane\logs` (the journal refuses less), **read only** on `control-plane-config`, Modify on `secrets` and `ui`. Your account: read on `ui` (so "Open ALBERA" can read `room.json`) and nothing else |
| Authority signing key `AlberaApprovalAuthority-host-1` | machine key store (Software KSP) | ECDSA P-256, Export Policy none, DACL SYSTEM, Administrators and the Authority's service SID only; read back from a fresh open and checked like the Authority's start-up guard; one sign/verify round trip; only the public key (SPKI) is exported, into the Broker config |
| Configs | `broker-config\AlberaHostBroker.service.json`, `authority\AlberaApprovalAuthority.service.json`, `control-plane-config\AlberaControlPlane.service.json`, `control-plane-config\albera.approval.json` | key sets read from the C# parsers (a test compares them); `policyVersion` is the same in both; kid `albera-authority-1`, audience `albera-host-broker`, lease `albera-host-lease-1`, generation 1, `signingKeyProvider` `software`. The Authority config names the approver either by the legacy pair `approverKeyId` + `approverPublicKey` (one Windows Hello key) or, with `-ApproverKeyFile`, by `approverKeys` (1 to 16 key records, `approver-webauthn.md`); never both. The Control Plane config has the `host`, `claude` (executable, SHA-256, `maxMinutes 15`, `maxToolCalls 120`) and `ui` (`controlPlaneSid`, `approverSid`) blocks. The approval settings are `examples/albera.approval.example.json` with `attestation: null`, the journal `control-plane\operations.sqlite`, one computer (`-VmName`, `-ComputerId`; default `albera-clone-01` to `clone-01`), and with `-GrantHyperVToBroker` the `desktop` block. The Control Plane service can read these files and cannot change them |
| Launcher, shortcuts, tray entry | `bin\launcher\open-albera.ps1`; Start menu `ALBERA\Open ALBERA` and `ALBERA\ALBERA update`; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run\AlberaApprover` | the launcher text is written by the installer and hashed into the record. "Open ALBERA" runs it: it needs the service RUNNING and the port held by the process `ui\room.json` names, then opens the browser. "ALBERA update" is made only when `bin\setup\albera-setup.exe` passes the same trust test as the rest. The Run entry is `"C:\Program Files\Albera\bin\approver\AlberaApprover.exe" --tray`; it starts at your next sign-in. Each shortcut is read back |
| `C:\ProgramData\Albera\install-manifest.json` | | lists exactly what the script created (also the pins, the launcher, the shortcuts, the Run entry and `setupRunId`); uninstall removes only that |
| `HKLM\SOFTWARE\Albera\SetupRunIdFloor` | registry | the highest setup run id this PC has seen, as decimal text. Every run that has a run id raises it; **nothing removes it, uninstall included** (that is what refuses an old build after an uninstall) |

BUILTIN\Users get read and execute on `bin\approver`, `bin\launcher` and `bin\setup` only, and no other rule anywhere under `C:\Program Files\Albera`. No `policy.json` is written, so the Authority starts at tier `careful`: a person approves every action. The first layout made a local user `albera-cp`; nothing creates it now, and `-Mode migrate` and uninstall remove it.

## Before you start

1. **Node.js at `C:\Program Files\nodejs\node.exe`** (the normal Node.js installer puts it there). Only this file is copied; a Node installed elsewhere is not looked at. The file and its folder must be writable by administrators only (see "When it stops").
2. **Claude Code installed for the account that says yes to UAC** (`<profile>\.local\bin\claude.exe`). You do not have to be logged in to it for the install; the token is entered later in the room.
3. **Windows Hello set up, and the approver key enrolled on this PC.** You need its three public values. In a NORMAL console of your account (not elevated): `AlberaApprover.exe enroll` the first time (Hello asks once; then `AlberaApprover.exe enroll --check --expect <approverKeyId>`), or `AlberaApprover.exe enroll --show` when the key exists. They print `approverKeyId`, `approverPublicKey` and `approverSid` and must equal what your own first `enroll` printed (`approver-app.md`, "Enrol and first approval"). On a new PC the program is in the update folder, under `repo\src\runtime\windows-approver\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish\`; nothing has verified that copy at that moment, so after the install run `"C:\Program Files\Albera\bin\approver\AlberaApprover.exe" enroll --show` (the verified build) and compare: if the three values differ, stop and uninstall, because the Authority would trust a key you do not hold. Hello key credentials are not available under Remote Desktop: do the approval steps at the PC itself, or register a WebAuthn key instead ("Changing the approver keys", below; `approver-webauthn.md`).
4. **An update folder from CI**, for the commit you reviewed (next section, step 1).
5. Only for a VM driven by the Broker: the Hyper-V role and the VM's exact name ("Giving the Broker Hyper-V").

## First install on a new PC (setup.exe)

`albera-setup.exe` (NativeAOT, built only on CI and attested) replaces the manual `cmd /d`, `set COR_`, `reg query` and `certutil` steps. It copies the update folder into an administrator-only work folder, verifies the copies offline with its bundled, version-pinned `gh.exe`, takes the tree hash from the attested `build-hashes.json`, and starts the installer script from the verified copy with a rebuilt environment. You type only the three public values.

1. **Get the update folder.** On github.com: Actions, workflow **Host build hashes**, Run workflow on `main` (it runs only when you start it, refuses any other branch, and Windows minutes cost money). When the three jobs (build, attest, verify) are green, download the artifact `albera-update` (kept 14 days) and unzip it into a folder only you use. It holds `build-hashes.json`, `bundles\`, `repo\` and `setup\`. This folder does not have to be trusted: setup verifies copies of it.
2. **Put setup in its place** (elevated console, see "Running the script yourself" for how to open one). Setup installs only from this folder and checks that only administrators can write to it:
   ```
   mkdir "C:\Program Files\Albera\bin\setup"
   copy /Y <update>\setup\albera-setup.exe "C:\Program Files\Albera\bin\setup\"
   copy /Y <update>\setup\gh.exe "C:\Program Files\Albera\bin\setup\"
   copy /Y <update>\setup\trusted_root.jsonl "C:\Program Files\Albera\bin\setup\"
   ```
   `gh.exe` and `trusted_root.jsonl` are checked against hashes compiled into `albera-setup.exe`. `albera-setup.exe` itself is trusted by where it sits; UAC will show an unknown publisher (no code signing), so "Checking a build with gh attestation verify" below gives an extra check for that one file.
3. **Run setup** (elevated console of the approver account), with your three public values:
   ```
   "C:\Program Files\Albera\bin\setup\albera-setup.exe" --update <update> --approver-key-id hello-... --approver-public-key <spki> --approver-sid S-1-5-21-...
   ```
   For the Hyper-V option add `--grant-hyperv-to-broker --vm-name <the VM's exact name> [--computer-id <id>]`. Setup never elevates itself. It prints seven numbered steps: (1) checks of this run (elevated, standard folders, pinned tools, protected work folder `C:\Program Files\Albera\setup-work\<id>`, location), (2) the copy, (3) offline verification of the 12 attested files, (4) that one workflow run built all of them, (5) the attested tree hash against the copies, then `ALBERA_SETUP_VERIFIED commit=<sha> run=<id> treeHash=<hex>`, (6) the anti-rollback check, (7) the installer script's own numbered steps. Compare `commit=` with the commit you reviewed. Exit codes: 0 done, 2 usage, 3 `REFUSED <code>: ...`, 4 the script failed (`ENGINE_EXIT <n>`) or ran over two hours. It waits for Enter at the end (`--no-pause` turns that off). `--mode verify` runs steps 1 to 5 only and installs nothing; you can run `<update>\setup\albera-setup.exe --mode verify --update <update>` (elevated) before step 2 to see the commit and run id first.
4. **Start the services**; setup does not: `Start-Service AlberaHostBroker; Start-Service AlberaApprovalAuthority; Start-Service AlberaControlPlane` in the elevated console, or restart Windows (delayed start). The tray starts at your next sign-in; to start it now: `"C:\Program Files\Albera\bin\approver\AlberaApprover.exe" --tray` in your normal console.
5. Continue with "First approval and the Claude Code token".

If setup or the script stops half-way, run the same command again: a partial install continues from where it stopped, or stops with the reason (anything that exists and is not in the manifest is never adopted). `-Mode status` shows the state.

## Giving the Broker Hyper-V (`-GrantHyperVToBroker`, optional)

Why it exists: the gated room needs the Broker to take screenshots of a VM and press keys in it (`adr-002-host-broker-trust-contract.md`, "Amendment 2026-11-03"; owner decision 2026-11-03). Windows has no narrower grant than membership of `BUILTIN\Hyper-V Administrators` (`S-1-5-32-578`), and Hyper-V refuses a restricted token even for a member (measured 2026-11-03). **Without the option nothing changes**: the same services, the same restricted SID type, the same configs, the same manifest, the same plan.

With `-GrantHyperVToBroker -VmName <the VM's exact name>` (setup: `--grant-hyperv-to-broker --vm-name <name>`; and `-ComputerId`, default `clone-01`, the id the room uses for it) install does these five extra things:

1. **Looks up the VM's GUID** right after the argument checks, read only, before anything is created. Exactly one VM must carry that name, otherwise the run stops with nothing changed. The GUID (lowercase) goes into the Broker config as `computers: [{ "computerId": "<-ComputerId>", "vmId": "<guid>" }]`; that key is also what makes the Broker open its desktop pipe. The Broker queries by GUID and never by name.
2. **Creates the Broker with `sc sidtype unrestricted`** (the Authority and the Control Plane stay `restricted`). All three services still have `SeChangeNotifyPrivilege` only. The drift check that used to be `sid_type_not_restricted` now follows the install record: the Broker is expected unrestricted exactly when the record says the grant was made (`sid_type_not_unrestricted` is the other direction); the others are always restricted.
3. **Adds only the Broker's service SID** (`NT SERVICE\AlberaHostBroker`, `S-1-5-80-...`, shown in the plan) to `S-1-5-32-578`. The Control Plane's service SID and the Authority are never added (nor was `albera-cp` of the first layout): the script takes the group and the member from one function that can only return the Broker's own derived SID, and `-Mode status` reads the group every time (install record or not) and fails (`control_plane_is_a_member`, `authority_is_a_member`) if the Control Plane or the Authority is ever found in it, or the Broker is found in it without a record (`broker_is_a_member_without_a_record`). The install step "hyperv" counts as done only when the record is there and the member list has nothing to report.
4. **Records it.** The record `created.hyperVGrant` (group, Broker SID, computer id, VM GUID) is saved to `install-manifest.json` BEFORE the member is added, and the membership is read back afterwards. A manifest whose record names any other SID or group is not one this script wrote and is refused.
5. **Writes the gated room's `desktop` block into the Control Plane settings** (`control-plane-config\albera.approval.json`), so nobody edits that file by hand. The block is `"desktop": { "helperPath": "C:\\Program Files\\Albera\\bin\\pipe-client\\albera-windows-broker-pipe-client.exe", "helperSha256": "<SHA-256 of that installed exe>" }`, placed between `computers` and `attestation` (the shape of `examples/albera.approval.example.json`). `helperPath` is the install layout's pipe client path. `helperSha256` is the hash of the exe as it sits in the administrator-only `bin` folder at the moment the configs are written, and it must equal the exe hash the install record took when the copies were verified; if the two differ, nothing is written and the run stops. Both values are public (a path and a hash). **An install with `-GrantHyperVToBroker` writes this block itself**; there is nothing to edit by hand, and `-Mode status` checks it. The rest of the file is what it always was: `broker.expect` is the service name only, `attestation` is `null`, and `computers` maps `-VmName` to `-ComputerId`, the same id the Broker config pairs with the VM GUID. The step "configs" is not done for a settings file without this block or with another helper path or hash, so an install begun without the option and finished with it rewrites the file. **Without the option the settings file is exactly what it was before: no `desktop` key.**

Run it (plan first; a plan without admin rights says "unknown" for the VM lookup because the VM list needs an elevated console):

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode plan -GrantHyperVToBroker -VmName <the VM's exact name>
"C:\Program Files\Albera\bin\setup\albera-setup.exe" --update <update> --approver-key-id hello-... --approver-public-key <spki> --approver-sid S-1-5-21-... --grant-hyperv-to-broker --vm-name <the VM's exact name>
```

The second line is the setup command of "First install" with the option added. The VM must exist already, so the Hyper-V role has to be on.

An install that is already complete is not changed: run with the option, it says so and grants nothing. To add the grant later: uninstall, then install again with the option (the same rule as any other change). `-Mode status` needs no option; it follows the record and adds three lines (the group membership, the Broker config's `computers`, and the Control Plane settings' `desktop` block against the helper hash the install recorded). The reverse is checked too: a `desktop` block in the settings of an install whose record has no grant is a FAIL line (install without the option writes none). The Broker's SID type follows the option of the run in both directions: an install begun with the option and finished without it puts the Broker back to `restricted` (an unrestricted Broker is never left behind without the grant).

**What it gives away, stated plainly.** Hyper-V Administrators is all-or-nothing and effectively host-administrator (ADR-002). From then on the only thing that limits the Broker is its own code: a fixed allowlist of screen capture and keyboard/mouse calls on the VMs in its config. The Control Plane gets nothing: it is a service with no Hyper-V right, and its right on the Broker service stays `LC` (query status).

**Undo.** `-Mode uninstall` needs no option; the install record decides. Its first step removes the Broker's SID from the group, reads the membership back, and stops (the services are NOT deleted) if the SID is still there. The order matters: a deleted service leaves its SID in the group, and the next service with that name would inherit the right. If you ever need to do it by hand: `Remove-LocalGroupMember -SID S-1-5-32-578 -Member <the Broker SID from the plan>`. Nobody else in the group is touched, and a group that no longer exists is skipped.

**Known limit of the `desktop` pin.** (Closed by the service layout; this is what it was.) In the first layout `control-plane\` gave `albera-cp` full control, so `albera-cp` could rewrite `albera.approval.json` and point `desktop` at a fake helper: the pin guarded against a room settings mistake or a mixed-up repository build, not against a hijacked `albera-cp`, and even then the fake helper holds no Broker lease, so its input does not reach the VM. Now the settings live in `control-plane-config\`, which the Control Plane service can only read, so the service cannot move the pin (decision `2026-11-03+cp-settings-pin-scope`, ADR-002 "Known limit: the helper pin"). What stays: the pin covers the helper exe, not the dll files beside it (`control-plane-service.md`, section 5).

**Lab.** `-VmId <lowercase GUID>` replaces the lookup and is refused unless `ALBERA_LAB_VM` is `1`, like `-NodeSource` and `-ClaudeSource`. The second pass of `lab-host-install-check.ps1` installs with the option and checks, independently of the installer's own read-back, that the Broker SID is in the group (via `net localgroup`), that the Control Plane and the Authority are not, the SID types (`UNRESTRICTED` and `RESTRICTED`), the privileges, the `computers` entry, the `desktop` block of the Control Plane settings (against a hash the hook takes itself with `Get-FileHash`; the default pass checks that a plain install writes none), the install record, a second install that changes nothing, and an uninstall that leaves the group as it was. It is BLOCKED, not passed, when the guest has no Hyper-V Administrators group, and it uses a fixed GUID, so the name lookup is not part of it.

**Not verified.** Nothing here has run on a real host with the stage 1 layout. In particular: `Add-LocalGroupMember` / `Remove-LocalGroupMember` with a service SID given as a string (the nested lab used `net.exe`, which this script may not start); reading the group's member list when one member is a service's virtual account (the script falls back to the member's WinNT path); a Broker started with a `computers` config as an unrestricted service next to a Control Plane service on the owner's PC; and, from ADR-002, adapter mouse input against a VM with a guest OS. The VM name to GUID lookup did run on the owner's PC on 2026-11-03 (first layout).

## WSL2 computer (`-AddWsl2Computer`, optional; ADR-012 phase 5)

**Status: written, never run.** Everything below was built with fakes (`test/host-install-wsl2.test.mjs`); no key, account, task, service, ACL, registry value or `wsl.exe` was touched when it was written. Treat the first real run as the first run.

Why it exists: the owner approved AGM-2 (ADR-002) and wants WSL2 jobs to run for real. A WSL2 job runs under a lease the Broker signs with its own CNG key; the bridge (the only program that runs `wsl.exe`) trusts that key's public half. The install side puts the key and its three copies in place so that you only run prepared commands.

With `-AddWsl2Computer` install does these things, in this order (the plan lists them; `-Mode plan -AddWsl2Computer`):

1. **Checks the options** before anything is created (`wsl2inputs`): shapes, the publish folder of the bridge, the image file, the repository folder, `git.exe` (a file under `C:\Program Files\Git` whose folder only administrators can write).
2. **Makes the Broker's attestation key** `AlberaHostBroker-attest-1` (`wsl2key`, right after the Authority's own key): ECDSA P-256, Microsoft Software KSP, machine scope, Export Policy none, DACL = SYSTEM, Administrators and the Broker's service SID, read back from a fresh open, one sign/verify round trip. **A key of that name that this script did not make is never adopted: the run stops.**
3. **Hands the public half to all three** in the `configs` step: the Authority config (`attestationKeyId` + `attestationPublicKey`, pinned), the Broker config (`attestation: { keyName, keyId }`, plus the computer `{ computerId, kind: "wsl2" }`) and, later, the bridge config (`brokerKeyId`, `brokerSpki`). The approval settings get the second computer (`isolation: wsl2`, `repositoryId`), the `wsl2` block (`pipeName`, `serverSid` = you, `git`) and, because the room's parser requires it, the `desktop` block.
4. **Makes `C:\ProgramData\Albera\wsl-bridge\`** (`wsl2folders`): administrators write, your account reads (config, lease floor, image); `state\` and `distributions\` are the only places your account writes. No service SID has any rule there.
5. **Copies the bridge, the image, the lease floor and the bridge config** (`wsl2files`). The bridge program goes to `C:\Program Files\Albera\bin\wsl-bridge` (administrator-only; you may read and run it). **It is not part of the five-component tree hash** that setup and CI verify (that value covers five builds and its CI workflow does not build the bridge): the bridge has its own hash, which you read in a normal console (`-Mode wsl2-hashes`) and type into the elevated command, and the COPY must hash to it. The image copy must hash to `-Wsl2ImageSha256`. The lease floor file holds the Broker config `generation` (1 at install); only Administrators, SYSTEM and your account can read it (ADR-012: Phase 5 required).
6. **Starts the installed bridge once** with a config whose Control Plane is you, and requires exit 77 (`wsl2verify`). Then **reads the key and its three copies back** and fails on any disagreement: the live key's public half against the Authority pin, the bridge's `brokerSpki`, the key id and key name in the Broker and bridge configs, the floor against the Broker generation, the computer and repository names, and the key's own ACL and export policy. Run from an elevated console the bridge refuses as `elevated` (it checks that before the Control Plane comparison), so this step proves that the installed program starts, trusts its config and refuses the wrong identity; the `control_plane_is_self` word is shown only by the tests.
7. **Adds the HKLM Run value `AlberaWslBridge`** (`wsl2run`): your session starts `"C:\Program Files\Albera\bin\wsl-bridge\albera-wsl-bridge.exe" serve "C:\ProgramData\Albera\wsl-bridge\bridge.json"` at sign-in, the way the approver tray starts. Any account that signs in runs it; a wrong account is refused by the room (`serverSid`), not by the bridge.

`-Mode status` follows the record and adds: the key (export policy, DACL, agreement of every copy), the three folders, the bridge folder hash, the image hash and the Run value. `-Mode set-approver` keeps the pin when it rewrites the Authority config. `-Mode uninstall` follows the record: Run value, then the key (after the Authority's), then the data folder and the install folder.

An install that is already complete is not changed (as with the Hyper-V option): to add the WSL2 computer later, uninstall, then install again with the option.

### The commands, in order

Everything marked **normal** runs in an ordinary console; **elevated** means the clean `cmd /d` described under "The elevated console" below, running the copy of the two script files you checked (`C:\Program Files\AlberaSetup\...`). `<repo>` is your checkout. Each step: one command, minutes of your time, and how to undo it.

1. **Build the bridge** (normal, about 5 minutes; undo: delete `src\runtime\windows-wsl-bridge\bin`).

   ```
   npm run build:wsl-bridge
   ```

2. **Read the bridge's tree hash** (normal, 1 minute; changes nothing). Write down the value after `ALBERA_WSL_BRIDGE_TREE_HASH=`.

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\host\albera-host.ps1 -Mode wsl2-hashes
   ```

3. **Have the image and its SHA-256 ready.** The image tar is built by `src/runtime/wsl2-guest/build-image.sh` (ADR-012, "The image"); that build runs in WSL and is not part of this install. Its hash:

   ```
   certutil -hashfile <path of albera-wsl2.tar> SHA256
   ```

4. **See what the C6 / N7 measurement will do** (elevated is not needed, 1 minute; changes nothing).

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\host\measure-attestation-key.ps1 -DryRun
   ```

5. **Run the C6 / N7 measurement** (elevated, about 5 minutes; undo: it deletes its own key, tasks and work folder on every way out; to remove the report: `rmdir /s /q C:\ProgramData\AlberaMeasure`). It creates a throwaway machine key and a few one-shot tasks, tries the key as a non-administrator, as a stand-in Broker, as another virtual account and as the Control Plane, tries to export it, and writes `C:\ProgramData\AlberaMeasure\attestation-key-report.json` (names, SIDs, SDDL, HRESULT names and yes / no answers: no key material). **Read the report before step 7:** a line `asExpected_* = NO` or `nonAdministratorCanTakeTheName = yes` is a finding for ADR-002 (N7) and for the install (a non-administrator who can create the name first can race the installer's "refuse if it exists" check). `not_measured` means Windows would not run that task as that account: the answer is open, not good.

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\measure-attestation-key.ps1"
   ```

   (Copy `measure-attestation-key.ps1` next to the two other script files and check its hash with `certutil` like them. The measurement script reads `albera-host-lib.ps1` from its own folder.)

6. **Plan the install** (normal, 1 minute; changes nothing). Put your values in; the plan names every wrong one.

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\host\albera-host.ps1 -Mode plan -AddWsl2Computer -Wsl2RepositoryId <id> -Wsl2RepositoryPath <C:\folder of the repository> -Wsl2Image <C:\path\albera-wsl2.tar> -Wsl2ImageSha256 <64 hex of step 3> -Wsl2BridgeTreeHash <64 hex of step 2> -Wsl2FloorExpiresAt <Unix seconds in the future>
   ```

   The floor expiry is a date after which the bridge refuses every run (ADR-012, decision 12); for 90 days from now: `[DateTimeOffset]::UtcNow.AddDays(90).ToUnixTimeSeconds()`.

7. **Install** (elevated, about 15 minutes; undo: `-Mode uninstall`, see "Uninstall"). This is the install of "First install" or "Running the script yourself" with the options of step 6 added: all the values of that install (`-ExpectedTreeHash`, `-ApproverKeyId` / `-ApproverPublicKey` or `-ApproverKeyFile`, `-ApproverSid`) plus `-AddWsl2Computer` and the six `-Wsl2...` values. With setup: the same line plus those options (setup passes unknown options through only if it was built to; if it was not, run the script directly).

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode install -ExpectedTreeHash <64 hex> -ApproverKeyId <hello-...> -ApproverPublicKey <spki> -ApproverSid <S-1-5-21-...> -AddWsl2Computer -Wsl2RepositoryId <id> -Wsl2RepositoryPath <C:\folder> -Wsl2Image <C:\path\albera-wsl2.tar> -Wsl2ImageSha256 <64 hex> -Wsl2BridgeTreeHash <64 hex> -Wsl2FloorExpiresAt <seconds>
   ```

8. **Check the state** (elevated, 1 minute; changes nothing). Every line must say `[ok]`.

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode status
   ```

9. **See what the SEC-2 check will do** (no admin needed, 1 minute; changes nothing).

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\host\lab-sec2.ps1 -DryRun
   ```

10. **Run the SEC-2 two-account check** (elevated, about 10 minutes; do it BEFORE the first WSL2 job and before any image pin is set). It makes a temporary local account `albera-sec2-<8 hex>`, copies the installed pipe client helper into a lab folder, writes a lab bridge config (another pipe, the account as Control Plane, its own state folders) and **stops to tell you one command to run in a normal console**: that starts the lab bridge as you. Then it runs the helper as the account three times (owner expected; wrong owner expected, which must be refused; owner and bridge image hash expected) and prints whether the owner check and the image pin work from another account. It removes the account, its profile folder and the lab folder on every way out. End the lab bridge with Ctrl+C in its console. Record the answers in ADR-012 (SEC-2). Undo: run it with `-RemoveStale` (below).

    ```
    C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\lab-sec2.ps1"
    ```

    If the process was killed and the account is still there:

    ```
    C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\lab-sec2.ps1" -RemoveStale
    ```

**Order, and why the SEC-2 check comes after the install.** ADR-012 asks for SEC-2, N7 and C6 "before the installer makes the key". N7 and C6 are step 5, before the install. SEC-2 cannot run before it: it needs the installed bridge, the installed helper and the bridge config the install writes. What the ADR gives as the reason ("no job can run before then") holds only while no WSL2 job is started: a WSL2 `task.start` always asks a person, so do not approve one until step 10 has an answer.

### A lost or exposed key

The bridge reads its public key **once at start** and holds one `keyId`; the Broker reads the private key at its start. There is **no overlap**: a rotation is a replacement, and every lease signed by the old key stops verifying the moment the bridge has the new one. The lease revocation runbook (`wsl2-lease-revocation-runbook.md`) covers generations only; it does not replace a key.

*Exposed* (someone may have been able to sign leases) or *lost* (the key file is gone, or its ACL changed so that the Broker cannot open it): the cure is the same, a new key. There is no "rotate" mode. Uninstall deletes the key; a new install makes another with the same name. The Broker journal is lost with it (as with any update: "uninstall, then install"), the lease floor and the generation start again at 1, and that is safe here because the pinned key changes: an old lease no longer verifies.

1. **Stop the Control Plane** (elevated, 1 minute), so nothing new arrives while you work. Undo: `Start-Service AlberaControlPlane`.

   ```
   Stop-Service AlberaControlPlane
   ```

2. **Stop the bridge.** Sign out of your Windows session (the bridge stops with it and every run ends), or end `albera-wsl-bridge.exe` in Task Manager. Do not run `wsl --shutdown`.

3. **Read what is wrong** (elevated, 1 minute; changes nothing). The line `WSL2 key AlberaHostBroker-attest-1:` names the failure: `key_missing`, `key_exportable`, `ace_untrusted`, `ace_missing`, `authority_spki`, `bridge_spki`, `floor_above_generation`.

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode status
   ```

4. **Remove everything the install made** (elevated, about 5 minutes). This deletes the key, the Run value, the bridge folder and the data. Nothing is guessed back.

   ```
   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode uninstall
   ```

5. **Install again with the same options** (elevated, about 15 minutes): the command of step 7 above. A new key is made; the Authority pin, the bridge config and the Broker config get its public half in the same run, and `wsl2verify` reads them back. If the key was exposed, also follow "Deal with the cause" in the revocation runbook before the Control Plane is started.

6. **Start the Control Plane** (elevated, 1 minute), then start the bridge by signing out and in, and start one WSL2 job to see it accepted.

   ```
   Start-Service AlberaControlPlane
   ```

### Recovery from exit 77 (the Broker will not start)

With `attestation` in its config the Broker opens the machine key at start and **never creates it**; if it cannot (the key is gone, or the ACL no longer lets the Broker's service SID use it), the service stops with specific exit code **77**. That stops the whole Broker, **including the VM claims of the Hyper-V computer**: it is one process. The Broker cannot tell a missing key from a denied one (a key it may not open answers `NTE_BAD_KEYSET`, "no such key"), so it reports both as the fixed word `signing_key_unavailable`.

1. **Confirm the code** (elevated, 1 minute; changes nothing). `ServiceSpecificExitCode` must be 77.

   ```
   Get-CimInstance Win32_Service -Filter "Name='AlberaHostBroker'" | Select-Object State, ExitCode, ServiceSpecificExitCode
   ```

2. **Read which of the two it is** (the `-Mode status` command of step 8; changes nothing). `key_missing` = the key is gone; any `key_ace_*` / `key_key_exportable` = it is there but not as installed.

3. **Choose one way back**, both through the uninstall of "A lost or exposed key" (step 4 there):

   - *WSL2 stays:* install again with the WSL2 options (a new key; the VM claims return with it).
   - *VM claims back first, WSL2 later:* install again **without** `-AddWsl2Computer` (with `-GrantHyperVToBroker -VmName <name>` if you had it). The Broker config then has no `attestation`, a WSL2 claim gets no lease, and the VM claims work as before.

   There is deliberately no repair that edits the Broker config or the key's ACL by hand: a key whose ACL was changed is a key somebody else may have used.

The bridge has its own 77: `BRIDGE_FATAL=elevated` (it was started from an elevated console) or `control_plane_is_self` (the Control Plane's SID in its config is the account it runs as). Start it from a normal console as yourself; if the second word appears, the bridge config is wrong: uninstall and install again.

**Not verified (WSL2 computer).** None of it has run on a real PC: the machine key with a service SID in its DACL and its read-back; the Broker opening it as `NT SERVICE\AlberaHostBroker` (C6); the key file's own ACL as the mechanism (L9); Task Scheduler running a one-shot task as `NT SERVICE\AlberaMeasure...` accounts that have no service (if it refuses, the measurement says `not_measured` and the question stays open); `Process.Start` with a temporary account's credentials and no loaded profile (`lab-sec2.ps1`; if PowerShell cannot start for that account the answer is `not_measured`); the first-start check against the real bridge (exit 77, shown as `elevated` from an elevated console); the HKLM Run start of the bridge in your session; `Set-HostDacl` on the bridge folder; the default `-Wsl2GitPath` (`C:\Program Files\Git\cmd\git.exe`, a launcher: give the `git.exe` you want the bridge to run if that is not it); whether the CI "Host build hashes" run should also cover the bridge (today it does not, so the bridge tree hash is a value computed on your PC, not a reviewed one); and `albera-setup.exe` passing the `-Wsl2...` options on.

## First approval and the Claude Code token (after the install)

1. **Open the room.** Start menu, `ALBERA`, `Open ALBERA` (in your normal session). It opens `http://127.0.0.1:<port>/room/#b=<code>`; the one-time code is in the URL fragment, which the browser never sends to the server. If it says the service is not running, start it (see "When it stops").
2. **Enter the token once.** In your own terminal, as your account, run `claude setup-token` and paste the value it prints into the room's field "Claude Code token (setup-token)" (button "Credentials"), then Save.
   - The field only writes. After saving, the room shows the first 8 hex characters of the value's SHA-256 and the time, never the value. The page tries to empty your clipboard and says if it could not.
   - Save checks the format only. Whether the token works is found out by the first job. How long a `setup-token` token lives and where it is revoked is NOT VERIFIED (M2). "Erase" removes ALBERA's copy only; to really revoke the token, do it on the Anthropic side.
   - Paste it straight into that field and nowhere else. On 2026-11-03 an API key that went through the clipboard ended up in the approver's `yes` prompt and in a chat.
   - The token is stored as a DPAPI blob in `secrets\`, which only the Control Plane service can read. ALBERA never reads your `~/.claude`. Uninstall deletes `secrets\`, so you enter the token again after a reinstall. The field "API key (optional)" is the other credential option; exactly one of the two is used.
3. **Approval test.** In the room: "Jobs", then "Approval test". It sends one harmless `synthetic.noop` to the approval window (the tray; it must be running). At the PC: the window shows what the action is and the result of its own digest check, and offers three 4-digit candidates. Press the one the room shows, then verify with Windows Hello. The job should end as "Approved (nothing was started)". One wrong pick shows a warning; the second wrong pick sends Deny. There is no approve button at all when the digest check fails or the text holds a control or direction character.
   - `AlberaApprover.exe list` and `approve <approvalId>` (type `yes`, then Hello) still work from your own console as the fallback. Nobody can run `albera-runtime approval-check` by hand any more: only the Control Plane's identity reaches the submit pipes, and that is a service now. The "Approval test" button replaces it.
4. **A real job.** "Jobs": pick the computer, write the task (up to 256 bytes), "Ask to start". The room shows that job's match code; pick the same digits in the approval window and verify with Hello; the job goes "Approved, starting", then "Started". By default a task is stopped after 15 minutes or 120 desktop tool calls (no money cap; `control-plane-service.md`, section 6.6). "Stop everything" cancels the waiting jobs and stops the hands; a request already in the approval window is not withdrawn: deny it there. The Authority stays at tier `careful` until a policy is set, so every start needs your approval. The settings name one computer (`-ComputerId`), and driving its VM needs the Hyper-V option above.

## Update (today: uninstall, then install)

There is no in-place update yet. A complete install met with a different verified build ends with `ENGINE_EXIT 5` and the script's note "Updating in place is not part of this installer yet: -Mode uninstall, then install again. Nothing was changed." The same build again is a check, not a change (it ends like `-Mode status`). So:

1. Dispatch Host build hashes on `main` for the commit you want (or reuse a run younger than 14 days), download `albera-update`, unzip it.
2. Uninstall ("Uninstall" below). This deletes the stored token and both journals; the Hello key, `bin\setup` and your approver values stay.
3. Copy the three files of the new `<update>\setup\` over those in `bin\setup` (step 2 of "First install"), so the setup that runs is the one from the build you install.
4. Run setup (step 3 of "First install") with the same options as the first time, the Hyper-V ones included: the update is a fresh install, so an install without `--grant-hyperv-to-broker` leaves the Broker without the grant.
5. Start the services, enter the token again, run the approval test.

A build older than what this PC has seen is refused (`rollback_refused`), also after an uninstall: the largest of the install record's `setupRunId`, the floor in `HKLM\SOFTWARE\Albera\SetupRunIdFloor` and the run id compiled into `albera-setup.exe` is the bound. The same run id is allowed (to finish or repair an install).

**The "ALBERA update" shortcut does not do this yet.** It starts `bin\setup\albera-setup.exe` (UAC) with no arguments, and setup requires `--update <folder>`: it stops with `--update <folder> is required` and the window closes. How the update folder reaches the owner is still open (`control-plane-service.md`, section 8, "Copy first"). Until then start setup yourself as in step 3 of "First install". The shortcut was never run.

## Moving from the first layout (`-Mode migrate`)

If this PC still has the first layout (the local account `albera-cp` as the Control Plane), `-Mode status` says "the first layout", and `-Mode install` stops and points to `-Mode migrate`. Run `-Mode migrate` once. The Control Plane becomes a service; `albera-cp` and its profile go. This is the one run that trades your hash check for a script (decision D7); every later update goes through attested setup.

You need the repository with the five builds made in a NORMAL console (`npm run build:windows-broker`, `npm run build:approval-authority`, `npm run build:control-plane`, `npm run build:approver`), Node.js and Claude Code as in "Before you start", and an elevated console of the approver account. Plan first (changes nothing), then migrate from the hashed script copy ("Running the script yourself"):

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode plan -PlanFor migrate -RepoRoot <repo> -TrustLocalBuilds
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -RepoRoot <repo> -Mode migrate -TrustLocalBuilds
```

What it does, in order: reads the old record and configs and carries over the Hello public values, the VM GUID, the computer id and the Hyper-V grant choice (do not pass `-ApproverKeyId`, `-ApproverPublicKey`, `-ApproverSid` or `-GrantHyperVToBroker`; it prints the carried values up front, so keep them if the run stops half-way, they are what `-Mode install` needs); checks, **before anything is removed**, that the new install can be made (five builds and the tree hash, node, claude, the approver account, and no unknown file or link in the old folders); disables `albera-cp`; stops its processes by PID, found from the owner SID and never by name; runs the ordinary uninstall (the Broker's SID leaves Hyper-V Administrators first; the account and `C:\Users\albera-cp` go); runs the ordinary install.

`-TrustLocalBuilds` says you accept the tree hash of the builds in this working tree: it proves nothing about who built them. The alternative is `-ExpectedTreeHash <64 hex>` from a Host build hashes run ("Where the tree hash comes from"); the two exclude each other. Lost by design: the Control Plane and Broker journals and the Authority's signing key (a new one is made). Kept: the Hello key and its three public values.

Afterwards: start the three services, open the room, enter the token, run the approval test. The "ALBERA update" shortcut exists only if `bin\setup\albera-setup.exe` was in place when the install step ran; put setup there ("First install", step 2) before the next install. `-Mode migrate` has run once, in the disposable VM (`lab-vm.ps1 -HostMigrate`, "VM lab hook"); it has not run on a real PC.

## Changing the approver keys (`-Mode set-approver`)

Why: the approver key is pinned in the Authority config, and over Remote Desktop the Windows Hello key cannot sign. The owner makes a WebAuthn key with `AlberaApprover.exe enroll --webauthn` (it writes the key's public record, a small JSON file, to `%LOCALAPPDATA%\Albera\approver-keys\<keyId>.json` and prints the key id), then puts that key into the Authority with this mode. UAC works over Remote Desktop, so the owner can do all of it remotely. **This is the only way a key is ever added.** There is no run-time `key_add`: a process running as you must not be able to register its own key, and UAC is the boundary such a process does not cross. Design and contract: `approver-webauthn.md` ("Keys", "Wire contract").

Plan first (changes nothing, needs no admin; on an installed PC without admin rights the first step says "unknown" because it cannot read the install, and the final list is "worked out in the elevated run"), then the real run from the hashed copy ("Running the script yourself"), in an elevated console:

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode plan -PlanFor set-approver -ApproverKeyFile "C:\Users\<you>\AppData\Local\Albera\approver-keys\<keyId>.json" -ExpectedApproverKeyId <keyId>
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode set-approver -ApproverKeyFile "C:\Users\<you>\AppData\Local\Albera\approver-keys\<keyId>.json" -ExpectedApproverKeyId <keyId>
```

**It adds; `-Replace` replaces.** Without `-Replace`, the given records are appended to the approver keys **in force**, in order, and nothing is dropped. With `-Replace` the given records are the only keys afterwards (use it to drop the old Hello key, or to start over). 1 to 16 keys in all: a list that would hold more than 16 is refused, and so is a given `keyId` that is in force already (it is refused, not skipped; running the same add twice fails the second time, with nothing changed). Give several files as one comma-separated value (`-ApproverKeyFile "C:\a.json","C:\b.json"` or `a.json,b.json`; when PowerShell is started with `-File` it passes a comma list as one string and refuses a parameter given twice, so a path with a comma in it cannot be given).

**The keys in force are the Authority's key store, not the config.** The store `authority\approver-keys.json` (written by the Authority; `{"v":1,"revision":n,"keys":[records],"signCounts":{...}}`) is what the Authority really trusts, and a key taken out with `key_remove` (a lost device) is gone from the store but still in the config. So when the store is there, trusted (owner SYSTEM, Administrators, TrustedInstaller or the Authority's own service SID; no other writer; no link) and valid (its records pass the same rules as a key file's, 1 to 16, none twice), the list starts from it. Only when there is no store does it start from the config's keys, the legacy pair counting as one `hello-rsa` key. **A store that is there but cannot be used is never a reason to read the config instead:** an add is refused (nothing changed), because the config could hand a removed key back. Repair or delete the file, or give the complete list with `-Replace`, which does not need the store. A legacy pair whose id is not the hash of its key (not a valid record, as in the lab VM's `hello-lab-0001`) cannot be carried into `approverKeys` either: add is refused, `-Replace` is not.

The run prints the keys in force and where they came from, the keys it adds, and then **the final list (key ids and kinds) the Authority will trust, before anything is written**. After the service is stopped the list is worked out once more and must come out the same, otherwise nothing is written and the service is started again (a `key_remove` that lands in between).

**You type `yes`.** After the list is on the screen the script says that nothing has been written yet and asks you to type `yes` in that elevated console. Only the word `yes` goes on (blanks around it are ignored; `y`, `YES`, an empty line or anything longer cancels). If the input or the output of the console is redirected, or the console is not interactive, the run is refused before the service is touched, with nothing changed: there is nobody to answer, and a process that cannot be seen cannot be allowed to answer. A run that finds everything in place already (`-Replace` with the list already in force) writes and restarts nothing and asks nothing. The lab VM has no console, so it has its own explicit way: `-LabAssumeYes` stands in for the typed `yes`, and is refused, like `-NodeSource`, `-ClaudeSource` and `-VmId`, unless the environment variable `ALBERA_LAB_VM` is exactly `1` (and for every mode but `set-approver`). On a real PC there is no flag that skips the question.

**`-ExpectedApproverKeyId <id>[,<id>...]` (required whenever `-ApproverKeyFile` is used: set-approver, and install or migrate with key files).** The record files are in your own profile, so anything running as you can write one, and can swap it between `enroll --webauthn` and this elevated run. The key id `enroll` printed on your own screen is the anchor (`enroll --webauthn` is meant to print the whole command with `-ExpectedApproverKeyId <keyId>` in it; that print belongs to phase 3 and is not checked by this script's tests). Give **one id per file, in the same order as the files** (comma-separated, like the files). The script computes the key id from each file's public key (the rule in `approver-webauthn.md`, "Keys") and refuses, before anything is changed, when it is not the id given for that file at that position. It refuses too when the number of ids differs from the number of files (also when there is none), and when an id is not of the form `webauthn-` or `hello-` plus 16 lower-case hex characters. A file swapped for another key, even a perfectly valid record, is refused with both ids in the message. The ids go with the files by position, not as a set: the right keys in the wrong order are refused. **The `credentialId` is not part of the anchor:** the key id is the hash of the public key alone, so a file with the right key and another `credentialId` passes this check. That is harmless: a swapped `credentialId` only makes the key unusable (the authenticator does not know it), it registers no other key. The check is made again when the files are read for the write (and again after the service is stopped), so a swap in between is caught as well.

What it checks before it changes anything, and refuses (exit 3, nothing changed) when any of it fails:

- the console is elevated (never self-elevating; the same seam as install), the install record is trusted and complete, of the service layout (a first-layout install is told to migrate), and lists `AlberaApprovalAuthority`;
- the Authority folder is trusted (owner, writers, no link); the Authority config is a file install wrote: valid shape (the legacy pair or `approverKeys`), every field outside the keys is what install writes for this PC, and the approver SID equals the one in the record;
- `authority\approver-keys.json` is absent or a plain file, not a folder, a junction or a link;
- the service `AlberaApprovalAuthority` exists and runs the command line install wrote;
- every record file passes the whole record contract: a plain absolute path with no link on it, read once through one handle (the handle's final path must be the path given), at most 4096 bytes; UTF-8 without a byte order mark; **exactly one record whose bytes are its canonical form** (the fields `keyId`, `kind`, `alg`, `publicKey` and, for `webauthn` only, `credentialId`, in that order, no space, no line break, no escape, no repeated key; an extra field, a second record or a trailing line break is refused); `keyId` is `webauthn-` or `hello-` plus the first 8 bytes of SHA-256 over the SPKI in lower-case hex, and must match the key; `alg` -7 with a P-256 key whose point is on the curve, or -257 with RSA (public exponent 65537; `webauthn` 2048 to 4096 bits, `hello-rsa` exactly 2048); `credentialId` is base64url without padding, 1 to 1023 bytes, one text per value; then as a list: no `keyId`, `credentialId` or public key twice; and every file's key id, computed from its public key, is the one given for it at the same position of `-ExpectedApproverKeyId`.

What it does, in order (each step is a numbered line, and a step that is already done is skipped):

1. **check** the above.
2. **keys** reads the files, works out the final list, prints it, and asks you to type `yes` (see "You type `yes`"). Nothing has been stopped or written yet.
3. **stop** `AlberaApprovalAuthority` if it is running (while it runs it may rewrite its key store and undo the next two steps). A service that is not running is left stopped, and is not started at the end.
4. **config** writes the final list as `approverKeys` into `authority\AlberaApprovalAuthority.service.json` through the same trusted write path as install (owner, writers and links checked before and after); the legacy pair `approverKeyId` + `approverPublicKey` is removed, never both; every other field, the approver SID included, is copied as it is.
5. **store** deletes `authority\approver-keys.json` (that one fixed path, only if it is a plain file), so the next start makes the Authority's key store from the config. The file's bytes are kept in memory first, for the rollback (step 6). The config now holds the whole list, so the only thing lost is the sign counts (next paragraph).
6. **start** starts the service again and waits until it is Running and still Running a few seconds later. **If it does not stay up** (the usual cause: the installed Authority build does not read `approverKeys` yet; a process holding the Authority's pipe name while the service was stopped does the same), the old config goes back byte for byte **and the key store goes back byte for byte**, the service is started again with the old keys, nothing is recorded, and the run ends with an error that says so. The same happens when a step fails after the service was stopped or the config written (the config write, the store step, the install record).

**Why the rollback puts the store back instead of deleting it.** The old config can still hold a key that `key_remove` took out of the store (a lost device). A store deleted for good would be made again at the next start from that old config, and the removed key would be back in force. So the bytes read from the store with the service stopped, before anything was changed, are kept in memory, and the rollback writes exactly those bytes to the same fixed path through the same kind of trusted write as the configs: the owner becomes Administrators, which the Authority's own store check accepts, and the file is read back through the trust test and compared byte for byte. If the file already holds those bytes (the delete never happened) it is not written at all. When there was no store at the start, the config was the list in force, so the rollback restores only the config and deletes the store a failed start may have made from the new one. If the store cannot be put back (for example `icacls` fails), the service is **left stopped** and the run says so: starting it on a store the run did not mean to leave could trust the wrong list. A store the install does not trust (only reachable with `-Replace`) cannot be vouched for and is not put back; the run says that too.

**set-approver resets the per-key sign counts.** The Authority makes its key store again from the config, and the config holds no counts, so every key starts again at zero. That is acceptable because every presence message carries a fresh per-entry challenge (`approver-webauthn.md`, "The proof"): an old assertion cannot be replayed whatever the count, so the count is only a clone signal (a counter that goes backwards or to zero after it was above zero). After a set-approver that signal starts over for every key; it does not make anything easier to forge.
7. **record** writes the list (key ids and kinds only) into the install record as `values.approverKeys` and the time as `values.approverKeysSetAt`; `values.approverKeyId` (the legacy pair's id) is removed.

Approvals that were waiting in the Authority when it stopped are lost by the restart (ask for them again). With `-Replace`, a run where the keys in force, the config and the record already hold exactly this list (same keys, same order) changes nothing and restarts nothing, and the key store with its sign counts is left alone. A run that was cut off after step 4 is finished by running the same command again. `-Mode status` has one line, `Authority approver keys`, with the key ids and kinds the config holds (the legacy pair counts as one `hello-rsa` key) and a `FAIL` when they differ from the record. Uninstall knows `authority\approver-keys.json` and removes it with the folder.

Not part of it: changing the approver SID (it stays as it is; a different account is a new install), starting the approver program (this script never does while elevated), and `albera-setup.exe` (it does not pass `-ApproverKeyFile` yet, so the key-file form of install and migrate is a direct run of this script). **Install and migrate** also take `-ApproverKeyFile` with the same required `-ExpectedApproverKeyId` (instead of `-ApproverKeyId` and `-ApproverPublicKey`; `-ApproverSid` is still typed for install and carried over by migrate, which then does not carry the old Hello key over: give its record file in the list to keep it); the same record checks apply, migrate runs them in its preflight before anything is removed, and the Authority config then holds `approverKeys`.

**Not run on a real PC.** The logic runs in the tests with fakes for the service control manager and the trusted write (`test/host-install/approver-harness.ps1`); the lab hook has a set-approver step (written, not run; it needs the VM build that has the Authority with the key list). The first real run is the first run.

## Check the state (`-Mode status`)

In an elevated console (once installed, `C:\ProgramData\Albera` can be read by administrators only; the owner's PC showed "access denied" in a normal console):

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode status
```

It is read-only. It prints one numbered line per check, `[ok]`, `[FAIL]` or `[unknown]`, then `STATUS: ok. Everything matches the install manifest.` (exit 0) or `STATUS: <n> item(s) differ or could not be checked.` (exit 1). With nothing installed it says so and exits 0. The lines cover: the install state; each of the three services (delayed start, SID type, privileges, command line; the Control Plane's failure actions; the Broker's service ACL); the Hyper-V group (only with a grant, or when something is wrong there); the ACL of every planned folder; the folder hash of each of the five builds; the signing key; the shape of the Broker and Authority configs; the approver keys the Authority config holds (key ids and kinds, compared with the install record); the settings file; the setup run id and the floor; the BUILTIN\Users rules (read and execute on the three folders, none elsewhere); the node.exe and claude.exe pins; the Control Plane service config; the launcher, the shortcuts and the Run entry. A first-layout install is reported as such, with "Run -Mode migrate once".

A stopped service is `[ok]` (its state is printed at the end of the line): status checks that the services are as installed, not that they run. For that: `Get-Service AlberaHostBroker, AlberaApprovalAuthority, AlberaControlPlane`.

## Uninstall

`-Mode plan -PlanFor uninstall` first (changes nothing), then, elevated, from the hashed copy:

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\AlberaSetup\albera-host.ps1" -Mode uninstall
```

It removes only what the install manifest lists, in this order: the Broker's SID from Hyper-V Administrators (when the record says it was added; before any service goes); the HKLM Run value `AlberaApprover` (only if it is the command install wrote); the two Start menu shortcuts and their folder; the three services, the Control Plane first (stopped, then deleted; a service whose command line is not the one install wrote is left alone and reported); the machine signing key; the folders this script made under `C:\Program Files\Albera` (the builds, the pinned node.exe and claude.exe, the launcher); the data folders under `C:\ProgramData\Albera` (configs, journals, `policy.json`, the stored token, `ui\room.json`, logs); `albera-cp` and its profile (first-layout installs only); and last the manifest and the data root. A folder that holds a file the script does not know, or a link or junction, is not deleted.

**Kept:** `C:\Program Files\Albera\bin\setup` and `setup-work` (and the root with them), so setup can install again; `HKLM\SOFTWARE\Albera\SetupRunIdFloor`; your Windows Hello key; Node.js and Claude Code. **Deleted with the data folders:** the Broker journal, the Control Plane journal and the stored token.

## When it stops

| You see | Why | What to do |
|---|---|---|
| `the node.exe source cannot be trusted: C:\Program Files\nodejs ... (writer_untrusted:S-1-...)`, also `owner_untrusted`, `reparse_point:<path>` | The installer copies `C:\Program Files\nodejs\node.exe` only when the file and its folder are owned by SYSTEM, Administrators or TrustedInstaller, nothing else can write to them, and no link is on the path. Another group's write rule, a tool that "fixed" permissions or a junction breaks that | Find the SID in the message and the rule: `icacls "C:\Program Files\nodejs"`. Remove that write rule, or reinstall Node.js into the default folder, then run the install again. **Do not delete the Node.js folder**: the message ends with a general "delete it yourself" line that fits only folders the script made. Exactly `writer_untrusted:S-1-5-32` (`BUILTIN\BUILTIN` in icacls, a rule the Node.js installer leaves) was a false alarm fixed in PR #191; use a build that has it |
| `node.exe not found at C:\Program Files\nodejs\node.exe` | Node.js is installed somewhere else (a per-user install, a version manager); only the Program Files copy is looked at | Install Node.js into `C:\Program Files\nodejs` |
| `claude.exe not found at ...\.local\bin\claude.exe`, `claude.exe cannot be located`, or `elevated_account_is_not_the_approver` | The pin is made from the Claude Code of the approver account, found through the profile path Windows records for the approver SID | Install Claude Code for that account and open the elevated console as that same account (the SID you passed). An administrator account that is not the approver is refused |
| `host has <x> GB free; need <n> GB (<v> GB VM + 4 GB headroom). Stop other VMs and retry.` | Lab only (`lab-vm.ps1`, `checkpoint-cost.ps1`; the installer and the service have no such check). `lab-vm.ps1` needs 8 GB free for its 4 GB VM, 9 GB with `-HyperV`. A 4 GB VM on a full host froze the PC on 2026-10-31 | Not a failure: the guard did its job. Do not stop other sessions, VMs or processes to make room (the message's "stop other VMs" is for the owner's own); do other work and try again later, and say in the report that the VM run waited. Do not lower the numbers. One lab VM at a time |
| set-approver: `REFUSED: approver key record rejected: <path>: record_not_canonical` (or another `record_*` word), `approver_keys_*`, `this file holds the key <id>, but the key id expected for it (-ExpectedApproverKeyId, position N) is <id>`, `-ExpectedApproverKeyId must give exactly one key id per -ApproverKeyFile file` | The file is not exactly what `AlberaApprover.exe enroll --webauthn` writes, a rule of the record contract fails, or a file holds another key than the id you typed for it (or the ids are fewer or more than the files). Without `-ExpectedApproverKeyId` at all the script stops with exit 2 (`-ExpectedApproverKeyId is required with -ApproverKeyFile`) before it reads anything. The words: `record_not_canonical` (any byte differs from the canonical text: a line break, a space, another order), `record_fields` (an extra or missing field), `record_key_id_mismatch` (the id is not the hash of the key), `record_curve` / `record_point_not_on_curve` / `record_rsa_size` / `record_rsa_exponent` (the key), `record_credential_id_form` / `record_credential_id_length`, `approver_keys_too_many` (over 16), `approver_keys_duplicate_*` | Nothing was changed. If the ids differ from the ones `enroll` printed, stop: someone replaced the file. Otherwise make the file again with `enroll --webauthn` |
| set-approver: `REFUSED: the approver key list is refused: already registered: <keyId>`, `N keys would be in force, at most 16`, `the Authority key store is there but cannot be used (...)`, `the legacy approver key ... is not a valid hello-rsa record` | An add (no `-Replace`) cannot be worked out safely: the key is in force already, the list would be over 16, the store that decides what is in force is unusable (untrusted, not valid, a link), or the legacy pair cannot be carried into `approverKeys` | Nothing was changed. Read `-Mode status` to see what is in force. To start over from exactly the keys you give, use `-Replace` with the complete list. A store you do not trust is a thing to look at, not to skip |
| set-approver: `REFUSED: the Authority config differs from what install writes in: ...` or `... is not valid (...)`, `approver-keys.json is a folder (or a link to one)`, `the service ... runs a different command line than install wrote` | The install was changed by hand, or is not one this script made | Nothing was changed. Inspect it; a hand-edited install is repaired by uninstall and install |
| set-approver: `REFUSED: set-approver asks you to type yes after it prints the final key list, and this console cannot be typed in` / `REFUSED: not confirmed: yes was not typed` / `REFUSED: -LabAssumeYes is lab-only` (exit 3, and exit 2 for the flag) | The console's input or output is redirected, or it is not interactive; or the answer was not exactly `yes`; or `-LabAssumeYes` was given outside the lab VM | Nothing was changed. Run the script in an elevated console window and type `yes`. There is no flag that skips the question on a real PC |
| set-approver: `AlberaApprovalAuthority did not start with the new approver key list, so the OLD config is back` | The Authority refused the new config (the installed build does not read `approverKeys` yet, or a limit differs), or something kept it from starting | The old config AND the old key store (the same bytes) are in force again (read the lines above the error: they say whether the service runs). Install a build that has the key list (uninstall, then install), then run set-approver again |
| set-approver: `the key store could NOT be put back as it was (...)` and `AlberaApprovalAuthority stays STOPPED` | The rollback could not write the old key store back (a tool failed, the folder is not trusted) | The service is left stopped on purpose. Read `-Mode status`, then run set-approver again with `-Replace` and the COMPLETE list of keys you want, or repair the file and start the service by hand |
| A service does not start, or stops again: a `Start-Service` error, `-StartCheck` saying `did not stay running` | See the steps below the table | See the steps below the table |
| "Open ALBERA" says `the service AlberaControlPlane is Stopped` or `the port named in ui\room.json is not held by the ALBERA process` | Delayed start has not run yet (it waits after Windows starts), or the host is restarting | `Start-Service AlberaControlPlane`, wait a few seconds and try again. If it stays down, see below |
| setup: `REFUSED setup_location` | Install mode runs only from `C:\Program Files\Albera\bin\setup`, with only administrators able to write there and no link on the path | "First install", step 2 |
| setup: `REFUSED update_missing`, `update_folder_missing` or `bundle_missing` | The `--update` folder is not a complete `albera-update` (wrong path, half unzipped, or the artifact expired after 14 days) | Download and unzip it again |
| setup: `REFUSED tree_hash_mismatch`, `tree_hash_inconsistent`, or a verification refusal from gh | The copies are not the attested build: a file was changed, added or removed | Do not install it. Download again; if it repeats on a fresh download, stop and tell the developer |
| setup: `REFUSED rollback_refused` | The build is older than the install record, the floor on this PC or the setup.exe itself | Use a newer run. The same run id is allowed |
| setup: `ENGINE_EXIT 5` | A complete install met with a different build | "Update" |
| setup: `ENGINE_EXIT 1`, `2` or `3` with an `ERROR:` or `REFUSED:` line above it | The installer script stopped; the line above says why | Read it, run `-Mode status`, then run the same command again (it continues) or uninstall |
| `... exists but was not created by this script` (for example `C:\ProgramData\Albera`) | Users can create folders in `C:\ProgramData`, so the script never adopts one it did not make. (`C:\Program Files\Albera` is adopted only when it holds nothing but setup's `bin\setup` and `setup-work`) | Inspect it, delete it as an administrator, run again |
| uninstall: `is still marked for deletion` | A tool (services.msc, Event Viewer) holds the service | Close them and run uninstall again |
| The approval window never appears, or `presence_signer_unavailable` | The tray is not running (it starts at sign-in and exits quietly for any account that is not the approver), the Authority is stopped, or you are on Remote Desktop, where Windows Hello key credentials are not available | Start the services and the tray (`AlberaApprover.exe --tray`), and approve at the PC itself |

**A service does not start.**

1. `sc.exe query <name>` shows `STATE`. For `AlberaControlPlane`, `WIN32_EXIT_CODE : 1066` means `SERVICE_EXIT_CODE` is the host's own code.
2. The Control Plane host's codes: 73 config rejected (`SERVICE_CONFIG=invalid:<reason>`), 74 not started by the SCM, 75 unexpected failure, 77 the Node child ended more often than the restart limit allows, 78 node.exe or the app tree refused (missing, hash differs, writable by others), 79 the Job object could not be created. The Broker and the Authority: 73 config or folder, 77 and 78 signing key, 79 policy.
3. Read `C:\ProgramData\Albera\control-plane\logs\host.log` (administrators can read it): `CPHOST_READY`, `CPHOST_CHILD_STARTED`, `CPHOST_CHILD_EXITED=<code>`, `CPHOST_RESTART=<n>/<max>`, `CPHOST_FATAL=<reason>`.
4. `-Mode status` names a changed pin or config (for example `node.exe pin: missing or changed since install`). A changed pin means uninstall, then install: install does not refresh pins.
5. After two automatic restarts, 5 s apart, the Control Plane stays stopped; start it by hand once the cause is fixed.
6. The Control Plane has no service dependency on the other two. Until the Broker and the Authority run, the room answers `broker_unavailable`.

## Running the script yourself (uninstall, status, migrate, plan; an install without setup)

Setup covers the install. Everything else runs `albera-host.ps1` directly, from a checkout of the reviewed commit or from `<update>\repo\scripts\host\` of the update folder you installed from.

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1                                    # plan: numbered steps, changes nothing, no admin needed while nothing is installed
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode install -ExpectedTreeHash <64 hex> -ApproverKeyId hello-... -ApproverPublicKey <spki> -ApproverSid S-1-5-21-...   # elevated console of YOUR account
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode status
Start-Service AlberaHostBroker; Start-Service AlberaApprovalAuthority; Start-Service AlberaControlPlane             # when ready
```

With WebAuthn key record files instead of the three Hello values (a direct run only: `albera-setup.exe` does not pass them yet), the install line takes `-ApproverKeyFile <record.json>[,<record.json>...] -ExpectedApproverKeyId <id>[,<id>...] -ApproverSid S-1-5-21-...` (one expected id per file, in order; required) in place of `-ApproverKeyId` and `-ApproverPublicKey`; see "Changing the approver keys" for the record rules.

Before a direct install (all in a NORMAL console of your account, so nothing from the repository runs elevated): `npm run build:windows-broker`, `npm run build:approval-authority`, `npm run build:control-plane`, `npm run build:approver`, and your three approver values from `AlberaApprover.exe enroll --show`. The script checks them (key id grammar, RSA-2048 SPKI, an S-1-5-21 user SID) and never starts the approver program. Start every command as shown, with the full path of `powershell.exe` (`cmd.exe` prefers a `powershell.exe` in the current folder, so a bare `powershell` can be someone else's program). `-NoProfile` skips profiles only; it does **not** keep user modules out: Windows PowerShell 5.1 searches `~\Documents\WindowsPowerShell\Modules` and `HKCU\Environment` `PSModulePath` before its own folder, and loads `CimCmdlets`, `LocalAccounts`, `Security`, `Utility` and `Management` lazily on first use (a fake `CimCmdlets` returning "HIJACKED" was reproduced). So the script protects itself: its first statements turn auto-loading off, reset `PSModulePath` to `$PSHOME\Modules` and import those five modules by the full path of their manifests, and it refuses unless `$PSHOME` is `C:\Windows\System32\WindowsPowerShell\v1.0` (a 32-bit PowerShell is refused). Install, uninstall and migrate refuse unless the console is elevated and never elevate themselves. Re-running a completed install checks it and changes nothing. `-StartCheck` starts each installed service once and stops it again (the only real test of the Broker and Authority configs; setup does not pass it).

### The elevated console: clean environment, copied script (required for direct runs)

An agent in your session can prepare the elevated console before the script's first line runs: `HKCU\Environment` values reach every new process, elevated or not (`COR_ENABLE_PROFILING` + `COR_PROFILER` + `COR_PROFILER_PATH` load any DLL into `powershell.exe` as it starts), and `HKCU\Software\Microsoft\Command Processor` `AutoRun` runs a command in every `cmd.exe` that starts without `/d`. And the script files sit in a tree it can rewrite, also between a hash check and the moment PowerShell reads them. So a direct install, uninstall, migrate or status is run only like this (every step, in this order). Setup does steps 2 to 4 for you (it rebuilds the environment and runs a verified copy), which is why the install above does not need them.

1. Open the console: Win+R, type `cmd /d`, press **Ctrl+Shift+Enter** (elevated, AutoRun skipped). Run everything below in that window. If no elevation prompt appears (it did not on the owner's PC on 2026-11-03), open Task Manager, Run new task, tick "Create this task with administrative privileges" and type `cmd /d` there.
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
   (`-Mode uninstall`, `-Mode status` and `-Mode migrate ...` the same way.)
5. Afterwards: `rmdir /S /Q "C:\Program Files\AlberaSetup"`.

The `script albera-host.ps1 sha256 ...` lines that install, uninstall and migrate print are information only: a replaced script can print anything, so they detect nothing. **Residual limit, stated plainly:** the comparisons are by you and by eye; `cmd.exe`, `certutil.exe`, `reg.exe` and the Run dialog are trusted as part of Windows; an attacker who is already an administrator is out of scope. The CI hashes cover the line endings the repository checks out (`.gitattributes`: `eol=lf`).

### Where `-ExpectedTreeHash` comes from (direct runs only)

Setup does not need this: it reads `treeHash` from the attested `build-hashes.json` and checks it against the copies. A direct run takes **one value that you type** (`-ExpectedTreeHash <64 lowercase hex>`), because the builds live in a working tree that a non-admin process (an agent running as you) can rewrite, together with their sidecar `.manifest.json` files and any hash file you keep next to them (Downloads included). A hash computed from that tree proves nothing, and so does a file. Take the value from the log of a CI run of the reviewed commit:

1. On github.com, Actions, workflow **Host build hashes**, Run workflow **on the branch `main`** (it runs only when you start it, and its jobs refuse any other branch; Windows minutes cost money). It builds on a clean runner (`npm run build:windows-broker`, `npm run build:approval-authority`, `npm run build:control-plane`, `npm run build:approver`) and runs `scripts/host/albera-host.ps1 -Mode hashes`.
2. Open the run on github.com. **Check two things on the run page before you read a hash:** the branch badge under the run title says `main`, and the commit SHA shown there (also printed as `commit=` and `ref=` in the log) equals the merge commit you reviewed (the merge commit of PR #148 when this check was first written). Then read the line `ALBERA_HOST_TREE_HASH=<hex>` in the log (also in the run summary). The per-file JSON is attached as the artifact `build-hashes` for diagnosis; a direct install does not read it. **A branch can edit the workflow file it runs from, including the `main` condition, so that check of branch + SHA by you is the real control; the condition is only a guard against a mistaken dispatch.**
3. Build locally in a normal console, then pass the value: `-ExpectedTreeHash <hex>`.

**The format** (one function, `Get-CanonicalTreeHash`, used by `-Mode hashes` and by install): for each component in the fixed order `broker`, `authority`, `pipe-client`, `control-plane`, `approver`, and inside it for each published file sorted by ordinal comparison of its relative path (written with `/`), one line `<component>/<relative path> TAB <SHA-256 of the file, 64 lowercase hex> LF` (TAB 0x09, LF 0x0A, no BOM, no other whitespace). The tree hash is the lowercase hex SHA-256 of the UTF-8 bytes of all lines concatenated. A file renamed, moved to another component, added, dropped or changed gives another value. Install computes it over the **copies** in the administrator-only `bin` folder and refuses (deleting the copies) unless it equals the given value.

**Limit, stated plainly:** the value only matches if the build is reproducible across machines (the runner's .NET SDK, the NuGet restore and the paths must give byte-identical output). The builds are self-contained, so the .NET SDK decides the runtime files, the apphost and the compiler output: the build scripts refuse any SDK but `HOST_BUILD_SDK` in `scripts/dotnet-build-env.mjs` (10.0.403), and the workflow installs exactly that one. **Measured 2026-11-02 on `main` 86ade4c (three components):** with SDK 10.0.302 here every exe differed from the runner; after installing 10.0.403 here (`winget install --id Microsoft.DotNet.SDK.10 --version 10.0.403`), the tree hash and both script hashes here equalled the Host build hashes run. Not measured for the five components. A mismatch is still the safe outcome (nothing is installed); the per-file JSON artifact against `-Mode hashes` on this PC shows which files differ. Running `-Mode hashes` on your own PC and typing its value defeats the check (the lab hook does exactly that, labelled lab-only).

### Checking a build with `gh attestation verify` (extra check)

Each Host build hashes run on `main` signs a GitHub artifact attestation (SLSA build provenance, `actions/attest-build-provenance`) for twelve files: the five exe files, `control-plane-app-hashes.json`, `albera-host.ps1`, `albera-host-lib.ps1`, `build-hashes.json`, `albera-setup.exe`, `gh.exe` and `trusted_root.jsonl`. It says "a file with exactly these bytes was produced by `.github/workflows/host-build-hashes.yml` in BERORINPO/albera at commit X on ref Y", signed with a short-lived Sigstore certificate. `albera-setup.exe` verifies all of them itself, offline, with its bundled `gh.exe` (`--bundle`, `--custom-trusted-root`, this repository, this workflow at `refs/heads/main`, no self-hosted runners). Checking one file by hand, for example the `albera-setup.exe` you are about to put into `bin\setup`:

```
gh attestation verify <file> --repo BERORINPO/albera --signer-workflow BERORINPO/albera/.github/workflows/host-build-hashes.yml --deny-self-hosted-runners
```

It must say `Verification succeeded`, and the commit and ref it prints must be the reviewed merge commit and `refs/heads/main` (`--signer-workflow` pins the workflow, not the branch; `--cert-identity https://github.com/BERORINPO/albera/.github/workflows/host-build-hashes.yml@refs/heads/main` in its place pins both). Check the script copies in `C:\Program Files\AlberaSetup` and `build-hashes.json` from the run's `build-hashes` artifact: its `treeHash` is the value for `-ExpectedTreeHash`, and its per-file list covers the DLLs. An exe alone proves little, because the builds are self-contained and not single-file: the exe is the .NET apphost launcher and the code is in the DLLs next to it.

What it does **not** do, stated plainly:

- **It is not Windows code signing.** The files carry no Authenticode signature, so UAC and SmartScreen still show an unknown publisher, and Windows itself checks nothing.
- **It does not replace `-ExpectedTreeHash` yet.** The installer does not read attestations: the script trusts only the value you type, or the one setup hands it. Only `albera-setup.exe` reads attestations, and on the setup path its own check is the one that counts; a `gh` you run by hand proves nothing to the script.
- **It does not make `gh` trusted.** `gh.exe` and its configuration live in your profile, which an agent in your session can change, so a `Verification succeeded` printed there is a second opinion, not the control. The control is setup's bundled `gh.exe` (pinned by hash) or your own check of branch and SHA on the run page.
- **It says where a file came from, not that the code is safe.** A reviewed-but-wrong commit on `main` gets a valid attestation too.

## Trust model (what a non-admin agent cannot do through this script)

Attacker: an AI agent in your non-admin session. It can pre-create `C:\ProgramData\Albera` (Users may create there), plant a manifest or a junction in it, and rewrite every file in the repository tree (builds, sidecar manifests, even this script's folder).

| Attack | What the script does |
|---|---|
| Plants `install-manifest.json` (valid shape) and makes `control-plane` a junction to another vendor's SYSTEM service folder | Nothing existing is trusted: `C:\ProgramData\Albera` and the manifest must be owned by SYSTEM or Administrators, protected, writable by no one else, and reached through no link (the path and every parent are checked by attribute, nothing is followed). Otherwise install and uninstall stop with "delete it as an administrator". Every planned folder gets the same check before any ACL is touched, and `icacls` runs with `/L` |
| A pre-existing `albera.approval.json` or config (even identical) | Must pass the same checks, and is then overwritten, never skipped |
| Forges the record (`created.user`, another service, key or folder) | The manifest shape allows only the three service names, the one key name and no other entry. The legacy account is removed only if its name is exactly `albera-cp`, its description is the one the old install set, and its SID is the recorded one |
| Replaces a build and its sidecar `.manifest.json`, or the hash file next to it | The script never reads a sidecar and takes no hash file. The build is copied into the already administrator-only `bin` folder and the tree hash of the **copies** must equal the attested value (setup) or the value you typed |
| Makes the elevated script run its program | The only programs started are `sc.exe` and `icacls.exe`, by full path (a test pins this), plus ONE exception: `launch-check` of the INSTALLED Control Plane host (the hash-verified copy in the administrator-only `bin` folder, with a minimal environment), which must answer 0 before the service is registered. With `-Mode migrate -TrustLocalBuilds` that copy is a copy of a local build with no provenance (decision D7). Nothing is found through PATH |
| Sets `SystemRoot`, `ProgramFiles` or `ProgramData` in `HKCU\Environment` (an elevated console started from that session inherits it) | No environment variable decides a path. `sc.exe`, `icacls.exe` and the install roots come from `[Environment]::SystemDirectory` / `GetFolderPath`, and the script refuses unless they are `C:\Windows\System32`, `C:\Program Files` and `C:\ProgramData` |
| Puts a fake module (`CimCmdlets`, `LocalAccounts`, ...) in `~\Documents\WindowsPowerShell\Modules` or `HKCU\Environment` `PSModulePath` | The script's first statements disable module auto-loading, reset `PSModulePath` to `C:\Windows\System32\WindowsPowerShell\v1.0\Modules` and import the five system modules by manifest path (a test runs the script with a fake `CimCmdlets` first in `PSModulePath` and asserts it is never loaded) |
| Races a folder between creation and `icacls` | Folders are created with their final owner and protected DACL in one call, and every creation is read back (owner, protected, exact accounts, no link) and re-checked with the installer's trust test before any later step; `DirectoryInfo.Create` succeeds silently on a folder someone made a moment earlier, which the read-back catches. An existing folder's DACL is written with .NET (icacls cannot look up a service SID that is not registered yet) |
| Swaps `node.exe` or `claude.exe` before the copy | `node.exe` and its folder must pass the trust test (owner, writers, no link). `claude.exe` lives in your own profile, where you and anything running as you can write by design, so its only protection is that the copy is made from one open handle and hashed; its trust is your PC at the moment of the copy (`control-plane-service.md`, section 8) |
| Replays an old, validly attested build, also after an uninstall | The bound is the largest of the install record, `HKLM\SOFTWARE\Albera\SetupRunIdFloor` (kept by uninstall; a floor that is not a decimal number refuses) and the run id compiled into `albera-setup.exe`; the script and setup both check it |
| Plants or swaps a key record file (`%LOCALAPPDATA%\Albera\approver-keys\<keyId>.json`, which its own session can write) so that the next `set-approver` registers the agent's key | The file is read once through one handle (final path checked, no link), must be exactly one canonical record whose `keyId` is the hash of its key, and its key id and kind are printed; `-ExpectedApproverKeyId` is required: the id typed from the screen that created the key, one per file in order, is compared with the id the script computes from each file's public key, and a file that holds any other key (a swapped, perfectly valid record included) is refused before anything changes. The run does not depend on anybody comparing printed ids; what it still trusts is the id you read off your own screen |
| Makes a `set-approver` fail on purpose (squats the Authority's pipe name while the service is stopped, so the start fails and the rollback runs) to bring a removed key back from the old config | The rollback never deletes the key store for good: it writes back the exact bytes it read before it changed anything (a removed key stays removed), or, when there was no store, restores only the config and deletes what a failed start made. A store it cannot put back keeps the service stopped |
| Runs `set-approver` from a process it controls (no console) or answers its question itself | The run needs a console a person can type in: redirected input or output, or a non-interactive console, is refused before the service is touched, and only the typed word `yes` goes on. `-LabAssumeYes` is refused unless `ALBERA_LAB_VM` is 1, and that variable alone changes nothing: the flag itself has to be on the command line of the elevated run, which only you type |
| Reads the token | It is a DPAPI blob in `secrets\`, readable by the Control Plane service only (not by you, not by another virtual account) |

Not covered: an attacker who is already an administrator; a wrong `-ExpectedTreeHash` (typed from something other than the CI log of `main`); the script files being edited between your check and the run (see the clean console above).

## VM lab hook (lab only)

`-NodeSource`, `-ClaudeSource` (a node.exe and a claude.exe from elsewhere) and `-VmId` are refused unless the environment variable `ALBERA_LAB_VM` is `1` (the lab driver sets it inside the disposable VM; never set it on a real PC). There is no account and no password any more. The approver values are passed as the normal parameters (a throw-away public key in place of Hello). `test/windows-service-lab/lab-host-install-check.ps1 -HostScriptDir <folder with albera-host*.ps1> -RepoRoot <folder with the build outputs>` (also run by `lab-vm.ps1 -HostInstall`) computes the `-ExpectedTreeHash` in the guest from the very folders it copied (LAB ONLY: that proves nothing about provenance, it only exercises the path), then runs, as Administrator: install with `-StartCheck`, status, a second install (must say "already complete", leave the manifest byte-identical, and refuse an older `-SetupRunId`), uninstall, and a final status; a second pass repeats it with the Hyper-V grant. It prints one JSON evidence object and exits 1 unless everything passed. It refuses to run if either Albera folder already exists. The lab needs free memory on the host (see "When it stops").

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\windows-service-lab\lab-vm.ps1 -Build -HostInstall -HostNodeExe "C:\Program Files\nodejs\node.exe"
```

**Migration lab.** `lab-vm.ps1 -HostMigrate -LegacyRef <commit>` (hook: `lab-host-migrate-check.ps1`, run in the guest) tests `-Mode migrate`. The driver builds the old Broker, Authority and pipe client from the tree of `<commit>` (`git archive` into the VM's folder, the commit's own build scripts, restore from the NuGet cache, nothing downloaded; the copy is removed afterwards) and copies them and the current five builds into the guest. The hook then: makes a first-layout install with the OLD installer (`-ControlPlanePassword`, a lab-made password that is never printed, and the Hyper-V grant with a fixed VM GUID); starts `cmd.exe /c exit 0` once as `albera-cp` the way `runas` does (`Start-Process -Credential -LoadUserProfile`), so that `C:\Users\albera-cp` exists and is not loaded; runs `-Mode plan -PlanFor migrate -TrustLocalBuilds` (nothing changes), `-Mode migrate -TrustLocalBuilds`, starts each service once and stops it, `-Mode status` and `-Mode uninstall`. It checks, with Windows' own tools: the approver key id, public key and SID, the VM GUID, the computer id, the project id and the grant choice are the old ones; the Authority key is a new one; `albera-cp`, its folder and its `Win32_UserProfile` entry are gone; the three services are `Auto` with delayed start and the Control Plane's account is `NT SERVICE\AlberaControlPlane` (restricted SID type, `SeChangeNotifyPrivilege` only, and both configs name its service SID); the Broker's SID, and nobody else, is in Hyper-V Administrators and leaves it again at uninstall; nothing is left behind. It prints one JSON evidence object (`host-migrate-results.json` in the evidence folder) and exits 1 unless every check passed.

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\windows-service-lab\lab-vm.ps1 -HostMigrate -LegacyRef 303ec40
```

`albera-cp`'s profile is made by a `runas`-style start on purpose: a scheduled task or a service also makes the profile, but Windows then keeps it loaded after the task or service has ended (measured in this lab), and a loaded profile cannot be deleted. If that ever happens on a real PC, migrate says "WARNING: the profile ... could not be removed" and leaves the folder; delete it after a restart.

## Not verified

- **Verified in the disposable VM, not on your PC.** `lab-vm.ps1 -Build -HostInstall` (PR #190, scripts at a2b6ada and ab27e90): the whole hook passed, with the Control Plane checks 16/16 and the Hyper-V grant checks 18/18. Its first run stopped at `icacls` exit 1332 for the service SID of a service not registered yet; fixed by writing the DACL with .NET. The lab used its own node.exe and a stand-in claude.exe (never run) and ran the script directly, not through setup. Whether `room-service` stays up under the service identity is a lab measurement (M4), not a pass criterion of the hook.
- **Migration, lab limits.** `-Mode migrate` ran in the VM (`-HostMigrate`, 34 of 34), with these gaps: no process of `albera-cp` was alive (a process started as another user in a PowerShell Direct session has no desktop and ends at once), so "stop by PID" is covered by fakes only; the old Control Plane itself (node and the room) was not run; the VM GUID was a fixed lab value (the lookup by name is not exercised); the Hello key was a throw-away public key; `-TrustLocalBuilds` hashed the copies in the guest, so provenance is not shown; the three services each started once and ran (the Broker too, although the guest has no Hyper-V role), which says nothing about a real job.
- **Not run anywhere:** setup's install mode end to end; `-Mode migrate` on a real PC; the Host build hashes workflow since PR #190 (it now builds the Control Plane host and the approver and attests 12 files; the last run, 41644370640, is older, so the five-component tree hash and the new attested set have never come out of CI); the Control Plane service on a real PC with the real `claude.exe`, DPAPI and the Broker; the approval window with a real Windows Hello (M14); the tray started from the HKLM Run entry; the "ALBERA update" shortcut.
- **`-Mode set-approver` and the key-file form of install and migrate** run in the tests with fakes (the service control manager, the trusted write) and have a lab-hook step; neither has run against a real Authority SERVICE. They have run against the phase 2 Authority's own code in a temp layout (`test/host-install-authority.test.mjs`, test-faults build, no admin, never the installed service): the config this script writes is accepted by the Authority's own reader (`service-check`), a table of config texts gets the same accept or refuse from both sides (the script may only be stricter: RSA exponent other than 65537, 2047-bit and even-modulus keys; never weaker), and a key store written by the Authority's serve loop (seeded, after an approval, after `key_remove`, from a legacy pair) is read by this script's store reader and a removed key is not brought back by an add. The limits the script mirrors (16 keys, config and store 32768 bytes, the `keys` reply metadata 1900 bytes, store revision at least 1) are compared with the Authority's C# source by a test, so a change on either side fails it. Still open: the Authority service started by the SCM on a real PC (the lab hook's set-approver step, which passes `-LabAssumeYes` because the VM has no console), the store's owner check against a file the real service wrote (the Authority's service SID as owner, which the temp layout cannot produce), and the rollback's `icacls /setowner` on a real store file (the tests stand in for `icacls`; the bytes written and read back are real). The typed `yes` was tested with a stand-in for the console (the real console check is run once, on a process with piped input and output, and says no).
- **`service-check` is not run at all.** The shipped Broker and Authority trust a config file only when the process token carries the per-service SID (`ServicePathGuard`), so from an elevated console it always answers `SERVICE_CONFIG=invalid:config_untrusted` before it looks at the content, and it would start a build while elevated. The script validates those two configs with its own mirror of the C# rules (a test compares the key sets with the C# parsers) and relies on the first start of each service (`-StartCheck`, or your `Start-Service`) as the real test. For the Control Plane it runs `launch-check` of the installed host once before the service is registered.
- A restricted-SID service token opening the machine key (the Authority guard accepts the DACL; opening under that token is lab-only, as `approval-authority.md` says). The Authority guard against this key, and the Broker, the Authority and the Control Plane starting together under delayed start on the owner's PC.
- Windows Hello provenance: the enrolled key is `NotSupported` for attestation on this PC (`approver-app.md`), so the "Hello provenance" precondition in `approval-authority.md` stays open. The script cannot prove the three approver values you pass came from your own `enroll`; compare them with what you saw.
- Whether the parent folder rule holds on this PC: `C:\ProgramData` lets Users create folders, so the script refuses a pre-existing `C:\ProgramData\Albera` and creates it itself, born with its final ACL. That creation call and the trust read-backs on a real administrator-owned tree have been exercised on user-owned temp folders, synthetic ACL summaries and the disposable VM.
- Whether the node source check passes on a real PC: the same lib function judged `C:\Program Files\nodejs` as `trusted` on the owner's PC after PR #191 (read only); no install ran there.
