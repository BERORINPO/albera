# ADR-002 implementation slice: Windows Host Broker trust contract

- **Status:** proposed implementation contract; ADR-002 remains **Proposed**
- **Scope:** Windows service identity, local IPC, request authorization, and a Mock IPC conformance test
- **Non-goals:** installing a service, changing ACLs or privileges, implementing a Windows named pipe, enabling Hyper-V, or changing the read-only Observer

This document makes the first Host Broker boundary reviewable without claiming that a Windows security boundary has been implemented. The production transport, installer, approval authority, and exact Hyper-V rights remain gates.

## Process and identity contract

| Process | Identity and rights | Must not have |
|---|---|---|
| Control Plane | Dedicated per-service virtual account (`NT SERVICE\AlberaControlPlane`) with its service SID enabled and restricted. It owns its own project/control database and may connect to the Broker pipe. | LocalSystem, Administrators or Hyper-V Administrators membership; Broker binary/config/state write access; host credentials; arbitrary process or shell authority. |
| Host Broker | Separate virtual account (`NT SERVICE\AlberaHostBroker`) with a restricted service SID. It owns its private replay/authorization state and fixed Provider adapter. | LocalSystem by default; shared identity with Control Plane; generic command execution; network listener; Guest-reachable endpoint. |
| Installer / service manager | Administrator-controlled installation/update path. Service configuration and image replacement are writable only by the installer trust root and Windows service-control principals. | Control Plane ability to replace, reconfigure, stop, or start the Broker service. |

Neither service is to be placed in a broad administrator group. The minimum Windows rights needed for each eventual Hyper-V API call have not been established. Until a reviewed per-action rights matrix is proven on supported Windows versions, the Broker must not be installed with Hyper-V mutation capability. The service-account selection also depends on a signed, administrator-controlled installer and update chain; that chain is not implemented here.

## Named-pipe candidate

- Endpoint: `\\.\pipe\ALBERA\HostBroker\v1`; local named pipe only. No TCP fallback.
- The Broker creates the first pipe instance with an explicit protected DACL and first-instance semantics; name squatting or an existing unexpected pipe fails closed.
- DACL principals: Broker service SID and `SYSTEM` receive server control; the Control Plane service SID receives only the read/write data and synchronization rights needed to exchange messages. Do not grant pipe-instance creation rights (`FILE_CREATE_PIPE_INSTANCE` / the pipe alias of `FILE_APPEND_DATA`) to the client.
- Do not grant `Everyone`, `Authenticated Users`, `Users`, `Interactive`, `Network`, or `Anonymous`. The service configuration DACL is separate and must not let Control Plane reconfigure the Broker.
- Set remote-client rejection (`PIPE_REJECT_REMOTE_CLIENTS`), bounded message mode, one request per connection, and a 2 KiB maximum protocol message. Close on malformed, oversized, or trailing data.
- Authenticate every connection from the kernel-provided named-pipe client token. Compare the enabled Control Plane service SID and require service session 0. A message's `subjectId`, SID, PID, approval claim, or other identity string is never proof of caller identity. PID is diagnostic only.
- Impersonate only at identification level to inspect the peer token. Fail closed on impersonation/token-query failure. Always revert before Provider work; if `RevertToSelf` fails, terminate the Broker process. Never run Provider work under the caller token.

The exact SDDL mask and token-group rules must be validated against the supported Windows versions using the native pipe APIs before production deployment. The contract intentionally excludes broad generic write access; the client must not be able to create another server instance or alter the pipe security descriptor.

## Control Plane ↔ Broker request contract

The existing bounded `broker.operation.request` envelope remains the wire shape: protocol version, unique request UUID, `operationId`, `expectedGeneration`, and `actionDigest`. It contains no caller identity, action-specific arbitrary arguments, host path, VM-native ID, shell text, PowerShell, executable name, or credential. The Broker:

1. derives the caller only from the pipe token and requires the configured Control Plane service SID;
2. loads the exact journaled operation and current Lease/generation using Broker-trusted state;
3. verifies a single-use authorization receipt bound to operation ID, action digest, Lease ID/generation, project, policy version, purpose, and expiry; the receipt signer/key must be unavailable to the Control Plane process;
4. permits only the fixed typed actions `create`, `inspect`, `start`, `stop`, and `destroy`, with action and provider arguments resolved from the trusted record;
5. atomically consumes the authorization and records the operation ID/request ID before a side effect; duplicate operation or request IDs never call the Provider again;
6. returns only the fixed response schema, observed state, timestamp, and allowlisted error code. Exception messages, paths, native identifiers, guest output, and secret-shaped error codes are discarded.

