# ADR-007 — Git-based Verified Integration and Evidence Binding

- **Status:** Proposed; integration experiments and security review required
- **Date:** 2026-10-28
- **Depends on:** ADR-002, ADR-003, ADR-004, ADR-005, ADR-006
- **Scope:** submission, merge planning, independent verification, comprehension and promotion

## 1. Decision
Git remains the authoritative source history. Agent changes from independently isolated clones/worktrees are **submissions**, never automatic production changes. ALBERA creates a throwaway integration candidate from pinned commits, runs required tests in a fresh Verification Computer, validates policy and (when mandated) human understanding, then requires an authorized approval before promotion to protected branches.

Different VMs use independent clones plus authenticated transport; same trusted filesystem may use separate worktrees. Avoid sharing writable `.git` data across unrelated guests.

## 2. Submission contract
```json
{
  "schemaVersion": 1,
  "submissionId": "sub_101",
  "tenantId": "tenant_local",
  "projectId": "proj_001",
  "taskId": "task_042",
  "runId": "run_102",
  "repositoryId": "repo_001",
  "baseCommitOid": "<full-oid>",
  "resultCommitOid": "<full-oid>",
  "sourceRef": "refs/albera/tasks/task_042/run_102",
  "evidenceRefs": ["ev_1"],
  "proposedBy": "agent_codex_1",
  "policyVersion": 3
}
```
A submission cannot trust the Guest-provided commit hash alone: host-side Integration Service fetches into a quarantined bare repository, checks object integrity, branch ancestry/allowed scope, object size, file path policy, symlink/submodule behavior, LFS pointers, executable files and secrets. The host does not `checkout` attacker-controlled content in a privileged writable location. Review dependency install/build scripts as untrusted; only execute inside hardened verification environments with network restrictions.

## 3. Integration state machine
`SUBMITTED -> VALIDATING -> PREPARED -> VERIFYING -> REVIEW_REQUIRED -> APPROVED -> PROMOTING -> MERGED`.
Alternative terminal or pausable states: `REJECTED`, `CONFLICTED`, `VERIFY_FAILED`, `STALE`, `BLOCKED`, `UNKNOWN_PROMOTION`.
Every transition is an idempotent operation with authoritative writer, optimistic concurrency version and append-only audit event. Do not re-run an ambiguous remote push without checking remote ref. Use conditional/force-with-lease restrictions on dedicated integration refs; **never force-push protected main**.

## 4. Candidate construction
1. Freeze exact target branch tip, submissions, policy revision, test plan, image digest, integration algorithm version.
2. Validate commit ancestry and allowed scope; precompute pairwise overlap and dependency graph.
3. Use Git's merge machinery, including `git merge-tree --write-tree` where suitable for initial conflict estimation without touching the working tree. This is only a conflict probe: successful text merge is *not* semantic compatibility.
4. Build candidate commit in isolated repository/workspace. Record exact commit OID and tree OID.
5. Fetch candidate into newly provisioned `verification` Computer from an approved image. Dependencies are version-pinned; external sources must be restricted/approved.
6. Run tiered verification: quick impacted tests as fast feedback, then all mandatory release/integration gates on exact candidate. Log runner, image digest, lockfile digest, test plan revision, timestamps, exit codes and tamper-evident content hashes.
7. Generate review packet: provenance of each change, design decision links, conflicts, test evidence, unresolved risks.
8. Gate on policy and human approval / comprehension as needed. Any target branch movement makes the candidate `STALE`; rebase/rebuild/reverify as policy demands.
9. Promote via dedicated credentials and native provider branch protection / required reviews. Do not bypass repository rules.

## 5. Evidence semantics
A test result is valid only relative to its exact input/environment and bounded observations, **not universal proof of absence of bugs**.
```json
{
  "evidenceId": "ev_500",
  "subjectCommitOid": "<full-oid>",
  "subjectTreeOid": "<full-oid>",
  "imageDigest": "sha256:<image>",
  "lockfileDigest": "sha256:<dependencies>",
  "testPlanDigest": "sha256:<test plan>",
  "policyVersion": 3,
  "runnerId": "trusted-verifier-01",
  "result": "passed",
  "capturedAt": "2026-10-28T00:00:00Z",
  "outputArtifactDigest": "sha256:<log>"
}
```
Host-generated verification evidence is distinguished from Agent-self-reported evidence. The verifier must not share writable volume, authority or persistent credentials with the developer Run. Cache evidence only for deterministic, safely reusable tests with all relevant inputs pinned; high-risk gates may require fresh execution.

## 6. Comprehension Gate
Keep `implementationStatus`, `verificationStatus`, `comprehensionStatus`, and `approvalStatus` independent.
- Low-risk: read acknowledgement with explicit scope.
- Medium-risk: explanation + change impact prediction; link answers to code/evidence.
- High-risk: code-grounded demonstration and designated human review.
A model-generated explanation is a *study aid*, not proof a developer understands. Reviewer's decision, task version, candidate commit and risk rating are recorded. Changes after acceptance invalidate linked gates according to policy.

## 7. Parallelization and optimization
Use file/symbol overlap, dependency graph, interface contracts and historical conflicts to select task concurrency. For fast feedback run impacted tests; for final approval execute mandatory integration tests against exact candidate. Measure **task-to-verified-result**, conflict count, rework time and false-negative semantic conflict rate. Avoid inventing a 'merge-safe' confidence without validation.

## 8. Failure and security cases
- Agent submits commit from unauthorized repo/branch -> reject.
- GitHub/remote times out after successful push -> query ref and journal before retry.
- Another agent changes target branch during verification -> mark candidate stale.
- Two approvals race on two candidate versions -> generation/version fencing.
- Malicious test scripts attempt network exfiltration -> verification network deny policy, secret-free guest, audit.
- Guest claims tests passed -> mark `agent_reported`, never `trusted_verified`.
- Source contains secrets -> quarantine, block export and follow incident procedure.
- Git conflict-free merge causes API incompatibility -> independent contract/integration test detects; unresolved issues block.
- Verifier compromised -> evidence cannot be considered independent; quarantine and invalidate affected evidence.
- Verification VM disappears after tests -> external durable evidence remains; missing results stay UNKNOWN.

## 9. Validation gates
Test with two isolated agents changing independent files, same file, shared API contract, DB migration and malicious repo contents. Verify that:
- no unapproved promotion occurs;
- exact commit OID ties to test evidence;
- stale candidate cannot be merged without new validation;
- forced replays never duplicate branch actions;
- project ACL and credential boundaries hold;
- semantic conflicts are not represented as guaranteed detected;
- integration itself is recoverable after host restart.

## 10. OSS reuse / open questions
Prefer native Git, GitHub branch protections and worktree/clone machinery; avoid rewriting Git merge algorithms. Evaluate Strata Source Control in isolation, without treating it as mature production substrate absent comparative tests. Open: remote-repository allowlist, force-push policy, test selection engine, artifact retention, binary/LFS controls, comprehension review scope.