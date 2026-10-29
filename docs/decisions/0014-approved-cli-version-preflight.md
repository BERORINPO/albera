# ADR 0014: Approved, bounded CLI version preflight

Date: 2026-10-27

## Status

Implemented; synthetic tests only. No real provider CLI has been run by this change.

## Context

The fixed Claude profiles use flags whose documented minimum versions differ. A static catalog helps clients explain these prerequisites but cannot stop an older installed CLI from starting.

## Decision

- The trusted approval request includes the profile-specific version floor and explicitly tells the user that ALBERA will run `<approved executable> --version` after approval and before the task launch.
- Only after approval, Runtime runs the canonical executable with fixed `--version` argv, `shell: false`, a temporary cwd, a three-second timeout, a 4 KiB stdout limit, and a minimized environment that excludes provider credentials and home-directory configuration selectors.
- A malformed, missing, timed-out, oversized, nonzero, or below-minimum version fails closed with `cli_version_unavailable` and does not start the task process.
- Executable identity is revalidated before and after the version probe.
- Minimum versions are centralized with profile policy: 2.1.248 for `read-only` and 2.1.259 for `read-only-streaming`.

## Consequences and limits

The preflight checks only the version string reported by the selected executable. It does not verify vendor identity, managed settings, account configuration, safety behavior, or network behavior. A reported version is not a certification. Real CLI acceptance remains gated on an explicit user-visible approval and has not been performed.

## Verification

Synthetic tests cover fixed argv, minimized environment, output parsing and bounds, timeout, below-minimum refusal before the main spawn, and approval disclosure. The Runtime catalog remains static and does not probe a CLI.
