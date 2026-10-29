# ADR 0007: Fail closed on unsafe POSIX Runtime storage permissions

## Status

Implemented for the Runtime audit journal; GitHub Actions run 40484508966 passed all Windows/macOS/Linux × Node 22/24 jobs, including both POSIX permission regressions.

## Decision

- On POSIX systems, the selected journal directory must be a real directory owned by the current user, with owner read/write/execute and no group or other permissions.
- Existing journal and lock files must be regular files owned by the current user, with owner read/write and no group or other permissions. Symlinks and non-regular journal paths are refused.
- Existing Runtime session identity sidecars must remain private and owned by the current user.
- Unsafe pre-existing storage is refused without changing its mode, ownership, or contents. ALBERA never runs `chmod` or `chown` to repair user-selected data.
- Windows continues to use read-only DACL inspection; unverifiable or broad ACLs are refused without rewriting them.

## Rationale

Creating a file with mode `0600` does not restrict an already existing file, and `mkdir(..., mode: 0700)` does not tighten an existing directory. Without explicit checks, a user-selected audit path could expose session/control metadata to other local users. A non-destructive refusal preserves the existing file and makes the access boundary explicit.

## Verification

POSIX-only tests create temporary journal files and directories with group/other access, assert that opening fails with a stable error, and verify the bytes remain unchanged. Windows/macOS/Linux CI covers both POSIX tests and the existing Windows DACL integration. No user-selected data is used by the tests.

## Consequences and limits

- The checks cover the selected directory and storage objects; they do not secure arbitrary ancestors or protect against the current user or root.
- Network and unusual filesystems may report ownership or mode data differently and fail closed.
- Windows ACL policy and POSIX mode checks do not provide encryption, backup, or protection against disk loss.
