# Approver app (`AlberaApprover.exe`): the human's console for the Approval Authority

**Status: Proposed, NOT VERIFIED.** The approver app is the human side of the Approval Authority (`approval-authority.md`). It lists the Authority's pending requests, shows every input of the action digest, approves or denies, and enrols the Windows Hello key. **The Windows Hello code is written and compiled into the shipped binary, but it has never run against a real Hello enrolment** (CI cannot; see "Real versus fake" and "Enrol and first approval"). This document does not edit ADR-002, the trust contract or the status documents; the lead folds the relevant parts into them. Related: #84.

## What it is

A .NET 10 console program (`src/runtime/windows-approver/`, assembly `AlberaApprover`), built on demand with `npm run build:approver`. It talks only to the Authority's approver pipe `ALBERA\ApprovalAuthority\approver\v1` (wire protocol: `approval-authority.md`). It shares only the receipt v2 / action digest contract with the other projects, by source include (`../broker-contract/*.cs`); the Broker and Authority projects are not referenced, and nothing in the Observer or the npm package names it (`npm run arch` rule 11, `npm run package:smoke`).

```
human ── AlberaApprover.exe ──(approver pipe; server verified first)──▶ Approval Authority
            list / approve / deny
            │  recompute digest with ActionDigest (broker-contract)
            │  enroll: IHelloKeyStore ──▶ creates / shows the Hello key, prints the Authority config values
            └─ IPresenceSigner ──▶ Windows Hello (KeyCredentialManager)   |   fake in-memory RSA key (test-faults build only)
```

## Commands

```
AlberaApprover.exe list
AlberaApprover.exe approve <approvalId>
AlberaApprover.exe deny <approvalId>
AlberaApprover.exe enroll [--show | --replace]
```

`<approvalId>` is the Authority's lowercase uuid; anything else is a usage error (exit 64). There is no other option, config file or environment variable in the shipped build. **There is no `--yes`**: the typed confirmation cannot be skipped.

- **list**: asks for every page (`afterSeq` = `lastSeq` while `more`) and prints `pending: N`, then one block per request (below).
- **approve**: needs an interactive console. If stdin is redirected (a pipe, a file, a script) it exits 65 `not_interactive` **before** it reads anything or opens the pipe, even if "yes" is on stdin. Then it fetches a fresh `list` and finds the request. It **refuses** (nothing signed, nothing sent) if the id is not pending, the entry is malformed, or the digest it recomputed from the shown fields differs from the Authority's `actionDigest`. Otherwise it prints the request, asks you to type `yes` (every time), prints a line that Windows Hello is about to ask (the Hello prompt shows only the app name, so the details are already on screen), asks the presence signer for a signature over the presence message, and sends `decide` with it.
- **deny**: sends `decide` `deny` (no presence proof; a deny can only make a request fail). It does not need to list first and works without a console.
- **enroll**: makes the approver's Windows Hello key and prints what the Authority config needs (below). `enroll` creates it (Hello asks you once) and **refuses if the key exists** (exit 65 `already_enrolled`). `enroll --show` prints the same values for the existing key (no prompt, no change, no console needed). `enroll --replace` first asks you to type `replace`, then makes a new key in place of the old one (the old key is lost; the Authority rejects approvals until its config has the new values). `enroll` and `enroll --replace` need an interactive console like `approve`.

### What `enroll` prints (stdout; public values only)

```
Windows Hello approver key (RSA-2048). Put these three values in the Authority config:
  "approverPublicKey": "<base64 SPKI>",
  "approverKeyId": "hello-<first 16 hex of SHA-256 of the SPKI>",
  "approverSid": "S-1-5-21-...",
Public values only. approverSid is this account: run approve as the same account, on this PC.
```

