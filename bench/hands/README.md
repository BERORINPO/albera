# Hands benchmark scripts

Scripts behind [`docs/benchmarks/2026-10-29-hands.md`](../../docs/benchmarks/2026-10-29-hands.md). Windows host with Hyper-V only. These scripts are for measurement, not part of the ALBERA package (they are not in `files` of `package.json`).

## What you need

- Windows 11 Pro (or another edition with Hyper-V), Hyper-V enabled, your user in the local `Hyper-V Administrators` group (sign out and in after adding it).
- A Windows Server 2025 evaluation ISO from Microsoft's Evaluation Center.
- Python 3.10+ (standard library only) and PowerShell 7 (`pwsh`).
- An Anthropic API key in `ANTHROPIC_API_KEY`.

## Terms

- Windows Server evaluation media is licensed for evaluation only and is time-limited. Use it under Microsoft's evaluation terms and do not use these VMs for production.

## Setup

1. Create a password for the VM's Administrator and keep it out of git: `local-secrets\admin-password.txt` (this folder is ignored).
2. Build the answer-file ISO: `pwsh -File make-unattend-iso.ps1 -ImageIndex 2` (index 2 is Standard with Desktop Experience on current media; check yours).
3. Create a Generation 2 VM named `albera-poc-01` with no network adapter connected, attach the Windows ISO and `local-secrets\unattend.iso`, boot from DVD and press a key (or send one with `vm-io.ps1`).

## Run

```
python hands_compare.py --models haiku sonnet haiku+opus --tasks t1 t2 t3 c1 c2 c3 c4 --trials 2 --cap-usd 5
```

Results are appended as JSON lines; screenshots go to `runs/` (ignored).

## Safety notes

- Keep the VM disconnected from any network. The tasks need none.
- `--cap-usd` stops the run at a hard spend limit.
