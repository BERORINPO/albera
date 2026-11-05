# Mission approval: talk to Bero, approve once, let it work

**Status: Proposed, NOT IMPLEMENTED.** Owner decision 2026-11-05: the room should be something you talk to, and the AI then works by itself inside what you allowed, not a form that starts one job at a time. Of the three options in the mock (`U:\dev\artifacts\albera-mocks\v1-talk-first.html`) the owner chose "approve once for a range". This builds the "Scoped grants" section of [approval-tiers.md](approval-tiers.md), which was left unbuilt because no prompt needed it; this is that prompt. It also starts roadmap phase 7 (Orchestration) and answers ORC-01.

## Why today's room is not that

- Bero is rules and dictionaries (`bero-director.mjs`, "no LLM"). It cannot hold a conversation or split a goal into tasks.
- Every `task.start` needs a person. The no-person path at `standard` needs a Broker task-start attestation, which exists only in the same-user prototype (owner decisions AGM-1 and AGM-2 gate the Windows Broker's version).

## Shape

```
person ──talks──▶ room (Control Plane) ──▶ main AI adapter (Claude Code, no tools, JSON out)
                        │  a proposal, validated by the host
                        ▼
                 mission card ──"Hello"──▶ submit mission.start ──▶ approver window: match code, Hello
                                                                        │ presence over the exact action
                                                  Authority: receipt + GRANT (in memory) ◀┘
main AI: next task ─▶ host checks ─▶ submit task.start + grantId ─▶ Authority: check grant, count - 1,
                                                                    receipt v3, basis grant:<id>
                                                                        ▼
                                              Broker: claim, desktop lease ─▶ hands in the VM
```

The rule from approval-tiers.md stays: the AI side never decides. The main AI can only propose and ask. The range is held by the Authority, not by a prompt or by the Control Plane.

| What | Who decides | Can the AI change it |
|---|---|---|
| The range (VM, number of starts, minutes) | the person, once, with Hello | no: it is in the digest the person signs |
| The goal text | the main AI writes it, the person reads it | it is a label, signed but not enforced: nothing checks that a task serves it |
| Each task text inside the range | the main AI | yes, that is the point. A person does not read it first. The receipt keeps only its digest; the text itself is only in the Control Plane's ledger |
| Whether a start is inside the range | the Authority | no |
| Stop | the person, in the room or in the tray (or the end of the time or count) | the AI can only finish early |

## Contract (fixed before the phases are built in parallel)

**`mission.start`**: a new action in `ACTIONS_BY_PURPOSE` under `guest.command`, Node and C#, in neither skippable list, so a person signs it at every tier. A new name, not a field on `task.start`, so an older Broker refuses it.

```
{ action: "mission.start", projectId, computerId,
  args: { goal, maxStarts, minutes, vmId, expectedGeneration } }
```

- `goal`: the same rules as a task (safe text, 1 to 256 UTF-8 bytes).
- `maxStarts`: 1 to 20. `minutes`: 5 to 480 (approval-tiers.md: at most 8 hours).
- `vmId`, `expectedGeneration`: required. A grant is bound to this VM, not to a computer name that can be reused.
- The computer must be on `missionComputers` in the Authority's config (written by the elevated installer, one entry per VM the owner names). Any other computer is refused before a person is asked. This is where the owner states "this VM may be handed over"; the Control Plane cannot add to it.
- The `approve` command refuses `mission.start`: it does not show the fixed lines of the window.
- The Broker records the claim and creates no desktop lease (like `synthetic.noop`).

**The grant.** When the person's `decide` on a `mission.start` verifies, the Authority makes one record, in memory only, and returns its id on `status`:

```
{ grantId, projectId, computerId, vmId, expectedGeneration, brokerEpoch, leaseGeneration, remaining: maxStarts, expiresAt, policyHash, approverKeyId, approvalId }
```

- `grantId`: 128 random bits from the Authority, base64url. The Control Plane cannot choose it. One live grant per computer: a new mission on the same computer ends the old grant.
- `expiresAt` is counted from the moment the person decided, at the Authority's clock.
- An Authority restart forgets every grant. The next start asks a person.
- A policy change, `key_remove` and an expired or used-up grant end it.

**Using a grant.** `submit` takes one new optional field, `grantId`. The Authority signs without a person only when ALL hold, in one critical section with the count:

- the action is `task.start` and nothing else (the allow-list is one name; `environment.*`, `task.cancel` and `mission.start` are never covered);
- the tier is not `careful` ("every action needs a person" stays true at `careful`, so using missions needs a one-time `policy set standard` with Hello);
- the grant is live, `remaining` > 0, and its `policyHash` is the policy in force;
- `projectId`, `computerId`, `args.vmId`, `args.expectedGeneration`, `brokerEpoch` and `leaseGeneration` equal the grant's;
- no per-action override says `task.start` prompts.

Anything else queues for a person, exactly as if `grantId` was not sent (unknown means prompt), with a fixed-word audit reason. It never fails open and never answers which check failed to the submit pipe.

**Receipt.** v3 with `basis: "grant:<grantId>"` (the shape v3 reserved; the validators refuse it today) and a signed `leaseUntil` equal to the grant's `expiresAt`. `exp` is never later than `expiresAt`, and the Broker sets the desktop lease's end to the earlier of its usual 60 minutes and `leaseUntil`: without this a 5-minute mission could keep the desktop for 65 minutes. Both validators (Node, C#) allow that basis for `task.start` only. `approverKeyId` is the grant's: the person who signed the range. Audit line `GRANT_SIGNED=<grantId> <approvalId>`. A grant receipt is not shown by the approver's `list`, like a policy receipt, and shares the 64-entry cap for 120 s.

**Ending.** `grant_end { grantId }` on both pipes. It only takes power away. On the submit pipe the Control Plane calls it, and "Stop everything" calls it for every live grant before it stops the hands. On the approver pipe, with `grants` (live grants: id, computer, goal, remaining, `expiresAt`), it backs a stop button in the tray, so a person can end a mission even when the Control Plane does not listen. Replies `{"ok":true}` for an unknown id too. Ending a grant stops new starts; a lease already running cannot be taken back (`control-plane-service.md` 6.6): the tray says so and offers to stop the VM.

**The approval window** shows, in plain words and before any digit is pressed: the goal; the VM; "up to N starts"; "for up to M minutes"; and three fixed lines: "The goal is what the AI wrote; the AI decides each task itself and you will not be asked for each one", "Inside this VM, what it does cannot be undone" and "If this VM has a network, effects outside it cannot be undone either; ALBERA has not checked that". The match code and Hello are as for any other request.

**Main AI adapter** `main-ai` (a Fake beside it):

- `turn({ words, state }) -> { say, propose?, next?, done? }`, at most one of `propose`, `next`, `done`.
- `propose`: `{ goal, computerId, maxStarts, minutes }`. `next`: `{ task }`. Both are validated by the host against the same rules as above; a reply that does not parse is one fixed line to the person and is never retried in a loop.
- Runs the pinned Claude Code executable in print mode with no tools, an empty MCP config, the owner's stored token and its own run folder. It holds no key, but as a child of the Control Plane it has the same identity and could reach the submit pipe, so "no tools" is the whole boundary: the adapter reads the `init` event and kills the child unless it reports 0 tools and 0 MCP servers (the check of section 6.3 expects six tools and does not fit here). The real adapter is not merged until M6 has shown that `--tools ""` does this.
- `say` is shown with `textContent` only, at most 2,000 characters, control characters removed.
- The person's words are the instructions. What the hands report and what a screen says go in as quoted data. Scope does not depend on the model obeying this: a hijacked main AI still only reaches `next`, which only reaches the grant.
- Turns per mission are capped at `maxStarts + 5`.

## Limits a person must be told

- **No undo inside the VM in this version.** Grant starts do not take a checkpoint (that is the Production Broker path).
- **This deviates from approval-tiers.md**, which says a grant never covers an action without a no-network attestation. No Windows Broker attestation exists, so v1 cannot read that fact in a trusted way. Provisional: a person-approved start is not held to it today, and a mission is a person's approval of N such starts, bounded in time and count, with the fixed lines above, on a VM the owner listed in `missionComputers`. What this widens: during the window, a compromised Control Plane or a hijacked main AI can run up to N tasks. The task text is not bound by the Broker, and during a lease any input can be sent to that VM, without a person reading it first. Why it is acceptable: the Control Plane has no Hyper-V rights and cannot give the VM a network, so on an offline VM nothing leaves it. The owner's listing is the statement that this holds.
- **The network is not checked.** `albera-clone-01` has one adapter on no switch (read on 2026-11-05): it is offline, so a task that needs a web page cannot work there. A mission cannot promise "read only" on the internet: nothing enforces it, and `control-plane-service.md` 6.6a asks that a VM handed to the hands has limited outbound traffic. Giving a VM a network is a host change and needs the owner.
- **No money limit.** The subscription gives no price per run (D4). The limits are count, minutes, and the existing per-task time and tool-call caps.
- **Not verified:** that the hands run at all under the service identity (M4), and what the subscription's limits do to a run (M5). Phase 0 comes first.

## Phases

| # | What | Merge tier | Needs |
|---|---|---|---|
| 0 | The hands really run: `token.cmd`, then one approved job on the real PC (M4) | owner step | nothing new |
| 1 | Talk panel in the room, `main-ai` adapter and Fake, `propose` shown as today's per-job approval. No Authority change: every start still asks | normal | 0 for the real adapter, not for the Fake |
| 2 | `mission.start`, `basis: grant:<id>`, `leaseUntil`, `missionComputers`, the grant in the Authority, `grants` and `grant_end`, the Broker's lease end, the approval window words, the tray's stop button. Node and C# vectors | security | contract above |
| 3 | The mission loop in the Control Plane: card, `next`, ledger lines, stop. Adversarial test for ORC-01 | security | 1 and 2 |
| 4 | Update the real PC, list the VM in `missionComputers`, `policy set standard` with Hello, first real mission, evidence in the ledger | owner step | 3 |

Phases 1 and 2 touch different files and can run in parallel. Each ends with the tests of its tier; 2 and 3 need Zaku and a VM run.

## Reviews

Zaku, one pass on this design (2026-11-05): no CRITICAL, 2 HIGH, 3 MEDIUM, all folded in above. No path to a receipt outside the range was found; the holes were what happens after a receipt (the lease outliving the mission) and the stop going only through the Control Plane. The no-attestation deviation was accepted on the condition of `missionComputers` and the third fixed line.

## Rejected

- **A `delegated` tier in `policy.json`.** It would make "no prompt" a standing state. A mission is one approval of one range and ends by itself.
- **The grant on disk.** A restart that forgets is the safe direction (approval-tiers.md).
- **Per-task review by a second AI.** It would add cost and still not be a person.
- **Letting the main AI write the range after the approval.** The range is in the digest.
