# Approver app (`AlberaApprover.exe`): the human's console for the Approval Authority

**Status: Proposed, NOT VERIFIED.** The approver app is the human side of the Approval Authority (`approval-authority.md`). It lists the Authority's pending requests, shows every input of the action digest, approves or denies, and enrols the Windows Hello key. **The Windows Hello code is written and compiled into the shipped binary, but it has never run against a real Hello enrolment** (CI cannot; see "Real versus fake" and "Enrol and first approval"). This document does not edit ADR-002, the trust contract or the status documents; the lead folds the relevant parts into them. Related: #84.

## What it is

A .NET 10 console program (`src/runtime/windows-approver/`, assembly `AlberaApprover`), built on demand with `npm run build:approver`. It talks only to the Authority's approver pipe `ALBERA\ApprovalAuthority\approver\v1` (wire protocol: `approval-authority.md`). It shares only the receipt v2 / action digest contract with the other projects, by source include (`../broker-contract/*.cs`); the Broker and Authority projects are not referenced, and nothing in the Observer or the npm package names it (`npm run arch` rule 11, `npm run package:smoke`).

```
human ── AlberaApprover.exe ──(approver pipe; server verified first)──▶ Approval Authority
            list / approve / deny
            │  recompute digest with ActionDigest (broker-contract)
            │  enroll: IHelloKeyStore ──▶ creates / shows the Hello key, prints the Authority config values
            │  enroll --check: opens the existing key, IPresenceSigner signs a self-check message, verified locally (no pipe)
            └─ IPresenceSigner ──▶ Windows Hello (KeyCredentialManager)   |   fake in-memory RSA key (test-faults build only)
```

## Commands

```
AlberaApprover.exe list
AlberaApprover.exe approve <approvalId>
AlberaApprover.exe deny <approvalId>
AlberaApprover.exe enroll [--show | --replace | --check [--expect <approverKeyId>]]
```

`<approvalId>` is the Authority's lowercase uuid; anything else is a usage error (exit 64). There is no other option, config file or environment variable in the shipped build. **There is no `--yes`**: the typed confirmation cannot be skipped.

