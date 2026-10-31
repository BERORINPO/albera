# Windows service lab

## Disposable Hyper-V VM

Run issue #23 end-to-end in a fresh, network-disconnected VM:

```powershell
powershell -File test/windows-service-lab/lab-vm.ps1 -Build
```

The script creates a differencing disk from the read-only Windows Server 2025 golden image, waits for PowerShell Direct, runs the existing lab, prints the result and rollback summaries, and deletes only the verified disposable VM and child VHDX. The run also starts the real Approval Authority service (`build:approval-authority`; `-Build` runs it) against signing keys that `new-authority-key.ps1` creates in the guest: checks `k_*` expect a good key to start, an exportable key and a key with an extra Everyone ACE to be refused with service exit code 78, and a missing key to end with 77. Checks `m1` to `m4` (issue #84) run the real Broker service against journals of its own: generation advance and refusal (1066 / 76), migration of a version 2 journal (the fixture comes from `lab-inputs.json`, generated on the host), an `inspect` that writes nothing, and a restore of a stopped service's journal followed by a replay. Clock rollback is deliberately NOT in the lab: it needs the test-only clock offset, which the published Broker does not contain; it is host-tested. Use `-KeepVm` for investigation, or override `-VmName`, `-PasswordFile`, and `-EvidenceDir` as needed. Exit codes are 0 for no failures, 1 for one or more failed checks, and 2 for setup or cleanup errors.
