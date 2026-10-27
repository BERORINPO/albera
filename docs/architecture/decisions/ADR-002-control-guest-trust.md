# ADR-002 — Control Plane, Privileged Broker, and Guest Trust Boundary

- **Status:** Proposed (security review required)
- **Date:** 2026-10-28
- **Related:** RFC v0.1 §3/§15; ADR-001

## Context
Coding agents routinely execute untrusted project code, tool hooks, dependencies and website content. A guest administrator may modify the Guest Agent and logs. A Hyper-V VM can isolate local resources but cannot by itself guarantee protection against outbound network exfiltration, guest-originated forged evidence, or replayed credentials after restore. Existing ALBERA read-only HTTP observer has no authenticated execution surface and must remain separate.

## Proposed decision

**Three mutually distrustful execution domains:**

1. **Canvas / unprivileged client:** sends authenticated intentions (`request task`, `approve exact action`, `request takeover`); never handles hypervisor credentials.
2. **Control Plane (low privilege):** durable project identity and ACL; policy evaluation; approval records; immutable audit journal; lease and auth epoch; event/evidence ingestion; integration decisions. It does not execute arbitrary host commands.
3. **Privileged Host Broker:** only narrowly enumerated Hyper-V actions on allowlisted VM IDs, image roots and network profiles; verifies authenticated caller, operation ID, authorization bound to trusted stored record, policy/lease generation, quotas and state. Uses elevated host permissions; cannot be reached by guest or unauthenticated observer.
4. **Guest VM and Guest Agent:** untrusted compute; receives narrowly scoped commands, produces provisional events/artifacts. Guest admins cannot mint approvals or attest their own isolation.
5. **Independent Verification Workspace:** separate from authoring guest, seeded from immutable revisions; signs/reports verification only via trusted verifier identity and host-measured execution context. Treat test outputs as evidence, not absolute proof of safety.

## Trust diagram

```text
Human --> Canvas [untrusted browser client]
            | authenticated request
            v
    Control API [low privilege]
      | Policy / Approvals / Lease / Operation Journal
      | authorized exact operation ID
      v
  Host Broker [privileged; isolated process]
      | fixed allowlisted hypervisor operations
      v
  Hyper-V VM [UNTRUSTED guest]
      | guest events are claims, not attestation
      +--> Evidence intake --> quarantine/sanitize --> trusted verification

Existing read-only Observer --X--> Host Broker / mutation API
Guest/AI --X--> Host Broker / host secrets / trusted approvals
```

## Threat model and mitigations

| Threat | Trust boundary | Mitigation + test |
|---|---|---|
| Browser CSRF/XSS or localhost origin trick | Client → Control API | Authenticated sessions, explicit origin/host checks, CSRF defenses where cookie based, secure session handling; deny unauthenticated mutation. |
| Prompt injection in README/issue/web page | Content → Agent decision | Treat source text as data; no policy upgrades; approval only via trusted UI and bound to immutable action digest. |
| Arbitrary host command from agent | API → Broker | No generic shell, no user-controlled binary/PowerShell snippets; action-specific typed parameters, validated host-held metadata. |
| Confused deputy VM ID or file path | Broker → Hypervisor | Resolve VM by stable ALBERA-owned registration and fixed root; check project, operator, image and network policy. |
| VM Guest Agent compromised | Guest → Control | Per-run scoped capability, short session, no host broker reachability; guest events never elevate privilege. |
| Token replay after snapshot restore | Old guest state → New epoch | Host-side generation fencing, short credentials, revoke before restore, rotate after, reject stale epoch even if guest clock rolls back. |
| Unapproved internet/LAN exfiltration | VM → Network | Host/hypervisor network enforcement; default deny egress + allowlisted broker endpoints; network tests from within guest. NAT or vSwitch alone ≠ deny policy. |
| Host file or secret exposure | Host → VM | No default shared folders, inherited host environment, SSH agent, long-lived token or mounts; credential broker only with approval and scope. |
| Forged successful tests | Guest → Evidence | External verifier reruns on exact commit and independently prepared environment; bind evidence to image/test/policy digests. |
| Guest attempts disk exhaustion / fork bomb | Guest → Host resources | Quotas for RAM/vCPU/disk, I/O concurrency budgets, deadlines, health monitors, quarantine. |
| Desktop human/AI race | Interaction → Guest | Exclusive input lease, sequence fencing, revoke old operator; stop external automation where broker cannot arbitrate it. |
| Duplicate network action after retry | Orchestrator → External system | Operation journal, idempotency keys, provider inspection and explicit compensation; never assume exactly-once across arbitrary APIs. |

## Authorization model

- **Subjects:** human user, Main AI acting on behalf of approved project, background service, verifier, Guest Agent.
- **Resources:** project, computer, task, run, memory scope, artifact, network profile, repository, credential grant.
- **Actions:** create/start/stop/restore/destroy VM; execute guest task; grant desktop input; fetch evidence; import artifact; use external credential; push/merge.
- **Policy decision input:** subject identity, project membership, resource owner, requested action, exact digest/operation payload, generation, policy version, network security profile, cost/limits, approval record.
- **Default deny**; a Main AI recommendation is not a human approval. Approvals are short-lived and bound to exact target, operation, scope and actor. Changing payload invalidates approval.
- **Guest capability:** a lease is *not* a credential that authorizes the guest to call hypervisor APIs. Host-held credential and operation records remain authoritative.

