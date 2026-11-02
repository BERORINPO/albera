# Host install: the Broker and the Approval Authority on the owner's PC

**Status: written, NOT RUN.** `scripts/host/albera-host.ps1` was run in plan mode and its logic was tested with fakes and a temp folder (`test/host-install.test.mjs`). No install, service, account, ACL or machine key was ever created by it, and the disposable-VM run (`test/windows-service-lab/lab-host-install-check.ps1`) has not happened. Treat the first real run as the first run.

Goal: put the two services on the owner's PC so the first real Windows Hello approval can happen (`approver-app.md`, steps 4 to 8). Related: `approval-authority.md` ("Needs the VM lab or the owner", "Preconditions before production"), `approval-tiers.md` ("Room start approval").

## What it installs

| Object | Where | Notes |
|---|---|---|
| Builds of the Broker, the Authority and the pipe client helper | `C:\Program Files\Albera\bin\{broker,authority,pipe-client}` | copied from the publish outputs (`npm run build:windows-broker`, `npm run build:approval-authority`); each file is hashed against the source, the exe against its `.manifest.json`; the exe SHA-256 and a whole-folder hash go into the manifest |
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
powershell -File scripts\host\albera-host.ps1                                    # plan: numbered steps, changes nothing, no admin needed
powershell -File scripts\host\albera-host.ps1 -Mode install -ApproverKeyId hello-...   # elevated console of YOUR account
powershell -File scripts\host\albera-host.ps1 -Mode status
Start-Service AlberaHostBroker; Start-Service AlberaApprovalAuthority             # when ready
```

Before install: `npm run build:windows-broker`, `npm run build:approval-authority`, `npm run build:approver`, and `AlberaApprover.exe enroll` + `enroll --check` (done 2026-10-31). `-ApproverKeyId` must be the `approverKeyId` your own `enroll` printed: the script runs `AlberaApprover.exe enroll --show` itself (same account, no prompt), refuses if the key id differs, if the SID is not an S-1-5-21 user SID or equals `albera-cp`'s, or if the key is not an RSA-2048 SPKI. Install refuses unless the console is elevated and never elevates itself. Re-running a completed install checks it and changes nothing; a partial install continues from where it stopped, or stops with the reason (anything that exists and is not in the manifest is never adopted). `-StartCheck` starts each service once and stops it again (the only real test of the configs, see below).

## First approval (`approver-app.md` steps 6 and 7)

`albera-runtime approval-check` sends ONE `broker.operation` / `synthetic.noop` (the Broker only records the claim; nothing moves) through fence, submit, wait, claim, and prints the approval id. Only the Control Plane account can reach the two submit pipes, so run it as `albera-cp`:

1. As `albera-cp` (for example `runas /user:.\albera-cp powershell.exe`, then in that window): `node <repo>\src\runtime\entry.mjs approval-check --approval C:\ProgramData\Albera\control-plane\albera.approval.json --helper "C:\Program Files\Albera\bin\pipe-client\albera-windows-broker-pipe-client.exe"`. It prints `approvalId: <uuid>` and waits (the request lasts 120 s).
2. In your own normal console: `AlberaApprover.exe list` (check the fields and `digest check: OK`), then `AlberaApprover.exe approve <approvalId>`, type `yes`, verify with Hello. The first window ends with `status: claimed` and exit 0.

`albera-cp` must be able to read `node.exe` and your checkout; the installer grants it nothing there.

## The Control Plane account (PROVISIONAL)

The Authority refuses one SID for both pipes (`sids_not_distinct`), and the approver SID is your own account, so the Control Plane cannot be you. Decision (`2026-11-02+host-install` in `spec/architecture.md`): a dedicated local standard user `albera-cp`, created by the script, password typed by you, never stored. Its SID is `controlPlaneSid` in both configs. Rejected: a virtual service account (nothing runs the Control Plane as a service yet); a second administrator (a bigger target than needed); adding `albera-cp` to Hyper-V Administrators (see below).

**Known consequence, not solved here:** the gated `room` uses the same-user Hyper-V prototype, which needs Hyper-V Administrators. Running `room` as `albera-cp` therefore does not work until that is decided (a privileged Broker for Hyper-V, or another identity). `approval-check` does not need Hyper-V. This is why the account choice stays provisional.

## Uninstall

`powershell -File scripts\host\albera-host.ps1 -Mode uninstall` (elevated; `-Mode plan -PlanFor uninstall` first). It stops and deletes the two services (a service whose command line is not the one it wrote is left alone), deletes the machine key, removes the install folder and the data folders, removes `albera-cp` (only if the manifest says it created it and the SID still matches; its profile folder, if it ever logged in, stays), and last the manifest and the data root. A folder that holds a file the script does not know, or a link/junction, is not deleted. This deletes the Broker journal and the Control Plane journal.

To update a build: uninstall, rebuild, install (an existing copy that differs is refused).

## VM lab hook (lab only)

`-ControlPlanePassword <SecureString>` and `-LabApproverValues <json>` (a throw-away public key in place of Hello) make install non-interactive, and are refused unless the environment variable `ALBERA_LAB_VM` is `1` (the lab driver sets it inside the disposable VM; never set it on a real PC). `test/windows-service-lab/lab-host-install-check.ps1 -HostScriptDir <folder with albera-host*.ps1> -RepoRoot <folder with the build outputs>` runs, in the guest as Administrator: install with `-StartCheck`, status, a second install (must say "already complete" and leave the manifest byte-identical), uninstall, and a final status; it prints one JSON evidence object and exits 1 unless everything passed. It refuses to run if either Albera folder already exists.

## Not verified

- **Everything that needs admin.** `sc.exe`, `icacls`, `New-LocalUser`, the machine key, the manifest, the ACL read-back and the whole install/uninstall flow have not been executed. Tested instead: plan, status and refusal modes of the real script; the pure helpers (validators that mirror the C# config rules, ACL plan, service and SDDL checks); copy-with-hash and removal-with-allow-list against a temp folder (taken out of the real script by AST); the key function in user scope, with Node verifying a signature against the SPKI. The VM hook is written and not run.
- **`service-check` is inconclusive from an elevated console.** The shipped Broker and Authority trust a config file only when the process token carries the per-service SID (`ServicePathGuard`), so `service-check` run by the installer always answers `SERVICE_CONFIG=invalid:config_untrusted` before it looks at the content. The script reports that as INCONCLUSIVE, validates the configs itself (its own mirror of the C# rules), and relies on the first start of each service (`-StartCheck`, or your `Start-Service`) as the real test. Exit codes: 73 config or folder, 77 and 78 signing key, 79 policy.
- A restricted-SID service token opening the machine key (the Authority guard accepts the DACL; opening under that token is lab-only, as `approval-authority.md` says). The Authority guard against this key, and the Broker/Authority start under the SCM with this layout.
- `AlberaApprover.exe enroll --show` from an elevated console of the same account (same SID expected; Hello's behaviour in an elevated process is unobserved). The enrolled key is `NotSupported` for attestation on this PC (`approver-app.md`), so the "Hello provenance" precondition in `approval-authority.md` stays open.
- Whether the parent folder rule holds on this PC: `C:\ProgramData` lets Users create folders, so the script refuses a pre-existing `C:\ProgramData\Albera` and creates it itself with the ACL set at once.
- Not changed: Broker or Authority C# code, tiers, the Hello approval, the room. No dependency added.
