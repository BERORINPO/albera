# ADR 0016: Non-destructive recovery of an incomplete Runtime journal tail

## Status

Accepted for the Runtime preview.

## Decision

An incomplete final JSONL record still prevents normal Runtime startup. The operator can run `albera-runtime recover-tail` after stopping Runtime to copy the preceding complete-record prefix to a new journal file in the same private directory.

The recovery command:

- acquires the normal exclusive journal lock and refuses an existing writer lock;
- validates every complete record, including v1/v2 sequence and hash-chain checks;
- refuses an invalid complete record, an oversized or empty prefix, and output paths that already exist;
- writes the stable session identity beside the new journal;
- preserves the source journal and incomplete tail byte-for-byte;
- does not remove, truncate, rewrite, or rename existing files.

The command does not prove the incomplete bytes were caused by a crash, recover a potentially lost final record/event, or restore active processes. It emits only the fully validated prefix and reports the incomplete-tail byte count. The operator must inspect the new output before selecting it as Runtime storage.

## Rationale

Automatically truncating an append-only audit file could erase evidence or discard accepted actions. Refusing all startup is safe but leaves an operator without a supported path to make validated prior records available. Copying the valid prefix to a new file preserves the original evidence while allowing an explicit, reviewable recovery action.

## Verification

Regression tests exercise a valid v2 prefix plus an incomplete suffix, prove the source remains unchanged, reopen the recovered file, verify session identity preservation, and reject complete-record corruption, an active writer lock, and existing output files.
