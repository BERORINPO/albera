# ALBERA — Acceptance Criteria and Traceability v1

**Status:** proposed; no verification is claimed. **Evidence state:** UNVERIFIED until attached CI logs, PoC artifacts or human sign-off. Machine-readable `acceptance-criteria.json` is authoritative for IDs; this document is the human-readable guide.

## Requirement coverage
| ID | Requirement | Design | Test evidence required |
|---|---|---|---|
| SEC-01 | Guest cannot obtain host management privileges | ADR-002,009 | forged guest claims; failed host operation; audit |
| SEC-02 | Reverted VM credentials and leases cannot revive | ADR-002,004,005 | restore/old-generation requests denied |
| SEC-03 | Project data isolation including indexing and caches | ADR-002,006,009 | adversarial ACL suite |
| DUR-01 | Operation intent persisted before provider mutation | ADR-003 | crash at journal boundaries |
| DUR-02 | Ambiguous provision/start cannot duplicate resource | ADR-003,005 | timeout-after-success injection |
| CMP-01 | VM-A work continues on VM-B via Git + handoff | ADR-004,006,PoC-001 | full handoff test incl. deleted A |
| CMP-02 | Pool respects capabilities/quotas/ownership | ADR-005 | property + concurrent stress tests |
| MEM-01 | Memory provenance and commit scope validated | ADR-006 | stale-claim + source mismatch test |
| MEM-02 | Search has no cross-tenant leaks | ADR-006 | raw ID, rank, cache, counts tests |
| ORC-01 | Main AI cannot self-approve or exceed budget | ADR-008 | mock adversarial planner/tool requests |
| ORC-02 | Unknown Run reconciled before retry | ADR-003,008 | disconnection/partial failure |
| INT-01 | Git candidate bound to exact commit + verification | ADR-007 | commit changed during verification |
| INT-02 | No protected branch promotion without approval | ADR-007 | denied/stale approvals + branch rules |
| CMPH-01 | Understanding not inferred from AI summary alone | ADR-007 | manual reviewer policy test |
| UI-01 | Revision gaps force safe resync | ADR-009 | disconnected/replay integration test |
| UI-02 | Human/AI desktop input ownership is exclusive | ADR-009 | takeover races and stale inputs |
| PERF-01 | Baselines reported on fixed reference machine | ADR-010 | benchmark JSON + machine profile |
| PERF-02 | No regression in security/correctness at higher throughput | ADR-010 | paired load+fault runs |
| CMP-03 | Physical machines are never placed as ephemeral or verification computers, nor across projects | ADR-005,011 | scheduler property test with physical-ssh candidates |
| SEC-04 | Physical machine enrollment pins the host key and installs a restricted, non-forwarding client key | ADR-002,011 | enrollment negatives: changed host key, missing restrict, forwarding attempt, non-owner enrollment |

## Definition of Done per workstream
1. Code reviewed against accepted ADR (not just draft).
2. Auth/authz boundaries and adverse cases covered by executable tests.
3. Independently verifiable positive path with artifacts: trace, target commits, exit codes, metrics.
4. User-facing docs describe **implemented** vs **future** accurately.
5. Benchmark baseline and, if changed, comparison attached.
6. No hidden dependency on unavailable credentials or external paid services.
7. PR merged only by authorized human with approval; not a model-driven automatic shortcut.

## System release gate (future)
A real user should be able to create a project, provision an isolated environment, run a supported CLI, observe real progress, interrupt/resume safely, hand off to a new computer, verify exact Git candidate independently, review comprehension evidence and approve promotion. All security controls, upgrade/downgrade migrations and backup/restore need evidence. This is a **target**, not a claim about current code.