`approverPublicKey` is the credential's `RetrievePublicKey(X509SubjectPublicKeyInfo)`; the app refuses a key that is not RSA-2048. `approverKeyId` is a **suggestion** derived from the key: the Authority only requires its id grammar (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`) and puts the value into receipts, so any id in that grammar works. `approverSid` is the SID of the account running `enroll` (the Authority requires the approver to be a user, `S-1-5-21-...`, and distinct from the Control Plane account). The private key never leaves Windows Hello; this code never reads, exports or stores it, and `enroll` writes nothing to disk.

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
| 65 | refused locally; nothing was decided | `digest_mismatch`, `invalid_entry`, `not_pending`, `not_confirmed`, `not_interactive` (stdin redirected), `already_enrolled`, `not_enrolled` (`enroll --show` with no key) |
| 66 | before the first byte was written: the server is not the Authority, or is not there | `server_identity_mismatch`, `server_identity_unavailable`, `authority_unreachable`, `access_denied`, `request_too_large` |
| 67 | the Authority answered `{"ok":false,"code":...}` | `authority:<code>` with one of its 7 fixed codes |
| 68 | after the write; the outcome is unknown (run `list` again) | `timeout`, `transport_error`, `invalid_response`, `response_too_large` |
| 69 | no usable Windows Hello key (Hello not supported / set up, key not enrolled): nothing was sent, the request stays pending. The message adds a `hint:` line (run `enroll`) | `presence_signer_unavailable` (approve); `hello_unavailable`, `hello_cancelled` (enroll) |
| 70 | internal error | `internal` |

## Server identity (before the first write)

Same order and checks as `windows-broker-pipe-client` (copied; that project is not referenced): open with SQOS **identification** (the server learns who we are but cannot act as us) and specific rights `0x00120083` (never `GENERIC_WRITE`) -> on the connected handle read the pipe **owner SID**, the **server PID** and (service mode) the **session id** -> only then write the frame. Production expects the owner `NT SERVICE\AlberaApprovalAuthority`, the PID the SCM reports as RUNNING for service `AlberaApprovalAuthority`, and session 0. Any failed check is a pre-send code (66); a server that squats the pipe name receives 0 bytes. The expected pipe root, service name and owner are constants of the shipped build. The server image hash is not pinned (the Node client can; the approver has no place to get the hash from).

## Presence signing

`IPresenceSigner.Sign(byte[] message)` returns `Signed(signature)`, `Unavailable` (the key exists but Hello gave no proof: cancelled, locked) or `NotReady` (no usable key: Hello not supported or not set up, credential not enrolled, API unusable). The message is `"albera.presence.v1" 0x00 approvalId 0x00 actionDigest 0x00 challenge` (UTF-8), **built from the digest this app recomputed**, never the Authority's; the Authority rebuilds the same bytes from its own entry and verifies one pinned RSA-2048 key, RSA PKCS#1 v1.5 / SHA-256, a 256-byte signature. A signature therefore binds the id, the exact action and the entry's random challenge.

- `Signed` -> `decide approve` with the signature.
- `Unavailable` -> `decide presence_unavailable`; the Authority fails the request (final; the Control Plane resubmits).
- `NotReady` -> exit 69 with an `enroll` hint, **nothing sent**; the request stays pending.

A wrong signature makes the Authority finalise the request as `presence_mismatch`.

`WindowsHelloPresenceSigner` (`WindowsHello.cs`): `KeyCredentialManager.IsSupportedAsync()` (false -> `NotReady`), `OpenAsync("AlberaApprover.v1")` (`NotFound` -> `NotReady`; cancelled, locked, other -> `Unavailable`), then `RequestSignAsync(message)` over the exact message bytes. Only a `Success` with a 256-byte signature is `Signed`. Any exception from the API becomes `NotReady` (nothing is sent; no exception text is printed). The prompt Hello shows names the app, not the action, so `approve` prints the request and takes the typed `yes` first. The plain WinRT API is used, without a window handle; see "Open points".

## Real versus fake

