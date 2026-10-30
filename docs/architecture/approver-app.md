# Approver app (`AlberaApprover.exe`): the human's console for the Approval Authority

**Status: Proposed, NOT VERIFIED.** The approver app is the human side of the Approval Authority (`approval-authority.md`). It lists the Authority's pending requests, shows every input of the action digest, and approves or denies. **The real Windows Hello step is not built** (see "Real versus fake" and "Owner decisions"): the shipped binary can list and deny, but it cannot approve. This document does not edit ADR-002, the trust contract or the status documents; the lead folds the relevant parts into them. Related: #84.

## What it is

A .NET 10 console program (`src/runtime/windows-approver/`, assembly `AlberaApprover`), built on demand with `npm run build:approver`. It talks only to the Authority's approver pipe `ALBERA\ApprovalAuthority\approver\v1` (wire protocol: `approval-authority.md`). It shares only the receipt v2 / action digest contract with the other projects, by source include (`../broker-contract/*.cs`); the Broker and Authority projects are not referenced, and nothing in the Observer or the npm package names it (`npm run arch` rule 11, `npm run package:smoke`).

```
human ── AlberaApprover.exe ──(approver pipe; server verified first)──▶ Approval Authority
            list / approve / deny
            │  recompute digest with ActionDigest (broker-contract)
            └─ IPresenceSigner ──▶ Windows Hello  (NOT built)   |   fake in-memory RSA key (test-faults build only)
```

## Commands

```
AlberaApprover.exe list
AlberaApprover.exe approve <approvalId> [--yes]
AlberaApprover.exe deny <approvalId>
```

`<approvalId>` is the Authority's lowercase uuid; anything else is a usage error (exit 64). There is no other option, config file or environment variable in the shipped build.

- **list**: asks for every page (`afterSeq` = `lastSeq` while `more`) and prints `pending: N`, then one block per request (below).
- **approve**: fetches a fresh `list` and finds the request. It **refuses** (nothing signed, nothing sent) if the id is not pending, the entry is malformed, or the digest it recomputed from the shown fields differs from the Authority's `actionDigest`. Otherwise it prints the request, asks you to type `yes` (skipped with `--yes`), asks the presence signer for a signature over the presence message, and sends `decide` with it.
- **deny**: sends `decide` `deny` (no presence proof; a deny can only make a request fail). It does not need to list first.

### Output format (stdout; `\n` line ends; printable ASCII only)

```
pending: 1
request 3f2b8c1e-5d4a-4b6f-9a7e-0c1d2e3f4a5b
  purpose: "broker.operation"
  action: "environment.start"
  projectId: "proj-alpha"
  computerId: "pc-01"
  args: 3
    "cpu" = 2 (int)
    "fast" = true (bool)
    "vmName" = "alpha" (string)
  operationId: "op-1"
  expiresAt: 1800000117 (2027-01-15T08:01:57Z, in 117 s)
  actionDigest: sha256:2e4b6c62...
  digest check: OK (recomputed from the fields above)
```

Every digest input is shown (purpose, action, projectId, computerId, every arg in the digest's sorted order), then the operationId (which binds the request to the Control Plane's operation, but is not in the digest), the expiry, the Authority's digest and the check. A digest mismatch prints `digest check: MISMATCH (the fields above hash to sha256:...) DO NOT APPROVE`; an unreadable entry prints `REFUSED: invalid_entry` and none of its fields. `approve` prints the same block and ends with `result: approved`; `deny` prints `result: denied`.