**Prototype wire shape (2026-10-30).** The .NET prototype in `src/runtime/windows-broker/Program.cs` does not yet implement the envelope above. Each direction is one frame: a 4-byte little-endian length followed by UTF-8 JSON. The request is exactly `{ "receipt", "signature" }` (base64); the signed receipt carries the operation and generation binding. Replies are exactly `{ ok: true, state, action }` or `{ ok: false, code: "denied" }`. `src/runtime/windows-broker-client.mjs` speaks this shape and enforces the 2 KiB request bound; the Broker itself still accepts frames up to 4 KiB, which must be lowered to 2 KiB to match this contract. The client does not yet verify the pipe server's identity (server process ID and token SID); because the prototype Broker exits after one request, a process that takes the name afterwards could read a signed receipt and forge a reply. That Control Plane check is a precondition for wiring the client into any caller.

The exact authorization-receipt authority and protected store are still an ADR-002 decision. A database writable by a compromised Control Plane is not Broker-trusted state. The mock test exercises the current SQLite journal's single-use approval and expiry checks; it does not implement an independent verifier, choose a production signer, protect state with Windows ACLs, or provide a human approval service. A verified Windows service SID authenticates the Control Plane process; it does not by itself prove human approval or protect against a compromised Control Plane.

The low-privilege Control Plane and privileged Broker are separate processes with separate identities, binaries, writable directories, and service configuration. The Control Plane cannot invoke arbitrary OS commands or reach the Provider directly. The Broker accepts only the named typed protocol above. The existing Observer remains read-only and has no route, credential, pipe handle, or composition path to the Broker.

## Evidence added in this implementation slice

`test/runtime-host-broker-ipc.test.mjs` uses a synthetic authenticated-channel map, the real SQLite operation journal, and `LocalEnvironmentHostBroker` with `MockEnvironmentProvider`. It exercises unauthenticated and wrong-peer denial, fixed-envelope validation, operation/generation binding, duplicate request and operation replay, expired approval, stale generation, and error-message/code redaction. All effects remain synthetic. The test helper's peer map and the in-process broker are not OS authentication, privilege separation, or a Windows IPC implementation.

## Remaining ADR-002 gates

- Select and validate the independent authorization-receipt signer and Broker-protected state.
- Implement and adversarially test native Windows named-pipe DACL, token validation, impersonation/reversion, service SID restriction, remote-client rejection, installer/update trust, and service lifecycle.
- Establish the exact per-action Hyper-V rights matrix and supported Windows editions without granting broad administrator groups.
- Validate crash/restart replay persistence, durable request/operation deduplication, multi-session policy, and fixed action argument resolution.
- Keep real VM, network, firewall, and credential operations disabled until their separate ADR acceptance gates pass.

## Current Windows implementation state — BLOCKED

The native Windows Named Pipe adapter and its Windows Node 22/24 integration tests have **not** been implemented in this checkpoint. The request requires prior approval for real ACL changes and service registration, while this environment provides no separate approval for those operations. No service, account, user right, persistent ACL, named-pipe DACL, or network setting was changed. The gated Windows Runtime storage ACL integration was not invoked.

The local host is Windows / Node `v24.13.0`, but `cl.exe`, `link.exe`, and `msbuild.exe` are unavailable, so a native Node addon cannot be built and exercised locally. The Node `net` API does support Windows named-pipe paths but exposes no parameter for a Windows security descriptor and no API to inspect the connected process token. Replacing the gap with a default-DACL `net` pipe would falsely claim the required boundary and is explicitly rejected. A native Windows API bridge, or another narrowly scoped maintained binding with equivalent documented behavior, must be selected and built before that code can be validated.

The existing OS-authenticated service identity also cannot be verified in this session: the ALBERA services are not registered, and creating/configuring them or assigning service/user rights requires the separately approved deployment step. A same-user child process is not evidence for a Control Plane service SID or a different Windows-user denial. Therefore actual Windows DACL/token-auth tests, separate service identity, service-restart replay proof, and Windows Node 22/24 IPC CI remain **BLOCKED / NOT VERIFIED**. Existing Mock IPC tests remain contract tests only. No code has been added that exposes an unauthenticated Broker route or changes Observer behavior.

To unblock the next implementation attempt, authorize only the disposable named-pipe DACL integration test first (temporary pipe object, spawned test client, automatic handle closure; no service or persistent ACL changes). Service registration, service-account configuration, and user-right changes require a separate explicit approval. After the temporary native boundary passes on Windows Node 22/24, review service identity and approval-store design before deployment. Hyper-V actions remain out of scope.