## Protocol sketch (conceptual)

```json
{
  "requestId": "req-01",
  "operationId": "op-01",
  "subjectId": "human-01",
  "projectId": "project-01",
  "computerId": "computer-01",
  "action": "start",
  "expectedGeneration": 12,
  "policyVersion": 3,
  "targetDigest": "sha256:..."
}
```

Transport: local authenticated IPC with restricted OS ACLs between low-privileged Control API and privileged broker; protocol versioned and schema validated. Do **not** trust a `subjectId` string supplied by the client: derive identity from authenticated transport and match the stored authorization record. If network broker is introduced later, require mutual authentication, replay defenses, strict firewall binding and rotation.

Response: operation ID, persisted observed state, provider timestamps, typed error code. Never include secrets, arbitrary guest output or sensitive host paths in default Canvas event streams.

## VM connectivity

- Bootstrap through controlled imaging and one-time enrollment; establish per-computer/run identity. A compromised guest can misuse its current granted authority, so minimize capabilities.
- For Ubuntu guests, prefer guest-initiated authenticated connection to a **narrow host-side Guest Session endpoint**, reachable only from approved isolated vNIC and authenticated. Separate this endpoint from the privileged Hyper-V broker.
- For Windows guests, PowerShell Direct may assist bootstrap, but only for supported Windows guests and only through privileged operations; not a generalized Linux remote interface.
- Network: private switch blocks direct external network at layer 2, but may need a separate carefully configured host-mediated control path. Internal switch with NAT gives network access, and therefore is **not** itself an isolation policy. Require testable default-deny host firewall/proxy controls; account for IPv6, DNS, proxies, alternate NICs.

## Minimum audit data

Record immutable/append-only: actor, authenticated subject, project, action, target digest, policy version, approval ID if relevant, operation/lease/generation, decision, observed provider result, timestamps, correlation ID, evidence hashes. Sensitive logs must be redacted and subject to retention/access control. An append-only local DB alone is not tamper-proof against a host admin; do not claim otherwise.

## Failure and recovery semantics

- **Lost Control API connection:** running guest actions continue only within valid preapproved scope and deadlines; no silent policy expansion.
- **Lost broker connection:** operation enters `UNKNOWN`; scheduler holds any conflicting claim; reconciliation inspects native VM before retrying.
- **Guest unresponsive / malicious:** revoke capabilities, block egress and quarantine; if necessary stop VM through broker.
- **Restore:** invalidate prior epoch before restoring; rotate enrollment after restoration; require new readiness proof and scoped authorization.
- **Host reboot:** reconcile registry vs Hyper-V native state; never launch duplicate workload because registry says `RUNNING` but state is uncertain.

## Rejected alternatives

- Adding mutable routes to existing unauthenticated read-only observer.
- Trusting Guest Agent event signatures as proof of an uncompromised guest.
- Full guest administrator plus unrestricted host shared volumes.
- Putting Hyper-V admin credentials inside a model context or environment variable copied to guest.
- Treating Hyper-V default virtual switch, NAT, or private switch alone as a tested egress-control architecture.
- Automatically granting Main AI human sign-off capability.

## Security acceptance tests

**S1 — Unauthorized callers:** unauthenticated calls, cross-project access, stale approvals and mismatched operation hashes return denial. S2 — Forged guest: emits fake success, old epoch and incorrect computer ID; neither privileged broker nor verifier trusts it. S3 — Rollback: restore guest snapshot with previously valid token; stale token denied. S4 — Network: verify from guest that host administrative endpoints, LAN and unauthorized internet are not reachable; allowed enrollment session remains reachable. S5 — Crash/replay: force restart between journal write and Hyper-V action and after native action before reply; no duplicate VM created or accidental privilege. S6 — Bad path/input: native IDs, image paths and strings cannot inject shell or escape authorized roots. S7 — Independent verification: deliberately forged passing guest test fails to promote integration without external rerun. S8 — Desktop input fencing: old AI commands cannot act after human takeover.

## Risks and decisions pending

1. Host broker identity, transport and privilege separation under Windows (dedicated service account, named-pipe ACL, executable signing).
2. Isolated network topology, guest bootstrap endpoint and enforceable egress model; proof must precede use with untrusted source code.
3. Image supply chain, updates, guest enrollment/attestation limits, secret broker design.
4. Local-only mode multi-user boundary vs future organizational tenancy.
5. Whether a full-admin guest is needed initially; prefer unprivileged guest user for PoC.

**Acceptance gate:** G0 requires broker/API boundary contract tests; G2 requires real Hyper-V network negative tests and stale-epoch restore test before enabling autonomous untrusted workloads.