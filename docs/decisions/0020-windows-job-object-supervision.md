# ADR 0020: Own Windows provider processes with a Job Object from launch

## Status

Implemented in the isolated Runtime prototype; local Windows 10/11 user-session integration verified. CI Node 22/24 matrix and broader host environments remain pending. Runtime publication remains blocked.

## Context

The Node Guardian previously launched a provider by path and used `taskkill /PID /T /F`. A PID-based tree walk does not establish stable ownership, misses descendants created in races, and a zero exit code does not prove that every descendant exited. The runtime needs OS-owned membership established before the provider can execute.

## Decision

- On Windows x64, launch a small self-contained .NET 10 guardian. If the packaged helper is absent or the architecture is unsupported, fail closed before creating a run. POSIX continues to use the Node Guardian.
- The helper creates an unnamed Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, without either breakaway limit flag. It starts the provider with `CREATE_SUSPENDED`, assigns that process to the Job, and resumes its primary thread only after assignment succeeds. Provider stdin/stdout/stderr inheritance is restricted to an explicit handle list; output is directed to `NUL` and is not relayed as control events.
- Stop uses `TerminateJobObject` as a termination request. It reports `treeConfirmed: true` only after `QueryInformationJobObject(JobObjectBasicAccountingInformation)` returns `ActiveProcesses == 0` within a bounded drain interval. Termination API success, taskkill success, root-process exit, PID disappearance, or a timeout does not prove a drained Job.
- The Gateway never uses the provider PID as a fallback for a Job-managed Windows run. If the helper control channel or process is lost before a drain acknowledgement, the state stays unknown/failed. The Job's kill-on-close limit is a cleanup mechanism; because the unnamed Job handle cannot be recovered after owner loss, it is not an acknowledgement or restart reconciliation proof.
- The legacy taskkill adapter may request cleanup for non-Job paths but always returns unconfirmed. A successful taskkill exit is not an OS-level completion observation.
- No Windows service is registered and no persistent ACL, privilege, network, or Hyper-V setting is changed by this implementation or its tests.

## Verification

`test/windows-job-supervisor.test.mjs` builds/uses a temporary synthetic process tree and verifies: root-child-grandchild termination before confirmation; root exit while a descendant remains; denial of `CREATE_BREAKAWAY_FROM_JOB`; and guardian termination causing Job handle close cleanup without an `exit`/confirmed acknowledgement. A Gateway regression verifies that a Job-managed control-channel failure never calls the PID-based fallback. These tests use the actual local Windows kernel Job Object and synthetic Node/.NET processes only.

## Consequences and remaining risks

- The implemented ownership boundary covers descendants created through ordinary Windows process creation while they remain in the Job. Processes delegated to an external service or otherwise created outside that process-creation inheritance path are not contained by this Job Object.
- An enclosing Job Object, security product, or host policy may reject nested Job assignment. Such a launch fails before resuming the provider; supported host policy combinations still need a matrix.
- `TerminateJobObject` is forceful. The current helper accepts the existing bounded stop protocol but does not provide cooperative per-process cancellation or a durable cross-restart Job identity.
- A guardian/process crash closes the last owned Job handle and asks Windows to kill the members, but the dead control plane cannot observe the final active count. The recorded state therefore remains unknown and must not permit automatic Lease release/retry.
- Current local OS evidence is from one Windows x64 user session with the installed .NET 10 SDK/runtime and Node 24.13.0. CI on Node 22/24 and Windows service/SID hosting are separate verification requirements.

## Related

- Issue #29: Windows process-tree termination confirmation.
- ADR 0015: legacy taskkill fallback is cleanup-only and unconfirmed.
- `docs/risks.md` R-05 and `docs/acceptance-criteria.md` RT-09.
