# Architecture Review — PR #18 (2026-10-28)

**Reviewer:** ChatGPT assisted design review
**Scope:** documentation consistency, base/main visibility, high-risk trust boundaries and implementation-readiness.
**Result:** APPROVE FOR DESIGN REVIEW / NOT APPROVED FOR AUTOMATIC IMPLEMENTATION OR DEPLOYMENT.
**Evidence limit:** reviewed selected design documents and public main branch, not the developer's unpushed local `codex/runtime-gateway` changes. Hyper-V PoC, failure injection, security penetration testing and performance benchmarks were **not run**.

## Verification
- PR #18 targets `main`, is OPEN, DRAFT and GitHub reports mergeable.
- `main` still contains the read-only Observer and architecture guard; `src/runtime/gateway.mjs` and `spec/runtime-gateway.md` were not present on `main` at review time. Local Codex work cannot be assessed from this branch.
- No runtime source changes are included by this documentation-only PR.
- The README links were adjusted to the actual in-repo paths; roadmap wording that inaccurately claimed no GitHub modification was corrected.
- The 18 acceptance criteria in JSON remain `NOT_VERIFIED`.

## Findings to resolve before marking ADRs Accepted

### SEC-R1 — Host Broker identity and Windows privilege isolation (HIGH / OPEN)
ADR-002 documents typed commands and broker validation but does not select an enforceable Windows IPC ACL/service identity design. Required: dedicated least-privilege service or equivalently constrained management broker; caller identity binding, named-pipe ACL test, broker identity rotation, binary/update trust. **Do not grant Hyper-V admin rights to the existing localhost read-only process**.

### SEC-R2 — Effective egress isolation (HIGH / OPEN)
A Hyper-V private/internal switch, NAT or default switch does not prove internet/LAN isolation. Before untrusted code execution: concrete vSwitch/vNIC topology, host firewall/proxy enforcement, IPv4+IPv6/DNS/proxy tests, host and LAN reachability denial, approved enrollment route, and evidence of network tests.

### DUR-R1 — Crash-recovery and fencing end-to-end (HIGH / OPEN)
ADR-003 journal is a sound proposal, but guest execution, VM create/restore, provider timeout-after-success, process-tree stop and push effects need distinct reconciliation tests. Expired lease is not evidence a guest process stopped. Confirm atomic claim semantics and double-active-generation prevention under concurrent owners.

### CMP-R1 — Image lineage / checkpoint restore safety (HIGH / OPEN)
Must verify base VHDX immutability, child-parent reference integrity, production checkpoint behavior on supported OS image, stale guest credentials after restore, disk quota and garbage collection. No cross-tenant hot reuse until reprovisioned and validated.

### INT-R1 — Independent test evidence / repository promotion (HIGH / OPEN)
Use a clean verifier without writable developer-agent mounts or tokens. Tie verifier evidence to exact commit OID, image digest and test plan; re-evaluate after branch movement. Do not grant agents authority to merge into protected branches.

### MEM-R1 — Memory authorization and provenance (MEDIUM / OPEN)
Strata/other retrieval engine cannot bypass project-scoped ACL. Test retrieval, ranking/caching and direct ID leakage. Conflicting and stale claims must remain traceable to source revisions. Handoff must never transfer privilege or credentials.

### OPS-R1 — OSS licensing and compatibility matrix (MEDIUM / OPEN)
Before embedding/forking upstream code record actual license per file, pinned version/SHA, platform support, CVEs, NOTICE/SBOM obligations and fallback adapter. Named upstream projects are candidates, not approved dependencies.

### DOC-R1 — Terminology and path reconciliation (LOW / DOCUMENTED)
Original v4 package uses ZIP-local filenames and previous statement "does not modify GitHub"; GitHub import relocates docs under `docs/architecture`. README index uses actual repo links. Roadmap statement corrected. Preserve stable ADR IDs if renamed.

## Minimum design review gates
1. Reviewer explicitly accepts or revises ADR-002 security model, supported local Windows host versions and threat assumptions.
2. Author commits Host Broker IPC and egress isolation executable test plans with clear pass/fail evidence expectations.
3. Runtime team compares current `codex/runtime-gateway` local implementation against ADR-001/002/003 and records delta without overwriting working changes.
4. PoC-001 runs only with explicit consent on disposable images, no production tokens; record machine and Hyper-V version.
5. Update machine-readable acceptance criteria with verification artifact references **only after tests complete**.
6. Re-review architectural decisions after empirical results before setting ADR status to Accepted.

## Review recommendation
The docs can be merged into `main` as **Proposed designs** after ordinary documentation review. This does not authorize VM provisioning, Guest privilege, network access or product release. Keep PR in Draft pending owner's normal review workflow.
