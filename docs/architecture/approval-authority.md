# Approval Authority (option B): design notes and wire protocol

**Status: Proposed, NOT VERIFIED.** The design (a separate Approval Authority; a human co-signs the exact action digest with Windows Hello; the Control Plane can only submit and poll) is provisionally adopted. This document describes what `src/runtime/windows-approval-authority/` implements today and what is still fake. It does not edit ADR-002; the lead folds the relevant parts into the shared docs. Related: #84.

## What it is

A separate .NET 10 service process, `NT SERVICE\AlberaApprovalAuthority` (restricted SID), built on demand with `npm run build:approval-authority`. It signs **receipt v2** (`src/runtime/broker-contract/`) only after a human has co-signed the exact request. The Control Plane has no way to approve, alter or sign: it can submit a request and poll for the outcome.

```
Control Plane ──submit/status──▶ [ALBERA\ApprovalAuthority\submit\v1]  ┐
                                                                        ├─ Authority (pending store, memory only)
Approver UI  ──list/decide────▶ [ALBERA\ApprovalAuthority\approver\v1] ┘        │ signs with the machine key
(Windows Hello on the human's PC)                                               ▼
                                          receipt v2 + ECDSA P-256 signature, returned by `status` to the Control Plane,
                                          which forwards it to the Broker (the Broker validates it; not wired yet)
```

## Trust model

- Two pipes, one principal each. Each pipe is created once as the first and only instance (a squatter or a second Authority makes the service stop with 70), owned by the service's own SID, with a DACL of exactly the service SID (full control) plus **one** configured SID with `0x00120083` (read data, write data, read attributes, read control, synchronize; never append / create-instance, never a generic right). The Control Plane SID is on the submit pipe only; the approver SID is on the approver pipe only.
- Every connection is checked again by peer SID (impersonate the client, read the SID, revert at once on the same thread; a revert that fails or leaks a token ends the process with 71). A peer that is not the configured SID gets `request_invalid`.
- The verb set depends on the pipe: submit pipe `submit` / `status`, approver pipe `list` / `decide`. Any other verb on a pipe is `request_invalid`. So a Control Plane connection cannot list or decide even if it somehow reached the approver pipe's logic, and the approver cannot submit.
- The Authority **computes the action digest itself** from the DTO (`ActionDigest.Compute`). A digest sent by the Control Plane is optional (`expectedDigest`), compared with the Authority's own and never used; a mismatch is `request_invalid` and nothing is queued.
- Fields the Broker validates (`brokerEpoch`, `brokerChallenge`, `leaseGeneration`, `leaseId`, `operationId`, `idempotencyKey`) come from the submit request. `audience`, `policyVersion`, `kid`, `approverKeyId` come from the Authority's trusted config. `iat` / `exp` (120 s) come from the Authority's clock.
- Before a request is queued, and again before signing, the receipt it would become is checked with the contract's own validator (`ReceiptV2.Validate`), so a request the Broker would reject never reaches a human, and a receipt is never signed that the contract rejects.
- Presence is verified over the Authority's own message, rebuilt from its own entry: `"albera.presence.v1" 0x00 approvalId 0x00 actionDigest 0x00 challenge` (UTF-8). The digest covers purpose, action, project, computer and args; the challenge is 128 random bits per entry. A signature therefore cannot be replayed on another request. The real verifier accepts exactly one pinned RSA-2048 public key and an RSA PKCS#1 v1.5 / SHA-256 signature (what a Windows Hello `KeyCredential` produces).
- Presence failure, a deny and an expiry are final for that request; the Control Plane resubmits (with a new `idempotencyKey` after a final failure) and the human decides again.
- The pending store is memory only: a restart forgets pending requests, which is safe (resubmit, approve again).

## Limits

| | |
|---|---|
| pending requests | 32 (the 33rd is `queue_full`); 64 entries in total including remembered outcomes |
| pending TTL | 120 s (`request_expired` for another 60 s, then forgotten) |
| outcome retention | 120 s after the decision |
| receipt TTL | 120 s (`iat` = approval time) |
| frame | 4-byte LE length + UTF-8 JSON, 1..2048 bytes each way, one request then one reply per connection |
| list entry | at most 1700 bytes (checked at submit, so a request that could not be shown in one frame is `request_invalid`); `list` pages by frame size |
| same `operationId` + `idempotencyKey` | returns the first request (pending, or approved while its receipt is valid); different content under that key is `request_invalid` |

## Wire protocol (exact JSON)

