# Approval tiers and reversible-by-default actions: design notes

**Status: Proposed, NOT IMPLEMENTED.** Owner direction (2026-10-31): fewer Windows Hello prompts, by (A) turning irreversible actions into reversible ones and (B) letting the owner pick how much needs a prompt, in steps. Nothing here changes the code yet. A Codex review of the first draft (1 CRITICAL, 5 HIGH) is folded in; the review notes are at the end. Related: [approval-authority.md](approval-authority.md), [approver-app.md](approver-app.md), ADR-002 "Receipt v2".

## Problem

Today every Broker operation needs one human approval (one Hello prompt per operation), including read-only ones. The safety comes from the Authority signing a receipt only after a presence signature over the exact action digest. That is the right floor for actions that cannot be undone, and too much for actions that can.

## Principle

A prompt is only needed when an action cannot be undone. So, in this order:

1. **Make the action undoable** where the Broker can (A). Only an action that the Broker itself makes undoable may skip the prompt.
2. **Let the owner set the tier** (B): which of the remaining actions prompt, and whether a scoped grant may cover several of them.
3. **Never let the AI side decide.** The tier policy lives in the Authority's own config (guarded by ServicePathGuard, exit 73), the Authority applies it, and the Broker still accepts only receipts signed by the Authority. The Control Plane cannot skip, lower or choose a tier, and nothing it claims about an action (that it is scheduled, that it has no network) is trusted.
4. **Unknown means prompt.** When the Authority cannot establish a fact a no-prompt rule depends on, the action prompts.

## A: reversible by default

The actions are fixed by `ACTIONS_BY_PURPOSE` (`src/runtime/broker-contract/action-digest.mjs`). Existing actions keep their meaning; undoable variants are **new action names**, so an old Broker or provider can never receive a no-prompt receipt for an action it still executes destructively.

| Action | Undoable? | Prompt at "standard" |
|---|---|---|
| `environment.inspect`, `workspace.inspect` | read-only | no |
| `environment.stop`, `task.cancel` | reduces risk | no |
| `environment.start` | yes (stop) | no, **only for an environment the Broker attests has no network** (see egress) |
| `environment.create` | yes (retire), costs disk | no, within a per-project quota and only without a network adapter |
| `environment.destroy` | **no** (deletes the disks) | **yes, at every tier**, unchanged |
| `environment.retire` (new) | yes: stop, detach from the project, keep the disks for a retention period (default 7 days) | no, once the Broker reports the `retire` capability; before that the action does not exist |
| `environment.purge` (new) | no | yes, at every tier; it can never be covered by a grant |
| `task.start` | inside the VM: yes if the Broker took a checkpoint first; outside (network): no | no only when the Broker attests a checkpoint and no network for that environment incarnation (one signed task-start attestation, see "Step 4 as built"); otherwise yes. Never at `careful`, never when an override says prompt |

**Purge after retention is not a receipt.** The Broker records each retirement in its own durable journal (environment incarnation id, retirement time, deadline). When the deadline passes, the Broker purges on its own from that record. The Control Plane cannot ask for an early purge without `environment.purge` and a prompt, and no field it sends ("scheduled", a retirement time) is read.

**Egress is decided by the Broker, not the request.** The Broker reads the effective network configuration of the environment (attached adapters and switches) and returns it, with the environment incarnation id and lease generation, as a Broker-signed attestation the Authority checks before applying a no-prompt rule. The attestation is bound into the receipt, so a receipt issued for "no network" is refused if the environment was changed afterwards. No attestation, a stale one, or "has network" means prompt. This covers `environment.start` too, so a VM that talks to the network at boot cannot be started without a prompt.

Open points for A: the retention disk budget (when full, refuse new creates and retires, never purge early), and the Hyper-V checkpoint cost per task (measure in the VM lab before choosing).

## B: three tiers

