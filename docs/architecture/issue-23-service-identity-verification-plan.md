# Issue #23 — Windows service identity isolation plan

- **Status:** preparation and restricted-token IPC proof only; service-isolation acceptance **BLOCKED / NOT VERIFIED**
- **Date:** 2026-10-28
- **Parent:** PR #25 (`codex/runtime-issue-22-dotnet-broker`)
- **Scope:** identity / ACL design, reversible lab runbook, non-admin OS-token denial test
- **Not performed:** service registration or lifecycle operations, account/group changes, persistent ACL changes, elevation, network changes, Hyper-V operations

## Host inventory collected without mutation

- Windows 10 Pro x64, build `10.0.26300`. This is an environment observation, not evidence that the host is in ADR-002's supported Windows 11 / Windows Server production matrix.
- The interactive user token was Medium Integrity. The local Administrators group was present as **deny-only**, not enabled; this session did not have an elevated administrator token. No SID value is recorded here.
- .NET SDK `10.0.302`, runtime `10.0.10`; Node `v24.13.0` from the prior Issue #22 integration run.
- No services, users, groups, privileges, or persistent ACLs were created or changed. A cross-account test credential/principal was not available to this non-elevated test.

## Service identity decision for the approved lab

Follow ADR-002's proposed two-service model. Run each service as its own virtual service account in an own-process service:

| Process | Logon account | Service SID | Required token shape | Minimum authority |
|---|---|---|---|---|
| Node Control Plane | `NT SERVICE\AlberaControlPlane` | `NT SERVICE\AlberaControlPlane` | Service SID enabled and present in `TokenRestrictedSids`; session 0; no admin groups or Hyper-V group | Read/execute signed CP files; write only its own state; connect to the fixed Broker pipe. No service-control, Broker-data, key, provider, shell, or Hyper-V rights. |
| C#/.NET Host Broker | `NT SERVICE\AlberaHostBroker` | `NT SERVICE\AlberaHostBroker` | Service SID enabled and present in `TokenRestrictedSids`; session 0; no admin groups or Hyper-V group | Read/execute signed Broker files/config; create the fixed pipe; read the pinned public key; read/write only Broker-owned journal directory. No network listener or arbitrary process execution. |
| Approval Authority | Separate service identity/process, not CP or Broker | Separate SID | Private key unavailable to CP/Broker | Sign only after independent human authorization. Key provider and user-presence ceremony remain a separate gate. |

Configure both SCM services with `SERVICE_SID_TYPE_RESTRICTED` (`sc.exe sidtype <name> restricted` equivalent). Keep one service per process: Windows requires all services sharing a process to use restricted service SID type if any one does. A restricted service SID adds a restricting-SID access check; it does **not** by itself remove user rights or prove least privilege. Do not grant `Se*` privileges unless a later, action-specific experiment identifies a required one. Do not use LocalSystem, Administrators, `Hyper-V Administrators`, or NetworkService. The product has no approved remote resource requirement; outbound and inbound network access remain denied by policy. If a platform limitation prevents a virtual account, stop and revise ADR-002 before substituting LocalService.

Let SCM manage the virtual-account service logon. Do not add a broad user or group to “Log on as a service” to make the test start. Any required user-right assignment is an explicit deployment review item.

Microsoft documents `SERVICE_SID_TYPE_RESTRICTED` as adding the service SID to the process token's restricted SID list, along with World, the service logon SID, and the write-restricted SID; the change takes effect at the next service start. It also says all co-hosted services must use restricted SID type. [SERVICE_SID_INFO](https://learn.microsoft.com/en-us/windows/desktop/api/winsvc/ns-winsvc-service_sid_info)

