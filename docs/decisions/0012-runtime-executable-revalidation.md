# ADR 0012: Revalidate provider executable after approval

## Status

Implemented as defense in depth; executable authenticity and the final OS race remain open.

## Decision

- Resolve and validate the fixed provider executable before presenting the immutable launch tuple for host approval.
- Capture the canonical path and file identity (`device`, `inode`, `mode`, `size`, `mtime`, and `ctime`) before awaiting host approval.
- After approval, resolve and validate the same path again and compare its file identity before calling `spawn`.
- If the file is missing, resolves elsewhere, or its identity changed while approval was pending, fail closed with `executable_unavailable`; do not spawn.
- Keep `shell: false` and the existing fixed-provider resolver.

## Rationale

Host approval can remain pending while an executable is replaced. Rechecking afterward rejects changes during that interval and binds the approved launch to the file observed before the decision. It narrows the race without claiming code-signature verification or atomic execution by file handle.

## Verification

`test/runtime-gateway.test.mjs` replaces a temporary executable fixture while the approval callback is blocked and verifies the Gateway rejects the start without calling `spawn`. This test does not run a real provider. Full local verification passed on Windows: `npm test` (513 passed, 3 skipped), `npm run arch` (82 paths, 0 violations), `npm run smoke`, and `npm run package:smoke`. GitHub Actions run 40499144241 passed all six Windows/macOS/Linux × Node 22/24 jobs, including Windows Runtime storage ACL integration.

## Consequences and limits

- The metadata comparison can detect common in-place edits and path replacement during user approval.
- The OS may replace the executable after the final check and before `spawn` opens it. Vendor identity, signature/ownership policy, and an atomic OS launch primitive remain open under R-03.
- Filesystems with weak or synthetic identity metadata may provide less detection; remote/network executable paths are not certified by this check.