Requests are read with the contract's strict JSON reader (objects, strings, booleans, safe integers; no null / arrays / duplicate keys / extra keys). `v` is always `1`.

Submit pipe:

```jsonc
// submit
{"v":1,"verb":"submit","purpose":"broker.operation","operationId":"op-1","idempotencyKey":"idem-1","leaseId":"lease-1",
 "leaseGeneration":7,"brokerEpoch":3,"brokerChallenge":"_-7dzLuqmYh3ZlVEMyIRAA",
 "action":{"action":"environment.start","projectId":"proj-alpha","computerId":"pc-01","args":{"vmName":"alpha"}},
 "expectedDigest":"sha256:<64 hex>"}            // expectedDigest optional
// reply
{"ok":true,"approvalId":"<uuid>","state":"pending","expiresAt":1800000120}      // state "approved" when an approved request is reused

// status
{"v":1,"verb":"status","approvalId":"<uuid>"}
// replies
{"ok":true,"state":"pending","expiresAt":1800000120}
{"ok":true,"state":"approved","receipt":"<base64 receipt v2 JSON>","signature":"<base64 64-byte ECDSA P-256 r||s over the receipt bytes>"}
{"ok":false,"code":"human_denied"}
```

Approver pipe:

```jsonc
// list (afterSeq optional, default 0)
{"v":1,"verb":"list","afterSeq":0}
// reply: oldest first, as many as fit one frame; if "more", ask again with afterSeq = lastSeq
{"ok":true,"pending":[{"seq":1,"approvalId":"<uuid>","purpose":"broker.operation","operationId":"op-1","actionDigest":"sha256:...",
  "challenge":"<22 chars>","expiresAt":1800000120,
  "action":{"action":"environment.start","projectId":"proj-alpha","computerId":"pc-01","args":{"vmName":"alpha"}}}],"more":false,"lastSeq":1}

// decide
{"v":1,"verb":"decide","approvalId":"<uuid>","decision":"approve","presence":"<base64 256-byte RSA PKCS#1 v1.5 SHA-256 signature over the presence message>"}
{"v":1,"verb":"decide","approvalId":"<uuid>","decision":"deny"}
{"v":1,"verb":"decide","approvalId":"<uuid>","decision":"presence_unavailable"}   // the UI could not get a Hello proof
// replies
{"ok":true,"state":"approved"}   {"ok":true,"state":"denied"}   {"ok":false,"code":"presence_mismatch"}
```

Error replies are always exactly `{"ok":false,"code":<code>}` with one of: `authority_unavailable` (the signing key is unusable, or an internal failure), `request_invalid` (malformed, wrong verb for the pipe, unknown id, wrong peer, request the contract rejects, not pending), `request_expired`, `human_denied`, `presence_unavailable`, `presence_mismatch`, `queue_full`. Nothing from the request is ever echoed.

## Service entry and config

`albera-approval-authority.exe service <config.json>` (started by the SCM only; anywhere else it exits 74 before touching the config, the key or a pipe) and `service-check <config.json>` (validates the config exactly as the service would, prints one fixed line). The config has exactly these string keys: `pipeRoot` (default `ALBERA\ApprovalAuthority`), `controlPlaneSid`, `approverSid`, `signingKeyName`, `signingKeyProvider` (`software` or `tpm`), `kid`, `approverKeyId`, `approverPublicKey` (base64 SPKI, RSA-2048), `audience`, `policyVersion`. The file must be owned and writable only by the service SID, SYSTEM or Administrators (exit 73 otherwise). Production also refuses one SID for both pipes, or the service's own SID (`sids_not_distinct`); the approver SID must be a user (S-1-5-21), the Control Plane SID a user or a virtual service account.

Exit codes: 70 pipe name taken, 71 impersonation revert failed, 72 pipe owner not settable, 73 config rejected, 74 not started by the SCM, 75 unexpected failure, 77 signing key cannot be opened, 78 signing key opened but not protected as required (below). 76 is the Broker's "journal refused" and is unused here.

### Signing-key guard (exit 78)

After the key is opened and **before either pipe exists**, `SigningKeyGuard` reads two things off the opened CNG key and refuses to start (`AUTHORITY_FATAL=SIGNING_KEY_UNPROTECTED:<reason>` plus one `AUTHORITY_FIX=` hint line, STOPPED with 1066 / 78) unless both hold:

