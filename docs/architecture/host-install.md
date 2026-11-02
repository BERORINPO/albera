# Host install: the Broker and the Approval Authority on the owner's PC

**Status: written, NOT RUN.** `scripts/host/albera-host.ps1` was run in plan mode and its logic was tested with fakes and a temp folder (`test/host-install.test.mjs`). No install, service, account, ACL or machine key was ever created by it, and the disposable-VM run (`test/windows-service-lab/lab-host-install-check.ps1`) has not happened. Treat the first real run as the first run.

Goal: put the two services on the owner's PC so the first real Windows Hello approval can happen (`approver-app.md`, steps 4 to 8). Related: `approval-authority.md` ("Needs the VM lab or the owner", "Preconditions before production"), `approval-tiers.md` ("Room start approval").

## What it installs

| Object | Where | Notes |
|---|---|---|
| Builds of the Broker, the Authority and the pipe client helper | `C:\Program Files\Albera\bin\{broker,authority,pipe-client}` | copied from the publish outputs (`npm run build:windows-broker`, `npm run build:approval-authority`) into the administrator-only `bin` folder FIRST; then the COPIES of all three are hashed and their one tree hash must equal the `-ExpectedTreeHash` you typed (any missing, extra, moved or changed file deletes all copies and stops). The exe SHA-256 and a folder hash of each go into the manifest |
| Services `AlberaHostBroker`, `AlberaApprovalAuthority` | SCM | exactly as `lab-guest.ps1`: own process, `obj= "NT SERVICE\<name>"`, `sc sidtype restricted`, `sc privs SeChangeNotifyPrivilege`, `start= demand`. The Broker's service ACL gives SYSTEM and Administrators everything and the Control Plane account only `LC` (SERVICE_QUERY_STATUS, 0x4). **Install does not start them.** |
| Data folders | `C:\ProgramData\Albera\{broker-config,broker,authority,control-plane}` | inheritance removed; SYSTEM and Administrators full. Broker SID: read on `broker-config`, Modify on `broker` (its journal). Authority SID: Modify on `authority` (its config and `policy.json`). Control Plane account: Modify on `control-plane`. The root gives each of the three read on that one folder only |
| Authority signing key `AlberaApprovalAuthority-host-1` | machine key store (Software KSP) | ECDSA P-256, Export Policy none, DACL SYSTEM, Administrators and the Authority's service SID only; read back from a fresh open and checked like the Authority's start-up guard; one sign/verify round trip; only the public key (SPKI) is exported, into the Broker config |
| Local user `albera-cp` | SAM | standard user (BUILTIN\Users only). You type the password at install time |
| Broker config, Authority config | `broker-config\AlberaHostBroker.service.json`, `authority\AlberaApprovalAuthority.service.json` | key sets read from the C# parsers (a test compares them); `policyVersion` is the same in both; kid `albera-authority-1`, audience `albera-host-broker`, lease `albera-host-lease-1`, generation 1, `signingKeyProvider` `software` |
| Control Plane settings | `control-plane\albera.approval.json` | `examples/albera.approval.example.json` with `attestation: null`; one computer (`-VmName`, `-ComputerId`, default `albera-clone-01` -> `clone-01`, only `approval-check` reads the first one). Journal path `control-plane\operations.sqlite` |
| `C:\ProgramData\Albera\install-manifest.json` | | lists exactly what the script created; uninstall removes only that |

No `policy.json` is written, so the Authority starts at tier `careful`: a person approves every action.