`LocalService` has minimum local privileges and anonymous network credentials, while `NetworkService` uses the computer identity for remote access. Those built-in accounts are fallback comparison points, not the ADR-selected identities. [LocalService account](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account), [Windows local accounts](https://learn.microsoft.com/en-us/windows/security/identity-protection/access-control/local-accounts)

### Object ACL policy

| Object | Read/use | Write/control | Explicit denial / rationale |
|---|---|---|---|
| Broker named pipe | Control Plane service SID: only `FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE` (`0x00100083`); SYSTEM/Broker as required | Broker service SID and SYSTEM manage/create the pipe instance | No Everyone, Users, Interactive, Guest, Anonymous, or Network ACE. No `FILE_APPEND_DATA`, generic write, or `FILE_CREATE_PIPE_INSTANCE`. Require first-instance and reject remote clients. Validate the actual client token, not message claims. |
| Broker journal directory, DB, `-wal`, `-shm`, backups | Broker SID; SYSTEM and administrator recovery identity | Broker SID; SYSTEM and administrator-controlled installer/recovery | Control Plane, Guest, Observer, and Approval Authority cannot read or write journal data. Restrict the parent directory so SQLite sidecars inherit the Broker ACL. Verify each file and directory after create/restore. |
| Pinned Approval Authority verification key | Broker reads; installer may verify during install | Installer/SYSTEM only | Public key confidentiality is unnecessary; integrity is essential. CP cannot replace Broker trust configuration. |
| Approval Authority private signing key | Approval Authority identity only; SYSTEM-backed key service only if the selected key provider requires it | Key provider/administrator ceremony only | No Control Plane, Broker, Guest, or Main AI read/export/sign rights. Prefer non-exportable CNG/KSP key; explicit human approval must gate signing. |
| Service executable and config | Corresponding service SID: read/execute | Signed administrator-controlled installer/SYSTEM | Neither service can write/reconfigure its executable, other service, service registry configuration, or trust anchor. |
| SCM service object | Installer/SYSTEM: create/configure/start/stop/delete; administrators retain recovery control | Installer/SYSTEM only | Control Plane gets no start/stop/change/delete rights. Grant query-only status only if a reviewed feature actually needs it. |

The Issue #22 prototype's `PipeOptions.CurrentUserOnly` denial test below does not inspect a service pipe's live security descriptor. The Issue #21 Win32 mask evidence is same-user prototype evidence and must not be treated as proof of the service-SID DACL. Inspect the actual service pipe DACL and token groups/restricted SIDs during the separately approved lab.

## Denial test implemented without a second account

`test/runtime-windows-restricted-token-pipe.test.mjs` starts a disposable .NET Broker pipe under the current user's SID. A C# test helper creates a restricted token containing a synthetic restricting SID that is not present in the pipe DACL, impersonates that token only around a synchronous local pipe open, and asserts Windows denies the connection. This is an OS DACL/access-check result; no user, group, service, persistent ACL, or privilege was changed.

Local Windows evidence: the test passed **1/1**. The restricted token retained the same `TokenUser` as the test harness; only its restricting SID set differed. Therefore this proves restricted-token access checking against a live pipe, **not** cross-account denial, a Control Plane service SID, a restricted service process token, token revert behavior, or a service boundary. True distinct-user and service-SID tests remain **BLOCKED** pending a pre-provisioned non-admin test principal / service identity and explicit approval for the service lifecycle test.

## Reversible service lab runbook — not executed

### Preconditions

1. Use a disposable, fully patched supported Windows x64 VM with a snapshot and console recovery. Do not use a developer workstation with unrelated services/data.
2. Obtain explicit approval for the exact service names, signed test artifacts, service identities, temporary data directory, ACL ACEs, event-log channels, test time window, and rollback operator.
3. Confirm both service names are absent, the install/data roots are new dedicated paths, and the pre-test service/ACL inventories are saved outside the test roots. Never reuse or edit an existing service.
4. Stage only signed binaries. Prepare separate non-admin Control Plane and Broker identities, plus an independently controlled Approval Authority identity/key. Do not create users/groups in this issue.
5. Disable all Hyper-V action adapters; use only the synthetic no-op action and temp journal. Keep external network access denied and host/network isolation controls in force until separately reviewed.

### Install and verify

1. Through an administrator-launched fixed installer (not an arbitrary script API), create the two own-process services on demand under their exact virtual accounts.
2. Set each service SID to restricted; install service-object DACLs and protected file/directory ACLs before starting either service. Persist the exact service configuration and SDDL evidence.
3. Start Broker, then Control Plane. Record `QueryServiceConfig[2]`, service status/PID, service object SDDL, process TokenUser, enabled TokenGroups, TokenRestrictedSids, integrity label and session ID. Redact secrets and unrelated account identifiers.
4. Inspect pipe DACL via the kernel object; assert only the intended service/SYSTEM ACEs and exact access masks. Verify CP connects, a pre-existing second principal is denied by DACL, and a connected wrong token is denied by Broker token validation before journal/provider access.
5. As each service identity, attempt bounded read/write probes against the other's state, the Broker DB/WAL/SHM, verification-key file, private signer key, SCM service config, and a synthetic host-protected path. Expected outcome is denial except the matrix grants above. Do not probe arbitrary host paths.
6. Exercise Broker restart and approval replay only with a temp DB and signed synthetic receipt. Preserve `UNKNOWN`; assert one journal claim and zero provider effects.
7. Capture Windows Security/System service events and test logs; verify no key bytes, receipts, user secrets or private paths appear.

### Rollback

1. Stop only the two newly created named services. Confirm their PIDs have exited; do not terminate unrelated processes.
2. Delete only the two services created for this run. Wait for SCM removal and verify both names are absent.
3. Remove only the dedicated temp install/data roots after preserving the test report, journal metadata, ACL/SDDL evidence, and logs. If cleanup is denied, leave the artifacts and report them; do not take ownership or broaden permissions to force deletion.
4. Compare the service, ACL, user/group, privilege, firewall, and network inventories with the preflight snapshots. Any unexpected delta blocks cleanup completion and requires the approved administrator to restore that exact delta.

These steps require admin rights and persist SCM/ACL state until rollback. They were intentionally **not run**. Windows documents that service-object DACL changes persist until the service is removed, and service configuration updates require explicit SCM rights. [Modifying a service DACL](https://learn.microsoft.com/en-us/windows/win32/services/modifying-the-dacl-for-a-service), [Service configuration](https://learn.microsoft.com/en-us/windows/win32/services/service-configuration)

## Verification status

| Acceptance item | Status | Evidence / remaining gate |
|---|---|---|
| Supported identities, rights and reversible procedure documented | **PARTIAL** | Proposed identities, ACL matrix and no-mutation runbook documented. Needs review and approved deployment artifact. |
| Cross-principal isolation and service token/DACL enforcement | **BLOCKED** | Restricted-token DACL negative test passed; different-account and actual service-token tests need an approved pre-provisioned identity and service registration. |
| No privilege inherited by Observer, Guest or Main AI | **DESIGN ONLY / NOT VERIFIED** | No service or Observer/Guest integration was installed. Must inspect actual service tokens and endpoint reachability in lab. |
| Broker restart/replay under service identity | **BLOCKED** | Issue #22 same-user Broker child replay test passed; service identity and service restart require approved registration. |
| Threat review and ADR status | **PENDING** | ADR-002 remains Proposed; do not upgrade status from this prototype. |

## References

- [Microsoft: Service SID information](https://learn.microsoft.com/en-us/windows/desktop/api/winsvc/ns-winsvc-service_sid_info)
- [Microsoft: LocalService account](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account)
- [Microsoft: Service object DACL](https://learn.microsoft.com/en-us/windows/win32/services/modifying-the-dacl-for-a-service)
- [Microsoft: Service configuration](https://learn.microsoft.com/en-us/windows/win32/services/service-configuration)