- **Export Policy is exactly none** (no export, no archiving, plaintext or not). Reason `key_exportable`; `export_policy_unreadable` if the property cannot be read.
- **The security descriptor (`NCRYPT_SECURITY_DESCR_PROPERTY`, owner + DACL) names only three principals: the Authority's own per-service SID (`NT SERVICE\AlberaApprovalAuthority`, S-1-5-80-..., derived from the fixed service name and required to be an enabled group of the process token, else `service_sid_missing`; the token's user SID is never trusted, so running as LocalService, NetworkService or a user is refused), `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators`**, as owner (`owner_untrusted`) and in every allow ACE of any access mask (`ace_untrusted`). Everyone, Users, Authenticated Users, Interactive, ALL SERVICES, LocalService, NetworkService, another service and any user are therefore refused. A NULL DACL is `dacl_missing`; a missing or malformed descriptor is `descriptor_unreadable`. Deny ACEs grant nothing and are ignored. SYSTEM and Administrators are inside the trust boundary because they can take the key file anyway; this guard is about everyone else.

The check only reads the key and runs once at start-up (not re-checked while running). The reason is one fixed word, never a SID or a name. The TPM Platform Crypto Provider may not expose the security-descriptor property; if it does not, the guard refuses (fail closed) until that is verified on hardware, so a `tpm` key is **untested** here.

## Real versus fake

| piece | real (shipped) | fake (test-faults build only) |
|---|---|---|
| receipt signer | `CngMachineKeySigner`: **opens** a named persisted ECDSA P-256 key with `NCRYPT_MACHINE_KEY_FLAG` (software KSP or the TPM Platform Crypto Provider); never creates, exports or imports a key, and refuses to start unless the key is non-exportable and only the service, SYSTEM and Administrators can use it (`SigningKeyGuard`, exit 78) | `FakeReceiptSigner`: in-memory key, issuer `albera-test-approval-authority` (production validation rejects it) |
| human presence | `RsaPresenceVerifier`: pinned RSA-2048 key, PKCS#1 v1.5 / SHA-256 (pure BCL, so it is fully tested with a Node-generated key) | `FakePresenceVerifier`: SHA-256 proof, or `0x55` for "unavailable" |
| Windows Hello itself | **not in this process.** The approver UI calls Hello and sends the signature; no UI exists yet | tests sign with a Node RSA key |
| pipes, ACLs, peer check, service host, protocol, store, receipt builder | real | same code |

The fakes and the `serve-loop` / `request` test entries are `#if ALBERA_AUTHORITY_TEST_FAULTS` (`-p:AlberaAuthorityTestFaults=true`). The publish script pins it `false`, and tests assert the shipped DLL has none of those names or strings.

## Code reuse

The Broker project is not referenced (separately deployable). `ServiceHost`, `ServicePathGuard` (config-file part only), the first-instance pipe creation, the peer-SID check and the frame I/O are **copied** into the Authority project; the receipt contract is source-included from `../broker-contract`. A `src/runtime/windows-common/` was not created: the copied pieces are small, tied to each project's exit codes and config, and the Broker is being changed by another change set. Factor them once both settle. The Authority has no database, so `DatabaseFolderPin` is not needed.

## Tests

- `test/runtime-approval-authority-unit.test.mjs`: 52 in-process checks via `test/approval-authority-harness/` (store limits and dedupe, digest recomputation, expiry, `queue_full`, receipts that validate with the contract and verify with the signer key, presence, protocol, config, CNG refusing a missing key, and the signing-key guard: 10 on synthetic descriptors, the service-SID derivation, the token test and export policies, 5 on real **per-user** software keys created with a random name and deleted at the end, no admin) plus a Node-vs-C# digest comparison. The machine-key scope and the exit code through the SCM cannot be host-tested.
- `test/windows-service-lab-authority-key.test.mjs`: `new-authority-key.ps1` run unprivileged with `-Scope user` (good / exportable / broad-ACE keys read back from a fresh open), plus source guards on the lab wiring.
- `test/runtime-approval-authority-integration.test.mjs`: the real pipes with the test-faults build (flows, deny, presence failures, wrong verb per pipe, tampered digest / DTO, expiry, `queue_full`, malformed frames, live DACLs with two SIDs, squatting, service-check, config trust, the shipped build having no fakes).
- `test/runtime-approval-authority-source.test.mjs`: source guards (any OS, no .NET).
- `test/runtime-approval-authority-client.test.mjs` (any OS, fake helper) and `test/runtime-approval-authority-client.integration.test.mjs` (the real helper against the test-faults Authority: submit, approve, status returns a receipt that validates; squatter, wrong owner / PID / image, stopped Authority).
- `scripts/arch-check.mjs` rule 10 and `scripts/package-smoke.mjs`: nothing in the Observer or the npm package names or ships the Authority.

