# ALBERA — Implementation Roadmap and Work Packages

**Scope:** Local-first development; existing read-only Observer remains working. **Status:** Planning only. Codex may have newer implementation changes: reconcile with current Git branch before any code modification.

## Sequencing rules
Do not run a second developer agent on the same uncommitted workspace. Current `codex/runtime-gateway` local modifications remain owned by the active Codex session; this package changes only documentation in a dedicated GitHub PR; it does not alter application source, main, or Codex's active runtime branch. Use feature branches and small reviewable PRs. Each feature starts from a verified main/base and updates architectural fitness checks.

| Wave | Deliverable | Blocking prerequisites | Proof |
|---|---|---|---|
| 0 | Baseline + test harness + threat model review | none | existing suite green; security invariants |
| 1 | Runtime Gateway hardened + stub Provider | wave 0 | lifecycle/race/authorization tests |
| 2 | Durable event journal, registry, reconciliation | wave 1 | crash and duplicate-prevention tests |
| 3 | Hyper-V Provider + Guest Agent PoC | waves 1-2 | PoC-001 provision, run, stop, cleanup |
| 4 | Handoff Manifest + scoped Memory v1 | waves 2-3 | VM-A deleted then resume VM-B |
| 5 | Git submissions + independent verification | waves 2-4 | exact commit candidate; stale invalidation |
| 6 | Authenticated Control API + live Canvas | waves 2-3 | subscribe/resync, approval, stop |
| 7 | Orchestrator v1 + capability matrix | waves 4-6 | multi-agent DAG, budgets, safe escalation |
| 8 | Desktop/Browser Computer Use | waves 3,6,7 | takeover, browser test, safe input lease |
| 9 | Computer Pool optimization, retrieval tuning, benchmark gates | waves 3-8 | measured comparison, no security regression |
| 10 | Comprehension, packaging, release testing | waves 5-9 | user study, E2E, cross-platform docs |

## Implementation boundaries
- Observer read-only API unchanged; never import privileged broker into it.
- Code execution only through separately authenticated Control API and low-privilege orchestrator; Host Broker holds minimal Hyper-V authority.
- Guest runs without host secrets and never determines its own policy or approval status.
- Must support `MockProvider` and simulated failures for CI on non-Windows runners; Hyper-V integration tests run on an authorized Windows host, not uncontrolled cloud CI.
- API errors typed, versioned schemas with compatibility strategy and unknown outcomes handled explicitly.

## Immediate next engineering issue set
1. Inspect current working tree, status, and active Codex branch without discarding changes.
2. Turn Gateway start/stop and containment rules into isolated unit/integration tests; check Windows executable adapter behavior.
3. Define host API DTOs for computer IDs, task/run IDs, lease generations, operation journal status.
4. Implement MockProvider and crash-injection test runner before Hyper-V live actions.
5. Record host capabilities (Windows edition, Hyper-V enabled, virtualization, RAM, free disk, GPU constraints) without transmitting private paths/credentials.
6. Run PoC-001 with disposable synthetic repository; generate evidence and benchmark artifacts.

## Release milestones
- **M0** Observe: renamed ALBERA read-only dashboard; verified current behavior and docs.
- **M1** Safe Compute: single supported Guest run, explicit approval, lifecycle recovery, no UI privilege leak.
- **M2** Continuity: VM-A -> VM-B handoff and independent candidate verification.
- **M3** Product MVP: live Canvas, human control, parallel tasks, source review and portable installer.
- **M4** v1.0: supported OS/provider matrix, recovery, comprehension gates, benchmark evidence, docs.
No milestone is complete by document production alone.

## Review cadence
For each PR: design delta, alternatives, security review, test evidence, performance impact, migration strategy, rollback, changed docs. Update acceptance criteria status only after proof is linked.