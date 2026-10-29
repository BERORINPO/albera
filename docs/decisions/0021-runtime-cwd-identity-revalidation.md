# ADR 0021: Bind approval to working-directory identity

## Status

Implemented as a path-based race check; atomic working-directory selection remains open.

## Decision

- Resolve the requested cwd, verify it is a directory inside an allowed root, and capture its `dev` and `ino` from `fs.stat` with bigint values before host approval.
- Include the stable `dev:ino` identifier in the immutable approval request. Do not add any cwd paths beyond the canonical cwd already present in that request.
- After approval and again immediately before spawn, resolve the original cwd request, re-check allowed-root containment, and require the same `dev:ino`. Fail closed with `cwd_not_allowed` on errors or identity/containment changes.
- Pass the latest canonical cwd path to `spawn` and keep `shell: false`.

## Rationale

The requested cwd can be a symlink or junction inside an allowed root. It may be redirected outside that root while host approval is pending, so the pre-approval canonical path alone does not bind approval to the directory later selected for process creation. Filesystem identity checks detect redirection or replacement present at either revalidation checkpoint without adding another path to the approval metadata.

## Verification

`test/runtime-gateway.test.mjs` retargets a symlink/junction to outside the allowed root while approval is pending and asserts `cwd_not_allowed` with no spawn. The test uses a fake spawner and does not launch a provider CLI. Local test results for this change are recorded after they complete.

## Consequences and limits

- `dev:ino` is a filesystem identity hint, not an authorization token or an atomic handle to the directory. Filesystems that expose weak or synthetic identity values are not certified by this check.
- The checks narrow the path-based race but cannot prevent a path component from changing after the final `stat`/`realpath` and before the OS opens cwd during `spawn`. A platform-native launcher that pins the directory handle or provides an equivalent atomic guarantee remains future work; R-02 stays OPEN.
