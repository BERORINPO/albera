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
4. Runs `albera-lab-service-shim.exe hyperv <inner VM GUID>` as four virtual-account services, each with `sc privs SeChangeNotifyPrivilege`: restricted or unrestricted service SID, each member of Hyper-V Administrators (`S-1-5-32-578`) or not. The probe (`HyperVProbe.cs`) uses COM late binding on `WbemScripting.SWbemLocator` in its own process, which is how the C# Broker will call WMI. Each service's token is read back first (`hv_<identity>_token`); a token that is not the cell's shape makes that cell BLOCKED, not a quiet pass.
5. Writes `hyperv-results.json` and `lab-output.txt` in the evidence folder and prints the table. The VM and its disk are deleted as in the other modes (`-KeepVm` also removes the lab services, group memberships and the inner VM inside the guest).

Checks are `hv_prereq_role`, `hv_prereq_inner_vm`, then for each identity (`r_member`, `r_nonmember`, `u_member`, `u_nonmember`) `hv_<identity>_token` and `hv_<identity>_<operation>` for `wmi_connect`, `vm_lookup`, `mgmt_read`, `thumbnail`, `keyboard_typekey` and `mouse_setabsoluteposition`:

| Identity | `wmi_connect`, `vm_lookup` | `thumbnail`, `keyboard_typekey`, `mouse_setabsoluteposition` | `mgmt_read` (read only; the Broker never calls it) |
|---|---|---|---|
| unrestricted, member | PASS if allowed | PASS if allowed | MEASURED |
| restricted, member | MEASURED | MEASURED (allowed or denied; either answer is the result) | MEASURED |
| restricted or unrestricted, not a member | MEASURED | PASS if refused (access denied, or the VM is not visible); FAIL if allowed | MEASURED |

Status values: PASS, FAIL, BLOCKED (could not be measured: wrong token shape, no probe output, an error that is not about access), MEASURED (the observation is recorded as the result). Exit code 0 means no FAIL and no BLOCKED; 1 means either; 2 is a setup or cleanup error. If the restricted member row says `denied`, the decision to fall back to `sidtype unrestricted` is the shareholder's, not this lab's. Not executed in a VM yet; the logic is covered by `hyperv-rights-checks.test.mjs`, and the probe's COM calls were run once on a development host against a VM GUID that does not exist (connect and read worked; every VM call said not found).
