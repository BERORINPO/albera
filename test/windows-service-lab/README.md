# Windows service lab

## Disposable Hyper-V VM

Run issue #23 end-to-end in a fresh, network-disconnected VM:

```powershell
powershell -File test/windows-service-lab/lab-vm.ps1 -Build
```

The script creates a differencing disk from the read-only Windows Server 2025 golden image, waits for PowerShell Direct, runs the existing lab, prints the result and rollback summaries, and deletes only the verified disposable VM and child VHDX. The run also starts the real Approval Authority service (`build:approval-authority`; `-Build` runs it) against signing keys that `new-authority-key.ps1` creates in the guest: checks `k_*` expect a good key to start, an exportable key and a key with an extra Everyone ACE to be refused with service exit code 78, and a missing key to end with 77. Checks `m1` to `m4` (issue #84) run the real Broker service against journals of its own: generation advance and refusal (1066 / 76), migration of a version 2 journal (the fixture comes from `lab-inputs.json`, generated on the host), an `inspect` that writes nothing, and a restore of a stopped service's journal followed by a replay. Checks `p1` to `p6` (issue #115 step 3a) run the same Authority service against its tier policy file, `policy.json`, in the Authority's own config folder: no file starts as careful (the approver pipe says rev 0), a config folder that `BUILTIN\Users` can write is refused (1066 / 73), an unsigned `standard` file is refused (1066 / 79), the running service writes `policy.json` itself when the approver pipe sends a `policy_set` that only adds a prompt (no signature needed), a restart reads that file back, and an unsigned `policy_set` that would loosen the policy is refused. A correctly signed `standard` policy cannot be made in the VM (it needs a real Windows Hello signature), so that direction stays host-tested. Clock rollback is deliberately NOT in the lab: it needs the test-only clock offset, which the published Broker does not contain; it is host-tested. Use `-KeepVm` for investigation, or override `-VmName`, `-PasswordFile`, and `-EvidenceDir` as needed. Exit codes are 0 for no failures, 1 for one or more failed checks, and 2 for setup or cleanup errors.

## Nested Hyper-V rights check (`-HyperV`)

ADR-002 puts the room's VM operations in a privileged Windows Broker (virtual account `NT SERVICE\AlberaHostBroker`, restricted service SID, `SeChangeNotifyPrivilege` only) whose SID is a member of Hyper-V Administrators. This mode measures whether a service of that shape may call the two Hyper-V WMI operations the Broker will own: a screen capture (`GetVirtualSystemThumbnailImage`) and input (`Msvm_Keyboard`, `Msvm_SyntheticMouse`). It is a different lab from the default one and from `-HostInstall`; pick one.

```powershell
powershell -File test/windows-service-lab/lab-vm.ps1 -HyperV -Build
```

Before running: the lab VM is 5 GB (the free-memory guard asks for 9 GB free: 5 GB VM + 4 GB headroom), so check the host first. The host is changed in no other way than creating and deleting this one VM; nested virtualization is switched on for that VM only.

What it does:

1. Creates the usual differencing-disk VM, offline, with `Set-VMProcessor -ExposeVirtualizationExtensions $true` while it is still off.
2. In the guest, `Install-WindowsFeature Hyper-V -IncludeManagementTools`, then restarts the guest and reconnects PowerShell Direct (up to 20 minutes, by comparing the boot time).
3. Makes an inner VM (Gen2, 512 MB fixed, no disk, no network). It stays at the UEFI screen, which is enough to capture and to type at.
4. Runs `albera-lab-service-shim.exe hyperv <inner VM GUID>` as four virtual-account services, each with `sc privs SeChangeNotifyPrivilege`: restricted or unrestricted service SID, each member of Hyper-V Administrators (`S-1-5-32-578`) or not. The probe (`HyperVProbe.cs`) uses COM late binding on `WbemScripting.SWbemLocator` in its own process, which is how the C# Broker will call WMI. It also runs the Broker's real Hyper-V desktop adapter (`HyperVDesktop` with `ComWmiConnection` from `src/runtime/windows-broker`, compiled into the shim by source include; PR #161) for `adapter_capture` (a 640x480 capture that must come back as a PNG with a valid signature, IHDR and IEND) and `adapter_input` (one move, one tap of Shift, one press and release of mouse button 1). Every WMI result is read through `Properties_.Item(...).Value`, never by property name (a by-name read made every later call in the process fail with `0x80004005`, which is what the first run saw for the keyboard and the mouse). Each service's token is read back first (`hv_<identity>_token`); a token that is not the cell's shape makes that cell BLOCKED, not a quiet pass.
5. Writes `hyperv-results.json` and `lab-output.txt` in the evidence folder and prints the table. The VM and its disk are deleted as in the other modes (`-KeepVm` also removes the lab services, group memberships and the inner VM inside the guest).

Checks are `hv_prereq_role`, `hv_prereq_inner_vm`, then for each identity (`r_member`, `r_nonmember`, `u_member`, `u_nonmember`) `hv_<identity>_token` and `hv_<identity>_<operation>` for `wmi_connect`, `vm_lookup`, `mgmt_read`, `thumbnail`, `keyboard_typekey`, `mouse_setabsoluteposition`, `adapter_capture` and `adapter_input`:

| Identity | `wmi_connect`, `vm_lookup` | `thumbnail`, `keyboard_typekey`, `mouse_setabsoluteposition`, `adapter_capture`, `adapter_input` | `mgmt_read` (read only; the Broker never calls it) |
|---|---|---|---|
| unrestricted, member | PASS if allowed | PASS if allowed | MEASURED |
| restricted, member | MEASURED | MEASURED (allowed or denied; either answer is the result) | MEASURED |
| restricted or unrestricted, not a member | MEASURED | PASS if refused (access denied, or the VM is not visible); FAIL if allowed | MEASURED |

Status values: PASS, FAIL, BLOCKED (could not be measured: wrong token shape, no probe output, an error that is not about access), MEASURED (the observation is recorded as the result). Exit code 0 means no FAIL and no BLOCKED; 1 means either; 2 is a setup or cleanup error. If the restricted member row says `denied`, the decision to fall back to `sidtype unrestricted` is the shareholder's, not this lab's. The adapter hides why it failed (one reason word), so an `adapter_*` failure counts as refused only when the raw check of the same operation (`thumbnail`; `keyboard_typekey` or `mouse_setabsoluteposition`) was refused in the same run; otherwise it is an error (BLOCKED), including a capture that is not a valid PNG. A "not found" from the probe itself (`management_service_not_found` and the like: the object is hidden from that caller) counts as not visible. The `adapter_*` operations and the property-reading fix have not been run in a VM yet; the logic is covered by `hyperv-rights-checks.test.mjs`, and the probe's COM calls were run once on a development host against a VM GUID that does not exist (connect and read worked; every VM call said not found).

### The Broker desktop pipe, as the real service (checks `bd_*`, after the four identities)

The same `-HyperV` run then installs the REAL Broker as it will be installed and uses its desktop pipe (Broker PR #164, ADR-002 "Amendment 2026-11-03"). It needs the Broker build as well as the shim (`-Build` makes both; without `-Build` the driver checks for both before it creates the VM). The Broker publish folder is copied to `bin\broker` in the guest. Three services, all virtual accounts with `SeChangeNotifyPrivilege` as the only privilege:

| Service | Shape | Role |
|---|---|---|
| `AlberaHostBroker` (fixed: the Broker derives the service SID it trusts from this name) | sidtype `unrestricted`, member of Hyper-V Administrators; config `computers` = the inner VM's GUID | `albera-windows-broker.exe service <config>` |
| `AlberaLabHvCP` | sidtype `restricted`, no group; its SID is the Broker's `controlPlaneSid`; it may query the Broker service status (as the Control Plane may) | the Control Plane |
| `AlberaLabHvOther` | same shape as the Broker (unrestricted, member), but not the Control Plane | "somebody else" |

The two callers run `albera-lab-service-shim.exe desktop <pipe> <identity> <step>...` (`DesktopClient.cs`), the lab's own small client: the Control Plane's real client has no desktop mode yet. It keeps the helper's rules for knowing who answers (pipe opened with exactly `0x00120083` at SECURITY_IDENTIFICATION; owner SID, server PID and, for a service, session 0 are checked on the connected handle before a byte is sent). The Control Plane finds the PID through the SCM (`service:AlberaHostBroker`); the other caller may not query the service, so it is given PID and owner SID (`pid:<pid>:<sid>`). Steps are `open:<view|act>:<computerId>` and `capture:<w>x<h>`; the first PNG is saved (`save=`) and the driver brings it back as `bd-view-capture.png` next to `hyperv-results.json`, so a person can look at the inner VM's screen.

| Check | PASS when | Not PASS |
|---|---|---|
| `bd_prereq_broker` | the Broker build is in the guest | BLOCKED |
| `bd_broker_ready` | the service reaches RUNNING (the Broker reports RUNNING only after the pipes exist) | FAIL, with the service exit codes; every later check is BLOCKED |
| `bd_broker_token` | the live Broker token (read as Administrator with `token-of <pid>`): user = its service SID, no restricting SIDs, Hyper-V Administrators enabled, exactly `SeChangeNotifyPrivilege` | FAIL on another shape; BLOCKED if the token cannot be read |
| `bd_cp_token` | restricted, Hyper-V Administrators absent, exactly `SeChangeNotifyPrivilege` | FAIL |
| `bd_other_token` | unrestricted, Hyper-V Administrators enabled, exactly `SeChangeNotifyPrivilege` (so its refusal is not for want of the group) | BLOCKED (the other results are then not used) |
| `bd_desktop_pipe` | the Control Plane opens `<pipeName>_desktop`: owner = Broker SID, ACEs only for the Broker (and SYSTEM) plus exactly one Control Plane ACE `0x120083`, served by the Broker's PID in session 0 | FAIL |
| `bd_cp_view_open` | a `view` open from the Control Plane is answered `{"ok":true}` | FAIL if refused; BLOCKED if no session could be made |
| `bd_cp_view_capture` | a 640x480 capture returns a header for that size and one PNG frame of exactly `bytes` bytes with a valid signature, IHDR of that size, 8-bit truecolour and IEND | FAIL (denied, or a PNG that is not valid); BLOCKED if the connection broke without a reply |
| `bd_other_refused` | the other caller gets no session: the pipe's DACL refuses the open (access denied), or the Broker answers the fixed `denied` frame. The evidence says which layer. | FAIL if a session opens; BLOCKED if it could not be measured |
| `bd_cp_act_refused` | the Control Plane connects and an `act` open is answered with the fixed `denied` frame (the lease is a later change). A closed pipe without that frame is not a pass. | FAIL if accepted; BLOCKED otherwise |

Not covered here: the Broker's per-connection peer check (thread token user SID = the Control Plane SID) is only reached by a caller the pipe DACL lets through, and the DACL lets through nobody else; it is host-tested (`test/runtime-windows-broker-desktop-pipe.test.mjs`). The Broker's own log (`DESKTOP_DENY=<reason>`) is not collected from the service, so a refusal is told apart by its layer, not by the Broker's reason word. `input` over the desktop pipe and the `act` session come with the lease; they add steps to `DesktopClient.cs` and checks next to `bd_cp_act_refused`.

The logic of these checks is covered without a VM: `broker-desktop-checks.test.mjs` (what the guest script installs and asks; the verdict functions on made-up client lines; the throwaway authority key), `desktop-client.test.mjs` (the client against a scripted Broker and against the real service loop, no VM). Nothing here has run in a VM yet.
