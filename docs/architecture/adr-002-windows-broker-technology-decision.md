# ADR-002 Supplement — Windows Host Broker Identity and IPC Technology

- **Issue:** [#20](https://github.com/BERORINPO/pigeonholes/issues/20)
- **Status:** Accepted (Broker/IPC scope) once the C1 lab re-run passes (CISO accept conditions C1-C3, decision-log row `2026-10-30+adr002-broker-accept-conditions`). The main ADR-002 file (`decisions/ADR-002-control-guest-trust.md`) remains **Proposed**; Hyper-V rights, the approval authority, the installer and the Guest side stay **NOT VERIFIED**
- **Date:** 2026-10-28
- **Scope:** Windows process identity, local Broker IPC, approval receipt boundary, durable replay handling, build/package target, and verification plan
- **Non-goals:** installing or configuring services, changing persistent ACLs/accounts/privileges, network/firewall changes, Hyper-V operations, or changing the Observer

This supplement selects a technology and makes ADR-002's Broker boundary implementable. It does not promote the main ADR-002 from Proposed (only the Broker/IPC scope named in the status line is accepted, conditionally) and does not claim that a production security boundary exists. The Runtime implementation remains an in-process adapter; the default Observer remains read-only and disconnected.

## Decision

Implement the future Host Broker as a **separate C#/.NET 10 Windows Service**, with a small, explicit Win32 P/Invoke layer for the Named Pipe operations whose security flags and access masks must be exact. Keep the existing Node.js ESM Control Plane as a separate, low-privilege process/service. The two services use distinct virtual service accounts and restricted service SIDs. The Broker must never run as `LocalSystem`, a local administrator, or a member of `Hyper-V Administrators` by default.

The Windows Service is the process and identity boundary; .NET is the Broker implementation. A dedicated service is not a competing technology alternative to a .NET process. The existing interactive Runtime CLI is not the production Control Plane service and must not connect to this Broker until its identity and approval composition have been separately reviewed.

```text
Human
  | explicit UI confirmation of exact action digest
  v
Approval Authority (separate identity; private signing key inaccessible to Control Plane)
  | signed, short-lived, one-use receipt
  v
Node Control Plane service (low privilege; NT SERVICE\AlberaControlPlane)
  | local Named Pipe; OS token identity + operation reference + receipt
  v
C#/.NET Host Broker service (restricted; NT SERVICE\AlberaHostBroker)
  | fixed typed actions only; Broker-owned durable replay journal
  v
Hyper-V adapter (disabled until per-action rights and host isolation pass review)

Read-only Observer --X--> Control Plane mutation API / Host Broker
Guest and AI payloads --X--> Broker identity, approval signing key, host secrets
```

### Rejected alternatives

| Alternative | Decision | Reason |
|---|---|---|
| Node `net` named pipe in the current Runtime process | Reject as the security boundary | Node's API can address a Windows pipe but does not expose the required explicit Windows security descriptor or connected process token. Default pipe ACLs are unsafe for this use: Windows documents read access for Everyone and Anonymous in the default descriptor. |
| Thin native Node addon (C++/Node-API) | Reject for the Broker boundary | Node-API provides ABI stability, but the addon would execute inside the Control Plane process and cannot create a process/identity boundary. It also adds node-gyp/MSVC, native packaging, architecture artifacts, and a native-code review surface. It may be reconsidered only for a separately justified client transport shim; it must not host privileged Broker code. |
| C# Broker child process launched by Node | Reject | Unless installed and started by the Service Control Manager under a distinct service identity, it inherits the caller's security context and does not create the required privilege boundary. |
| Separate .NET Windows Service | Select | Uses Windows SCM lifecycle and a distinct service token/SID; Microsoft-maintained .NET APIs cover worker hosting, named-pipe streams, and access-control types. P/Invoke remains narrowly limited to Win32 pipe creation/client open and token/revert operations. |

## Process identity, service permissions, and installation

| Component | Proposed identity | Allowed authority | Explicitly denied |
|---|---|---|---|
| Control Plane | Virtual account `NT SERVICE\AlberaControlPlane`; restricted service SID | Own Control Plane state; connect to the named Broker pipe; query Broker service status if needed for server identity confirmation | LocalSystem/admin groups; Broker files, config, and journal write access; arbitrary shell or PowerShell; service start/stop/reconfigure rights; Hyper-V rights |
| Host Broker | Virtual account `NT SERVICE\AlberaHostBroker`; restricted service SID | Own Broker executable configuration and private journal; create its fixed pipe; only future per-action Hyper-V rights after a separate least-privilege review | LocalSystem/admin groups; Control Plane state write access; network listener; arbitrary command execution; Guest-reachable endpoint |
| Approval Authority | Separate process and OS identity; private signing key ACL restricted to this identity | Sign a receipt only after an explicit human UI decision over the exact canonical action/digest | Main AI or Control Plane ability to invoke an unattended signing operation; Broker ability to sign or mint approval |
| Installer / SCM | Administrator-controlled signed installation/update path; SYSTEM for service lifecycle | Create/update service registrations and protected installation directories | Control Plane write access to service binaries, service configuration, Broker state, or approval key |

Use `SERVICE_WIN32_OWN_PROCESS` and `SERVICE_SID_TYPE_RESTRICTED` for both services, in separate processes. The Broker's service-object DACL permits configuration, start, stop, delete, and binary replacement only to the administrator-controlled installer/SCM trust root and SYSTEM; the Control Plane receives query-only status access if needed. The installer must set service image path, start mode, service SID type, service DACL, and directory/file ACLs atomically or fail without starting either service. Updates must validate the signed artifact before replacement and restart. Service registration, ACL changes, account changes, and privilege assignment are deployment operations, not application startup behavior.

The first deployment artifact is a signed x64 ZIP containing the self-contained .NET Broker, a fixed C# .NET 10 administrator-run Installer helper, Node Control Plane service files, and schema/configuration defaults. The Installer helper is the only application component allowed to register services or set persistent ACLs; it calls fixed SCM/security APIs, accepts no shell/script/ACL/identity text from a caller, and runs only after an administrator explicitly launches it. App startup and the Control Plane can never invoke installation. Use `dotnet publish` plus a signed artifact manifest and Authenticode signatures; the helper performs fixed install/upgrade/rollback/uninstall transactions and refuses unknown existing service state. This avoids adding an installer authoring dependency before its license/maintenance terms are approved. No installer code, certificate, or service state is created in this issue.

## Named Pipe and token contract

### Creation and DACL

- Pipe name: `\\.\pipe\ALBERA\HostBroker\v1`; local IPC only; never fall back to TCP/HTTP.
- Broker creates the first instance with `CreateNamedPipeW`, an explicit protected DACL, `FILE_FLAG_FIRST_PIPE_INSTANCE`, and `PIPE_REJECT_REMOTE_CLIENTS`. Failure to create the first instance is fatal for the Broker startup; do not connect to an existing pipe or silently choose another name.
- DACL grants the Broker service SID and SYSTEM full pipe-object control. The Control Plane service SID receives only the data-transfer and synchronization bits required by the client. Do not grant `Everyone`, `Authenticated Users`, `Users`, `Interactive`, `Network`, `Anonymous`, or broad generic write.
- Client open uses specific rights and never requests `GENERIC_WRITE`/`FILE_GENERIC_WRITE` or `FILE_APPEND_DATA`: for named pipes Windows aliases `FILE_APPEND_DATA` to `FILE_CREATE_PIPE_INSTANCE`, which can let a client create another instance. The Issue #21 Windows 10 Pro x64 experiment denied a client opened with `FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE` (`0x00100003`) and accepted `FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE` (`0x00100083`). Use the latter as the prototype's measured mask; revalidate on every supported Windows target before fixing the production mask. The Control Plane client also needs `READ_CONTROL` to read the pipe owner before it sends (see the trust contract's server-verification bullet), so the planned Control Plane mask is `0x00120083`; that addition is not yet measured against a service-SID DACL (lab step 4a in the Issue #23 plan).
- Use one request per connection, byte mode with a bounded length-prefixed frame (maximum 2 KiB), strict protocol/version/schema checks, and immediate close on truncation, over-size, malformed, or trailing bytes. No identity field, PID, path, command, arbitrary action arguments, or secret travels in the request.
- The client verifies the server before sending data: obtain the pipe server PID, hold a process handle while inspecting its token, require the Broker service SID and session 0, and cross-check against the SCM-reported running Broker PID. If identity cannot be established, fail closed. PID is diagnostic/cross-check data, not the identity proof.

Windows documents that a null/default pipe security descriptor grants broad read access, that generic write includes the pipe-instance creation bit, and that `FILE_FLAG_FIRST_PIPE_INSTANCE` causes later instance creation to fail. These are reasons to use explicit Win32 flags and access masks rather than assume a pipe name is private.

### Client token validation and impersonation

1. Read one bounded frame, then inspect the kernel-associated client token; ignore any caller-supplied user, SID, PID, service name, approval, or identity claim.
2. Use `ImpersonateNamedPipeClient` only to obtain/query the thread token at identification level. **Implemented and enforced today (corrected 2026-10-30, accept condition C2 ii):** the token's user SID must equal the configured Control Plane SID (a virtual service account or a user, never a group); any token-query error is a denial. **Target design, NOT implemented** (listed as a gap in `adr-002-host-broker-trust-contract.md`): additionally require the exact enabled Control Plane service SID in `TokenGroups`, the service SID in `TokenRestrictedSids`, `TokenSessionId == 0`, and the expected mandatory-integrity level for the installed configuration, and reject a normal interactive-user token, disabled/missing service SID, unexpected restricting SIDs or low integrity. Until then the pipe DACL (data rights to that one SID only) is what admits the caller. PID is not substituted for token inspection. The query needs no `SeImpersonatePrivilege` (the client opens at `SECURITY_IDENTIFICATION`); see "Least privilege" in the trust contract.
3. The impersonated section is synchronous, bounded, and contains only token queries. No disk, database, Provider, or Hyper-V work occurs while impersonated. Do not `await`, queue work, call plugins, or invoke callbacks inside it.
4. Always call `RevertToSelf` from a `finally` path before handling the request. If revert fails, call `Environment.FailFast`/terminate the Broker process; do not continue servicing another connection. Provider dispatch occurs only after successful revert.
5. Treat `GetNamedPipeClientProcessId` as diagnostic only. On token impersonation or inspection failure, close the connection and return a fixed generic denial; never fall back to message identity.

An ephemeral same-user pipe can establish API behavior, DACL masks, first-instance rejection, and the presence of token inspection code. It cannot establish the registered Control Plane service SID, a restricted service token, different-account denial, SCM service-object permissions, installer trust, or privilege separation. Those require a separately approved test service/account setup and an administrator-controlled Windows host.

## Approval and fixed-action contract

The Approval Authority is a distinct trust domain. It receives a normalized immutable approval request from the Control Plane, displays the exact action, target, project, Computer, Lease generation, policy version, and digest to the human, and emits a signed receipt only after explicit human confirmation. The signing private key is not present in the Model, Guest, Control Plane, or Broker; the Broker pins only the authority's public verification key. The exact human-presence mechanism and production key-provisioning ceremony remain an implementation gate and must be decided before enabling actions.

The receipt binds at least: issuer, audience=`ALBERA-HostBroker`, approval ID, unique receipt ID (`jti`), human approver, subject, project, task/run/Computer, exact `operationId`, idempotency key, fixed action, canonical action digest, Lease ID and generation, policy version, purpose, issued-at, expiry, and one-use nonce. It carries the exact bounded, typed action DTO covered by the digest; it never carries a command, arbitrary provider arguments, host path, native VM ID, or credential. Broker validates signature, audience, purpose, expiry, generation and digest against Broker-trusted state, then persists the signed DTO and its receipt atomically before dispatch. Broker maintains the current Computer generation in its own journal and advances it only from a Broker-verified restore/re-registration fence; a client-supplied generation cannot create or advance that state. Guest/client payloads cannot choose the trusted record or signer. Main AI can propose an action but cannot issue, extend, or approve its receipt.

The only Broker actions are typed `create`, `inspect`, `start`, `stop`, and `destroy`, resolved from the Broker-trusted operation record. There is no generic executable, shell, PowerShell, script, WMI query, path, or command parameter. The current minimum Hyper-V rights are **none**: until an action-by-action permission matrix and host/network gates pass, the production Broker exposes no Hyper-V mutation capability. Do not add the Broker service identity to `Hyper-V Administrators`. Hyper-V uses the `root\virtualization\v2` WMI/CIM provider, and WMI namespace ACLs are only one layer; provider-level method/resource checks still need empirical verification on each supported host. Determine and test the minimum rights for each fixed operation under the dedicated Broker identity before enabling even one operation.

## Durable operation and replay protocol

- Broker owns a separate journal under a directory writable only by the Broker service SID and SYSTEM. The Control Plane cannot edit or restore it. Use SQLite WAL with `synchronous=FULL`, atomic uniqueness constraints, integrity checks, bounded records and a protected backup/recovery policy; inspect WAL/SHM/backup ACLs as well as the main file.
- Before a provider side effect, one transaction persists the validated operation ID, request ID, receipt `jti`, immutable digest, Lease generation, action, and transition to `IN_PROGRESS/UNKNOWN`. A unique constraint prevents receipt/operation reuse. A durable `UNKNOWN` claim is not evidence the provider action happened or stopped.
- Exact duplicate requests return the already stored status/result; the same operation ID or receipt nonce with different fields is denied. A new request ID cannot cause the same operation's provider mutation to run again.
- On restart, all previously `IN_PROGRESS` work becomes or remains `UNKNOWN`. Reconciliation performs read-only inspection using the fixed operation ID and trusted provider registration. It never automatically repeats a mutation. Missing, delayed, conflicting, or unavailable provider state remains `UNKNOWN` for explicit recovery.
- Lost response, timeout, process termination, or storage error after dispatch is ambiguous, not proof of failure. Do not issue compensation or a fresh operation automatically.
- Receipt expiry uses Broker time; persist the last accepted time and fail closed on an observed clock rollback beyond the documented tolerance. Lease generation is checked both before durable claim and immediately before dispatch.

## Windows target, SDK, licensing, and packaging

Initial support target is **x64, fully patched** Windows 11 Pro/Enterprise versions still in servicing (currently 25H2/26H2; Enterprise 24H2 only while Microsoft services it) and Windows Server 2022/2025 Standard or Datacenter. Windows 11 Home is excluded because it cannot install Hyper-V; Windows 11 24H2 Home/Pro is excluded after its October 13, 2026 end of updates. Re-evaluate the support table every release; “Windows 11” without edition/build is not a tested support claim. ARM64 is out of scope until separate build, OS, Hyper-V, and integration evidence exists.

Required build/test toolchain for the selected implementation:

- Microsoft .NET SDK **10.0.x LTS**, pinned by `global.json` and a repository `packages.lock.json`; current host observation is SDK `10.0.302`, runtime `10.0.10`. Microsoft listed runtime patch `10.0.14` on 2026-10-25, so the locally installed runtime is not current and must be patched before running a Broker binary.
- `Microsoft.Extensions.Hosting.WindowsServices` 10.0.x for SCM worker hosting; `System.IO.Pipes.AccessControl` and .NET's `System.IO.Pipes` APIs for access-control types/stream wrapping; direct P/Invoke for `CreateNamedPipeW`, `CreateFileW`, `GetNamedPipeClient/ServerProcessId`, token queries, `ImpersonateNamedPipeClient`, `RevertToSelf`, and safe handle release. No C/C++ toolchain is required for C# P/Invoke.
- Windows x64 CI runner with .NET SDK 10 and Node 22/24; run API/contract tests on all platforms, but run named-pipe, Windows token, DACL and service integration only on Windows. Test Node 22/24 against the same independently built Broker artifact.
- No C++ compiler or Node native addon is required for this design. If later code uses `node-addon-api`, Node-API is ABI-stable and the project is MIT-licensed, but the addon still does not provide process separation and requires native build/package maintenance.
- Self-contained signed x64 ZIP + fixed .NET Installer helper; protected install/data directories; explicit SCM service DACLs; signed upgrade/rollback. Build with `dotnet publish`, `System.IO.Compression`, and Windows SDK `signtool.exe`; pin the Windows SDK/SignTool version in CI and verify signatures before install. The production Authenticode certificate and its custody require separate approval. No WiX or Inno Setup dependency is selected: their 2026 commercial-use terms include fees/license expectations that must not be assumed or silently accepted.

This approach adds a separately built .NET service and Microsoft-hosted package references but no non-Microsoft native runtime. .NET and `node-addon-api` are MIT-licensed. Package versions and transitive dependencies still require lockfile, vulnerability, license, and support review at implementation time.

## Negative test matrix and evidence boundary

| Case | Expected result | Unprivileged ephemeral pipe | Separate service/account test required |
|---|---|---|---|
| No connection token / token query failure | Fixed denial; no journal/provider call | Can inject API failure; can test same-user connection only | **Yes** for OS token failure behavior |
| Unauthorized SID / different Windows user | DACL denies connect; if connected, token SID check denies before journal/provider | DACL shape can be inspected; no proof for an unconfigured account | **Yes** with approved pre-existing second account or service identity |
| Tampered SID/PID/subject in request | Ignore/reject schema; OS token remains sole peer identity | **Yes** with synthetic fields and real local pipe | No, for transport identity source itself |
| Pipe squatting / unexpected server | Broker first-instance creation fails; Control Plane rejects unexpected server SID/PID | **Yes** with two unprivileged disposable processes and a random pipe name | Service install is not needed; service-token identity check remains separate. Evidence (prototype, same-user only): `test/runtime-windows-broker-fault-injection.test.mjs` pre-creates the pipe and races two Brokers; the Broker exits 70 (`BROKER_FATAL=PIPE_UNAVAILABLE`) before `BROKER_READY` and touches no journal. The Control Plane SID/PID check is not covered. |
| Remote client | Connection refused by `PIPE_REJECT_REMOTE_CLIENTS` | Can inspect flag; remote-origin proof needs a separate isolated test host | **Yes** for empirical remote-denial evidence |
| Stale Lease generation | Broker denies before provider dispatch | **Yes** with synthetic journal/Lease state | No, unless coupled to restore service integration |
| Expired or altered approval receipt | Signature/expiry/digest validation denies before dispatch | **Yes** with test keys and fixed clock | Separate approval service/key protection still required |
| Request/operation/receipt replay | Unique IDs reject reuse; exact retry returns prior fixed status, never repeats mutation | **Yes**, including restart using a disposable Broker child and temp journal | No service registration needed; production protected journal ACL remains separate |
| Crash before/after provider effect or before response | Restart recovery retains `UNKNOWN`; inspect before any retry; no duplicate mutation | **Yes** using a fake provider and separate child process | Real Hyper-V effect is prohibited and not required for this issue |
| Impersonation revert failure | Process terminates; it never handles another request | Can fault-inject wrapper behavior | **Yes** for actual Win32 failure-path evidence. Evidence (prototype, injected only): a test-only `serve-fault` build (`-p:AlberaBrokerTestFaults=true`, absent from the shipped build) skips the real `RevertToSelf` (returns false, throws, or claims success while the thread stays impersonated); the Broker terminates with exit 71 (`BROKER_FATAL=IMPERSONATION_REVERT_FAILED`), writes no response and creates no journal. A genuine Win32 `RevertToSelf` failure remains NOT_VERIFIED. |

For any ephemeral OS test, use a random pipe name and disposable temp state, close every handle/process, and preserve no service/account or persistent ACL changes. Cross-account/service tests require a pre-approved test account/service identity and Windows host; service registration, service rights, installer ACLs, network changes, and Hyper-V remain separately approved operations. This Issue has not performed those tests.

## Current evidence and open gates

- The local host reports Windows build `10.0.26300` and .NET SDK `10.0.302`; MSVC `cl.exe`/`link.exe` are not on PATH. This identifies available tooling only; it does not identify the Windows edition or prove service/pipe behavior.
- Official Microsoft API references document `NamedPipeServerStreamAcl.Create` with a `PipeSecurity`, named-pipe client impersonation, default-DACL risks, `FILE_CREATE_PIPE_INSTANCE` aliasing, first-instance failure semantics, and service SID tokens. They support the selected API design, not successful ALBERA integration.
- Existing Node Mock IPC tests are contract tests only. They do not prove Windows SID/DACL/service identity, OS impersonation/revert, service isolation, or Broker restart replay.
- No pipe was created, no service registered, and no account, persistent ACL, privilege, firewall, network, or Hyper-V state was changed for Issue #20.

### Issue #21 ephemeral Named Pipe prototype evidence

- A test-only C#/.NET 10 prototype now creates a random local pipe with `CreateNamedPipeW`, an explicit protected DACL, `FILE_FLAG_FIRST_PIPE_INSTANCE`, and `PIPE_REJECT_REMOTE_CLIENTS`. `GetSecurityInfo` inspected the live kernel pipe object: the DACL was protected, had exactly one ACE, and its SID matched the configured test user. The reported access mask was `0x00100083`; the SID itself is intentionally omitted from test/CI logs.
- A disposable client used `CreateFileW` with the observed specific mask. The server obtained the peer SID inside `NamedPipeServerStream.RunAsClient` and compared the OS token identity to the expected SID; it did not trust request identity or PID fields. A syntactically valid request with spoofed identity/PID and a synthetic secret-bearing field received only the fixed `invalid_request` response, and the injected text did not appear in output.
- A disposable same-user process pre-created the random pipe. The Broker prototype's first-instance creation failed closed with `ERROR_ACCESS_DENIED (5)`. After the squatter process exited, creating the same first-instance name succeeded, showing that the temporary pipe name was released.
- This is same-user evidence only. It does not prove cross-account denial, the Control Plane/Broker restricted service SID, session-0/service token groups, service-object ACLs, or production identity isolation. Those remain unverified and require a separately approved test identity/service setup. No service, user, permanent ACL, privilege, network, or Hyper-V state was changed.
- Local evidence was collected on Windows product `Windows 10 Pro`, build `10.0.26300`, Node `v24.13.0`, .NET SDK `10.0.302`, and installed .NET runtime `10.0.10`. The shell token reported Medium Integrity and the Administrators group as deny-only. This build/edition is not a verified supported-target claim; the installed .NET runtime is behind the current servicing patch and must be updated before running a production Broker.
- `test/runtime-windows-named-pipe.test.mjs` runs the disposable probe during `npm test` on Windows when an existing .NET 10 SDK is available; otherwise it emits an explicit skip. Hosted Windows Node 22/24 runs are required for the PR evidence. The test harness writes build output to a unique OS temp directory and removes it after completion.

Before implementation can claim the ADR-002 transport acceptance gate: compile and test the Windows wrapper on Node 22/24; run ephemeral same-user pipe/DACL/pipe-squatting tests; execute the pre-approved cross-account/service tests; record actual token group/SID and DACL evidence; inject `RevertToSelf` failure; and pass Broker-child restart replay tests. Before enabling Hyper-V actions: separately approve service registration/identity setup, complete per-action rights analysis, sign/verify the installer chain, review the independent approval authority/key ceremony, and prove network isolation. ADR-002 stays Proposed until those gates pass.

## References

- [Microsoft: Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft: CreateNamedPipeW](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew)
- [Microsoft: NamedPipeServerStreamAcl.Create](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeserverstreamacl.create)
- [Microsoft: NamedPipeServerStream.RunAsClient](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeserverstream.runasclient)
- [Microsoft: Service SID information](https://learn.microsoft.com/en-us/windows/desktop/api/winsvc/ns-winsvc-service_sid_info)
- [Microsoft: .NET Windows Service hosting](https://learn.microsoft.com/en-us/dotnet/core/extensions/windows-service)
- [Microsoft: .NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy)
- [Microsoft: .NET runtime license](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT)
- [Microsoft: Windows 11 release information](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information)
- [Microsoft: Windows Server 2022 lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-server-2022)
- [Microsoft: Windows Server 2025 lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-server-2025)
- [Microsoft: Hyper-V installation support](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v)
- [Microsoft: Hyper-V WMI v2 interface](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/refactor-wmi-v1-to-wmi-v2)
- [Microsoft: WMI namespace security](https://learn.microsoft.com/en-us/windows/win32/wmisdk/securing-wmi-namespaces)
- [Node.js: Node-API ABI stability](https://github.com/nodejs/node-addon-api/blob/main/doc/README.md)
- [Node.js: node-addon-api license](https://github.com/nodejs/node-addon-api/blob/main/LICENSE)
- [WiX Toolset: open-source maintenance fee terms](https://github.com/wixtoolset/wix/blob/main/OSMFEULA.txt)
- [Inno Setup: commercial use terms](https://jrsoftware.org/isorder.php)
