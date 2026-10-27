# OSS Research, License Due Diligence, and Risk Register

**Status:** candidates—not unconditional endorsements; verify current license and maintenance before adoption.

## Candidate reuse matrix
| Capability | Candidate / approach | Decision now | Evaluation gate |
|---|---|---|---|
| Provider abstraction | ALBERA interface + Hyper-V PowerShell Host Broker | BUILD adapter | host privilege and lifecycle PoC |
| Remote sandbox | Daytona/E2B | EVALUATE API | isolation, cost, network ACL, data region |
| AI harness | Codex SDK / Codex app-server | ADAPT official | stream, approvals, cancellation, version compatibility |
| Other CLI harness | Claude Code/OpenCode official supported interfaces | EVALUATE | CLI capabilities and permission models |
| Memory | SQLite FTS5 initial; Strata Memory comparison | ADAPT after benchmark | scoped Recall, MRR, ACL, latency, data egress |
| Vector storage | local vector extension/engine | DEFER | FTS baseline recall insufficient |
| Browser | Playwright | ADOPT | isolated contexts and sandboxed guest |
| Computer use | documented model API + desktop driver | ADAPT | policy mediated human takeover and secrets |
| Git integration | Git CLI / `merge-tree` | ADOPT | exact commit, malicious repo, integration correctness |
| Workflows | SQLite journal first; Temporal later | DEFER | measured complexity/recovery justification |
| Telemetry | OpenTelemetry | ADOPT selectively | redaction; schemas pinned; low overhead |
| Canvas | Existing DOM, React Flow evaluation | BENCHMARK first | visible-node FPS, updates, migration cost |

## Risks and mitigations
| Risk | Severity | Mitigation and owner |
|---|---|---|
| VM escape/host privileged broker exposed | Critical | separate privileged broker, allowlist actions, host ACL; security owner |
| Guest networking exfiltrates sensitive code | Critical | deny-first virtual network, monitored egress broker, no host secrets; security owner |
| Restored snapshot revives credentials | Critical | new lease generation, credential rotation, isolate before restore; runtime owner |
| Fake guest completion or evidence | High | trusted independent verifier and immutable commit binding; integration owner |
| Memory injection and cross-tenant leakage | High | ACL before retrieval, untrusted claims and review status; memory owner |
| Unexpected disk growth / snapshot chain corruption | High | immutable base, quotas, cleanup, backup, fault injection; compute owner |
| Forking OSS creates unmaintainable dependency | Medium | prefer adapter, pin releases, SBOM, NOTICE, exit plan; maintainers |
| Vendor API changes | Medium | provider contract tests, feature detect, integration matrix; platform owner |
| AI token costs exceed budget | Medium | per-project ceilings, cost telemetry, guarded retries; orchestrator owner |
| Canvas overload masks alerts | High | priority channel, projected state + stale indicator; UI owner |

## Licensing protocol
Before code import/fork: record exact upstream repo URL, git SHA, SPDX license, file-level exceptions, dependencies/license tree, NOTICE requirements, trademark restrictions, security posture, fork divergence and update cadence. Prefer linking docs/API or re-implementation from public concepts when legal provenance is ambiguous. GPL/AGPL obligations and hosted-service clauses must be reviewed with legal expertise before redistribution. Do not describe copying as automatically permitted.

## Source reference dates
Sources here are pointers for re-verification as of 2026-10-28, not a guarantee of future stability.
- https://learn.chatgpt.com/docs/codex-sdk
- https://developers.openai.com/blog/codex-as-a-platform
- https://playwright.dev/docs/browser-contexts
- https://git-scm.com/docs/git-merge-tree
- https://www.sqlite.org/fts5.html
- https://opentelemetry.io/docs/
- https://github.com/kytheros/strata