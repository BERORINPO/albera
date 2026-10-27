# ADR 0008: Refuse hard-linked Runtime journal and lock files

## Status

Implemented locally; full suite and cross-platform CI pending.

## Decision

- Accept only journal and lock files with exactly one hard link.
- Check link count before reading an existing journal, before removing a stale lock, and again on the opened journal handle before use.
- Fail closed without modifying either pathname when a file has multiple links or the platform does not report a usable link count.

## Rationale

`O_NOFOLLOW` protects the final path component from symbolic links but does not reject a hard link. Appending to a hard-linked journal changes the same underlying file reachable through every other pathname. Rejecting multi-link files prevents Runtime from appending audit metadata into another existing file selected or linked by mistake.

## Verification

Tests create temporary hard links for both the journal path and lock path. Journal open must fail with a stable error, and both linked names must retain their original bytes. The tests do not touch user-selected data.

## Consequences and limits

- Filesystems that cannot report a reliable link count fail closed.
- This prevents accidental writes through pre-existing hard links; it does not protect against a malicious process running as the same user racing filesystem changes.