**Safe rendering.** Strings are quoted. Only printable ASCII is shown as it is, `"` and `\` are backslash-escaped, and **everything else** (controls, bidi marks, line/paragraph separators, zero-width and combining characters, every non-ASCII letter, lone surrogates) is shown as `\u{HEX}` of the code point. So nothing can reorder, hide or imitate text, a Cyrillic "a" is visible as `\u{430}`, NFC and NFD forms look different (the digest does not normalize), and a newline inside a value cannot start a fake line. The Authority already rejects control and bidi characters; this is the second layer. A `note:` line counts the escaped characters. A readable mode for non-ASCII text is not built.

### Exit codes and errors (stderr: one `error: <code>` line)

| exit | meaning | codes |
|---|---|---|
| 0 | done | |
| 64 | usage | (usage line) |
| 65 | refused locally; nothing was decided | `digest_mismatch`, `invalid_entry`, `not_pending`, `not_confirmed` |
| 66 | before the first byte was written: the server is not the Authority, or is not there | `server_identity_mismatch`, `server_identity_unavailable`, `authority_unreachable`, `access_denied`, `request_too_large` |
| 67 | the Authority answered `{"ok":false,"code":...}` | `authority:<code>` with one of its 7 fixed codes |
| 68 | after the write; the outcome is unknown (run `list` again) | `timeout`, `transport_error`, `invalid_response`, `response_too_large` |
| 69 | this build has no Windows Hello signer; nothing was sent, the request stays pending | `presence_signer_not_built` |
| 70 | internal error | `internal` |

## Server identity (before the first write)

Same order and checks as `windows-broker-pipe-client` (copied; that project is not referenced): open with SQOS **identification** (the server learns who we are but cannot act as us) and specific rights `0x00120083` (never `GENERIC_WRITE`) -> on the connected handle read the pipe **owner SID**, the **server PID** and (service mode) the **session id** -> only then write the frame. Production expects the owner `NT SERVICE\AlberaApprovalAuthority`, the PID the SCM reports as RUNNING for service `AlberaApprovalAuthority`, and session 0. Any failed check is a pre-send code (66); a server that squats the pipe name receives 0 bytes. The expected pipe root, service name and owner are constants of the shipped build. The server image hash is not pinned (the Node client can; the approver has no place to get the hash from).

## Presence signing

`IPresenceSigner.Sign(byte[] message)` returns `Signed(signature)`, `Unavailable` (Hello gave no proof: cancelled, not enrolled, locked) or `NotBuilt`. The message is `"albera.presence.v1" 0x00 approvalId 0x00 actionDigest 0x00 challenge` (UTF-8), **built from the digest this app recomputed**, never the Authority's; the Authority rebuilds the same bytes from its own entry and verifies one pinned RSA-2048 key, RSA PKCS#1 v1.5 / SHA-256, a 256-byte signature. A signature therefore binds the id, the exact action and the entry's random challenge.

- `Signed` -> `decide approve` with the signature.
- `Unavailable` -> `decide presence_unavailable`; the Authority fails the request (final; the Control Plane resubmits).
- `NotBuilt` -> exit 69, nothing sent.

A wrong signature makes the Authority finalise the request as `presence_mismatch`.

## Real versus fake

| piece | real (shipped) | fake (test-faults build only) |
|---|---|---|
| `list`, `deny`, rendering, digest recompute and refusal, pipe client with server verification | real | same code |
| `approve` | works up to the presence step, then `NotBuilt` (exit 69) | same, until a fake key is given |
| presence signer | **none.** `NotBuiltPresenceSigner` | `FakePresenceSigner`: an in-memory RSA-2048 key (PKCS#1 v1.5 / SHA-256), or "Hello gave no proof" |
| Windows Hello (`KeyCredentialManager`) | **not written, not built** | not used |

The fake and the `--test-*` options (`--test-pipe-root`, `--test-owner-sid`, `--test-pid`, `--test-fake-key <base64 pkcs8>`, `--test-presence unavailable`, `--test-timeout-ms`) are `#if ALBERA_APPROVER_TEST_FAULTS` (`-p:AlberaApproverTestFaults=true`). The publish script pins it `false` as a global MSBuild property; tests assert that the shipped DLL has none of those names or strings and that the shipped binary rejects the options with exit 64.

## Build

`npm run build:approver` publishes `src/runtime/windows-approver/bin/Release/net10.0-windows/win-x64/publish/AlberaApprover.exe` (git-ignored) and writes `AlberaApprover.exe.manifest.json` (`{"sha256": ...}`, via `captureExecutableIdentity`). It only builds: no install, service registration, elevation, key, signing or Hello enrolment. The restore is locked (`packages.lock.json` pins no package); the build uses only the installed .NET 10 SDK, offline.

## Owner decisions for the real Windows Hello (follow-up, owner-gated)

Why it is not built here: `Windows.Security.Credentials.KeyCredentialManager` is a WinRT API. From C# it needs the Windows SDK projection (target framework `net10.0-windows10.0.19041.0` and its `Microsoft.Windows.SDK.NET.Ref` targeting pack), which the SDK restores **from NuGet** (the installed packs are only `Microsoft.NETCore.App.Ref`, `Microsoft.WindowsDesktop.App.Ref`, `Microsoft.AspNetCore.App.Ref`). That is a download and a new dependency, and could not be verified without a Hello enrolment, so it is left to the owner. The shape of the follow-up: one class `WindowsHelloPresenceSigner : IPresenceSigner` that opens the named `KeyCredential` and calls `RequestSignAsync(message)`, mapping a user cancel / missing credential to `Unavailable`; nothing else changes.

