# ADR 0006: Runtime audit journal retention and capacity

## Status

Implemented for the local prototype; encrypted manual backup/restore is available, while production retention and key recovery remain open.

## Decision

- Keep the Runtime audit journal append-only. ALBERA does not rotate, compact, expire, or delete journal records automatically.
- Enforce a 16 MiB default capacity, a configurable limit no greater than 64 MiB, 20,000 records, and a per-record size bound.
- Append each bounded JSONL record with synchronous writes and `fsync` before returning the append Promise. On write or sync failure, reject the append and fail the journal closed; do not truncate or roll back any bytes.
- Write new records in journal format v2 with a SHA-256 `previousHash` and `recordHash`. Preserve existing v1 bytes exactly; the first v2 record hashes the complete legacy prefix, and later v2 records chain to the prior v2 record hash.
- Reject a v2 hash mismatch, sequence gap, v1 record after v2, or invalid record without repairing or rewriting the file.
- When the byte or record limit is reached, reject the write. The Runtime host treats audit-write failure as fatal and shuts down the API and Gateway rather than continuing without an audit trail.
- Preserve all bytes written before capacity is reached. Reopening the journal must recover those records without rewriting the file.
- Do not create automatic backups. The journal contains local control metadata and remains at the user-selected path. An explicit `albera-runtime backup` command can create a passphrase-encrypted copy only while the Runtime writer lock is available; it includes the stable session identity so history and event cursors survive restoration. `restore` authenticates and validates the payload before creating a new destination directory. Both commands refuse overwrites, do not delete or change the source, and do not upload data. The CLI accepts the passphrase only through a hidden interactive terminal prompt, uses scrypt (N=32768, r=8, p=1) and AES-256-GCM, and requires at least 12 UTF-8 bytes.
- `albera-runtime verify-backup --backup <absolute-path>` authenticates and validates an encrypted backup offline using the same hidden passphrase prompt. It does not create or modify files and does not start Runtime or a provider process.

## Rationale

Automatic rotation or retention expiry could destroy audit and recovery evidence without an explicit user decision. Failing closed at a fixed bound keeps disk use finite while preserving earlier records and making loss of continued audit visible. The backup copy has separate confidentiality and passphrase-recovery semantics. Its ciphertext can be copied off-host by the operator, but automatic scheduling, key recovery, retention, independent hash-head anchoring, and a production backup policy remain out of scope. Weak passphrases remain susceptible to offline guessing, and a lost passphrase makes the backup unrecoverable.

## Verification

`test/runtime-audit-journal.test.mjs` exercises capacity rejection, confirms previous records remain byte-for-byte intact after the failed write and close, reopens the journal, and confirms all prior records are still readable. A synchronous-append regression verifies the complete line is visible and the injected sync function has returned before `append()` returns its Promise; another verifies sync failure rejects and prevents later writes without truncating bytes. These temporary-journal tests passed across Windows/macOS/Linux × Node 22/24 in GitHub Actions run 40497148500 on `ee12cfb` and do not touch user data.

`test/runtime-journal-backup.test.mjs` verifies exact byte/session-ID restoration, source preservation, ciphertext opacity, active-writer refusal, authentication failure on wrong passphrase or tampering, and no-overwrite behavior. On Windows Node 24.13.0, `ALBERA_RUN_WINDOWS_ACL_INTEGRATION=1 node --test test/runtime-windows-acl.test.mjs` passed 8/8, including real DACL checks for the restored directory and files. The new Windows/macOS/Linux × Node 22/24 CI matrix is pending; no real provider CLI was invoked.

A non-destructive one-off sample wrote 100 synthetic audit records to a newly created directory under the current user's home directory with the real Windows DACL guard enabled. The DACL passed. Windows Node 24.13.0 measured p50 0.586 ms, p95 0.723 ms, max 8.271 ms per sequential append including `fsync`. The generated directory was removed after the measurement. An initial LocalAppData candidate was refused by the same DACL guard and was preserved by the refusal path. This is evidence for one local directory and system only; it does not characterize other filesystems, disk states, or concurrency.

The restore path reads an already opened, file-identity-checked backup only up to the validated size, probes at most one byte for concurrent growth, and rechecks the size before decrypting. `test/runtime-journal-backup.test.mjs` covers normal reads, a file that grows during the read, and an oversized declared length. Commit `778f632` passed Actions run `40538766885` across Windows/macOS/Linux × Node 22/24, including the Windows Runtime storage ACL integration. This bounds restore input memory; it does not address lost passphrases, key recovery, or retention policy.

## Consequences and limits

- This is not an indefinite retention or durability guarantee. Disk loss, corruption, and manual deletion remain possible.
- A crash during the write/flush can still leave a partial or non-durable tail. Startup refuses incomplete records and preserves the file; it does not attempt automatic repair.
- Synchronous `fsync` blocks the Runtime event loop while the storage flushes. One real-DACL local Windows home-directory sample is recorded above; measure additional supported local filesystems before production hosting and avoid slow or remote journal paths.
- The live journal remains unencrypted. Windows DACL and POSIX mode checks protect it at the selected storage objects. The encrypted backup is authenticated but depends on passphrase strength and has no recovery mechanism.
- At capacity, Runtime stops rather than pruning data or continuing without audit.
- The hash chain detects accidental or partial edits, removal, and reordering when the file is checked. It is not a signature or MAC: a writer able to replace the entire journal can recompute the chain. Truncating a valid suffix is also not detectable without an independently stored or remotely anchored head hash.
- Existing v1 data is not retroactively authenticated; the first v2 record anchors to the exact bytes present when the journal is opened for append. A fully rewritten legacy prefix can be paired with a newly recomputed v2 chain.
