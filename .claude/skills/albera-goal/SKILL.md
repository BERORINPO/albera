---
name: albera-goal
description: Goal-driven development loop for ALBERA (BERORINPO/albera). Use when continuing ALBERA roadmap or Runtime work autonomously toward acceptance criteria, in a Codex /goal run or a Claude Code session. Covers evidence rules, what stops an agent and what to do instead, merge tiers and the hard limits.
---

# ALBERA Goal-Driven Development

Identical copies live in `.agents/skills/albera-goal/` (read by Codex) and `.claude/skills/albera-goal/` (read by Claude Code). `test/agent-skill-sync.test.mjs` fails when they differ, so edit both.

Keep moving safely: when one item stops, record why, hand off what only a person can do, and continue with the next independent item. Never fake progress to get past a stop.

## Where things are

| What | File |
|---|---|
| Current position (continuation ledger) | `docs/architecture/runtime-implementation-progress.md` |
| Requests to Yosuke | "Waiting on Yosuke" section at the top of that ledger |
| Decisions, one line each | `spec/architecture.md` section 4 |
| Acceptance IDs | `docs/architecture/acceptance-criteria.json` (authoritative) and `docs/architecture/acceptance-criteria.md` |
| v1.0 product gate | `docs/acceptance-criteria.md`; its evidence rows are in `docs/progress.md` (history: add a row only when a gate status changes) |

Do not add numbered files to `docs/decisions/`; numbers 0005, 0011 and 0012 already collide. Use the decision log.

## Loop

1. **Observe** — read the ledger's current position and "Waiting on Yosuke" first, then git status, branch, open PRs, CI and (Codex) the session-bus inbox. Preserve all existing changes. Never touch another agent's branch or worktree.
2. **Define** — list unmet criteria as `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED` or `VERIFIED`. `VERIFIED` needs a recorded command and result, or reproducible manual evidence.
3. **Plan** — choose the smallest item that unblocks others. Name the security boundary it touches and its merge tier.
4. **Implement** — on a new branch from current `origin/main`, in its own worktree. Stack at most one level on an unmerged PR. Keep the read-only Observer separate from execution. No server or UI integration before its security phase.
5. **Verify** — run the checks that fit (`npm test`, `npm run arch`, `npm run smoke`, `git diff --check`, platform and VM checks). Label synthetic and fake checks as such.
6. **Review** — authorization, executable resolution, argument handling, environment exposure, filesystem scope, process cleanup, output retention, cross-platform behaviour; then the review its merge tier requires.
7. **Repair** — fix what can be fixed safely and rerun. The same check failing 3 times in a row ends the item (see Stops).
8. **Record** — ledger entry with evidence, decision line, acceptance status. Never mark an unobserved result verified.
9. **Repeat** — next unmet criterion. After every 5 finished items, write a short checkpoint in the ledger (Codex: also send it to Velo over session-bus).

## Merge tiers

Yosuke does not review PRs (owner instruction, 2026-10-30), so a waiting PR is a stalled PR.

| Change | Required before merge |
|---|---|
| Docs, tests or test tools only | Tests and CI green |
| Normal code | Also one short review by another AI (Codex and Velo review each other, or Jin) |
| Security boundary (Broker, helper, approval, receipts, ACL, service host) | Also a Zaku review and a disposable-VM run |

- Velo (Claude Code) merges with `gh pr merge` once the tier is met. Merge is reversible by revert; never merge with red CI, never bypass branch protection.
- Codex does not merge (the fence blocks `gh pr merge`). Mark the PR ready with its evidence, send a merge request to Velo over session-bus, and start the next independent item from `origin/main`.
- Shared documents (the `spec/architecture.md` decision log, the trust contract): a parallel worker writes its line in the PR body and Velo appends the lines after merge in one commit.

## Stops: what to do instead

Never get around a stop by rephrasing, splitting, encoding or switching tools. Read the reason, then:

| Stop | Do this |
|---|---|
| Harness denial (Codex fence, Claude Code auto-mode classifier, agm-guard hook) | Treat that action as blocked. If it is within your authority and only an allow rule is missing, put the exact rule in a card for Yosuke. Move on. |
| Needs admin or UAC (service install, ACL, Hyper-V, firewall) | Never self-elevate (no RunAs, no `-Verb RunAs`). Write an idempotent script with a dry run, test its logic with fakes, and run the real part in the disposable VM lab: `powershell -File test/windows-service-lab/lab-vm.ps1 -Build`. It creates and deletes only its own offline VM and may read its own guest password file; never print that password. Changes to the host itself need a card. |
| Needs a person (Windows Hello PIN, approver app, physical presence) | Card. This is a designed control, not a defect: never simulate or skip it outside test-fault builds. |
| Spec gap | Reversible choice: take the recommended option, add a decision line marked `provisional`, continue. Irreversible, or under a hard limit below: card and `BLOCKED`. |
| Same failure 3 times, or a flaky test | Record the cause and the three results, mark the item `BLOCKED` (or `IN_PROGRESS` with a note) and pick an independent item. Never weaken, skip or delete a test to pass. |
| GUI check tool refuses | Record the GUI step as unverified with the reason, keep the synthetic check, do not claim the GUI works. |
| Command waits for input | Use non-interactive forms (`git commit -m`, explicit arguments), set a timeout, run long jobs in the background. |
| Missing or expired credential | Do not log in, mint tokens or read stored credentials. Card. |
| Context compacted or new session | Start again at Observe from the ledger. |
| Usage or budget limit | Write the checkpoint first if possible. |

## Card for Yosuke

Write cards in plain Japanese. Add each to "Waiting on Yosuke" in the ledger and repeat open cards at the top of the final report.

```
### <短い件名>
- やること: <1 行 1 動作。コピーして実行できるコマンド>
- 所要: <約 N 分 (Yosuke の作業時間)>
- これで進むもの: <受入 ID / PR>
- 取り消し: <できる / できない。戻し方>
```

## Hard limits

These need the owner's approval first and are never done as a side effect:

- Creating or deleting VMs other than the lab's own, host network or firewall changes, privilege elevation, installing services on the host.
- Using, creating or reading credentials, OAuth grants or API keys.
- Force push, direct push to `main`/`develop`, history rewrite, `git reset --hard`, `git clean -f`, deleting branches before merge.
- Repository settings, visibility, renames, branch protection, rulesets, secrets.
- Publishing (npm, GitHub releases, SNS) and anything that costs money.
- Adopting a new external library or a major version: propose it with evidence instead of adding it.
- Weakening a read-only boundary or a human approval to make a test pass.

For Codex, `~/.codex/rules/fence.rules` blocks most of these before they run, and its message says what to do instead. It checks a command only when the command is plain: PowerShell containing `$`, `if`, redirection or script blocks is not checked (measured 2026-10-31). Run `git push`, `gh` and any host-changing command as a single plain command, never inside a script. Self-test: `codex-fence-canary` must be rejected with `FENCE-CANARY`.

## Evidence rules

- A mock proves only the behaviour of the mock path; it does not prove OS process handling or real provider compatibility.
- Do not claim a provider, platform, GUI, recovery path or security property works without a corresponding observed check.
- Keep credentials, prompts, raw process output and private filesystem paths out of logs and records.

## When the run ends

End and write the final report when every in-scope criterion is `VERIFIED` or `BLOCKED` with a card, when only blocked items remain, or when the budget is used. The report starts with the open cards, then what was verified with its evidence, then the remaining risks.
