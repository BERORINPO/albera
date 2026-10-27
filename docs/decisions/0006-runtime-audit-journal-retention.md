# ADR 0006: Runtime audit journal retention and capacity

## Status

Implemented for the local prototype; production retention, backup, and encryption remain open.

## Decision

- Keep the Runtime audit journal append-only. ALBERA does not rotate, compact, expire, or delete journal records automatically.
- Enforce a 16 MiB default capacity, a configurable limit no greater than 64 MiB, 20,000 records, and a per-record size bound.
- Append each bounded JSONL record with synchronous writes and `fsync` before returning the append Promise. On write or sync failure, reject the append and fail the journal closed; do not truncate or roll back any bytes.
- Write new records in journal format v2 with a SHA-256 `previousHash` and `recordHash`. Preserve existing v1 bytes exactly; the first v2 record hashes the complete legacy prefix, and later v2 records chain to the prior v2 record hash.
- Reject a v2 hash mismatch, sequence gap, v1 record after v2, or invalid record without repairing or rewriting the file.
- When the byte or record limit is reached, reject the write. The Runtime host treats audit-write failure as fatal and shuts down the API and Gateway rather than continuing without an audit trail.
- Preserve all bytes written before capacity is reached. Reopening the journal must recover those records without rewriting the file.
- Do not create automatic backups. The journal contains local control metadata, is not encrypted, and remains at the user-selected path. Operators who need backup or longer retention must use a reviewed local backup process that preserves the journal's access controls. No external upload is performed by ALBERA.

## Rationale

Automatic rotation or retention expiry could destroy audit and recovery evidence without an explicit user decision. Failing closed at a fixed bound keeps disk use finite while preserving earlier records and making loss of continued audit visible. A backup mechanism would create additional copies with separate confidentiality, access-control, and deletion semantics; it is deferred until those behaviors have a dedicated threat model.

## Verification

`test/runtime-audit-journal.test.mjs` exercises capacity rejection, confirms previous records remain byte-for-byte intact after the failed write and close, reopens the journal, and confirms all prior records are still readable. A synchronous-append regression verifies the complete line is visible and the injected sync function has returned before `append()` returns its Promise; another verifies sync failure rejects and prevents later writes without truncating bytes. These temporary-journal tests passed across Windows/macOS/Linux × Node 22/24 in GitHub Actions run 40497148500 on `ee12cfb` and do not touch user data.

A non-destructive one-off sample wrote 100 synthetic audit records to a newly created directory under the current user's home directory with the real Windows DACL guard enabled. The DACL passed. Windows Node 24.13.0 measured p50 0.586 ms, p95 0.723 ms, max 8.271 ms per sequential append including `fsync`. The generated directory was removed after the measurement. An initial LocalAppData candidate was refused by the same DACL guard and was preserved by the refusal path. This is evidence for one local directory and system only; it does not characterize other filesystems, disk states, or concurrency.

## Consequences and limits

- This is not an indefinite retention or durability guarantee. Disk loss, corruption, and manual deletion remain possible.
- A crash during the write/flush can still leave a partial or non-durable tail. Startup refuses incomplete records and preserves the file; it does not attempt automatic repair.
- Synchronous `fsync` blocks the Runtime event loop while the storage flushes. One real-DACL local Windows home-directory sample is recorded above; measure additional supported local filesystems before production hosting and avoid slow or remote journal paths.
- The journal is unencrypted. Windows DACL and POSIX mode checks protect access at the selected storage objects, but a production backup workflow and encryption policy are not implemented.
- At capacity, Runtime stops rather than pruning data or continuing without audit.
- The hash chain detects accidental or partial edits, removal, and reordering when the file is checked. It is not a signature or MAC: a writer able to replace the entire journal can recompute the chain. Truncating a valid suffix is also not detectable without an independently stored or remotely anchored head hash.
- Existing v1 data is not retroactively authenticated; the first v2 record anchors to the exact bytes present when the journal is opened for append. A fully rewritten legacy prefix can be paired with a newly recomputed v2 chain.
