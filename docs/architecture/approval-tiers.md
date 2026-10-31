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
| `task.start` | inside the VM: yes if the Broker took a checkpoint first; outside (network): no | no only when the Broker attests a checkpoint and no network for that environment incarnation; otherwise yes |

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
3. Receipt v3 with `basis`, the policy file, the Hello-signed policy change, the careful and standard tiers. `environment.destroy` keeps prompting. **3a done in PR #123 (2026-10-31)**: the tiers and the four actions that need no attestation; see "Step 3a as built". 3b (start / create with a `none` attestation) is next.
4. Checkpoint before `task.start` (measure the cost in the VM lab first).
5. Scoped grants (delegated tier) and the approval-screen text for them.

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