## Run it (you, elevated)

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1                                    # plan: numbered steps, changes nothing, no admin needed
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode install -ExpectedTreeHash <64 hex> -ApproverKeyId hello-... -ApproverPublicKey <spki> -ApproverSid S-1-5-21-...   # elevated console of YOUR account
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode status
Start-Service AlberaHostBroker; Start-Service AlberaApprovalAuthority             # when ready
```

Before install (all in a NORMAL console of your account, so nothing from the repository runs elevated): `npm run build:windows-broker`, `npm run build:approval-authority`, `npm run build:approver`; `AlberaApprover.exe enroll --show` prints the three public values to pass as `-ApproverKeyId`, `-ApproverPublicKey`, `-ApproverSid` (they must equal what your own first `enroll` printed; `enroll` + `enroll --check` were done 2026-10-31). The script checks them (key id grammar, RSA-2048 SPKI, an S-1-5-21 user SID that is not `albera-cp`'s) and never starts the approver program. Start every command as shown (`powershell -NoProfile -ExecutionPolicy Bypass -File ...`): without `-NoProfile`, profiles and user modules load even in an elevated console. Install refuses unless the console is elevated and never elevates itself. Re-running a completed install checks it and changes nothing; a partial install continues from where it stopped, or stops with the reason (anything that exists and is not in the manifest is never adopted). `-StartCheck` starts each installed service once and stops it again (the only real test of the configs, see below).

### Where `-ExpectedTreeHash` comes from (read this)

The builds live in the working tree, which a non-admin process (an agent running as you) can rewrite, together with their sidecar `.manifest.json` files and any hash file you keep next to them (Downloads included). A hash computed from that tree proves nothing, and so does a file: so install takes **one value that you type** (`-ExpectedTreeHash <64 lowercase hex>`) from the log of a CI run of the reviewed commit:

1. On github.com, Actions, workflow **Host build hashes**, Run workflow on the reviewed commit (it runs only when you start it; Windows minutes cost money). It builds on a clean runner (`npm run build:windows-broker`, `npm run build:approval-authority`) and runs `powershell -NoProfile -File scripts/host/albera-host.ps1 -Mode hashes`.
2. Read the line `ALBERA_HOST_TREE_HASH=<hex>` in that run's log (also in the run summary) and check the run is for the commit you reviewed. The per-file JSON is attached as the artifact `build-hashes` for diagnosis; install does not read it.
3. Build locally in a normal console, then pass the value to install: `-ExpectedTreeHash <hex>`.

**The format** (one function, `Get-CanonicalTreeHash`, used by `-Mode hashes` and by install): for each component in the fixed order `broker`, `authority`, `pipe-client`, and inside it for each published file sorted by ordinal comparison of its relative path (written with `/`), one line `<component>/<relative path> TAB <SHA-256 of the file, 64 lowercase hex> LF` (TAB 0x09, LF 0x0A, no BOM, no other whitespace). The tree hash is the lowercase hex SHA-256 of the UTF-8 bytes of all lines concatenated. A file renamed, moved to another component, added, dropped or changed gives another value. Install computes it over the **copies** in the administrator-only `bin` folder and refuses (deleting the copies) unless it equals the typed value.

**Limit, stated plainly:** the value only matches if the build is reproducible across machines (the runner's .NET SDK, the NuGet restore and the paths must give byte-identical output). `scripts/check-reproducible-build.mjs` checks two builds on one machine; **a build on the runner and a build on this PC being identical is not proven yet.** Until it is, a mismatch is the expected safe outcome (nothing is installed) and not evidence of tampering; the per-file JSON artifact against `-Mode hashes` on this PC shows which files differ. Running `-Mode hashes` on your own PC and typing its value defeats the check (the lab hook does exactly that, labelled lab-only). Run the script itself from a reviewed checkout, not from a tree an agent edits.

## First approval (`approver-app.md` steps 6 and 7)

`albera-runtime approval-check` sends ONE `broker.operation` / `synthetic.noop` (the Broker only records the claim; nothing moves) through fence, submit, wait, claim, and prints the approval id. Only the Control Plane account can reach the two submit pipes, so run it as `albera-cp`:

1. As `albera-cp` (for example `runas /user:.\albera-cp powershell.exe`, then in that window): `node <repo>\src\runtime\entry.mjs approval-check --approval C:\ProgramData\Albera\control-plane\albera.approval.json --helper "C:\Program Files\Albera\bin\pipe-client\albera-windows-broker-pipe-client.exe"`. It prints `approvalId: <uuid>` and waits (the request lasts 120 s).
2. In your own normal console: `AlberaApprover.exe list` (check the fields and `digest check: OK`), then `AlberaApprover.exe approve <approvalId>`, type `yes`, verify with Hello. The first window ends with `status: claimed` and exit 0.

`albera-cp` must be able to read `node.exe` and your checkout; the installer grants it nothing there.

## The Control Plane account (PROVISIONAL)

The Authority refuses one SID for both pipes (`sids_not_distinct`), and the approver SID is your own account, so the Control Plane cannot be you. Decision (`2026-11-02+host-install` in `spec/architecture.md`): a dedicated local standard user `albera-cp`, created by the script, password typed by you, never stored. Its SID is `controlPlaneSid` in both configs. Rejected: a virtual service account (nothing runs the Control Plane as a service yet); a second administrator (a bigger target than needed); adding `albera-cp` to Hyper-V Administrators (see below).

**Known consequence, not solved here:** the gated `room` uses the same-user Hyper-V prototype, which needs Hyper-V Administrators. Running `room` as `albera-cp` therefore does not work until that is decided (a privileged Broker for Hyper-V, or another identity). `approval-check` does not need Hyper-V. This is why the account choice stays provisional.

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
| Races a folder between creation and `icacls` | Folders are created with their final owner and protected DACL in one call, and every creation is read back (owner, protected, exact accounts, no link) and re-checked with the installer's trust test before any later step; `DirectoryInfo.Create` succeeds silently on a folder someone made a moment earlier, which the read-back catches |

Not covered: an attacker who is already an administrator; a wrong `-ExpectedTreeHash` (typed from something other than the CI log); the script itself being edited before you run it.

## Uninstall

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 -Mode uninstall` (elevated; `-Mode plan -PlanFor uninstall` first). It stops and deletes the two services (a service whose command line is not the one it wrote is left alone), deletes the machine key, removes the install folder and the data folders, removes `albera-cp` (only if the manifest says it created it and the SID still matches; its profile folder, if it ever logged in, stays), and last the manifest and the data root. A folder that holds a file the script does not know, or a link/junction, is not deleted. This deletes the Broker journal and the Control Plane journal.

