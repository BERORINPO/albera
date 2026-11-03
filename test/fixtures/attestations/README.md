# Attestation fixtures for the setup program tests

Public values only. Nothing here is a secret.

| Folder | What it is | Made by |
|---|---|---|
| `synthetic/` | Files written by hand for the unit tests of `src/runtime/windows-setup`. Not produced by GitHub, Sigstore or `gh`, and never valid for any real verification. | the PR6 author |
| `real/` | Bundles and a trusted root taken from a real Host build hashes run. **None yet.** | (nobody) |

`real/` does not exist because no real bundle was fetched: PR6 forbids downloading anything on the development PC, and the first real bundle comes from the Host build hashes
run on `main` after PR6 merges (its last step verifies the run's own bundles with the built `albera-setup.exe`; that is measurement M8 of
`docs/architecture/control-plane-service.md`). When a real run's bundle is added, put it in `real/` with the run id, the commit and the date in a `real/README.md`; the tests that
read `real/` must say they read it, so a green test never claims more than the fixture can prove.

## Files in `synthetic/`

- `gh-verify-output.json`: what `gh attestation verify --format json` prints for one attestation, in the shape its manual describes
  (`verificationResult.statement.subject`, `.signature.certificate`, `.verifiedTimestamps`; the certificate field names come from sigstore-go's `certificate.Extensions`). It names
  `sample.bin` by its SHA-256 and carries every value `albera-setup.exe` pins. A test feeds it to the C# policy.
- `sample.bin`: the "artifact" that file names.
- `bundle.jsonl`, `trusted_root.jsonl`: placeholders. A test runs a real `gh attestation verify` (the one on `PATH`, if any) with the exact arguments setup builds and these files;
  gh must not complain about an unknown flag, and must refuse the bundle.
