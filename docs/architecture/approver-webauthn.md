# Approver presence through WebAuthn, with several keys

**Status:** the owner chose this direction on 2026-11-04 ("それで進める"). The details below are provisional until the feasibility probe passes ("Feasibility probe"). Nothing here is implemented yet.

## Why

The owner can reach the ALBERA host only over Remote Desktop. In a Remote Desktop session `KeyCredentialManager.IsSupportedAsync()` returns false (measured 2026-11-04, session `rdp-tcp#1`, `SM_REMOTESESSION` true). So the approver's Windows Hello signer (`WindowsHello.cs`) is never ready there. Four `task.start` requests expired because nothing could be signed (ledger, "2026-11-04 — owner run on the real PC").

The Windows WebAuthn API (`webauthn.dll`) works in the same session. It reported API version 9 and a user-verifying platform authenticator (probe without a prompt, 2026-11-04). Remote Desktop forwards WebAuthn requests to the PC the person connects from, so Windows Hello asks on that PC ([WebAuthn redirection](https://learn.microsoft.com/is-is/azure/virtual-desktop/redirection-configure-webauthn)). At the console, the same API asks the host's own Hello.

## What changes and what stays

| | today | with this design |
|---|---|---|
| who signs | one Windows Hello key on the host (`KeyCredentialManager`, RSA-2048) | any one of the **registered approver keys**: WebAuthn credentials (host Hello, the connecting PC's Hello, a phone passkey or a security key), and the existing Hello key while it is registered |
| where Hello asks | the host only | wherever the person is: the host at the console, the connecting PC over Remote Desktop, a phone through a QR code |
| what is signed | `albera.presence.v1` message (approvalId, action digest, entry challenge) | the same message, bound through the WebAuthn challenge |
| keys | one, pinned in the Authority config | a list. The first one is written by the elevated installer. Later ones are added only with a signature by a key that is already registered |

Unchanged: the match code, the approval window and `approve`, the Authority building the message from its own entry, receipts (their `approverKeyId` names the key that signed), the approver SID (one Windows account), the pipe and its server checks, and every "Known limits" item in `approver-app.md` (same-user processes are trusted; the prompt does not show the action).

## The proof

The approver builds the client data itself, as exactly these bytes (UTF-8, no spaces):

```
{"type":"webauthn.get","challenge":"<base64url(SHA-256(presence message))>","origin":"albera://approver","crossOrigin":false}
```

It calls `WebAuthNAuthenticatorGetAssertion` with the fixed rp id `approver.albera.local` (provisional, see "Open points"). User verification is required. `allowCredentials` holds the credential ids of the registered WebAuthn keys, which `list` returns as public metadata. The `decide approve` frame then carries:

```
"presence": {"kind":"webauthn","credentialId":"<b64url>","authenticatorData":"<b64>","signature":"<b64>"}
```

The client data is not sent. The Authority rebuilds the exact bytes from its own entry, so a signature can only verify for that entry. The existing form `"presence":"<base64 RSA signature>"` stays valid for a registered Hello key.

## Verification (Authority)

A new `WebAuthnPresenceVerifier` implements the existing `IHumanPresenceVerifier`. A proof is `Verified` only if all of these hold. Any other proof is `Mismatch`, never an exception.

1. `credentialId` names a registered WebAuthn key.
2. `authenticatorData` has at least 37 bytes.
   - The first 32 bytes are SHA-256 of the rp id.
   - The flags have user present (0x01) and user verified (0x04) set, and attested data (0x40) and extensions (0x80) clear.
   - Nothing follows the 37 bytes.
3. The signature verifies over `authenticatorData || SHA-256(clientData)`, with the rebuilt client data. The algorithm is the one the key was enrolled with: ES256 (P-256, DER signature) or RS256 (RSA-2048 or larger, PKCS#1 v1.5, SHA-256).
4. Sign count: when both the stored and the new count are non-zero, the new one must be larger. The Authority keeps the last count per key. Zero means the authenticator has no counter, which Windows Hello may report; the probe records the value.

## Keys

**Key record (public data only):** `keyId`, `kind` (`webauthn` or `hello-rsa`), `alg`, `publicKey` (SubjectPublicKeyInfo), and for `webauthn` the `credentialId`. The key id is `webauthn-` plus the first 8 bytes of SHA-256 over the SPKI, in lower-case hex, the same rule as `hello-` today.

**The first key** is written by the elevated installer, as the approver values are today. A new elevated mode, `albera-host.ps1 -Mode set-approver`, replaces the key list of an existing install from `AlberaApprover.exe enroll --show` values and restarts the Authority. UAC works over Remote Desktop, so the owner can do this remotely. The config keeps reading the old single-key fields as one `hello-rsa` key.

**Adding a key** (`AlberaApprover.exe keys add`):
1. The approver creates the new WebAuthn credential (one prompt, on the device that will hold it).
2. It asks the Authority for a fresh key challenge.
3. It signs `albera.keyadd.v1` 0x00 newKeyId 0x00 SHA-256(new key record) 0x00 challenge twice: once with an already registered key (one prompt) and once with the new key, to prove the person holds it (one prompt).
4. The Authority checks both signatures and the challenge, and stores the key in its own file `authority\approver-keys.json`, next to the policy store, with the same trust checks.

**Removing a key** needs a signature by any registered key over `albera.keyremove.v1` with the same structure. The last key cannot be removed.

**Attestation:** the approver asks for none. Like the owner's current Hello key (status `NotSupported`), a WebAuthn key is not proven to be hardware-backed. `enroll` and `keys add` need `--accept-unattested` and print the same warning line as today.

## Remote sessions

- The approver uses WebAuthn first, at the console and over Remote Desktop. It uses `KeyCredentialManager` only when no WebAuthn key is registered and the session is not remote.
- In a remote session with no WebAuthn key, the window says before any digit is pressed: "Windows Hello does not work over Remote Desktop for this key; add a key with `keys add`". It no longer gives the "run enroll" hint (see the open item in the ledger).
- If WebAuthn redirection is turned off by policy, the request does not reach the connecting PC and the assertion fails (`Unavailable` or `NotReady`). Nothing is approved.

## What the threat picture changes

- **The private key can now live outside the host** (the connecting PC, a phone, a security key). To approve, an attacker needs that device and its Hello, and also a same-user process on the host to reach the approver pipe. Today's single key sits on the host.
- **A same-user process in the remote session can start a WebAuthn prompt on the connecting PC.** This is the same class as today: such a process can already call `RequestSignAsync` on the Hello key. The approval window and match code are unchanged; a surprise prompt is still a reason to refuse.
- **More keys mean more ways to approve.** So adding a key needs a signature by an existing key, and the key list is visible (`keys list`, and `status` on the host).

## Phases

| # | piece | tier |
|---|---|---|
| 0 | feasibility probe on the owner's PC (below) | none (scratch tool, not in the repository) |
| 1 | this document | docs |
| 2 | Authority: key list (config and store), `WebAuthnPresenceVerifier`, `decide` with the new proof, key metadata in `list`, `key_challenge` / `key_add` / `key_remove` | security: CI, Zaku, disposable VM |
| 3 | Approver: WebAuthn signer (shipped build only), `enroll --webauthn`, `approve` / window / `policy` with it, `keys add/remove/list`, the remote-session message; a software authenticator in the test-faults build | security |
| 4 | Installer: `-Mode set-approver`, WebAuthn key values in install and migrate | security |
| 5 | Owner: `enroll --webauthn` over Remote Desktop, the elevated `set-approver`, then the first job | owner step |

## Feasibility probe (before phase 2)

`C:\dev\albera-owner-1104\owner\webauthn-test.cmd` (scratch build, not committed). In the owner's Remote Desktop session it:
1. creates a credential for rp id `probe.albera.local` with user verification (one prompt);
2. signs a fresh challenge with it (one prompt);
3. verifies the signature locally and prints `RESULT: OK` or the failing step, the flags and the sign count.

Nothing is sent anywhere. The design goes ahead only if the result is OK with user verified set.

## Open points

- **rp id.** `approver.albera.local` is not a web origin anyone can serve with a trusted certificate, so a web page cannot ask for these credentials. Whether Windows accepts it for every authenticator (phone, security key) is checked by the probe only for the authenticator the owner uses.
- **Window handle.** WebAuthn takes the window handle of the approval window or the console. Whether the prompt then shows in front over Remote Desktop is checked by the probe for the console case.
- **Sign count** of Windows Hello over redirection: recorded by the probe.
