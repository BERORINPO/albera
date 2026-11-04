# Approver presence through WebAuthn, with several keys

**Status:** the owner chose this direction on 2026-11-04 ("それで進める"). The feasibility probe passed the same day ("Feasibility probe"). Phases 2 to 4 are being built against "Wire contract".

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

It calls `WebAuthNAuthenticatorGetAssertion` with the fixed rp id `approver.albera.local` (provisional, see "Open points"). User verification is required. `allowCredentials` holds the credential ids of the registered WebAuthn keys, which the new `keys` verb returns (public data only). The `decide approve` frame then carries:

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

**The first key** is written by the elevated installer, as the approver values are today (the three Hello values, or `-ApproverKeyFile` record files). Every later key is added by the elevated `albera-host.ps1 -Mode set-approver` ("Adding a key", and the store rule under "Key store"): it adds the given record files to the keys in force, or with `-Replace` uses only them, and restarts the Authority. It never replaces the list by accident: without `-Replace` nothing in force is dropped. UAC works over Remote Desktop, so the owner can do this remotely. The config keeps reading the old single-key fields as one `hello-rsa` key.

**Adding a key** is done only by the elevated `-Mode set-approver`, behind the owner's UAC. There is no run-time `key_add` (decision 2026-11-04, after Zaku's review of phase 2).
- A run-time add needs only one Hello signature by a registered key. A same-user process could get that signature at the moment of a real approval (the prompt does not show what is signed) and register its own software key. One prompt would then buy every later approval, where today one prompt buys one approval.
- UAC is a boundary that same-user processes do not cross. So the owner:
  1. runs `AlberaApprover.exe enroll --webauthn` on the device that will hold the key (it writes the record file);
  2. runs `set-approver` with that file, which adds it to the current list.

**Removing a key** needs a signature by any registered key over `albera.keyremove.v1` with the same structure. The last key cannot be removed.

**Attestation:** the approver asks for none. Like the owner's current Hello key (status `NotSupported`), a WebAuthn key is not proven to be hardware-backed. `enroll --webauthn` needs `--accept-unattested` and print the same warning line as today.

## Wire contract (fixed for phases 2 to 4)

Phases 2, 3 and 4 are built at the same time against this section. A change here changes all three. Replies keep the Authority's shape: `{"ok":true,...}` or `{"ok":false,"code":"<code>"}`. Nothing the caller sent is echoed.

**Key record** (JSON, public data only):

```
{"keyId":"webauthn-0123456789abcdef","kind":"webauthn","alg":-7,"publicKey":"<base64 SPKI>","credentialId":"<base64url, no padding>"}
{"keyId":"hello-951a135537287eae","kind":"hello-rsa","alg":-257,"publicKey":"<base64 SPKI>"}
```

- `keyId`: `webauthn-` or `hello-` plus the first 8 bytes of SHA-256 over the SPKI DER, lower-case hex. A record whose id does not match its key is refused.
- `alg`: `-7` (ES256, P-256) or `-257` (RS256; RSA-2048 or larger for `webauthn`, exactly 2048 for `hello-rsa`).
- `credentialId`: `webauthn` only, 1 to 1023 bytes.
- **Canonical bytes** of a record: the JSON above with the keys in exactly that order, no spaces, UTF-8, `credentialId` left out for `hello-rsa`.

**Authority config** (written by the elevated installer):
- New field `approverKeys`: an array of 1 to 16 key records.
- The legacy pair `approverKeyId` + `approverPublicKey` is still read, as one `hello-rsa` record. A config with both the pair and `approverKeys` is refused (`config_approver_keys`).

**Key store** `authority\approver-keys.json` (written by the Authority only; same trust checks as the policy store): `{"v":1,"revision":<n>,"keys":[<records>],"signCounts":{"<keyId>":<n>}}`.
- On start, a missing store is created from the config keys. After that the store is the key list.
- `-Mode set-approver -ApproverKeyFile <path> [...] [-Replace]` starts from the **effective** list: the store's keys when the store is present and trusted, otherwise the config's.
  - It adds the given records, or with `-Replace` uses only them.
  - It writes the result as `approverKeys` into the config and deletes the store, so the next start seeds it from the config again.
  - Starting from the config alone would bring back a key that `key_remove` took out, which must never happen.

**`keys`** (approver role): `{"v":1,"verb":"keys"}` replies `{"ok":true,"keys":[{"keyId":..,"kind":..,"credentialId":..}]}`. `credentialId` appears for `webauthn` only. It is a new verb, so `list` stays as it is and an installed approver keeps working.

