# ADR-008 — Main AI Orchestration and Decision Engine

**Status:** Proposed | **Owner:** ALBERA | **Dependency:** ADR-002/003/005/006/007

## Decision
Main AI is a **planner**, never the authority for side effects. The authoritative durable Task DAG, policy decision, approval, work lease, action journal and evidence registry remain in the Control Plane. The planner may propose tasks, agent assignment, environment requirements and retries. Deterministic services validate and execute the proposals. Separate orchestration from the provider-specific agent harness.

## Components
- **Task Planner**: translate user-approved goal into DAG with atomic tasks, acceptance criteria, risk, dependencies, files/interfaces likely touched, estimated cost and stop condition.
- **Graph Validator**: reject cycles, invalid dependencies, missing verification criteria and unapproved expansion of scope.
- **Dispatch Engine**: eligible-task scheduling using ADR-005; prioritize critical path and predicted merge conflict, not maximum agent count.
- **Agent Harness Adapter**: `start`, `observe`, `interrupt`, `resume`, `capabilities`; prefer documented Codex SDK/app-server for Codex, provider-supported interfaces for other CLIs; version-pin interfaces.
- **Failure Classifier**: classify deterministic failures locally; LLM escalation only on ambiguous or high-impact cases.
- **Completion Evaluator**: a task is not finished merely because the model says so; implementation, evidence, comprehension and approval state are distinct (ADR-007).
- **Budget Controller**: model tokens/currency, wall time, VM time, retry budget and per-project concurrency caps.

## Planner contract (illustrative)
```json
{"planId":"plan-1","goalId":"goal-1","baseCommit":"<oid>","tasks":[{"taskId":"t1","description":"Implement API","dependsOn":[],"acceptanceCriteria":["test api passes"],"risk":"medium","requiredCapabilities":["terminal"],"estimatedBudget":{"modelCostMax":5,"wallSecondsMax":900}}],"proposalRevision":1}
```
Plans are **untrusted proposals** and receive canonical server-generated IDs/tenant scope on acceptance. The scheduler owns leases, not the model.

## Task status and transition ownership
`PROPOSED -> READY -> RESERVED -> RUNNING -> SUBMITTED -> VERIFYING -> REVIEW_REQUIRED -> ACCEPTED`. Alternatives: `BLOCKED`, `FAILED`, `CANCELLED`, `STALE`, `NEEDS_HUMAN`, `UNKNOWN`. Graph dependency transitions must be committed with journal entries. A stalled/UNKNOWN Run cannot be blindly retried: reconcile guest and provider state first.

## Autonomy policy
1. Within approved task, approved image, scoped project and budget: automatic agent actions only within grant.
2. Network destination expansion, credential access, repository push, external service mutations, security policy changes: host-mediated permission and often human approval.
3. Scope expansion and new cost ceilings require explicit authorization.
4. LLM-generated instructions, repository documents and browser content are untrusted inputs; no authority over Control Plane.
5. Main AI cannot self-approve, grant host privileges, deactivate audit or change policy revision.
6. When approval is absent, time out into BLOCKED; no unauthorized fallback.

## Scheduling and intelligence optimization
Fast path: state events, dependency unlocks, heartbeats, throttling, basic retries—no model call. Decision path: deterministic rules, learned but bounded estimates; reasoning path: new plan, complex exception or unstructured trade-off—model call with curated context pack. Use fixed max fanout, retry budget and tenant quotas. Prioritize expected **time to verified integration**, accounting for branch overlap and independent verification.

## Provider differences and capabilities
Maintain feature matrix with observed capability version for Codex, Claude Code and OpenCode: structured events, approvals, PTY, session resume, tool invocation, file edits, image/UI support. Unsupported features have explicit degraded paths, not guessed CLI flags. Never attempt arbitrary host process launching through read-only Observer.

## Failure handling
- Timeout after `start`: journal lookup/provider reconcile, never duplicate run on unknown outcome.
- Provider upgraded and event schema changes: stop unsupported adapter, quarantine unknown event shapes.
- Budget exceeded: cancel new work, request owner decision, preserve evidence and state.
- Agent sends malformed/malicious tool request: reject at policy boundary and audit.
- Simultaneous plan edits: revision/CAS validation; produce conflict for human.
- Agent crash during side effect: reconcile before retry; don't assume exactly-once external actions.

## Performance and acceptance
Measure task-to-first-action, task-to-verified-result, time spent blocked, model spend, regression rate, parallel speedup after integration and human interventions. Compare rule-only vs planner, and one vs N agents on identical seeded tasks. Success: graph constraints hold; no unauthorized actions; budget enforced; ten fault injections produce no duplicate protected side effects; human can stop all live runs. Targets are *proposed*, not measured.

## Alternatives and deferrals
Don't build generic multi-tenant workflow SaaS first. Start with SQLite durable operation state (ADR-003); consider Temporal only when workflow volume/recovery needs justify operational overhead. Do not replace existing agent harness internals when documented APIs exist.

## Open questions
Pricing model, model/provider permissions, cross-provider context limits, dynamic replanning policy, who can alter task priorities, stateful GUI-agent takeover semantics.

## References
- https://developers.openai.com/blog/codex-as-a-platform
- https://learn.chatgpt.com/docs/codex-sdk