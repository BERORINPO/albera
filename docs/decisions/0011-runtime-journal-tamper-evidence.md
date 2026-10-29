# ADR 0011: Runtime journal tamper evidence

## Status

Implemented for new journal entries; the legacy prefix and authenticity limitations remain.

## Decision

- Keep existing v1 JSONL lines byte-for-byte. Do not migrate, rewrite, repair, or delete old data during startup.
- Write newly appended records as v2. The first v2 record includes the SHA-256 hash of the exact existing prefix as `previousHash`; subsequent records point to the preceding v2 `recordHash`.
- Hash the serialized allowlisted record fields and reject journal startup if a v2 record hash, predecessor hash, version order, or sequence is invalid.
- Continue synchronous append and `fsync` before resolving append promises. Any write/sync error continues to fail the journal closed.

## Rationale

The journal can detect local edits to a v2 record and many incomplete, removed, or reordered records without changing existing JSONL data. The migration is additive and the previous v1 bytes remain readable and intact.

## Verification

`test/runtime-audit-journal.test.mjs` verifies the v1 prefix remains byte-identical, the first v2 record anchors to its SHA-256, later v2 records chain to their predecessor, and edits/removal/reordering are rejected without modifying the corrupt file. Full local verification passed on Windows: `npm test` (512 passed, 3 skipped), `npm run arch` (82 paths, 0 violations), `npm run smoke`, and `npm run package:smoke`. GitHub Actions run 40498380655 passed all six Windows/macOS/Linux × Node 22/24 jobs, including the real Windows Runtime storage ACL integration step.

## Consequences and limits

- This is tamper evidence, not proof of authenticity. There is no secret key, signature, or external trust anchor.
- A writer with full file replacement access can recompute the entire chain. Truncation of a valid final suffix is not detectable unless the latest hash is stored independently.
- The legacy prefix is only anchored as bytes when the first v2 record is appended. This cannot prove that legacy v1 records were not modified before that append.
- Any detected inconsistency stops journal startup and preserves all bytes for manual investigation; there is no automatic repair path.
