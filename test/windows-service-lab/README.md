# Windows service lab

## Disposable Hyper-V VM

Run issue #23 end-to-end in a fresh, network-disconnected VM:

```powershell
powershell -File test/windows-service-lab/lab-vm.ps1 -Build
```

The script creates a differencing disk from the read-only Windows Server 2025 golden image, waits for PowerShell Direct, runs the existing lab, prints the result and rollback summaries, and deletes only the verified disposable VM and child VHDX. Use `-KeepVm` for investigation, or override `-VmName`, `-PasswordFile`, and `-EvidenceDir` as needed. Exit codes are 0 for no failures, 1 for one or more failed checks, and 2 for setup or cleanup errors.
