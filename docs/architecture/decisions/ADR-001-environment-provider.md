# ADR-001 — Environment Provider Contract

- **Status:** Proposed (pending PoC / review)
- **Date:** 2026-10-28
- **Related:** ALBERA System Design RFC v0.1, ADR-002
- **Scope:** Computer lifecycle and provider substitution; not an authorization mechanism.

## Context and decision drivers
ALBERA must support long-lived project workspaces, disposable task workspaces and clean verification workspaces. Hyper-V on Windows is the first target, but local containers and remote VM services must be possible without rewriting Task/Run, memory, integration or Canvas logic. Host infrastructure is privileged and may fail midway through operations. VM state can be rolled back while Git and other external effects cannot.

Drivers, in order: isolation/credential safety; correct lifecycle under failures; provider replaceability; reproducible environments; observability; speed/resource efficiency.

## Decision proposed

1. Separate **Environment Provider** (provision/inspect/start/stop/restore/destroy) from **Execution Driver** (start/stop/inspect a guest task), **Interaction Driver** (browser/desktop/terminal), and **Artifact Transport**. A provider's availability does not imply desktop/CLI capability.
2. Hyper-V is an initial provider adapter via a narrow broker; it is **not** part of the domain model. The provider is responsible for native VM identity, and ALBERA maps it to a stable `computerId`.
3. A provider API receives an already authorized, versioned operation from Control Plane. Authorization takes place *before* calling the provider and again in privileged broker using host-held context. The guest never directly provisions VMs.
4. Control Plane maintains durable desired state and operation journal; provider `inspect` supplies observed state. `UNKNOWN` triggers reconciliation, never blind replay.
5. Environments are identified by immutable image references and specified network/security profiles. Capabilities are discovered and validated, not inferred from provider name.
6. For **cross-project reuse**, destroy and re-provision from approved immutable images rather than trying to sanitize an old untrusted guest. Persistent environments never migrate to another project implicitly.

## Contract sketch (conceptual TypeScript; not current implementation)

```ts
type ComputerId = string;
type OperationId = string;
type ImageDigest = string;

type EnvironmentSpec = {
  projectId: string;
  taskId?: string;
  kind: 'persistent' | 'ephemeral' | 'verification';
  os: 'linux' | 'windows';
  architecture: 'x64' | 'arm64';
  imageDigest: ImageDigest;
  capabilities: Array<'terminal'|'browser'|'desktop'>;
  resources: { vcpu: number; memoryMiB: number; diskGiB: number };
  networkProfileId: string;
  securityProfileId: string;
};

type AuthorizedOperation = {
  operationId: OperationId;
  computerId: ComputerId;
  projectId: string;
  expectedGeneration: number;
  policyVersion: number;
  action: 'create'|'start'|'stop'|'inspect'|'destroy'|'checkpoint'|'restore';
  // Broker retrieves authorization from host-held record rather than trusting this object alone.
};

type ObservedEnvironment = {
  computerId: ComputerId;
  providerId: string;
  nativeId: string;
  state: 'missing'|'provisioning'|'off'|'running'|'paused'|'failed'|'unknown';
  observedAt: string;
  imageDigest?: ImageDigest;
  health?: 'unknown'|'ready'|'unhealthy';
};

interface EnvironmentProvider {
  capabilities(): Promise<ProviderCapabilities>;
  create(op: AuthorizedOperation, spec: EnvironmentSpec): Promise<ObservedEnvironment>;
  inspect(op: AuthorizedOperation): Promise<ObservedEnvironment>;
  start(op: AuthorizedOperation): Promise<ObservedEnvironment>;
  stop(op: AuthorizedOperation): Promise<ObservedEnvironment>;
  destroy(op: AuthorizedOperation): Promise<ObservedEnvironment>;
  checkpoint?(op: AuthorizedOperation, label: string): Promise<CheckpointRef>;
  restore?(op: AuthorizedOperation, checkpoint: CheckpointRef): Promise<ObservedEnvironment>;
}
```