**Proofs.** Two forms are used in `decide`, `policy_set` and `key_remove`:
- WebAuthn: `{"kind":"webauthn","credentialId":"<b64url>","authenticatorData":"<b64>","signature":"<b64>"}`. The signed client data is the fixed JSON in "The proof", with `challenge` = base64url(SHA-256(message)).
- Hello: the existing base64 RSA signature string over the message itself, exactly 256 bytes once decoded. It is only ever checked against the registered `hello-rsa` keys, never fed to the WebAuthn path. The Authority tries each such key.

The receipt's `approverKeyId` is the key that verified.

**Messages** (UTF-8, 0x00 between parts):
- presence (unchanged): `albera.presence.v1` approvalId actionDigest challenge
- remove: `albera.keyremove.v1` keyId keyChallenge (no record hash: the approver of another device has no copy of the record; the key id names one registered key)

**`key_challenge`**: `{"v":1,"verb":"key_challenge","op":"remove","keyId":"<key to remove>"}` (`op` `add` is refused, `request_invalid`) replies `{"ok":true,"challenge":"<22 chars, 128-bit base64url>","expiresAt":<unix s>}`. The challenge is single-use, lives 120 s, and is bound to the op and the key id. One challenge is outstanding at a time; a new one replaces the old.

**`key_add`** does not exist (see "Adding a key"); the verb is unknown to the Authority.

**`key_remove`**: `{"v":1,"verb":"key_remove","keyId":"..","challenge":"..","by":<proof by a registered key>}`, over the remove message. It replies `{"ok":true,"keys":[...]}` as `keys` does, plus `"policyReset":true` when the removed key had signed the policy in force (the policy is set back to careful first).

**Codes** (new): `challenge_unknown`, `challenge_expired`, `key_unknown`, `last_key`, `too_many_keys` (the list does not fit). Existing codes are reused: `request_invalid` for anything malformed, `presence_mismatch` for a proof that does not verify.

**Sign count:** a stored count above zero followed by a new count of zero is a mismatch (WebAuthn treats it as a sign of a cloned authenticator).

Only the approver SID may call `keys`, `key_challenge` and `key_remove`, with the same caller check as `decide`.

## Remote sessions

- The approver uses WebAuthn first, at the console and over Remote Desktop. It uses `KeyCredentialManager` only when no WebAuthn key is registered and the session is not remote.
- In a remote session with no WebAuthn key, the window says before any digit is pressed: "Windows Hello does not work over Remote Desktop for this key; make one with `enroll --webauthn` and add it with `set-approver`". It no longer gives the "run enroll" hint (see the open item in the ledger).
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
| 2 | Authority: key list (config and store), `WebAuthnPresenceVerifier`, `decide` with the new proof, the `keys` verb, `key_challenge` / `key_remove` | security: CI, Zaku, disposable VM |
| 3 | Approver: WebAuthn signer (shipped build only), `enroll --webauthn`, `approve` / window / `policy` with it, `keys list|remove`, the remote-session message; a software authenticator in the test-faults build | security |
| 4 | Installer: `-Mode set-approver`, WebAuthn key values in install and migrate | security |
| 5 | Owner: `enroll --webauthn` over Remote Desktop, the elevated `set-approver`, then the first job | owner step |

## Feasibility probe (before phase 2)

`C:\dev\albera-owner-1104\owner\webauthn-test.cmd` (scratch build, not committed). In the owner's Remote Desktop session it:
1. creates a credential for rp id `probe.albera.local` with user verification (one prompt);
2. signs a fresh challenge with it (one prompt);
3. verifies the signature locally and prints `RESULT: OK` or the failing step, the flags and the sign count.

Nothing is sent anywhere. The design goes ahead only if the result is OK with user verified set.

**Result (2026-11-04, owner's Remote Desktop session, `SM_REMOTESESSION` true):** `RESULT: OK`. The owner confirmed Windows Hello twice on the connecting PC.
- create: attestation format `none`, credential id 32 bytes, ES256 (P-256), user present and user verified set, rp id hash matches.
- sign: user present and user verified set, sign count **1**.
- The signature verified with the created public key, over the client data the probe built itself. So the client data passed over the redirection unchanged.

The console window's handle was used.

## Open points

- **rp id.** `approver.albera.local` is not a web origin anyone can serve with a trusted certificate, so a web page cannot ask for these credentials. Windows accepted the same shape (`probe.albera.local`) for the owner's Hello over Remote Desktop. A phone or a security key is not checked.
- **Window handle.** The console window handle worked over Remote Desktop. The approval window's handle is not checked yet; phase 3 uses it.
- **Sign count.** Windows Hello over redirection reported 1 on the first assertion, so the counter is live and the monotonic check (verification rule 4) applies to it.