| piece | real (shipped) | fake (test-faults build only) |
|---|---|---|
| `list`, `deny`, rendering, digest recompute and refusal, pipe client with server verification | real | same code |
| `approve` flow up to the presence step, typed `yes`, console check | real | same code |
| presence signer | `WindowsHelloPresenceSigner` (Windows Hello). **Written and compiled; never run against a real enrolment** | `FakePresenceSigner`: an in-memory RSA-2048 key (PKCS#1 v1.5 / SHA-256), or "Hello gave no proof"; without a key, a signer that is never ready |
| `enroll` | `WindowsHelloKeyStore` (`RequestCreateAsync`, `RetrievePublicKey`). **Never run against a real Hello** | `FakeKeyStore` (in-memory RSA key) |
| Windows Hello (`KeyCredentialManager`) | used | **not present in the build at all** (`WindowsHello.cs` is removed from it) |

The fakes and the `--test-*` options (`--test-pipe-root`, `--test-owner-sid`, `--test-pid`, `--test-fake-key <base64 pkcs8>`, `--test-key-state missing`, `--test-presence unavailable`, `--test-interactive yes`, `--test-timeout-ms`) are `#if ALBERA_APPROVER_TEST_FAULTS` (`-p:AlberaApproverTestFaults=true`). The publish script pins it `false` as a global MSBuild property (and `ALBERA_SEAM` fails a build that inherits the symbol); tests assert that the shipped DLL has none of those names or strings, that the shipped DLL contains `WindowsHelloPresenceSigner` and the test-faults DLL does not, and that the shipped binary rejects the options with exit 64. So no test can reach the real `KeyCredentialManager`.

## Build and the one dependency

`npm run build:approver` publishes `src/runtime/windows-approver/bin/Release/net10.0-windows10.0.19041.0/win-x64/publish/AlberaApprover.exe` (git-ignored, self-contained, about 100 MB with the .NET runtime) and writes `AlberaApprover.exe.manifest.json` (`{"sha256": ...}`, via `captureExecutableIdentity`). It only builds: no install, service registration, elevation, key, signing or Hello enrolment.

The only external dependency is the **Windows SDK projection** for WinRT: the target framework `net10.0-windows10.0.19041.0` makes the SDK restore the targeting pack **`Microsoft.Windows.SDK.NET.Ref` version `10.0.19041.57`** from NuGet (Microsoft, signed; the nupkg is 12,719,136 bytes, about 12 MB, 75 MB unpacked in `~/.nuget/packages`; `Microsoft.Windows.SDK.NET.dll` of 24.9 MB is copied into the publish folder). It is not a `PackageReference`: the csproj pins it with `WindowsSdkPackageVersion`, and `packages.lock.json` (which records no targeting pack) only records the new target framework. Arch rule 11 (`11e`) and the source test allow exactly this and fail on any `PackageReference`, `FrameworkReference`, `COMReference` or other reference. The first restore on a machine needs the network; after that it is in the NuGet cache. CI runs with the network.

## Enrol and first approval (owner, once, on this PC)

Needs: Windows Hello set up for your account (Settings > Accounts > Sign-in options: a PIN is enough). If Hello is not set up, `enroll` stops with `hello_unavailable` and creates nothing.

1. `npm run build:approver`
2. Open a normal console (not elevated, not redirected, same Windows account that will approve) and run `src\runtime\windows-approver\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish\AlberaApprover.exe enroll`. Verify with your Hello PIN when Windows asks. It prints `approverPublicKey`, `approverKeyId` and `approverSid`. (Printed again any time by `enroll --show`.)
3. Put those three values in the Authority config (`approval-authority.md`, "Service entry and config"; `service-check <config.json>` validates it), together with the Control Plane account in `controlPlaneSid` (it must differ from `approverSid`). Restart the Authority service so it reads the config.
4. Have the Control Plane submit a harmless request, then run `AlberaApprover.exe list` and check the printed fields and `digest check: OK`.
5. Run `AlberaApprover.exe approve <approvalId>`, read the request, type `yes`, and verify with Hello. Expect `result: approved`.
6. If it exits 69, read the `hint:` line. If it exits 67 `authority:presence_mismatch`, the config key is not the one `enroll --show` prints; fix the config.

If the Hello prompt does not appear at step 5, or `approve` reports `presence_signer_unavailable` although `enroll --show` works, stop and tell the developer: that is the "window handle" open point below.
## Open points (not verified; need the owner's machine)

- **Window handle.** The plain `KeyCredentialManager` API is called without a window handle. Whether Windows shows the Hello prompt in front of a console process, and finds the credential from this exe, could not be tested without triggering Hello. If it does not, the follow-up is `IKeyCredentialManagerInterop` (`RequestCreateAsync` / `OpenAsync` with the console window handle); the CsWinRT projection does not contain that interop, so it would be hand-written COM. Nothing else changes (one class).
- **Credential scope.** Hello credentials for an unpackaged app are tied to the calling app and user. If the exe is rebuilt to another path or replaced, `approve` may report `presence_signer_unavailable` and `enroll --show` `not_enrolled`; run `enroll` (or `--replace`) again and update the Authority config. Not verified.
- **This PC at the time of writing.** `KeyCredentialManager.IsSupportedAsync()` returned `False` for a probe run from a non-interactive shell here, so Hello (PIN) may need to be set up first.
- **Provenance.** The Authority's open precondition: the pinned key must be proven to be a Hello key credential (attestation, `GetAttestationAsync`), not just any RSA-2048 key. `enroll` does not collect or check an attestation; the owner creates the key on his own PC and pins it by hand.
- **Code signing.** No Authenticode certificate; SmartScreen may warn on first run of an unsigned exe. None is created here.
- **Policy knobs left.** Per-call timeout (10 s; the signing step is outside it); whether the typed `yes` stays once Hello shows its own prompt (it stays: the Hello prompt shows no details).

## Tests

- `test/runtime-approver-unit.test.mjs` (38 in-process checks via `test/approver-harness/`, the real sources except `Program.cs` and `WindowsHello.cs`, plus the fakes): the `enroll` flows (show, create, refuse existing, typed `replace`, console required, cancelled / unusable Hello, public values only, key id grammar), the console rule for `approve` (redirected stdin refused before anything is read or sent), the always-typed `yes`, the exit 69 hint, no `--yes` in the grammar, safe rendering (controls, bidi, zero width, non-ASCII, look-alikes, astral, lone surrogates, NFC/NFD, a literal `\u{41}`), every digest input shown, the digest recomputed with the contract and every tampered field / digest / purpose refused before anything is signed or sent, malformed entries and pages, the exact presence message bytes, the fake signer, approve / deny / `presence_unavailable` / not-built flows against a canned channel, the typed-confirmation rule, Authority code mapping, channel failure exit codes, paging, the command grammar.
- `test/runtime-approver-integration.test.mjs` (21 tests; Windows, same user, unprivileged; includes an `enroll --show` -> Authority config -> approve round trip with the fake key, and the shipped build refusing redirected stdin for `approve` / `enroll`): the real test-faults Authority (real RSA presence verifier pinned to the fake key) and the real app. Empty and 7-request lists (more than one frame), approve with fake Hello -> `status` returns a receipt that validates with the contract and verifies with the signer key, typed-`yes` rule, deny and a second decision, `presence_unavailable` / `presence_mismatch` / no-signer, non-ASCII text, a tampering proxy (5 kinds of lie, plus smuggled fields / bidi / null) refused with the proxy never receiving `decide`, wrong owner SID and wrong PID refused with the Authority never seeing a request, a squatter receiving 0 bytes (and, as a control, being spoken to when it is the expected identity), no Authority, and the shipped build (no fakes, no test options, stops at the identity check).
- `test/runtime-approver-source.test.mjs` (10 source guards, any OS): separate project, the one pinned dependency and no other, no process / file / network / key / service code, the WinRT Hello calls confined to `WindowsHello.cs` as a fixed member list (no delete, no private export), the shipped wiring uses `WindowsHelloPresenceSigner` and the test-faults wiring does not, no `--yes`, fakes only inside the `#if`, verify-before-write order and the exact P/Invoke set, only `list` / `decide` and only the three decisions, digest refusal before the signer, rendering through `SafeText`, build script and package exclusion.
- `scripts/arch-check.mjs` rule 11 and `scripts/package-smoke.mjs`: nothing in the Observer or the npm package names or ships the approver.

Elevated CI note: Node-made pipes (the proxy and the squatter) are owned by Administrators, so those tests expect `nodePipeOwnerSid()`, and temp paths are resolved with `realpathSync.native`.

## Not done here

- A run of `enroll` or a signature against a real Windows Hello (CI cannot; "Open points"), the window-handle interop, attestation of the enrolled key, and any GUI.
- The service identity (SCM PID, `NT SERVICE\AlberaApprovalAuthority` owner, session 0) is exercised only through the same-user owner/PID path; the real service path needs the VM lab (as for the Broker client).
- The Authority's image hash is not checked by the approver.
- A same-user process can also run `AlberaApprover.exe`, so a real approval rests entirely on Hello (user presence on the Hello key); the typed `yes` is not a security control.
