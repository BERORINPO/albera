# 0005 — Windows Runtime storage ACL verification

- Status: Implemented; Windows behavior verified locally and on the prior cross-platform matrix; isolated-step matrix rerun pending
- Date: 2026-10-27
- Scope: Optional Runtime audit journal, lock file, and journal session-identity sidecar

## Decision

On Windows, Runtime startup reads and validates the DACL of the journal directory and any existing journal, lock, or identity file before reading or changing them. Startup fails closed when ACL inspection fails, a target is not a regular file/directory, the DACL is absent, the owner is outside the current user / LocalSystem / local Administrators, a deny ACE exists, the current user lacks Full Control, or another principal receives rights beyond execute/traverse and synchronization.

The check does not modify ACLs or existing data. New files inherit from the checked directory. POSIX retains its existing `0700` directory and `0600` file checks. The regular read-only Observer does not use Runtime storage.

## Rationale

Windows file and directory ACLs inherit from parent directories, so Node's POSIX-style `mode` creation argument is not evidence that a Runtime journal is private. A blanket `icacls /inheritance:r` repair would change access on the selected object and may remove intentional inherited rights; it cannot be applied safely to a caller-selected parent directory or its existing contents. Effective access also depends on the SIDs in the process token, so parsing a friendly group name or checking a Unix permission bit is insufficient.

The verifier invokes the system Windows PowerShell by its absolute path, without a shell, with an encoded fixed script and a minimal environment. It only reads the security descriptor. The audit journal remains bounded and redacted; this control protects its remaining activity metadata from other local principals.

## Verification

- Unit cases cover allowed trusted principals, broad data grants, external ACL/owner changes, deny ACEs, a null DACL, missing user Full Control, and harmless execute/traverse rights.
- Windows-only test queries and validates the actual current user's profile DACL through the Windows security APIs.
- Journal and sidecar integration tests confirm ACL refusal occurs before existing metadata is read or modified.
- Local Windows Node 24.13.0: `npm test` 496 passed / 1 skipped, plus `ALBERA_RUN_WINDOWS_ACL_INTEGRATION=1 node --test test/runtime-windows-acl.test.mjs` 7/7; `npm run arch` 82 paths / 0 violations; `npm run smoke` passed.
- GitHub Actions run 40480832114 on commit `f8ae7b5` passed all six Windows/macOS/Linux × Node 22/24 test and architecture jobs. Its Windows ACL query took 34–39 seconds under parallel test load, so the real DACL integration now runs in a separate Windows-only workflow step; the 60-second fail-closed timeout remains unchanged. The isolated-step matrix rerun is pending.

## References

- [Windows file security and parent ACL inheritance](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
- [How DACL access checks use the process token's SIDs](https://learn.microsoft.com/en-us/windows/win32/secauthz/how-dacls-control-access-to-an-object)
- [Microsoft `icacls` inheritance and DACL modification behavior](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
