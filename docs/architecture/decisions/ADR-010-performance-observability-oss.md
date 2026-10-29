# ADR-010 — Performance Engineering, Observability and OSS Governance

**Status:** Proposed | **Dependencies:** ADR-001..009

## Decision
Optimization is guided by **Task-to-Verified-Result** and **Verified Throughput** on fixed acceptance tasks, with correctness, security, human comprehension and cost as separate guardrails. No optimization can relax authorization, isolation or required verification. Capture a baseline before adopting highly optimized OSS or rewriting subsystems.

## Trace boundaries
Propagate `traceId`, `projectId` (opaque), `taskId`, `runId`, `operationId`, `computerId`, `policyVersion`, `leaseGeneration` through Control Plane events. Don't emit prompts, code, stdout, access tokens, source paths or screen images by default. Traces must redact/hash identifiers according to telemetry policy; protect inter-tenant query access and retention.

## Critical path spans
`goal.accept -> task.dag -> placement -> reserve -> provision -> guest.ready -> agent.firstAction -> agent.submit -> integrate.prepare -> verify.execute -> approval -> promotion`. Record wait vs active time and causal parents. Provider timeouts are marked UNKNOWN, not success. OpenTelemetry GenAI conventions are evolving; pin schema versions and choose privacy-safe instrumentation.

## Provisional SLOs (not measurements)
- Scheduler computation p95 <20 ms at 100 eligible candidates on reference hardware, excl. provider I/O.
- FTS-only memory retrieval p95 <30 ms for 100k scoped records, controlled warm-cache benchmark.
- Project read-model propagation p95 <100 ms at 1k synthetic events/s, after accepted durable commit.
- Interactive canvas frame p95 <=16.7 ms with 500 visible simplified nodes on specified reference browser/GPU.
- No stale-lease protected action / no unauthorized cross-project disclosure in adversarial tests.
- Cold VM readiness, snapshot/restore, durable write throughput, end-to-end verified result and API cost: **baseline first**, then set hardware-specific SLOs.

## Resource budgets and backpressure
Reserve host memory/CPU for UI, SQLite writer, Control Plane and emergency stop. Independent bounded pools for image clone I/O, model calls, full verification, screenshots, logs and embedding. Never let video encoding or semantic indexing block emergency stop, approval or operation journaling. Split high-priority control channel from best-effort telemetry. Beware SQLite WAL checkpoint starvation; one bounded writer and read-only projections should be measured; backups must be tested.

## Performance studies
- Compute: cold/warm/hot, differencing disk chain depth, shutdown/cleanup, host contention, VM boot P95/P99.
- Memory: exact/FTS/hybrid, scoped Recall@5/20, MRR, stale claims, ACL safety, write/index cost, token overhead.
- Orchestrator: serial vs parallel task benchmarks including integration+retry and total model spend.
- Canvas: viewport 100/500/1000 visible nodes, 1k/10k global nodes, 100/1k/10k event/s ingest, inspector video 0/1/N streams.
- Git: independent changes, same-file conflict, semantic API/DB mismatch, malicious code, targeted vs mandatory full tests.
- Recovery: fault inject after journal commit, provider action, event projection and release; verify reconciliation and no duplicate protected side effects.
Record machine specs, branch commit, provider versions, image digests, cache regime, seeds, datasets, instrumentation overhead and run counts. Report median/p95/p99 and uncertainty; compare to identical baseline.

## OSS adoption decision record
For each OSS: problem solved; API stability; active maintenance; license + transitive dependencies + NOTICE; CVE/SBOM; threat model; resource footprint; reproducible benchmarks; migration and exit plan. Decisions: `ADOPT_API`, `ADAPT`, `FORK`, `BUILD`, `REJECT`, with evidence and owner. Prefer adapters: Git, Playwright, SQLite FTS5, OpenTelemetry, Codex SDK/app-server; evaluate Strata Memory for retrieval, OpenHands for agent runtime, Daytona/E2B as remote environment alternatives, Temporal only if operational needs exceed SQLite durable workflows. Source copying without license/provenance review is forbidden.

## Profiling / optimization workflow
Create representative workload -> baseline -> locate dominant span / CPU or I/O hot path -> propose optimization with predicted effect -> implement behind feature flag -> compare A/B under same tasks -> security and correctness regression -> rollout/rollback plan. Do not start by porting JS to Rust, adopting WebGL, or rewriting Git without a measured bottleneck.

## Exit criteria
CI has deterministic architectural/security/fault tests; host-specific benchmark runner publishes machine-readable JSON and performance distributions; privacy review of traces; OSS inventory and license report; decision log for every adoption.

## References
- https://opentelemetry.io/docs/
- https://github.com/open-telemetry/semantic-conventions-genai
- https://www.sqlite.org/wal.html
- https://git-scm.com/docs/git-merge-tree