# Hyper-V Provider Readiness and PoC Gates

**Updated:** 2026-10-28  
**Status:** Preparation only; no Hyper-V Provider implementation or host mutation is approved by this document.  
**Architecture source:** PR #18, ADR-001 (Proposed) and ADR-002 (Proposed).

## Current implementation boundary

`src/runtime/hyperv-environment-provider.mjs` is a typed adapter seam. It validates the fixed provider operations and returned observations, but has no IPC client implementation, process launcher, PowerShell invocation, Hyper-V API calls, VM lifecycle side effects, network setup, or credentials. `LocalEnvironmentHostBroker` is an in-process contract adapter, not a privileged OS service. The MockProvider is the only implemented provider that can currently exercise lifecycle operations end to end.

Therefore, the project does not yet declare a supported Hyper-V host matrix. ADR-001's Windows-only target and provider notes are proposed design constraints, not evidence of a supported host or completed PoC.

## Microsoft host prerequisites

Microsoft's Hyper-V host requirements list Windows 10/11 Pro or Enterprise for client Hyper-V, a 64-bit SLAT-capable processor with VM Monitor Mode extensions, hardware virtualization enabled in BIOS/UEFI, DEP enabled, and sufficient memory. Microsoft's installation guidance separately states that Windows Home editions cannot install the Hyper-V role. These are platform prerequisites, not ALBERA security or compatibility acceptance.

Microsoft's pages are not fully aligned on client editions: the system-requirements and install pages list Pro/Enterprise, while the overview also lists Windows 11 Education. ALBERA should use Pro/Enterprise as the conservative initial client target unless Microsoft clarifies the supported role/feature behavior for Education and ALBERA tests it. The published page coverage also does not certify a particular current servicing build; the project must choose builds that remain serviced at the time of release.

References:

- [System requirements for Hyper-V on Windows and Windows Server](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements)
- [Install Hyper-V in Windows and Windows Server](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v)
- [Hyper-V virtualization in Windows and Windows Server](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview)

The project's actual support matrix must be selected and tested against currently serviced Windows releases and exact editions/builds. Passing Microsoft's minimum requirements alone does not validate ALBERA's Broker, VM images, egress controls, recovery, or operational safety.

## Read-only local diagnostic snapshot

On 2026-10-28, a read-only query of the current development host reported:

| Signal | Observed value | What it proves |
|---|---|---|
| Windows product label | Windows 10 Pro | Registry product label only |
| Display version / build | 26H2 / 26300 | Local registry metadata; not a declared ALBERA support target |
| Edition ID | Professional | Local registry metadata |
| `Win32_ComputerSystem.HypervisorPresent` | `true` | A hypervisor is present; does not establish that the Hyper-V role or management stack is installed |
| Installed Hyper-V PowerShell module | Not found by `Get-Module -ListAvailable Hyper-V` | No module was returned to this process; does not prove the optional feature is absent |
| Physical memory | 31.9 GiB | Host total only; available capacity for guests was not measured |

This snapshot is diagnostic, not a compatibility certification. In particular, no `Get-VM`, DISM feature mutation, service enablement, administrator elevation, VM creation, switch change, firewall change, guest boot, or network test was performed. The OS label/version combination and missing PowerShell module need investigation on a deliberately provisioned test host before choosing a supported target.

## Support and verification matrix

| Area | Current status | Evidence required before a Hyper-V PoC can pass |
|---|---|---|
| Windows edition/build | **UNVERIFIED as a project target** | Declare exact supported client/server editions and serviced builds; run the full suite on each selected image |
| Firmware and CPU | **UNVERIFIED** | Record SLAT, VM Monitor Mode, firmware virtualization, and DEP capability/state using documented read-only checks |
| Hyper-V feature and management stack | **UNVERIFIED** | On a provisioned lab host, record role/feature and module availability; do not install or enable them as part of this implementation change |
| Host resource headroom | **UNVERIFIED** | Set explicit CPU, memory, storage, and concurrent-VM budgets; test admission and exhaustion behavior |
| Broker identity and IPC | **MISSING** | ADR-002 review; fixed action-specific protocol; OS caller authentication, pipe ACLs, service identity, replay/freshness checks, binary/update trust, and negative tests |
| Native operation mapping | **MISSING** | Implement only fixed typed operations; never accept arbitrary PowerShell, command strings, native IDs, paths, or credentials from an agent |
| Image provenance and lifecycle | **UNVERIFIED** | Immutable signed image identity, ownership tags, disk/differencing-chain accounting, restore generation fencing, idempotent cleanup, and orphan detection |
| Guest trust and credentials | **MISSING / UNVERIFIED** | Host-owned enrollment and rotatable credentials; restored VM rejects pre-restore tokens/approvals; no credential in logs/events/manifests |
| Egress and host/LAN isolation | **UNVERIFIED** | Independently evidenced IPv4 and IPv6 tests for guest-to-host, guest-to-LAN, DNS, and unapproved egress denial; approved Broker path tested separately |
| Recovery and UNKNOWN state | **PARTIAL in MockProvider only** | Inject timeout-after-side-effect, Broker loss, host restart, restore and duplicate requests; reconcile by inspection without blind replay |
| Performance and reliability | **UNVERIFIED for Hyper-V** | Measure cold/warm create/start/stop/destroy, disk growth, concurrent capacity and cleanup; report hardware/build and distributions |

No row becomes VERIFIED from MockProvider results or CI alone. CI does not establish effective Hyper-V network isolation or the availability of a supported host environment.

## Staged readiness gates

1. **Contract gate:** resolve ADR-002 trust and Broker decisions; keep the existing Observer read-only and separate from execution.
2. **Mock gate:** complete fixed-operation, idempotency, stale-generation, timeout/UNKNOWN, restore, resource-quota, and cleanup fault tests without host effects.
3. **Lab-host gate:** select a disposable, explicitly provisioned Windows host and immutable test image. Record edition/build, hardware prerequisites, Hyper-V feature state, capacity, and recovery plan before any mutation.
4. **Broker security gate:** implement and independently review a least-privilege OS-authenticated Broker with fixed action schemas, caller/service identity binding, audit redaction, and no generic shell or PowerShell API.
5. **Isolation gate:** prove guest-to-host/LAN/unapproved-egress denial for IPv4/IPv6 and DNS using packet-level evidence and independent host controls before running agent workloads.
6. **Lifecycle PoC gate:** only after the prior gates pass, separately authorize harmless create/boot/handshake/stop/destroy operations on the lab host, then verify VM and disk absence and reconcile fault-injected outcomes.

Until all relevant gates have evidence, Hyper-V support, isolation, credentials, performance, and recovery must be reported as unverified. No Hyper-V operation was run for this readiness review.