1. **How to get the API.** Allow the NuGet restore of the Windows SDK projection (pin it in `packages.lock.json`, review the license and supply chain), or write the WinRT calls by hand (`RoGetActivationFactory` + COM vtables; no dependency, but unreviewed unsafe interop that nobody can test without Hello). Either needs a change to the "no package" guards in `test/runtime-approver-source.test.mjs` and arch rule 11.
2. **Packaging and identity.** An unpackaged console exe is the simplest; a Hello prompt from a console process needs a window handle (`IKeyCredentialManagerInterop` with the console's HWND), which must be checked on a real machine. An MSIX package would give an app identity but needs a signing certificate. Decide whether v1 stays a console app or becomes a small window (the prompt text of Hello shows the app, not the action: the details must be on screen, as `approve` does now).
3. **Code signing.** An Authenticode certificate (cost, who holds it) so that SmartScreen and policy accept the exe, and so that the approver exe's identity can be pinned by the installer. None is created here.
4. **Enrolment.** Someone with Hello set up creates the credential (`KeyCredentialManager.RequestCreateAsync(<name>, ...)`, RSA-2048), exports its public key (SPKI, base64) into the Authority config (`approverPublicKey`, `approverKeyId`) and records which account is the approver (`approverSid`). The key lives on that user and that PC, so the Authority and the approver must run on the same machine.
5. **Provenance.** The Authority's open precondition: the pinned key must be proven to be a Hello key credential (KeyCredential attestation, `GetAttestationAsync`, or an equivalent binding), not just any RSA-2048 key. The enrolment step should collect and check it.
6. **Policy knobs.** Whether `--yes` stays (it skips only the typed `yes`; Hello is the real gate), whether the typed confirmation is wanted at all once Hello shows its own prompt, and the per-call timeout (10 s; Hello needs a person, so the signing step is outside it).

## Tests

- `test/runtime-approver-unit.test.mjs` (29 in-process checks via `test/approver-harness/`, the real sources plus the fake): safe rendering (controls, bidi, zero width, non-ASCII, look-alikes, astral, lone surrogates, NFC/NFD, a literal `\u{41}`), every digest input shown, the digest recomputed with the contract and every tampered field / digest / purpose refused before anything is signed or sent, malformed entries and pages, the exact presence message bytes, the fake signer, approve / deny / `presence_unavailable` / not-built flows against a canned channel, the typed-confirmation rule, Authority code mapping, channel failure exit codes, paging, the command grammar.
- `test/runtime-approver-integration.test.mjs` (17 tests; Windows, same user, unprivileged): the real test-faults Authority (real RSA presence verifier pinned to the fake key) and the real app. Empty and 7-request lists (more than one frame), approve with fake Hello -> `status` returns a receipt that validates with the contract and verifies with the signer key, typed-`yes` rule, deny and a second decision, `presence_unavailable` / `presence_mismatch` / no-signer, non-ASCII text, a tampering proxy (5 kinds of lie, plus smuggled fields / bidi / null) refused with the proxy never receiving `decide`, wrong owner SID and wrong PID refused with the Authority never seeing a request, a squatter receiving 0 bytes (and, as a control, being spoken to when it is the expected identity), no Authority, and the shipped build (no fakes, no test options, stops at the identity check).
- `test/runtime-approver-source.test.mjs` (9 source guards, any OS): separate project and no package, no process / file / network / key / service code, no Hello code, fakes only inside the `#if`, verify-before-write order and the exact P/Invoke set, only `list` / `decide` and only the three decisions, digest refusal before the signer, rendering through `SafeText`, build script and package exclusion.
- `scripts/arch-check.mjs` rule 11 and `scripts/package-smoke.mjs`: nothing in the Observer or the npm package names or ships the approver.

Elevated CI note: Node-made pipes (the proxy and the squatter) are owned by Administrators, so those tests expect `nodePipeOwnerSid()`, and temp paths are resolved with `realpathSync.native`.

## Not done here

- The real Windows Hello signer (above) and any GUI.
- The service identity (SCM PID, `NT SERVICE\AlberaApprovalAuthority` owner, session 0) is exercised only through the same-user owner/PID path; the real service path needs the VM lab (as for the Broker client).
- The Authority's image hash is not checked by the approver.
- A same-user process can also run `AlberaApprover.exe`, so a real approval rests entirely on Hello (user presence on the Hello key); the typed `yes` is not a security control.
