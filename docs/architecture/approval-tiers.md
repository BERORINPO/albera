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
| careful | every action that is not read-only (today's behaviour, minus inspects) | first use, important work |
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

1. `environment.retire` + the Broker's retirement journal and scheduled purge; `environment.purge` (always prompts). No tier yet: every action still prompts.
2. Network attestation from the Broker (adapters and switches, bound to incarnation and lease generation).
3. Receipt v3 with `basis`, the policy file, the Hello-signed policy change, the careful and standard tiers. `environment.destroy` keeps prompting.
4. Checkpoint before `task.start` (measure the cost in the VM lab first).
5. Scoped grants (delegated tier) and the approval-screen text for them.

Each step ships on its own and keeps today's behaviour until the owner picks a tier.

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