**Important:** This signature is the control-level shape, not a direct public RPC schema. The broker must authenticate its caller, fetch the operation from durable trusted storage, validate resource identity and freshness, and enforce a *fixed action-specific* argument schema. Provider-native IDs, file paths, PowerShell parameters and credentials must not be accepted unvalidated from agent output.

## Lifecycle and concurrency

- ALBERA registry states: `REQUESTED → PROVISIONING → READY → LEASED → RELEASING → CLEANING → AVAILABLE`, and `UNKNOWN / QUARANTINED / FAILED / DESTROYING / DESTROYED`.
- Provision operation: reserve ID and quota transactionally; persist operation as pending; call broker; inspect native provider; reconcile; mark ready only after guest readiness probe.
- Lease acquisition: database compare-and-swap on computer generation, project association and readiness; only one exclusive writer lease per task workspace. Observer access may be shared and separately authorized.
- Duplicate operation IDs return same persisted outcome; if side effect outcome uncertain, inspect by ALBERA-provisioned native tags/metadata before trying again.
- Restore: disconnect egress, terminate/hold prior lease, increment auth epoch, invoke restore, invalidate guest session credentials, inspect and re-establish new identity before unquarantine.
- Delete: revoke lease first; collect approved artifacts; stop; remove VM; verify absence; garbage-collect disks/images only when no other consumers reference them.

## Provider-specific notes

**Hyper-V:** Windows-only host adapter. Use documented PowerShell/management operations behind a privileged broker. Do not call an arbitrary PowerShell string supplied by an agent. Golden images and differencing disks are an *optimization* subject to chain ownership, disk capacity and lifecycle tests. Production checkpoint is guest-consistent without capturing running memory; standard checkpoint captures memory but is not equivalent to a backup. Linux guest command execution requires a guest agent / authenticated network path; PowerShell Direct applies to supported Windows guests, not Linux. Hyper-V virtual-switch selection alone is not a complete egress filtering policy.

**Container:** lower cost but different isolation properties (kernel sharing) and GUI capabilities. Scheduler must honor hard `isolation=vm` requirements and never downgrade them silently.

**Remote:** credentials, data residency, network cost and billing are additional hard filters. Unsupported optional operations (fork/snapshot/desktop) must be represented explicitly in capabilities.

## Alternatives rejected/deferred

| Alternative | Assessment |
|---|---|
| Hyper-V APIs directly in Canvas/read-only Node server | Rejected: privileged action exposed across inappropriate boundary. |
| Entire orchestration tightly coupled to Hyper-V | Rejected: portability and testing risk. |
| Every task always gets a full VM | Rejected: unnecessary RAM/boot cost; only use if policy requires. |
| Generic `exec(command)` broker / unchecked PowerShell | Rejected: arbitrary host command execution. |
| Cross-tenant recycling of existing guest disks | Rejected: cleanup cannot be trusted. |
| Immediate cloud-first control plane | Deferred pending local-first end-to-end experiment. |

## Verification gates

1. Fake provider contract suite on all CI OSs: create/start/inspect/stop/destroy, idempotency, concurrent lease requests, provider failure, timeout, missing VM, restore replay.
2. Hyper-V integration suite on explicitly provisioned Windows host: from golden Ubuntu image create isolated VM; boot; handshake; run harmless test; stop; destroy; verify disks and native VM absence.
3. Negative tests: wrong project, stale generation, unsupported capability, unapproved image, quota breach, forged native ID and duplicate request must fail safely.
4. Network test: attempted guest→host, guest→LAN and guest→unapproved internet destinations fail; approved broker channel still works. Confirm with packet-level evidence and independent host controls.
5. Benchmark cold/warm startup, RAM and disk usage, clone/restore/remove overhead. No performance claim until measured.

## Consequences / open questions

+ Reusable domain contracts; swappable providers and fake-driven tests.
+ More reliable reconciliation and evidence provenance.
− Additional broker/protocol complexity.
− Host-specific integration tests remain necessary.

Open: Windows edition, host disk and RAM capacity, VM image signing/secure boot, exact private-network/egress implementation, credentials bootstrapping, GPU requirements, supported Linux distribution, native provider tagging strategy.

**Decision gate:** do not mark `Accepted` until security review and G2 PoC meet the above tests.