# ADR-004 — Golden Images, Differencing Disks and Checkpoint Lifecycle

- **Status:** Proposed; pending host-specific validation
- **Date:** 2026-10-28
- **Depends on:** ADR-001, ADR-002, ADR-003

## Decision
Use reproducible, versioned **Golden Images** to construct clean task/verification machines, with per-VM differencing disks where the provider supports them. Use **Hyper-V checkpoints selectively for short-lived rollback/investigation**, not as the authoritative repository, database backup or cross-provider serialization mechanism. Persistent project computers are long-lived but must export approved artifacts and project knowledge outside the guest.

## Distinguished objects
| Object | Purpose | Lifecycle |
|---|---|---|
| Golden Image | Approved OS, tools and version-pinned agent bootstrap; immutable parent | Reproducible, versioned, retired only when unreferenced |
| Differencing VHDX | Per-computer writable child referencing exact parent | Created at provision, never manually detached from active parent |
| Production Checkpoint | Data-consistent VM restore point; guest filesystem freeze/VSS where supported | Selected pre-change recovery point |
| Standard Checkpoint | VM execution/memory state; not application-consistent | Lab/debug only by policy |
| Work Artifact | Git commit, test report, screenshot, bounded trace | Exported, hashed, verified, independent of VM deletion |

`New-VHD -Differencing -ParentPath` is a supported Hyper-V mechanism. Parent images must remain in place and must never be modified while descendants depend on them. Hyper-V checkpoint `.avhdx` chains need hypervisor-managed removal/merge; do not delete files manually. Production checkpoints exclude guest volatile memory and do not guarantee application-specific correctness without app-level coordination.

## Golden Image manifest
```json
{
  "schemaVersion": 1,
  "imageId": "ubuntu-dev-24.04-node22-v3",
  "contentDigest": "sha256:<computed-on-build>",
  "os": "linux",
  "arch": "x64",
  "tools": {"node": "22", "guestAgent": "version-pinned"},
  "securityProfileId": "guest-restricted-v1",
  "provisionerRevision": "version-pinned",
  "parentImageId": null,
  "status": "approved"
}
```
Image manifests need host-controlled attestation of file hash, signature/check approval, vulnerability review and SBOM as release policy develops. Placeholders above are not real digests.

## Provisioning sequence
1. Validate project quotas, network/security profile, available disk and CPU/RAM, desired image approval.
2. Journal create operation (ADR-003), reserve capacity and allocate unique stable computer ID.
3. Under privileged broker: verify exact immutable parent path/digest, create isolated child disk and VM with project-scoped virtual switch; tag VM with ALBERA identity.
4. Bootstrap guest identity and ephemeral credentials; provision no reusable host credentials in Golden Image.
5. Start guest with egress default-deny; verify agent bootstrap, heartbeat, fixed capabilities and host-observed network state.
6. Declare READY only after policy checks; assign new generation-fenced Lease when task begins.
7. On failure: mark QUARANTINED, retain forensic reference where needed, release quotas only after verified cleanup.

## Checkpoint creation
- Reason required (`pre-upgrade`, `debug-failure`, etc.) with project/run/computer, active leases, image and guest synchronization status.
- Stop/quiet IO when practical, flush application state, commit Git progress and export valuable artifacts first.
- In general prefer Production checkpoint, validate Linux integration service behavior on supported guest/host combinations.
- Apply retention policies: count/depth/disk budget/time-to-live; skip if disk headroom insufficient.
- Record checkpoint ID, provider-native ID, requested type, observed type, host timestamp, parent chain and completion. Fail if configured ProductionOnly cannot be satisfied; **do not silently fall back** to Standard.

## Restore protocol
1. Require host-side approval appropriate to task risk; journal restore intent.
2. Freeze all new dispatch; revoke lease at host, increment auth generation; block network egress and host data bridges.
3. Stop or suspend dependent operations; inspect checkpoint chain and capacity.
4. Apply provider checkpoint through typed broker command; on uncertainty reconcile, do not replay blindly.
5. Recreate guest identity/session; invalidate credentials stored inside restored VM, including outbound access tokens. Critical enforcement must be host-side; do not rely on guest to delete compromised secrets.
6. Inspect filesystem and Guest Agent readiness, restore *task* progress from control-side work/memory if appropriate, record `RESTORED` with new generation.
7. Open only currently authorized network routes; release to READY after verification. If any step fails, remain QUARANTINED.

External Git pushes/API effects do not roll back when VM restores. For exactly that reason, restores do not automatically repeat `push`, PR creation, payment or provisioning actions.

## Cleanup and garbage collection
- Refuse to delete a parent referenced by any child, snapshot, active VM or retention hold.
- Prefer provider APIs for checkpoint remove/merge; verify cleanup and available space.
- Ephemeral VM deletion is allowed only after required artifacts are exported and verified or operator approves explicit discard.
- Pool reuse **within same project** still requires cleanliness proof. Cross-project reuse requires destroy/reprovision from approved image, not sanitizing an old guest.
- Disk high-water marks trigger admissions stop, checkpoint thinning via supported APIs and alerts, never unsafe manual file removal.

## Backup distinction
A checkpoint is not a durable backup. Control DB, artifacts, image manifests and Git repositories need separate tested backup/restore plans. Restoring a database snapshot must reconcile against current VMs and external Git state.

## Acceptance tests
1. Two VMs from same immutable parent produce independent writable changes; parent hash unchanged.
2. Corrupted/missing parent rejected before VM creation; no orphan child left untracked.
3. Reject overwriting/moving a referenced image.
4. ProductionOnly policy refuses fallback to Standard.
5. Restore reissues generation; stale guest commands, approvals and credentials unusable.
6. VM checkpoint restore does not erase independent Git/artifacts/memory/events.
7. Simulate failed merge, low disk, power interruption; quarantine and report cause.
8. Pool destroys guest from Project A and re-provisions clean guest for Project B, with no data/network/secrets crossover.
9. Deletion of ephemeral VM blocked until required artifact export/verification or explicit discard approval.
10. Disk/CPU/RAM/restore timings and delta chain depth benchmarked on target Windows host.

## Official references
- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/checkpoints
- https://learn.microsoft.com/en-us/powershell/module/hyper-v/new-vhd
- https://learn.microsoft.com/en-us/troubleshoot/windows-server/virtualization/hyper-v-snapshots-checkpoints-differencing-disks