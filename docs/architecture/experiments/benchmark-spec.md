# ALBERA — Experimental Design and Benchmark Specification

**Status:** proposed. No benchmark or Hyper-V validation has been executed by this package.

## Hypotheses and falsification conditions
| Experiment | Hypothesis | Disproof / failure |
|---|---|---|
| E01 Computer handoff | Git + manifest preserves task continuity across disposable VM replacement | missing accepted facts/commit or restored stale lease |
| E02 Pool | Adaptive warm capacity improves median first action without budget violation | no speed gain or host resource pressure/reuse contamination |
| E03 Memory | Evidence-scoped retrieval reduces repeated work | lower acceptance performance or cross-project retrieval |
| E04 Parallel agents | DAG placement reduces verified completion time | integration/retry offset exceeds parallel speedup |
| E05 UI | Read-model batching maintains responsive state under burst | state loss/incorrect approval/stale state masquerade |
| E06 Git integration | Exact-commit independent validation rejects unsafe candidates | stale candidate promoted or bypassed tests |
| E07 Fault recovery | Journal + reconciliation contains partial failure | duplicate VM, orphaned credentials, missing audit |
| E08 Comprehension | Grounded review improves developer impact prediction | no change vs control / unjustified gate cost |

## Test harness design
- Fixed benchmark fixtures and deterministic seeds for synthetic code and memory; separate real open-source fixture repos with pinned commit, license assessment and stable dependencies.
- Separate **functional CI** (every PR) from **host integration** (authorized Hyper-V host), **performance nightly/manual**, and **security fault-injection** (gated).
- Each run emits machine-readable JSON: `benchmarkId`, `fixtureDigest`, `commitOid`, `hardwareProfile`, `providerVersion`, `imageDigest`, `start/end`, `runCount`, `cacheMode`, `metricDistribution`, `failures`, `traceRef`.
- Report p50/p95/p99, throughput, failure and budget rate, stratify cold/warm, GPU/noGPU, host RAM pressure and multi-agent concurrency. Never use a microbenchmark to claim end-to-end product advantage.
- Memory: report Recall@5/20, MRR, stale result rate, citation accuracy, token cost and latency; use tenant-disjoint corpora to probe ACL leaks.
- Merge: independent code edits, same-file edits, schema mismatches, malicious submodules/hooks/scripts; run in secret-free verification guest.
- Comprehension: randomized controlled within-subject user test where possible, independent questions and review duration, no grading by the same AI that produced the implementation.
- Reboot/recovery: crash process before/after journal transaction, hypervisor succeeds but times out, disconnect guest, restore checkpoint with old token, disk full, repeated stop calls.

## Suggested dataset and scale tiers
- Tier S: one repo, 1 VM, 1 agent, 1k events, 1k memory records.
- Tier M: three repos, 3 simultaneous VMs, 4 agents, 100k events, 100k memory records, 500 visible graph nodes.
- Tier L: synthetic 20 agents, 1M events, 1M memory records, 10k total graph nodes; not a default laptop acceptance gate.
Real benchmark loads must be capped by physical host capacity. Cold VM readiness goals remain uncommitted until measured.

## Stop rules
Immediate abort/quarantine on unauthorized command, cross-project data read, escaped secret, runaway billing, host memory pressure or unbounded disk growth. Record evidence; do not auto-promote status to PASSED.

## Execution record template
```json
{"experimentId":"E01","status":"NOT_RUN","commitOid":null,"hostProfile":null,"fixtures":[],"passCriteria":[],"metrics":{},"evidenceRefs":[],"openIncidents":[]}
```