To update a build: uninstall, rebuild, install (an existing copy that differs is refused).

## VM lab hook (lab only)

`-ControlPlanePassword <SecureString>` makes install non-interactive and is refused unless the environment variable `ALBERA_LAB_VM` is `1` (the lab driver sets it inside the disposable VM; never set it on a real PC). The approver values are passed as the normal parameters (a throw-away public key in place of Hello). `test/windows-service-lab/lab-host-install-check.ps1 -HostScriptDir <folder with albera-host*.ps1> -RepoRoot <folder with the build outputs>` (also run by `lab-vm.ps1 -HostInstall`) computes the `-ExpectedTreeHash` in the guest from the very folders it copied (LAB ONLY: that proves nothing about provenance, it only exercises the path), then runs, as Administrator: install with `-StartCheck`, status, a second install (must say "already complete" and leave the manifest byte-identical), uninstall, and a final status; it prints one JSON evidence object and exits 1 unless everything passed. It refuses to run if either Albera folder already exists.

## Not verified

- **Everything that needs admin.** `sc.exe`, `icacls`, `New-LocalUser`, the machine key, the manifest, the ACL read-back and the whole install/uninstall flow have not been executed. Tested instead: plan, status and refusal modes of the real script; the pure helpers (validators that mirror the C# config rules, ACL plan, service and SDDL checks); copy-with-hash and removal-with-allow-list against a temp folder (taken out of the real script by AST); the key function in user scope, with Node verifying a signature against the SPKI. The VM hook is written and not run.
- **`service-check` is not run at all.** The shipped Broker and Authority trust a config file only when the process token carries the per-service SID (`ServicePathGuard`), so from an elevated console it always answers `SERVICE_CONFIG=invalid:config_untrusted` before it looks at the content, and it would start a build while elevated. The script validates the configs with its own mirror of the C# rules (a test compares the key sets with the C# parsers) and relies on the first start of each service (`-StartCheck`, or your `Start-Service`) as the real test. Exit codes: 73 config or folder, 77 and 78 signing key, 79 policy.
- A restricted-SID service token opening the machine key (the Authority guard accepts the DACL; opening under that token is lab-only, as `approval-authority.md` says). The Authority guard against this key, and the Broker/Authority start under the SCM with this layout.
- Windows Hello provenance: the enrolled key is `NotSupported` for attestation on this PC (`approver-app.md`), so the "Hello provenance" precondition in `approval-authority.md` stays open. The script cannot prove the three approver values you pass came from your own `enroll`; compare them with what you saw.
- Whether the parent folder rule holds on this PC: `C:\ProgramData` lets Users create folders, so the script refuses a pre-existing `C:\ProgramData\Albera` and creates it itself, born with its final ACL (`DirectoryInfo.Create(DirectorySecurity)`, not created and fixed afterwards). That creation call, `icacls /L`, and the trust read-backs on a real administrator-owned tree have only been exercised on user-owned temp folders and synthetic ACL summaries.
- Not changed: Broker or Authority C# code, tiers, the Hello approval, the room. No dependency added.
