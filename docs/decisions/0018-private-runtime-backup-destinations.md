# ADR 0018: Verify Runtime backup destination privacy before writing

Date: 2026-10-28

## Status

Implemented; actual Windows storage ACL integration passed 9/9 locally. GitHub Actions run 40579849549 on `2040e6b` passed all six Windows/macOS/Linux × Node 22/24 jobs.

## Context

The offline encrypted journal backup created its output with exclusive creation and POSIX mode `0600`, but did not check the destination directory's permissions or the new file's inherited Windows DACL. The restore and tail-recovery paths already validate their created destinations. On Windows, POSIX mode bits do not establish a private DACL, so a backup could be written to a broadly accessible directory or file ACL.

## Decision

- Require the output parent to be an existing non-symlink directory and check POSIX ownership/mode plus the Windows DACL before reading and encrypting the journal.
- Create the output exclusively, using no-follow semantics where the platform supports the flag. Before writing ciphertext, inspect the opened file handle, require a regular single-link file, check its POSIX owner/mode, and validate its Windows DACL by pathname. Compare path and handle `dev`/`ino` before and after the Windows ACL query, and compare the output directory identity again after file creation.
- On any validation failure, do not write ciphertext and do not overwrite any existing path. A newly created empty output may remain after post-create validation fails so the command does not remove a path without proving ownership after a possible same-user race.
- Keep the journal and backup passphrase handling unchanged. This protects the backup destination's access/integrity posture; it does not add key recovery, independent hash anchoring, automatic retention, or crash-safe active-process recovery.

Windows ACL inspection remains pathname-based rather than handle-bound. The identity checks reject a path replacement observed during the ACL query, but do not prove safety against a writable ancestor being swapped between checks or a privileged/same-user local attacker. Those limits remain within the local Runtime trust boundary.

## Verification

`test/runtime-journal-backup.test.mjs` asserts the parent and opened output file are validated, rejects synthetic directory/file ACL failures before writing ciphertext, checks that file and directory paths replaced during ACL verification are refused, and checks POSIX rejection of a broadly accessible output directory on non-Windows platforms. Actual Windows Runtime storage ACL integration passed 9/9 and verified backup generation/restoration in an ACL-accepted user-profile directory. Local Windows `npm test` passed 555 with 6 skips; `npm run arch`, `npm run smoke`, `npm run package:smoke`, and `git diff --check` passed. GitHub Actions run [40579849549](https://github.com/BERORINPO/pigeonholes/actions/runs/40579849549) passed all six Windows/macOS/Linux × Node 22/24 jobs on `2040e6b`, including Windows Runtime storage ACL integration.
