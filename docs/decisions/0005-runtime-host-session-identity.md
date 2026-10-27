# Decision 0005: Stable Runtime host identity for journal replay

Date: 2026-10-27

## Context

The Runtime API can replay run and event projections when a trusted host reissues the same session ID. The standalone `albera-runtime` entrypoint previously created a fresh random session on every start, so a valid journal's history was not visible after restart.

## Decision

- Store a random 128-bit non-secret API session ID in a sibling `<journal>.session-id` file.
- Create the file exclusively, with `O_NOFOLLOW` where supported and POSIX mode `0600`. Reuse only a regular file with exactly one valid 32-character lowercase hexadecimal ID and private POSIX permissions.
- Fail closed on symlinks, malformed content, non-files, permissive POSIX modes, or I/O errors. Never auto-repair, truncate, chmod, or delete an existing identity file.
- Reissue the identity only to the API credential minted by the trusted Runtime host. It is not an API bearer token and is never exposed to the browser.
- Continue restoring unfinished runs as `interrupted`; do not claim active process recovery.

## Consequences and limits

- Journaled run/event projections survive normal Runtime host restarts and can appear in the new UI session.
- A crash can still occur before the API poller records the last lifecycle event. The Guardian remains responsible for killing child trees after host loss.
- Windows ACL inheritance is not verified by POSIX mode checks and needs a dedicated Windows security review.
- The identity binds only to the chosen journal path. Moving a journal without its sidecar deliberately starts a different API session.

## Evidence

`test/runtime-approval-host.test.mjs` verifies ID creation/reuse, private POSIX mode, rejection of malformed or permissive identity files, and preservation of malformed contents. Existing Runtime API recovery tests verify journal replay for a reissued session ID. No real CLI or provider process is used.
