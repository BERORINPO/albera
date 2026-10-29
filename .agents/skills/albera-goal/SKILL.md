---
name: albera-goal
description: Goal-driven development workflow for completing ALBERA product phases with evidence, security review, and iterative repair.
---

# ALBERA Goal-Driven Development

Use this workflow for ALBERA roadmap work. Do not stop at plans or prototypes when implementation is in scope.

1. **Observe** — inspect the current branch, main diff, working tree, architecture, tests, CI, and relevant product specs. Preserve all existing user changes.
2. **Define** — identify unmet acceptance criteria and classify each as `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, or `VERIFIED`. `VERIFIED` requires a recorded command/result or reproducible manual evidence.
3. **Plan** — choose the next smallest work item that unblocks downstream criteria. Record material dependencies and security boundaries.
4. **Implement** — make a minimal coherent change. Keep the read-only Observer separate from execution capabilities. Do not add a server or UI integration before its security phase.
5. **Verify** — add and run unit, integration, architecture, and platform checks appropriate to the change. Distinguish synthetic/fake checks from real CLI or GUI checks.
6. **Review** — inspect authorization, executable resolution, argument handling, environment exposure, filesystem scope, process cleanup, output retention, and cross-platform behavior.
7. **Repair** — fix every discovered defect that can be addressed safely; rerun affected verification.
8. **Record** — update `docs/progress.md`, acceptance statuses, risks, and decision records with evidence. Never mark an unobserved result verified.
9. **Repeat** — proceed to the next unmet criterion while useful work remains. Report genuine external, authorization, or platform blockers with alternatives.

## Evidence rules

- A mock proves only the behavior of the mock path; it does not prove OS process handling or real provider compatibility.
- Do not claim a provider, platform, GUI, recovery path, or security property works without a corresponding observed check.
- Keep credentials, prompts, raw process output, and private filesystem paths out of logs and progress records.
- Do not weaken read-only boundaries or bypass human approval to make a test pass.
- Do not merge, publish, rename repositories, or make destructive data changes without explicit user approval.
