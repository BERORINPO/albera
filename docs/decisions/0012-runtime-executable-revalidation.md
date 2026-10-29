# ADR 0012: Bind approval to provider executable content

## Status

Partially implemented as defense in depth; atomic image identity and publisher authenticity remain open. This decision does not authorize Runtime publication.

## Decision

- Resolve and validate the fixed provider executable before presenting the immutable launch tuple for host approval.
- Capture canonical path metadata and a SHA-256 digest by reading from one open file handle before awaiting host approval. Verify metadata is stable across the hash read.
- Include the SHA-256 digest in the immutable approval request and display it in the approval UI. The human decision is bound to the captured content digest, not only the executable path.
- After approval and after the version probe, resolve and validate the canonical path again; compare all captured metadata and the SHA-256 digest before continuing.
- If the file is missing, resolves elsewhere, or its identity changed while approval was pending, fail closed with `executable_unavailable`; do not spawn.
- Keep `shell: false` and the existing fixed-provider resolver.

## Rationale

Host approval can remain pending while an executable is replaced or edited in place. An open-handle hash improves identity beyond timestamps and binds the requested bytes to the approval record. It detects changes at the subsequent hash checkpoints, but does not make the path-based version probe or final process creation atomic.

## Verification

`test/runtime-executable-identity.test.mjs` checks the digest against known synthetic bytes and detects same-size in-place replacement even after mtime restoration. `test/runtime-gateway.test.mjs` replaces content while host approval is pending and retargets a symlink/junction; it verifies that changed bytes are refused without spawning and that retargeting cannot redirect the canonical path to a different target. Tests use synthetic files and fake spawners; no provider CLI is run. Cross-platform CI and local results for this change are recorded in `docs/progress.md` after they complete.

## Consequences and limits

- The handle-based SHA-256 plus metadata comparison detects content changes present at the hash checkpoints, including same-size in-place edits and path replacements during approval. Approval UI/audit sees the digest, but the digest is not a vendor signature.
- The version probe is itself a path-based process creation after approval. A replacement can race between any final digest check and the OS opening the image for the probe or provider spawn. The code does not currently use Windows `CreateFile` share locks across `CreateProcess`, POSIX `fexecve`, or another native pinned-image launcher. Node's `child_process.spawn` is path-based, and the Windows `CreateProcessW` API selects the executable module by pathname. This is a documented design limit, not a verified absence of all OS alternatives.
- A future platform adapter must prove that the exact approved image is what both the version probe and provider process execute, including symlink/junction, replacement, access-denied, and race tests on the supported OS versions. Until then R-03 remains OPEN and Runtime publication/broad activation remains blocked.
- Filesystems with weak or synthetic identity metadata, remote/network executable paths, and publisher/signature trust are not certified by this check.

## References

- [Node.js child process API](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)
- [Windows CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- [Windows file sharing and CreateFile](https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files)
