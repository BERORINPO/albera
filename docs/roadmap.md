# ALBERA Roadmap

**Updated:** 2026-11-26. Replaces the v1.0 phase table of 2026-11-02 (still in git history).

Documents written before 2026-11-12 describe the old plan and are historical.

No new pull requests to the frozen runtime until D2 is reopened (review 2026-12-31). Exceptions: the smallest fix that keeps CI green, and security fixes.

## Where the work is now

- The main work is the explain-map tool **mochiba** (a map of the code, a walk through each pull request, explain practice). It lives in its own repository, which is private for now. It is no longer in this repository.
- ALBERA's VM / WSL2 job runtime (jobs, approval, ledger) is **frozen**: the code stays, nobody maintains it.
- The read-only session board (`albera`) stays as it is.

Why: on 2026-11-12 the owner looked again at what to build. Other tools already cover session lists, sandboxes and computer use. Only the signed approval and the ledger looked unique, and the computer-use VM parts are not needed. In interviews on 2026-11-24 the biggest pain was "I cannot explain what the AI built"; the second was "where are the outputs"; and the owner wants fewer, lighter tools.

## Definition of done

Done means **proof on real machines, not documents**: the tool is used for real work on the company PC and at home, and the person can show it working. Green CI, design notes and passing unit tests alone do not count. (The runtime had green CI, but no real job ever finished on a real machine.)

## Stages

| Stage | What | Time (rough) |
|---|---|---|
| S0 | Decide; keep one canonical copy of mochiba; stop the parts that are not used | ALBERA side: this change |
| S1 | mochiba used on the company PC and at home (= minimal v1) | 2-3 weeks |
| S2 | Open the outputs in one click | 1.5-2 weeks |
| S3 | Fewer tools | 1-2 days, then a check after 2 weeks |
| S4 | Optional: give it to other people (D7) | not planned |
| S5 | Optional: a real signed job on the runtime (D2) | not planned |

## Decisions (2026-11-26, by the owner, all as recommended)

| # | Question | Outcome |
|---|---|---|
| D1 | What counts as "complete" | The explain-map tool mochiba (map, story walk-through, explain practice) is the main product. ALBERA's VM / WSL2 job runtime is frozen: code kept, not maintained. |
| D2 | Run a real signed job on the runtime | Not now. Review on 2026-12-31. If still "no", the README keeps saying the runtime is "kept, not maintained". |
| D3 | Where mochiba lives | Its own private repository is the one canonical copy. ALBERA's copy is removed; the README points to the separate repository. |
| D4 | Which output locations mochiba covers | Decided later, in S2, after collecting 5 real examples. |
| D5 | How mochiba gets onto the company PC | As a ZIP, without using `gh` there (a `--no-gh` flag). |
| D6 | Which tools to retire | Decided in S3. |
| D7 | Give it to other people | Not now. Revisit after S3. |

D1, D2, D3 and D7 are also in `spec/architecture.md` section 4. D4 and D6 are added when decided (S2, S3). D5 is recorded in the mochiba repository.

## Where to look

| Question | File |
|---|---|
| Why a choice was made | `spec/architecture.md` section 4 |
| What the frozen runtime was waiting on, and what happened to each item | "Waiting on Yosuke" at the top of `docs/architecture/runtime-implementation-progress.md` |
| The old plan (historical) | `docs/architecture/implementation-roadmap.md`, `docs/architecture/acceptance-criteria.md` |

## Boundaries that do not change

The default `albera` command stays a read-only local dashboard and never imports Runtime execution code (`npm run arch` rule 2e). The frozen runtime code stays in the repository and its tests keep running in CI, but it gets no new features.