**Packaged only (issue #101).** Every command that reaches Windows Hello (`approve`, `enroll` in all its forms including `--show`, `enroll --check`, and `policy set` when the change needs Hello) first checks that the process runs from the approver's own, installed MSIX package, and otherwise exits **65** with `error: not_packaged` (not packaged), `wrong_package` (another package name or publisher, compared exactly, case-sensitive) or `development_mode_package` (a package registered loose from a folder, whose files the user can still edit), plus a one-line hint. The check comes after the command's own console check (`not_interactive` first) and **before** the pipe is opened, a word is typed or Hello is called. `list`, `deny`, `policy` and a `policy set` that only adds prompts never reach Hello and still work unpackaged. **Why refuse instead of keeping an unpackaged path:** an unpackaged copy sees a different, unprotected set of Hello credentials, which is the exact weakness the package removes; the tests do not need it (the test-faults build has no Hello and a fake package identity), so nothing legitimate depends on it. See "Package and install".

- **list**: asks for every page (`afterSeq` = `lastSeq` while `more`) and prints `pending: N`, then one block per request (below).
- **approve**: needs an interactive console. If stdin is redirected (a pipe, a file, a script) it exits 65 `not_interactive` **before** it reads anything or opens the pipe, even if "yes" is on stdin. Then it fetches a fresh `list` and finds the request. It **refuses** (nothing signed, nothing sent) if the id is not pending, the entry is malformed, or the digest it recomputed from the shown fields differs from the Authority's `actionDigest`. Otherwise it prints the request, asks you to type `yes` (every time), prints a line that Windows Hello is about to ask (the Hello prompt shows only the app name, so the details are already on screen), asks the presence signer for a signature over the presence message, and sends `decide` with it.
- **deny**: sends `decide` `deny` (no presence proof; a deny can only make a request fail). It does not need to list first and works without a console.
- **enroll**: makes the approver's Windows Hello key and prints what the Authority config needs (below). `enroll` creates it (Hello asks you once) and **refuses if the key exists** (exit 65 `already_enrolled`). `enroll --show` prints the same values for the existing key (no prompt, no change, no console needed). `enroll --replace` first asks you to type `replace`, then makes a new key in place of the old one (the old key is lost; the Authority rejects approvals until its config has the new values). `enroll` and `enroll --replace` need an interactive console like `approve`.
- **enroll --check** (self-check): proves on this PC, **without the Approval Authority**, that the enrolled Hello key works. It opens the **existing** key `AlberaApprover.v1` only (never creates, replaces or deletes one), asks Hello once (one prompt) to sign `"albera.selfcheck.v1" 0x00 <64 hex chars = 32 fresh random bytes>`, and verifies the signature **locally** with the public key of the same credential (RSA-2048, PKCS#1 v1.5 / SHA-256, a 256-byte signature, the same parameters the Authority checks presence with; the approver and the Authority share no code, so the parameters are repeated in `PresenceSignature.Verify`). Nothing is sent: no pipe, no network, no file. Needs an interactive console like `approve` (checked first, exit 65 `not_interactive`). `--expect <approverKeyId>` compares the key's id with the one you recorded at `enroll`; on a difference it prints `KEY_MISMATCH` and stops **before** Hello is asked.

  stdout on success is exactly these three lines (public values only):

  ```
  self-check: OK
  approverKeyId: hello-0123456789abcdef
  approverSid: S-1-5-21-...
  ```

  On `self-check: FAILED` (Hello signed, but the signature does not verify with the credential's public key) or `self-check: KEY_MISMATCH` the line is on stdout and an `error:` line is on stderr. The message is **domain-separated** from the presence message: `albera.selfcheck.v1` versus `albera.presence.v1`, so neither starts like the other and a self-check signature can never verify as a presence signature for any request (a unit check asserts this). A pass shows that the key signs and matches its public key; it does **not** show who created the key (see "Known limits": keep your own `enroll` output and use `--expect`).

### What `enroll` prints (stdout; public values only)

```
Windows Hello approver key (RSA-2048). Put these three values in the Authority config:
  "approverPublicKey": "<base64 SPKI>",
  "approverKeyId": "hello-<first 16 hex of SHA-256 of the SPKI>",
  "approverSid": "S-1-5-21-...",
Public values only. approverSid is this account: run approve as the same account, on this PC.
attestation: Success (Windows Hello reports the key as attested; certificate chain 1234 bytes, statement 567 bytes; the chain and statement are NOT verified by this program)
```

The `attestation:` line is printed only by `enroll` / `enroll --replace` for the key they just made (see "Attestation at enroll"); `enroll --show` never prints it, because it opens an existing key and claims nothing about it.

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
| 65 | refused locally; nothing was decided | `digest_mismatch`, `invalid_entry`, `not_pending`, `not_confirmed`, `not_interactive` (stdin redirected), `already_enrolled`, `not_enrolled` (`enroll --show` with no key), `key_mismatch` (`enroll --check --expect`), `not_packaged`, `wrong_package`, `development_mode_package` (issue #101: not running from the approver's package; nothing was done) |
| 66 | before the first byte was written: the server is not the Authority, or is not there | `server_identity_mismatch`, `server_identity_unavailable`, `authority_unreachable`, `access_denied`, `request_too_large` |
| 67 | the Authority answered `{"ok":false,"code":...}` | `authority:<code>` with one of its 7 fixed codes |
| 68 | after the write; the outcome is unknown (run `list` again) | `timeout`, `transport_error`, `invalid_response`, `response_too_large` |
| 69 | no usable Windows Hello key (Hello not supported / set up, key not enrolled): nothing was sent, the request stays pending. The message adds a `hint:` line (run `enroll`) | `presence_signer_unavailable` (approve, `enroll --check`); `hello_unavailable`, `hello_cancelled` (enroll, `enroll --check`); `not_enrolled` (`enroll --check` with no key; unlike `enroll --show`, which is 65), `hello_no_proof` (`enroll --check`: Hello did not verify you), `attestation_refused` (`enroll`: Windows did not attest the new key; the key was removed and nothing is printed for the Authority config) |
| 70 | internal error; also `enroll --check` when Hello signed but the signature does not verify with the enrolled public key (the key and its own signature disagree, which a healthy key never does; not a local refusal, so not 65) | `internal`, `self_check_failed` |

### Tier policy (step 3a of #115)

- `policy [show]` prints the Authority's policy and its hash (the app recomputes the hash and refuses a reply that disagrees, or one without `kid` / `audience`).
- `policy set <careful|standard> [--prompt <action>]...` sends a complete new policy with `rev + 1`. It prints which actions "will no longer ask you" and "will start asking you". A change that lets more actions skip a person needs a console, a typed `yes` and one Windows Hello signature over `UTF8("albera.policy.v1") 0x00 kid 0x00 audience 0x00 <hash>`; a change that only adds prompts is sent as it is.

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
| `enroll`, `enroll --check` | `WindowsHelloKeyStore` (`RequestCreateAsync`, `RetrievePublicKey`) and, for the check, `WindowsHelloPresenceSigner`. **Never run against a real Hello by any test** | `FakeKeyStore` (in-memory RSA key) and `FakePresenceSigner` |
| package identity (`Windows.ApplicationModel.Package.Current`) | `WindowsPackageIdentity` (read-only; "not packaged" when the API throws) | `FakePackageIdentity` (`--test-package approver` by default; `none`, `wrong-name`, `wrong-publisher`, `development`); **the real package API has never run inside a package** |
| attestation of a key `enroll` just made | `GetAttestationAsync` (never run against a real key) | `--test-attestation <status>` on the fake key store |
| Windows Hello (`KeyCredentialManager`) | used | **not present in the build at all** (`WindowsHello.cs` is removed from it) |

The fakes and the `--test-*` options (`--test-pipe-root`, `--test-owner-sid`, `--test-pid`, `--test-fake-key <base64 pkcs8>`, `--test-key-state missing`, `--test-presence unavailable`, `--test-interactive yes`, `--test-timeout-ms`) are `#if ALBERA_APPROVER_TEST_FAULTS` (`-p:AlberaApproverTestFaults=true`). The publish script pins it `false` as a global MSBuild property (and `ALBERA_SEAM` fails a build that inherits the symbol); tests assert that the shipped DLL has none of those names or strings, that the shipped DLL contains `WindowsHelloPresenceSigner` and the test-faults DLL does not, and that the shipped binary rejects the options with exit 64. So no test can reach the real `KeyCredentialManager`.

## Build and the one dependency

`npm run build:approver` publishes `src/runtime/windows-approver/bin/Release/net10.0-windows10.0.19041.0/win-x64/publish/AlberaApprover.exe` (git-ignored, self-contained, about 100 MB with the .NET runtime) and writes `AlberaApprover.exe.manifest.json` (`{"sha256": ...}`, via `captureExecutableIdentity`). It only builds: no install, service registration, elevation, key, signing or Hello enrolment.

**Hardened build environment** (issue #102; all `build:*` scripts, shared helper `scripts/dotnet-build-env.mjs`): dotnet is taken only from `<ProgramFiles>\dotnet\dotnet.exe`, where the Program Files folder is read from HKLM (`C:\Windows\System32\reg.exe`, fixed path; `ProgramW6432Dir`, else `ProgramFilesDir`) and must agree with `HKLM\SOFTWARE\dotnet\Setup\InstalledVersions\x64` `InstallLocation` when that is set; never PATH and never the ProgramFiles environment variables; there is deliberately no override variable. Every MSBuild call gets `-noAutoResponse` and switches off the 12 `ImportUserLocationsByWildcard*` imports from the user's MSBuild folder. The child environment is an allowlist (TEMP, USERPROFILE, LOCALAPPDATA and a few more; SystemRoot, ProgramFiles and PATH are set from C:\Windows and the registry, PATH = System32 + the dotnet folder; APPDATA is a fresh empty folder, because NuGet still parses the user-level `NuGet.Config` even with `--configfile`), so MSBuild*, NuGet*, DOTNET_* (except three we set: no logo, no telemetry, no first-run work), DefineConstants and Albera* variables never reach the build. Restore is a separate locked step (`--locked-mode`, `--configfile scripts/nuget.publish.config`: `<clear/>` plus nuget.org only); publish then runs `--no-restore`. A project without `packages.lock.json` is refused. After each build the script prints two lines to compare two builds: `dotnet sdk <version>` and `sha256 <hash> <path>`.

The only external dependency is the **Windows SDK projection** for WinRT: the target framework `net10.0-windows10.0.19041.0` makes the SDK restore the targeting pack **`Microsoft.Windows.SDK.NET.Ref` version `10.0.19041.57`** from NuGet (Microsoft, signed; the nupkg is 12,719,136 bytes, about 12 MB, 75 MB unpacked in `~/.nuget/packages`; `Microsoft.Windows.SDK.NET.dll` of 24.9 MB is copied into the publish folder). It is not a `PackageReference`: the csproj pins it with `WindowsSdkPackageVersion`, and `packages.lock.json` (which records no targeting pack) only records the new target framework. Arch rule 11e (`scripts/approver-build-inputs.mjs`, tested by `test/approver-build-inputs.test.mjs`) is an **exact pin**: the csproj text must equal the string kept in the script (only CRLF/LF and trailing newlines are ignored), so any change to the csproj, including the pinned `WindowsSdkPackageVersion`, must change the script in the same PR; no `Directory.Build.props/.targets`, `Directory.Packages.props`, `global.json`, `nuget.config` or similar may exist from the project directory up to the repository root; nothing from the project directory up to the root (and no entry in the project directory) may be a symbolic link or junction; and the project directory holds only `.cs` files, the csproj and `packages.lock.json`. The first restore on a machine needs the network; after that it is in the NuGet cache. CI runs with the network.

## Package and install (issue #101; self-signed MSIX, this PC only)

**What it is.** `AlberaApprover.exe` packed as an MSIX, so Windows scopes its Hello credential to the **package family name** instead of to the user. One registry holds the identity, `scripts/approver-msix-identity.json` (read by the manifest builder and the installer script; the C# constants in `PackageIdentity.cs` mirror it and `test/approver-msix.test.mjs` fails if they differ).

| field | value |
|---|---|
| package name | `Albera.LocalApprover` |
| publisher (also the certificate subject) | `CN=ALBERA Local Approver` |
| package family name | `Albera.LocalApprover_rfb9xr8x8ned2` (the publisher id is derived from the publisher string; the derivation was checked against all 169 distinct publishers of the packages installed on the author's PC) |
| application | full trust (`runFullTrust`, the only capability), x64, console subsystem, no Start entry, command `AlberaApprover.exe` through an app execution alias |

Changing the publisher or the name changes the family name and orphans the enrolled key.

**Pack (no host change).** `npm run build:approver`, then `npm run package:approver-msix` (`scripts/package-windows-approver-msix.mjs`). It fetches the two tools it needs from one pinned NuGet package, **`Microsoft.Windows.SDK.BuildTools` 10.0.28000.2705** (the owner approved this one download; it is not a `PackageReference` and no project build uses it): downloaded over https into a fresh folder of its own under the temp folder, the nupkg's **SHA-512** (`47kp42eMb8rF3bjDuZHVkzGRb9Fr7wyFZDIT2sWr3StwnTCoDHIisDe0SPWGwerwVUw/eQQO/OxDb0YYHbfNvA==`) is computed while it is written and the file is deleted unread on a difference; only then is `bin/10.0.28000.0/x64` extracted with the fixed `C:\Windows\System32\tar.exe`; `makeappx.exe` and `signtool.exe` must carry a **Valid** Authenticode signature by **Microsoft Corporation** (read through the fixed Windows PowerShell, minimal environment). The temp folders are removed at exit. Not covered: the temp folder is only as private as the user's temp folder (a same-user process could swap a tool between the check and the run; the limit of `dotnet-build-env.mjs` too), and the signature check relies on this PC's own trust store. `makeappx` validates the generated `AppxManifest.xml` against the Windows schema (it rejected the first draft: a console `Application` needs `SupportsMultipleInstances="true"`) and writes `src\runtime\windows-approver\bin\msix\AlberaApprover.unsigned.msix` (about 43 MB). No certificate store is read or written by this step, and nothing is installed.

**Install (host changes; owner, in this order; `scripts/approver-msix-install.ps1` is the ONLY file that creates a certificate, trusts one or installs/removes a package, and every step is a dry run until `-Apply`).** Run each step without `-Apply` first: it prints `CHANGES`, `NEEDS` and `UNDO` and changes nothing.

```
npm run build:approver
powershell -NoProfile -File scripts\approver-msix-install.ps1 -Step Sign              # dry run; then add -Apply (not elevated)
powershell -NoProfile -File scripts\approver-msix-install.ps1 -Step Trust             # dry run; then -Apply in PowerShell "Run as administrator" (the one UAC prompt)
powershell -NoProfile -File scripts\approver-msix-install.ps1 -Step Install           # dry run; then add -Apply (not elevated)
```

1. **Sign**: makes the self-signed code-signing certificate `CN=ALBERA Local Approver` (RSA 3072, non-exportable key, 3 years) in `Cert:\CurrentUser\My`, packs and signs `AlberaApprover.msix`, writes the public certificate `AlberaApprover.cer`, and **deletes the certificate and its private key again** (also when packing fails).
2. **Trust**: imports only the public `AlberaApprover.cer` into `Cert:\LocalMachine\TrustedPeople` (needs administrator rights; the script never elevates itself and stops with a message otherwise).
3. **Install**: `Add-AppxPackage` for the current user; prints the package family name and the full path of the command (`%LOCALAPPDATA%\Microsoft\WindowsApps\AlberaApprover.exe`).

**Undo.** `-Step Uninstall -Apply` (not elevated; `Remove-AppxPackage`) and `-Step Untrust -Apply` (administrator; removes the certificate by thumbprint). Delete `bin\msix\*` for the files. If `-Step Sign` stopped half way: `Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -eq 'CN=ALBERA Local Approver' | Remove-Item -DeleteKey`.

**Check that the scope is real (first start, before any Authority step).** (a) `Get-AppxPackage -Name Albera.LocalApprover` shows `PackageFamilyName : Albera.LocalApprover_rfb9xr8x8ned2`. (b) `AlberaApprover.exe enroll --show` must answer `error: not_enrolled`: the old unpackaged key `hello-951a135537287eae` must **not** be visible. If it prints that old key, the scope claim is false on this PC: stop and tell the developer. (c) Then `enroll` as in "Enrol and first approval".

**Not verified here (no host change was allowed):** that `makeappx`'s output installs and starts; that the alias gives a working console (stdin/stdout, `Console.IsInputRedirected` false in a normal console); that the signing and certificate-removal commands of the script work (they are only dry-run and syntax-checked); that Windows really hides the credential from unpackaged processes; and what Windows does with the key when the package is removed.

## Attestation at enroll (issue #101)

`enroll` and `enroll --replace` ask Windows to attest the key they just made (`KeyCredential.GetAttestationAsync`) and keep it only when the answer is acceptable (`AttestationPolicy` in `HelloKeyStore.cs`, one place; the real and the fake key store both use it). `KeyCredentialAttestationStatus` has four values:

| status | meaning | enroll |
|---|---|---|
| `Success`, with a **non-empty certificate chain buffer and a non-empty attestation statement buffer** | Windows produced an attestation for the key | **accepted** (the only pass) |
| `NotSupported` | no attestation is possible for this key (the key is not held by hardware that can attest it) | refused |
| `TemporaryFailure` | try later | refused (accepting it would let an unattested key through; run `enroll` again) |
| `UnknownError`, an exception from the API, a status name this code does not know (a future value), an empty buffer, another spelling (`success`) | | refused |

A refusal removes the key that was just made (`KeyCredentialManager.DeleteAsync` on the fixed name, in the Hello file only; with `--replace` the old key was already replaced and is gone, as for any replace), exits **69** `attestation_refused` naming the status and buffer sizes, and prints no config value, so an unattested key is never left behind for `enroll --show` or `approve` to find. Narrowest rule that can work on a TPM machine: one status, no override flag.

**What a pass does and does not verify.** Verified: Windows returned status `Success` and two non-empty buffers, from the Hello API of this process. **Not verified by this program** (and the printed line says so): the certificate chain is not parsed or validated (no root pinned, no revocation, no check that it is a TPM vendor chain), the attestation statement's signature is not verified, the statement is not matched to the key's public key (no binding), and nothing is fresh (no challenge). The buffers are not stored or printed (only their sizes), so the Authority cannot check them later. So the line is "Windows says it attested this key", not proof for a third party; the Authority still pins the key by hand. **Not observed on a real machine:** which status this PC returns (a PC without TPM attestation gets `attestation_refused` and cannot enrol).

## Enrol and first approval (owner, once, on this PC)

Needs: Windows Hello set up for your account (Settings > Accounts > Sign-in options: a PIN is enough). If Hello is not set up, `enroll` stops with `hello_unavailable` and creates nothing.

1. Install the package first (issue #101; "Package and install" below). The old unpackaged key (`hello-951a135537287eae`) is not visible to the packaged app, so you enrol again here, and the unpackaged exe now refuses to run any Hello command. Everything below is run as `AlberaApprover.exe` from the package (the command the package adds), not from the publish folder.
2. Open a normal console (not elevated, not redirected, same Windows account that will approve) and run `AlberaApprover.exe enroll`. Verify with your Hello PIN when Windows asks. It prints `approverPublicKey`, `approverKeyId`, `approverSid` and an `attestation:` line. If it exits 69 `attestation_refused`, this PC cannot give a hardware-attested key (see "Attestation at enroll"): nothing was kept; stop and tell the developer. (The three values are printed again any time by `enroll --show`.)
3. Run the self-check, still before any Authority step: `AlberaApprover.exe enroll --check --expect <approverKeyId from step 2>`. Verify with Hello once. It must print `self-check: OK` and the same `approverKeyId` and `approverSid` as step 2 (exit 0). That proves the enrolled key signs on this PC and matches its public key, without the Authority service. `KEY_MISMATCH` means the enrolled key is not the one step 2 printed; `FAILED` means Hello's signature does not verify with its own public key: do not use the key (`enroll --replace`). If the Hello prompt does not appear, stop: that is the "window handle" open point below, and it now shows up here, before the Authority is involved.
4. Check that the key is yours. If `enroll` answers `already_enrolled`, a key with the fixed name already exists; if you did not make it with this program, another app of your account may have made it, so run `enroll --replace` (type `replace`) and use the output of that run. Keep the output of your own `enroll`: `enroll --show` prints a warning, and its values are trustworthy only if they are identical to what your own run printed.
5. Put those three values in the Authority config (`approval-authority.md`, "Service entry and config"; `service-check <config.json>` validates it), together with the Control Plane account in `controlPlaneSid` (it must differ from `approverSid`). Restart the Authority service so it reads the config.
6. Have the Control Plane submit a harmless request, then run `AlberaApprover.exe list` and check the printed fields and `digest check: OK`.
7. Run `AlberaApprover.exe approve <approvalId>`, read the request, type `yes`, and verify with Hello. Expect `result: approved`.
8. If it exits 69, read the `hint:` line. If it exits 67 `authority:presence_mismatch`, the config key is not the one `enroll --show` prints; fix the config.

If the Hello prompt does not appear at step 7, or `approve` reports `presence_signer_unavailable` although `enroll --show` works, stop and tell the developer: that is the "window handle" open point below.
## Known limits (what the package does and does not change)

Before issue #101 the approver was an unpackaged console exe, so Windows treated everything running as your account as one party. Packaging narrows that for the Hello key; it is not a sandbox. Plainly:

- **The self-check is not provenance.** `enroll --check` proves the key signs and matches its public key; another app of your account could have made that key first. Compare with the `approverKeyId` your own `enroll` printed (`--expect`).
- **The Hello key is scoped to the package family name** (`Albera.LocalApprover_<publisher id>`), not to "this user": the claim is that another unpackaged process of the same account no longer opens or creates the credential `AlberaApprover.v1` that the package made. **NOT VERIFIED on a real machine:** the packaging, the manifest and the refusal logic are built and tested here, but this was never installed and Hello was never run (no host change was allowed). The owner's first `enroll` from the package is the first real observation, and "Package and install" says how to check it.
- **The process is not sandboxed.** It is a full-trust desktop process (`runFullTrust`, a normal medium-integrity token, not an AppContainer). A same-user process can still do everything a same-user process can do to this one: attach a debugger, inject code, drive its console (an agent driving `approve` through a pseudo-console still counts as "not redirected"), or answer the pipe. Packaging protects the stored credential, not the running program.
- **Where the files live.** An installed (non-development) package's files sit under `C:\Program Files\WindowsApps`, which a standard user cannot write; that is why a development-mode registration (editable files) is refused. The command `AlberaApprover.exe` is an app execution alias in `%LOCALAPPDATA%\Microsoft\WindowsApps`, a folder the user can write: another program of the account could put a decoy of the same name earlier in PATH. Start it as the full path printed by the installer, and trust the `package family name` the installer printed.
- **The signing key is deleted right after signing.** `-Step Sign` makes a self-signed certificate, signs, exports the public half and deletes the private key (no key stays on the PC to forge a package with the same publisher). Any rebuild therefore makes a new certificate and needs `-Step Trust` again (one more UAC prompt). The trusted certificate is machine-wide in `Cert:\LocalMachine\TrustedPeople`; no private key exists for it, so it can only vouch for the package that was signed.
- **Hello's prompt does not show the action.** It names the app only. A process that gets a human to verify at the same moment (a racing presence message for another request, or an agent driving `approve` through a pseudo-console) can have a different request approved than the one the person is looking at. `approve` therefore prints the whole request (the id and every input of the action digest, the digest and the recompute check) and takes the exact typed word `yes` **before** it asks Hello (unit-tested: the text printed at the moment Hello is called, and no Hello call after any other answer). That only helps a person who reads it.
- Keep approving only while no agent is driving the console, and treat a surprise Hello prompt as a reason to refuse.

## Open points (not verified; need the owner's machine)

- **Window handle.** The plain `KeyCredentialManager` API is called without a window handle. Whether Windows shows the Hello prompt in front of a console process, and finds the credential from this exe, could not be tested without triggering Hello. If it does not, the follow-up is `IKeyCredentialManagerInterop` (`RequestCreateAsync` / `OpenAsync` with the console window handle); the CsWinRT projection does not contain that interop, so it would be hand-written COM. Nothing else changes (one class).
- **Credential scope.** The credential is meant to be scoped to the package family name, so a rebuilt exe in a package with the same name and publisher keeps its key, while a new publisher or package name (or a removed and reinstalled package: what Windows does with the key then is not known here) needs `enroll` again and a new Authority config. Not verified on a real machine.
- **This PC at the time of writing.** `KeyCredentialManager.IsSupportedAsync()` returned `False` for a probe run from a non-interactive shell here, so Hello (PIN) may need to be set up first.
- **Provenance.** The Authority's open precondition: the pinned key must be proven to be a Hello key credential, not just any RSA-2048 key. `enroll` now refuses a key Windows will not attest (below), but it does not verify the attestation, so the Authority still pins the key by hand and the precondition stays open in the strict sense. See "Attestation at enroll" for exactly what is and is not checked.
- **Code signing.** The package is signed with a self-signed certificate that only this PC trusts (owner decision, issue #101: free, local). It proves nothing to anyone else, and SmartScreen is not involved for a sideloaded package. No Authenticode certificate for the exe itself.
- **Policy knobs left.** Per-call timeout (10 s; the signing step is outside it); whether the typed `yes` stays once Hello shows its own prompt (it stays: the Hello prompt shows no details).

## Tests

- `test/runtime-approver-unit.test.mjs` (71 in-process checks via `test/approver-harness/`, the real sources except `Program.cs` and `WindowsHello.cs`, plus the fakes): the `enroll` flows (show, create, refuse existing, typed `replace`, console required, cancelled / unusable Hello, public values only, key id grammar), the `enroll --check` self-check (exact signed bytes, three fixed output lines, domain separation from the presence message including cross-verification, a different key or garbage signature -> FAILED, no key -> 69 with nothing created, console first, `--expect` match / KEY_MISMATCH before any prompt, fresh nonce, grammar), the console rule for `approve` (redirected stdin refused before anything is read or sent), the always-typed `yes`, the exit 69 hint, no `--yes` in the grammar, safe rendering (controls, bidi, zero width, non-ASCII, look-alikes, astral, lone surrogates, NFC/NFD, a literal `\u{41}`), every digest input shown, the digest recomputed with the contract and every tampered field / digest / purpose refused before anything is signed or sent, malformed entries and pages, the exact presence message bytes, the fake signer, approve / deny / `presence_unavailable` / not-built flows against a canned channel, the typed-confirmation rule, Authority code mapping, channel failure exit codes, paging, the command grammar.
- `test/runtime-approver-integration.test.mjs` (36 tests; Windows, same user, unprivileged; includes an `enroll --show` -> Authority config -> approve round trip with the fake key, and the shipped build refusing redirected stdin for `approve` / `enroll`): the real test-faults Authority (real RSA presence verifier pinned to the fake key) and the real app. Empty and 7-request lists (more than one frame), approve with fake Hello -> `status` returns a receipt that validates with the contract and verifies with the signer key, typed-`yes` rule, deny and a second decision, `presence_unavailable` / `presence_mismatch` / no-signer, non-ASCII text, a tampering proxy (5 kinds of lie, plus smuggled fields / bidi / null) refused with the proxy never receiving `decide`, wrong owner SID and wrong PID refused with the Authority never seeing a request, a squatter receiving 0 bytes (and, as a control, being spoken to when it is the expected identity), no Authority, and the shipped build (no fakes, no test options, stops at the identity check).
- `test/runtime-approver-source.test.mjs` (14 source guards, any OS): separate project, the one pinned dependency and no other, no process / file / network / key / service code, the WinRT Hello calls confined to `WindowsHello.cs` as a fixed member list (no private export; since #101 the list includes exactly one `GetAttestationAsync` and one `DeleteAsync`, the removal of the key `enroll` just made), the package API in that file only, the gate before the pipe / typed word / Hello in every command and handed to all four by the entry point, the attestation rule in one place, the shipped wiring uses `WindowsHelloPresenceSigner` and the test-faults wiring does not, no `--yes`, fakes only inside the `#if`, verify-before-write order and the exact P/Invoke set, only `list` / `decide` and only the three decisions, digest refusal before the signer, rendering through `SafeText`, build script and package exclusion.
- Issue #101 added to the unit harness (`test/approver-harness/GateChecks.cs`): the gate (no package, another name, another publisher, the name in another case, development mode) in front of `approve`, every form of `enroll`, `enroll --check` and `policy set` with the key store, signer, pipe and typed word untouched; `list` / `deny` / `policy show` unpackaged; the text printed at the moment Hello is called; and the attestation rule (every status, empty buffers, other spelling). The integration file adds the same through the real Authority and the process, plus the shipped build refusing `enroll --show` unpackaged (the real package API reports "not packaged"). Mutations checked: a gate that never refuses, and an attestation rule that also accepts `TemporaryFailure`, each fail the harness.
- `test/approver-msix.test.mjs` (19 tests, no download, no certificate, no package): the identity registry and its C# mirror, the family name (publisher id derivation), the manifest, the logos, the layout copy, the pinned build tools (hash match and mismatch, size limits, no process before the hash matched, signature statuses and look-alike signers), and the installer script (ASCII, dry by default, nothing changes before `-Apply`, administrator check for the two machine-wide steps, signing key deleted in a `finally`, the only file that names these commands; all five steps run as a dry run on Windows).
- `scripts/arch-check.mjs` rule 11 and `scripts/package-smoke.mjs`: nothing in the Observer or the npm package names or ships the approver.

Elevated CI note: Node-made pipes (the proxy and the squatter) are owned by Administrators, so those tests expect `nodePipeOwnerSid()`, and temp paths are resolved with `realpathSync.native`.

## Not done here

- A run of `enroll` or a signature against a real Windows Hello (CI cannot; "Open points"), the window-handle interop, **validation** of the attestation (chain, statement signature, key binding; "Attestation at enroll"), an install of the package and a real signing (host changes; "Package and install" lists what is unverified), running the process in an AppContainer, and any GUI.
- The service identity (SCM PID, `NT SERVICE\AlberaApprovalAuthority` owner, session 0) is exercised only through the same-user owner/PID path; the real service path needs the VM lab (as for the Broker client).
- The Authority's image hash is not checked by the approver.
- A same-user process can also run `AlberaApprover.exe`, so a real approval rests entirely on Hello (user presence on the Hello key); the typed `yes` is not a security control.