| Tier | Prompts for | Use |
|---|---|---|
| careful | every action, including inspects (today's behaviour; the default when no policy file exists) | first use, important work |
| standard (default) | `environment.destroy`, `environment.purge`, anything with network or without an attestation, anything over quota | everyday |
| delegated | as standard, but one prompt can approve a **scoped grant** that covers later matching actions | long unattended runs |

- **Per-action override**: the owner can make one action prompt even when its tier would not (for example: standard, but `task.start` always prompts).
- **A policy change that removes a prompt needs Hello.** The rule is by effect, not by tier name: any change that makes the set of no-prompt actions larger (careful to standard, standard to delegated, removing an override, adding a grant) is an approver-pipe request with a presence signature over the hash of the complete new policy. A change that only adds prompts needs none. The approver pipe is checked by SID only, so a process running as the approver could send such a request; without the presence signature it is refused.
- **Every policy change revokes every grant**, including a change that only adds prompts.

### Scoped grants (delegated tier)

> **Not built (provisional, 2026-11-01).** After step 4 (#132) every action a grant may cover (an attested `environment.start` or `task.start`) already needs no person at the standard tier, and a grant may never cover `environment.destroy`, `environment.purge`, `environment.create` (no attestation is possible before the VM exists) or anything with a network. So a grant would remove no prompt today. Build it only when a prompt appears that a grant could legitimately cover; the rules below stay the design for that day.

- One Hello over `{ actions, projectId, environmentIncarnationIds, leaseGeneration, policyHash, maxCount, expiresAt }`, at most 8 hours, shown on the approval screen in plain words.
- Bound to environment **incarnations**, not to reusable computer ids: retiring an environment and reusing its name for a new VM does not carry the grant over. A lease generation change or a policy change ends the grant.
- Never covers `environment.destroy`, `environment.purge`, or an action without a no-network attestation.
- The count is consumed atomically: the Authority checks the grant, takes one from the count and reserves the signature in one critical section, so two concurrent requests against a count of 1 get one receipt and one prompt. A receipt is never issued with `exp` later than the grant's `expiresAt`.
- Kept in memory only: an Authority restart forgets every grant, which is safe (the next action prompts).

## How the Authority signs without a prompt

- This needs **receipt v3**. Receipt v2 rejects unknown fields, so a new field cannot be added to it. v3 adds `basis`: `presence` (a person approved this action), `grant:<id>` (covered by a scoped grant) or `policy` (the tier needs no prompt), plus the attestation digest when a no-prompt rule used one. `policyVersion` becomes the hash of the policy in force. The Broker keeps accepting v2 receipts, which are always presence-based.
- The Authority computes the action digest itself, as today, so it decides the tier from the action it will sign and from Broker attestations, not from anything the Control Plane claims.

## What stays the same

Two pipes, one principal each; the Authority computes the digest; receipts expire after 120 s; challenges are single use; every Broker restart raises the epoch (issue #84). A tier only decides whether a person must sign. It never widens what a receipt allows.

## Order of work

The order is chosen so that no step can make a destructive action promptless on its own.

1. `environment.retire` + the Broker's retirement journal and scheduled purge; `environment.purge` (always prompts). No tier yet: every action still prompts. **Done in PR #118 (2026-10-31)**, see "Step 1 as built" below.
2. Network attestation from the Broker (adapters and switches, bound to incarnation and lease generation). **Done in PR #120 (2026-10-31)**, see "Step 2 as built".
3. Receipt v3 with `basis`, the policy file, the Hello-signed policy change, the careful and standard tiers. `environment.destroy` keeps prompting. **3a done in PR #123 (2026-10-31)**: the tiers and the four actions that need no attestation; see "Step 3a as built". **3b done in PR #126 (2026-10-31)**: `environment.start` with a `none` attestation; `environment.create` stays with a person (no VM exists to attest); see "Step 3b as built".
4. Checkpoint before `task.start` (measure the cost in the VM lab first). **Measured 2026-10-31**, see "Step 4: checkpoint cost"; the Production checkpoint type is chosen (provisional). **Built (this PR, 2026-10-31)**: `task.start` is signed without a person at the standard tier for one Broker task-start attestation; see "Step 4 as built". Restore (undo) is not built.
5. Scoped grants (delegated tier) and the approval-screen text for them. **Not built (provisional, 2026-11-01)**: after step 4 a grant would remove no prompt; see "Scoped grants".

Each step ships on its own and keeps today's behaviour until the owner picks a tier.

## Step 1 as built (PR #118)

- The retirement record lives in `src/runtime/environment-retirement-journal.mjs`: a SQLite file (WAL, `synchronous=FULL`, every change one `BEGIN IMMEDIATE` transaction) handed only to Broker-side code. Each record holds computerId, generation, projectId, the VM's own Hyper-V id, a random 128-bit incarnation id, the retirement time and the deadline. The time and the deadline come from the journal's clock; a repeated retire returns the existing record, so the deadline cannot be extended.
- Retire writes the record, then the incarnation and project into the VM's Notes. Retire retry, requested purge, scheduled purge (`purgeExpiredRetirements`, not yet on a timer) and destroy of a recorded VM all require the VM id, project, generation and incarnation to match. A mismatch is not applied and the record is kept; a failure to drop a record is an unknown outcome, never success.
- `environment.destroy` without a record behaves exactly as before. With a record, it refuses a VM that does not match it.
- Operation store schema v5 to v6 (the action CHECK constraint now includes retire and purge).
- Known limits:
  - The real `env-io.ps1` identity checks were first run on real Hyper-V with PR #122 (see Step 2 as built).
  - A record that matches no surviving VM (for example a restored copy with another VM id) stays until an operator removes it, and it blocks create and start of that id.
  - Restoring a backup of the retired VM in place with the same Hyper-V VM id is treated as the same VM (it would be retired and later purged). The Broker cannot tell the two apart; destroy still prompts, and purge only runs after the retention period.
  - No retention disk budget yet; the Control Plane store does not release the lease after retire.
- Reviews: Codex, three rounds (5 HIGH, then 2 HIGH, all fixed; the last finding is the in-place restore limit above).

## Step 2 as built (PR #120)

- Contract `src/runtime/broker-contract/network-attestation.mjs` (pure, pinned by `network-attestation-vectors.json`): a 10-key body (v, network, computerId, vmId, generation, projectId, leaseId, leaseGeneration, observedAt, expiresAt; TTL 60 s by default, at most 300 s), a domain-separated canonical digest (`albera.network-attestation.v1`), a signed envelope `{attestation, digest, keyId, signature}`, and `verifyNetworkAttestation`, which checks the signature first and reads the clock after it, then refuses an expired or not-yet-valid statement and any binding that differs from what the caller expects.
- Classification: no adapters = `none`; any well-formed adapter, connected or not = `present`; anything unreadable or malformed = `unknown`.
- Produced Broker-side only: a read-only `network` method in `env-io.ps1` returns the VM id and its adapters in one observation; `attestNetwork` on the Hyper-V Broker prototype signs through a signer port (a fake HMAC signer in tests; no real key yet). The project comes only from the VM's Notes, which `create` now writes; a VM without a project in its Notes is refused, so VMs created before this change cannot be attested until re-created.
- Nothing consumes the attestation yet (step 3b will, with a C# twin and a real signature).
- Known limits: pass-through physical NICs (DDA / SR-IOV) are not read.
- Since PR #122, `create` removes every network adapter and fails (rolled back) if one remains, so a new VM attests `none`. Real Hyper-V run on the host (2026-10-31, Windows Server 2025 golden image, 5/5 pass in about 18 minutes): create with 0 adapters and a `none` attestation; retire stops the VM, refuses start, keeps the disk and writes project + incarnation into the Notes; requested purge removes VM, disk, folder and record; scheduled purge does nothing 1 ms before the deadline and purges at it; destroy without a record is unchanged; the golden image hash is unchanged.
- Reviews: Codex, two rounds (3 HIGH, all fixed).

## Step 3a as built (PR #123)

- Receipt v3 (`receipt-v3.mjs`, `ReceiptV3.cs`, `test-vectors-v3.json`): the v2 fields plus `basis` (`presence` | `policy`; `grant:` is refused); `policyVersion` is the hash of the policy in force. Presence receipts stay v2, byte-identical to before; only policy-signed receipts are v3. The contract itself refuses `basis: policy` for anything outside `environment.inspect`, `environment.stop`, `workspace.inspect`, `task.cancel`.
- Policy file, signature and folder rules: approval-authority.md, "Tier policy (exit 79)". Approver commands: approver-app.md, "Tier policy".
- Built differently from the first design: `careful` prompts for inspects too (it is exactly today's behaviour); `synthetic.noop` is not in the no-prompt set (a Broker claim writes a journal row); a `rev` counter was added so a captured signature cannot be applied twice.
- Known limits: the real .NET Broker still claims only `synthetic.noop`, so a policy receipt for a real action cannot be claimed end to end yet; the Broker cannot compare `policyVersion` for v3 (the Authority's signature covers it); rollback of the file by a trusted writer is out of scope. The real service writing and reloading `policy.json` under the SCM passed in the VM lab (PR #125); a correctly signed loosening can only be made with a real Hello key, so that direction is host-tested only.
- Reviews: Codex, two rounds (2 HIGH: the policy was adopted at start without a signature, and a user could squat `policy.json` in an untrusted folder; both fixed). VM service lab on the branch: 25 pass, 0 fail, 1 blocked (as before).

## Step 3b as built (PR #126)

- At the standard tier the Authority signs `environment.start` without a person only when the submit carries a Broker network attestation that verifies against the key pinned in the Authority's config, says `none`, matches the submit's computer, project, lease, lease generation, generation and Hyper-V VM id, and has at least 10 s left. The receipt (v3, `basis: policy`) carries `attestationDigest` and ends no later than the attestation. Anything else queues for a person.
- `environment.create` is not attested (no VM exists before it) and always needs a person. The policy hash domain moved to `albera.policy-hash.v2`, so a standard policy signed earlier has to be signed again with Hello.
- Reviews: Codex (one HIGH: an attestation for one VM could start another VM with the same ids; fixed by binding the VM id), CISO (no CRITICAL or HIGH; the remaining MEDIUM and three LOWs are #128). VM service lab: 31 pass, 0 fail, 1 blocked (session 0, as before).
- Known limits: the Windows Broker has no `attest` verb yet and does not execute a start (it only records claims).
- Follow-ups from the CISO review (#128), enforced where execution exists today (`environment-operations.mjs`, the Hyper-V prototype, the mock provider), not in the Windows Broker:
  - `bindStartToReceipt` builds the start operation from the Broker-verified receipt: an attested-policy `environment.start` gets its `vmId` from the receipt's action (`attested_start_requires_vm_id` if it names none; a different `vmId` from the Control Plane is `operation_conflict`) and the marker `attestedPolicy: true`. `validateEnvironmentOperation` refuses the marker without a `vmId`. When the Broker executes starts, it must go through the same function.
  - A provider that sees `attestedPolicy` reads the adapters again right before the start (Hyper-V: the `network` call, same observation as the VM id) and refuses unless `none` (`network_not_isolated`, not applied). A person-approved start is not held to this. A gap remains between that read and the script's start (the script checks the VM id only).
  - When the attestation is valid but the receipt cannot be signed, the Authority queues the request for a person (audit `ATTESTATION_REFUSED=sign_failed`) instead of answering `authority_unavailable`. A plain no-attestation policy action keeps `authority_unavailable`.

## Step 4: checkpoint cost (measured 2026-10-31)

`test/windows-service-lab/checkpoint-cost.ps1` takes a checkpoint of a disposable offline 4 GB / 2 CPU VM, writes random data in the guest, restores, checks the data is gone, and discards the checkpoint. Raw numbers: `benchmarks/task-start-checkpoint-cost-2026-10-31.json` (one host, few samples).

| | Production (VSS in the guest) | Standard (saves guest RAM) |
|---|---|---|
| Create | 16 to 51 s, typically about 20 s (4 runs) | 32 and 48 s; **1 of 3 failed** (timed out saving RAM) |
| Restore until the guest answers | about 2.2 min (restores to Off, then boots) | 31 and 46 s (keeps running) |
| Discard (merge) | about 29 s | about 14 s |
| Extra host disk | the written data plus 0.1 to 0.2 GB | the same, plus about 1 GB of guest RAM |
| Restore undid the write | yes, every time | yes, every time |

Choice (provisional, decision log `2026-10-31+task-checkpoint`): **Production**. It never failed, and it does not copy the guest's memory (which may hold secrets) to the host disk. Plan for the build:

- The Broker takes the checkpoint itself as the first part of `task.start`. If it fails, there is no checkpoint attestation, so the start needs a person (unknown means prompt). Built with `ProductionOnly`, see "Step 4 as built".
- One checkpoint per environment incarnation: the one before the latest task. Taking the next one discards the previous one (the merge runs in the background, about 30 s).
- Cost: about 20 s more per task start. Undo costs about 2 minutes and is rare.
- Undo (going back to the checkpoint) throws away the task's work, so it starts as an action that always needs a person; whether it may become promptless is decided later.

## Step 4 as built (task-start attestation)

Before a `guest.command` / `task.start` is submitted, the Hyper-V Broker side takes a Production checkpoint of the VM and signs ONE statement that says "no network" and "this checkpoint was taken". At the `standard` tier the Authority then signs `task.start` with basis `policy` (no person). Without a valid statement nothing changes: a person is asked.

- **Contract** `src/runtime/broker-contract/task-start-attestation.mjs` (C# twin `TaskStartAttestation.cs`, pinned by `task-start-attestation-vectors.json`: 51 digest and 79 signed cases, one ephemeral key). It is its own kind next to the network attestation: domain `albera.task-start-attestation.v2`, a 14-key body (the network attestation's `network`, computerId, vmId, generation, projectId, leaseId, leaseGeneration, observedAt and expiresAt, plus `operationId`, `actionDigest` (the `sha256:` action digest of the guest.command DTO the Authority will sign), `checkpointId` (the Hyper-V snapshot id, a lowercase GUID) and `checkpointType` `production` or `standard`). v2 is #133: `actionDigest` was added, so the domain and the version moved together and a v1 statement is `malformed`. Same Broker key, same ECDSA P-256 signature, same TTL rule (60 s by default, at most 300 s). A network attestation is `malformed` as a task-start one (other keys) and a task-start one is `malformed` as a network one; a body signed under the other domain fails the signature or the digest. Tested both ways in Node, in the C# harness and through the real Authority process.
- **Receipt v3 is unchanged in shape.** The statement's digest travels in the same `attestationDigest` field; `task.start` joined `ATTESTED_POLICY_BASIS_ACTIONS` (Node and C#), so the contract now requires, for a policy-basis `task.start`, the digest and `args.vmId` (a lowercase GUID). A policy receipt for `task.start` without them is refused by both validators. No schema change.
- **Authority, standard tier only.** It signs `task.start` without a person only when the submit's statement verifies against the pinned key, says network `none` AND `checkpointType` `production`, is bound to the DTO's computerId and projectId, the submit's lease, lease generation and **operationId**, to the **action digest the Authority computed itself** from the DTO it would sign (#133: one statement backs exactly one action, so the same operation resubmitted with another task needs its own statement; this is stateless, unlike refusing a second receipt per operationId, which an Authority restart would forget), and the `vmId` and `expectedGeneration` args (filled in by the Control Plane from its own inspect and covered by the action digest, so a person would see them), and has at least 10 s left. The receipt ends no later than the statement. Anything else queues for a person, with a fixed-word audit reason (`checkpoint_standard`, `network_present`, `binding:operationId`, `malformed:$extra` for the other kind, and so on). A per-action override that makes `task.start` prompt wins over a valid statement; `careful` always asks a person.
- **Broker.** `attestTaskStart({ computerId, projectId, leaseId, leaseGeneration, generation, vmId, operationId, actionDigest })` on the Hyper-V prototype (`actionDigest` is only echoed into the statement; the flow passes the digest of the DTO it submits and attaches the statement only if it names that digest): read the network (must be `none`; the VM must be ours at that generation and project, with the VM id the approval names, and not retired), then the new fixed `checkpoint` op of `env-io.ps1`, then read the network again (still `none`, same VM id), then sign at the Broker's clock. Any failure returns `null` (never an error): no statement, a person is asked. The `checkpoint` op sets `CheckpointType ProductionOnly` only if the VM has another value, calls `Checkpoint-VM` once with a name `albera-task-<24 hex of SHA-256(operationId)>` that it checks against that exact shape, and puts the VM's own `CheckpointType` back in a `finally` (#133: no lasting change to the VM's configuration; if the put-back fails the VM stays `ProductionOnly`, the safe direction, and the op reports an unknown outcome, i.e. no statement). It does nothing else (a test pins the cmdlets and arguments). **What is not observed (#133):** `checkpointType: "production"` is attested from the configured `ProductionOnly` (under which `Checkpoint-VM` fails rather than falling back to Standard) plus the success of the call, not read back from the snapshot. `Get-VMSnapshot` reports `SnapshotType: Standard` for a ProductionOnly checkpoint (real host, 2026-10-31), and no other read-only property of the Hyper-V module is known to tell the two apart, so there is nothing to verify here yet; `scripts/task-start-attestation-real.mjs` prints candidate properties (informational) for the host check. No checkpoint is restored, removed or merged anywhere. The flow calls the optional `broker.attestTaskStart` for `task.start` as it calls `broker.attest` for `environment.start`.
- **Policy hash domain `albera.policy-hash.v3`.** "standard" now also means attested `task.start`, so a standard policy signed under v2 no longer verifies and needs a new Hello signature (the same reason as step 3b's v2). The Windows Broker accepts a `task.start` DTO whose args are `{ task }` alone or `{ task, vmId, expectedGeneration }` (it only records the claim; it does not start anything yet).
- **Known limits.** (1) Nothing starts a process in the VM yet, so nothing yet compares the attested VM id with the VM that runs the task. (2) Older ALBERA checkpoints are never deleted: every attested `task.start` leaves one (about the data the task writes plus 0.1 to 0.2 GB, as measured), so host disk grows until a clean-up exists; "one checkpoint per incarnation" is not enforced. (3) Restore (undo) does not exist. (4) The Windows Broker has no `attestTaskStart` verb yet; only the Hyper-V prototype (same user, not the privileged Broker) makes the statement. (5) The `checkpoint` op was not run on real Hyper-V by the change's author: `ProductionOnly` (not `Production`, which falls back to a Standard checkpoint, saving guest memory to the host disk, when the guest cannot freeze its disk) is untested until the host check. (6) A typical `task.start` with its statement is about 1.2 KB of the Authority's 2 KB frame; if one does not fit, the flow submits without the statement and a person is asked.

## Room start approval (A3: `room --require-start-approval --approval <file>`)

The control room can start a hand only after a `guest.command` / `task.start` operation was claimed by the Host Broker. `src/runtime/room-approval-wiring.mjs` builds that path from one settings file: it opens the durable flow journal (`flowJournal()` of the SQLite operation store), binds the real Broker and Approval Authority pipe clients, builds the gate (`task-start-gate.mjs`) over the approved-operation flow, and hands the gate to the room host. The room's fleet is created with no jobs; each initial job (and each job a decision card starts) is requested through the gate and appears as `start_approved` or `start_refused {code}` in the ledger. Nothing starts on a denial, an expiry, a failure or an unknown outcome.

Settings file (`examples/albera.approval.example.json`; strict, unknown keys refused; names and paths only, no secret; a bad file is exit 2 with a fixed `runtime_room_approval_*` code and prints neither the content nor a path):

| Field | Meaning |
|---|---|
| `projectId` | the project the operations belong to (the Authority's policy and the approver's screen show it) |
| `broker.pipeName`, `broker.expect` | the Host Broker's pipe and what the pipe client must find on the server before it writes (`serviceName`, optionally `ownerSid` / `imageSha256`) |
| `authority.pipeRoot`, `authority.expect` | the Approval Authority's pipe root (`<root>\submit\v1` is used) and the same server expectation |
| `journal` | absolute path of the SQLite operation store that holds the flow's records (private folder; the store checks its own ACL) |
| `computers` | Hyper-V VM name of the room -> `computerId`. A VM that is not listed is refused, and so is a task that cannot be a `task.start` argument (empty, over 256 UTF-8 bytes, control characters), before any request. An entry may also name the VM's Hyper-V id and generation (`vmId`, `expectedGeneration`) |
| `attestation` | `null`, or `keyFile` (PKCS#8 PEM P-256 private key), `keyId`, `cloneRoot`: the Hyper-V Broker prototype's `attestTaskStart` is given to the flow |

How the person is skipped: with `attestation` set and a computer that names `vmId` + `expectedGeneration`, the gate adds those two args to the `task.start` action (the Broker accepts `{ task }` or `{ task, vmId, expectedGeneration }`), the flow asks the prototype for a checkpoint attestation, and a `standard`-tier policy may then sign without a person. Everything else (no `attestation`, a computer without `vmId`, any failure of the checkpoint) asks the person, exactly as before. The prototype looks the VM up as `albera-<computerId>`, so only VMs made by the environment Broker can be attested.

First real run on the host (none of this was run by the author; see "not verified"):

1. Install and start the Host Broker and the Approval Authority services, `AlberaApprover.exe enroll` + `enroll --check`, and sign a policy (`approver-app.md`, `approval-authority.md`).
2. Make a private folder for the journal, write `albera.approval.json` from the example (real pipe names, service names, `projectId`, VM -> computer map; leave `attestation` `null` for the first run).
3. `albera-runtime room --job <vm>=<task> --require-start-approval --approval albera.approval.json` (with `ANTHROPIC_API_KEY` set). Approve the `task.start` in the approver app; the ledger shows `start_approved` and the hand starts.
4. Only after step 3 works: create the attestation key (a person, outside this repository), pin its public key and key id in the Authority's config, set the standard tier, add `attestation` and the VM ids to the file.

Not verified: no real Broker, Authority, Hello approval, Hyper-V checkpoint or SQLite store was involved in any test (fakes only). Known limits: the journal keeps unfinished operations of an earlier run but a new room run never resumes them (each start is a new operation id); the prototype is same-user, not the privileged Broker; the Windows Broker still only records the claim and does not start a process, so "approved" does not yet mean the hand is bound to the approved task by the Broker.

## Review of the first draft (Codex, 2026-10-31)

| Severity | Finding | Change above |
|---|---|---|
| CRITICAL | Changing `environment.destroy` in place to mean retire, with tiers shipping first, would let a standard-tier receipt destroy disks for good | Existing actions keep their meaning; `retire` / `purge` are new names; destroy always prompts; retire ships first |
| HIGH | "Scheduled purge needs no prompt" had no trusted owner of the schedule | The Broker purges from its own durable retirement record; no receipt, no Control Plane field |
| HIGH | Egress had no trusted input, and `environment.start` bypassed it | Broker-signed network attestation bound to incarnation and lease generation; start is covered too |
| HIGH | "Raising the tier needs no Hello" was ambiguous by tier number | Rule by effect: any change that grows the no-prompt set needs a presence signature over the new policy hash |
| HIGH | Grants not bound to environment incarnation or policy | Bound to incarnation, lease generation and policy hash; every policy change revokes all grants |
| HIGH | `maxCount` not consumed atomically; receipts could outlive the grant | One critical section for check, consume, reserve; `exp <= expiresAt` |
| note | "Receipt stays v2" contradicts the v2 validator, which rejects extra fields | Receipt v3 |
