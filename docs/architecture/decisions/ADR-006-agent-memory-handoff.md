# ADR-006 — Durable Agent Memory, Evidence-bound Handoff and Retrieval

- **Status:** Proposed; memory quality and security PoCs required
- **Date:** 2026-10-28
- **Depends on:** ADR-002 (Trust), ADR-003 (Events), ADR-005 (Computer lease); integrates with ADR-007 (Evidence)
- **Goal:** computer, provider or agent can change without losing approved work context, but cannot inherit credentials or authority

## 1. Decision
Memory is a **project-scoped Control Plane service** external to VMs. It stores qualified claims with provenance, applicable commit/branch scope, authority and stale/superseded status. The handoff is a *new authorized Run* with a signed-or-MACed manifest of immutable source references; it never copies live credentials, process handles, or implicit permissions.

Memory tiers:
- `L0`: volatile Run context, with explicit checkpointed summaries if restart is needed.
- `L1`: task/run status and next-step Handoff records.
- `L2`: project knowledge, decisions, verified bug fixes and architecture.
- `L3`: organizational reusable knowledge only when ACLs and review allow.

Prefer SQLite tables for typed truth and FTS5 search for local-first MVP. **Strata Memory is an evaluation candidate**, not an automatic dependency or substitute for tenant ACLs/provenance. Its published hybrid BM25/vector/RRF and quality gates are reference implementation ideas; measure quality on ALBERA's own workload. Vector search may be opt-in and local/offline default.

## 2. Required claim model
```json
{
  "schemaVersion": 1,
  "memoryId": "mem_204",
  "tenantId": "local_personal",
  "projectId": "proj_001",
  "kind": "decision",
  "subject": "auth.token_validation",
  "assertion": "Validation occurs in middleware X",
  "sourceRefs": [{"kind": "git", "repoId": "repo_1", "commitOid": "<full-oid>", "path": "src/auth.ts"}],
  "scope": {"branch": "main", "commitOid": "<full-oid>"},
  "status": "candidate",
  "review": "unreviewed",
  "supersedes": [],
  "createdAt": "2026-10-28T00:00:00Z",
  "contentDigest": "sha256:<canonical-content>",
  "policyVersion": 1
}
```
In production, source may be a diff, test, user decision, log excerpt, URL snapshot, or approved document. `confidence`, factual validity, review approval and classification are **independent axes**, never one opaque trusted bit.

### Write pipeline
1. Accept candidate from Guest/AI as **untrusted** data, strictly size-limit and redact sensitive fields before persistence.
2. Determine tenant/project ACL and retention policy server-side; guest-selected project/tenant is only a request.
3. Quality filters: actionable, specific, relevant; deduplicate using exact digest then near-match detection, but do not delete conflicting facts.
4. Resolve evidence references; record whether source was actually retrieved and whether result is observation or verified.
5. Persist as `candidate`; promotion to `accepted_decision` requires human or explicitly policy-authorized approval.
6. Maintain `supersedes` links and stale marks from relevant Git changes; **not** 'latest timestamp wins'.

### Read pipeline
`Authenticated query -> pre-filter tenant/project/ACL -> commit/scope filter -> exact/FTS5 candidates -> optional dense search -> RRF + provenance scoring -> dedup -> context pack`.
Authorization must apply *before* indexing/search/ranking/cache access (per-tenant partitions or security-safe query plan). Avoid information leaks via counts, timing, snippets and cache keys. FTS5 `bm25()` uses lower-is-better ordering.

Memory versions are immutable revisions; edits create a new version and previous revision remains auditable where retention policy permits. Classified data is encrypted at rest as required, with keys not available to guest.

## 3. Handoff v1 contract
```json
{
  "schemaVersion": 1,
  "handoffId": "handoff_001",
  "taskId": "task_042",
  "sourceRunId": "run_102",
  "sourceComputerId": "comp_A",
  "sourceLeaseGeneration": 8,
  "repository": {"repoId": "repo_1", "baseCommitOid": "<full-oid>", "resultCommitOid": "<full-oid>"},
  "objective": "Implement login",
  "verifiedAcceptanceCriteria": ["AC-1"],
  "openAcceptanceCriteria": ["AC-2"],
  "memoryRefs": ["mem_204@v3"],
  "evidenceRefs": ["ev_8"],
  "policyVersion": 4,
  "issuedAt": "2026-10-28T00:00:00Z",
  "expiresAt": "2026-10-29T00:00:00Z",
  "manifestDigest": "sha256:<canonical-manifest>"
}
```
`manifestDigest` covers canonical fields excluding itself; full implementation uses server signature/MAC, key rotation and tenant authorization. A digest alone **does not authenticate** origin. Resolve every reference at consume time; verify commit object existence and access permissions. Do not turn raw previous-agent text or fetched web content into higher-priority instructions.

### Handoff state machine
`DRAFT -> SEALED -> CONSUMED -> VERIFIED` with `EXPIRED/REVOKED/REJECTED` alternatives. Repeated consumption may be allowed as read-only provenance, but **each new Run requires a fresh Lease/authorization**, and idempotency prevents accidental duplicate activation.
If prior VM is lost before export, recover last durable Git state and explicitly mark uncheckpointed work as **LOST/UNKNOWN**; never fabricate task completion.

## 4. Conflict resolution and invalidation
- Facts valid on different branches may both be correct; preserve `scope` and source commit ancestry.
- Git change affecting source path/symbol triggers `needs_revalidation`, not blind deletion.
- Contradiction detector generates a candidate issue with both claims and evidence; deterministic rules for same subject/field, optional LLM reviewer for semantics.
- Accepted human decision may supersede another decision but cannot change what older source actually said.
- Results cache key includes tenant/ACL revision, project, commit scope, query normalization, retrieval/index version and allowed sources.
- Protect retrieval from prompt injection by treating retrieved memory as **data with citation**, never executable instruction.

## 5. OSS evaluation
Evaluate Strata via adapter or MCP sandbox using a synthetic project corpus. Record pinned commit/version and full dependency license/SBOM before deployment; no live secret ingestion. Compare with simple SQLite FTS5 baseline.
- Accuracy: Recall@5/@20, MRR, false provenance, stale-claim selection rate, handoff continuation success.
- Speed: indexed p50/p95/p99 with cold/warm cache, 10k/100k/1M entries; index update and storage growth.
- Risk: ACL cross-project leaks, external API calls, data retention, migrations, deletion and opt-out.
- Operational complexity: additional daemons, platform compatibility, memory use.

## 6. Acceptance / fault injection
- Recreate Task on different VM and different CLI from Handoff; preserve pinned commit, AC statuses and evidence.
- Force old lease to expire; previous computer cannot gain Control Plane authority from handoff.
- Change relevant source file; retrieval flags old claim and does not present as current approved truth.
- Concurrent writes of conflicting claims; preserve both and create resolver issue.
- Tenant A cannot retrieve Tenant B's memories via search, count, snippet, cache hit or direct ID.
- Crash during write/handoff creation; no partially sealed authorization.
- Offline mode works with FTS only; no network required.
- Replay malicious source text 'ignore approvals'; it remains untrusted data.
- Measure token-budget use and Compare no-memory baseline with retrieved-memory path on same tasks.

## 7. Non-goals and revisit
No attempt to preserve model-internal hidden state. Not all conversations become memory. LLM-generated confidence never alone yields approval. Initial MVP uses FTS5 + evidence, adds vector/RRF only when measured recall justifies overhead.