## Node client for the submit pipe

`src/runtime/approval-authority-client.mjs` exports `submitApproval({...})` and `getApprovalStatus({ approvalId, ... })`. It builds the request strictly (ids, counters, canonical challenge, the action DTO through `broker-contract/action-digest.mjs`, optional `expectedDigest` when `includeDigest: true`, 2 KiB bound in UTF-8 bytes), validates the reply against a fixed schema (an approved reply must carry a receipt v2 that parses and names the requested approval, plus a 64-byte signature) and returns only fixed codes. It never opens the pipe itself: it spawns the SHA-256-manifest-checked pipe client helper (`windows-broker-pipe-client`, now serving both servers through an `authority` request kind), which opens with SQOS identification and verifies the owner SID, the PID (service mode: the SCM PID and session 0) and optionally the image hash on the connected handle before writing. The caller passes the Authority's pipe root and the `expect` (service name in production; owner SID + PID in tests). Pre-send codes (retry-safe): `invalid_request`, `invalid_pipe_name`, `request_too_large`, `unsupported_platform`, `authority_unreachable`, `access_denied`, `server_identity_mismatch`, `server_identity_unavailable`, `helper_unavailable`. Everything else, including the Authority's own codes, comes after the frame was written. The signature and the receipt content are not verified by the client; the Broker does that.

## Needs the VM lab or the owner

- **VM lab (admin, disposable VM):** register the service as `NT SERVICE\AlberaApprovalAuthority` with a restricted SID and reduced privileges; confirm the pipe owner and DACL with real, different Control Plane and approver accounts (a test has one user, so it proves the ACE separation from the live DACL and the verb allow-list, not an actual second-account denial); run `service` under the SCM (RUNNING only after both pipes exist, STOP, exit codes 70 / 71 / 72 / 73 / 77); an impersonation-revert failure injection (exit 71 is copied code, not fault-injected here). The key guard is wired into the lab driver (`test/windows-service-lab/`, checks `k_*`, **not yet executed in the VM**): `new-authority-key.ps1` creates a machine key in the guest, the real Authority service is started with it, and the checks expect RUNNING for a good key, 1066 / 78 for an exportable key and for a key with an extra Everyone ACE, and 1066 / 77 for a missing key. The lab must also show that a restricted-SID service token can open and sign with a key whose DACL names only its service SID (the guard accepts it, but opening under that token is not host-tested).
- **Owner (Yosuke):** enrol Windows Hello and provide the approver key (an RSA-2048 `KeyCredential` public key and which account approves); create the machine signing key (TPM or software KSP) with its ACL limited to the service account, and its public key to the Broker; pick `kid`, `approverKeyId`, `audience`, `policyVersion`. An approver UI that lists requests, shows the exact DTO (strings are shown exactly, NFC and NFD differ), asks Hello to sign the presence message and calls `decide` is not written.
- **Not done here:** the Broker does not enforce receipt v2 yet (single-use store, `brokerEpoch` / `brokerChallenge` issuing, `kid` to public key pinning); the Node client for the submit pipe exists (`src/runtime/approval-authority-client.mjs`, below) but nothing calls it yet; AzureAD-joined approver SIDs (`S-1-12-1-...`) are not accepted.

## Preconditions before production (review of PR #89, 2026-10-30)

- **Signing-key isolation is checked, not assumed.** Implemented (exit 78, see "Signing-key guard"): at start-up the Authority reads the CNG key's security descriptor and export policy and refuses to start unless the key is non-exportable and its owner and every allow ACE are limited to `NT SERVICE\AlberaApprovalAuthority`, SYSTEM and BUILTIN\Administrators (cross-vendor review, MEDIUM). Host-tested on synthetic descriptors and per-user keys; the machine-key path and the exit code are lab-only and not yet run. Still open: the TPM provider path, and the owner's installer must create the production key this way (the lab script `new-authority-key.ps1` is the reference, lab use only).
- **Windows Hello provenance is verified.** The pinned approver key must come from a trusted enrollment that proves it is a Hello key credential (KeyCredential attestation or an equivalent binding), not any RSA-2048 key whose private part sits in a file (cross-vendor review, MEDIUM).
- The client side (Control Plane and approver UI) must verify the pipe server's owner SID and PID before writing, like `windows-broker-pipe-client` does for the Broker (CISO review).
