# WSL2 Run Lease Revocation Runbook

**Status:** Proposal. It cannot be run yet: the production Broker has no key to sign leases (ADR-002 AGM-2), and the bridge has no installer (ADR-012 phase 5). The bridge half has been observed on a real machine. The Broker half has not been run for WSL2.
**Scope:** Revoking every WSL2 run lease issued so far, for example when the Control Plane's account or its files may be compromised.

## Why two numbers

A run lease is a bearer statement, and a restart of the Broker does not revoke it. Two numbers decide whether a lease still works:

| Number | Where | Effect of raising it |
|---|---|---|
| Broker `generation` | `C:\ProgramData\Albera\broker-config\AlberaHostBroker.service.json` | New leases carry the new number. Takes effect at the next Broker start |
| Bridge floor | The file named by `leaseFloorPath` in the bridge config | Leases below it are refused, and runs below it are ended. Takes effect on a running bridge, with no restart |

**Raising only one revokes nothing useful and warns nobody.** Raise only the Broker and old leases keep working at the bridge. Raise only the floor and no new lease can start. That second state is closed, so it is safe, but WSL2 stays out of service until the Broker follows.

## Steps

Run these in an elevated PowerShell. `N` is the Broker's current `generation`.

1. **Stop the Control Plane**, so nothing new arrives while you work:

   ```powershell
   Stop-Service AlberaControlPlane
   ```

2. **Raise the bridge floor to `N + 1`, first.** This is what ends old leases, so it comes before anything else that takes time. Rewrite the file in place: a file moved from elsewhere can bring other ACLs, and the bridge then refuses it.

   ```powershell
   Set-Content -LiteralPath '<leaseFloorPath>' -Value '<N + 1>' -Encoding ascii
   ```

   The file holds one number and nothing but line ends after it.

3. **Confirm the runs are gone.** The reaper ends a run below the floor within one tick (5 s). A failed teardown retries inside the tick, so a hung `wsl.exe` can delay this by up to 90 s per name.

   ```powershell
   wsl --list --quiet
   ```

   No `albera-run-` name may remain. Other distributions are not part of this. **Do not run `wsl --shutdown`**: it stops every distribution on the PC, the owner's included.

4. **If a run remains, or the floor cannot be read, stop the bridge.** A floor the reaper cannot read ends nothing, and such a run lasts until its lease ends. Stopping the bridge ends every run. Its restart is refused until the floor can be read.

5. **Raise the Broker's `generation` to `N + 1` and restart it.** Change only that one number in the config, in place.

   ```powershell
   Restart-Service AlberaHostBroker
   ```

   The start advances the journal's generation and deletes every challenge. A value below the journal's refuses the start (`generation_regressed`). Never lower it, because that would bring the revoked generations back.

6. **Deal with the cause before step 7.** If the Control Plane was compromised, a new generation does not clean it. Rebuild it first.

7. **Start the Control Plane again**, then start one WSL2 job and confirm it is accepted. A refusal that names the generation means the two numbers do not match.

   ```powershell
   Start-Service AlberaControlPlane
   ```

## What this does not do

- It does not undo what a job already did. Results that were collected stay collected, and they still need review.
- It does not replace the Broker's key. If the key itself may be exposed, this runbook is not enough: the bridge's pinned `brokerKeyId` and `brokerSpki` must change too, and no procedure for that exists yet.
- The floor has no high-water mark, so an administrator can lower it again. Lowering it brings old leases back until they expire. Do not lower it.

## Refusals you may see

| Word | Meaning | What to do |
|---|---|---|
| `lease_floor_unreadable` | The floor is missing, in use, loosely protected or not a number. Every `begin` is refused | Fix the file. It is never read as "no limit" |
| `generation_regressed` | The Broker's configured generation is below its journal's | Set the config to the journal's value or higher |

## Not verified

- Observed on a real machine (`scripts/wsl2-bridge-gates.mjs`, fake Control Plane, test key): the floor rewritten under a running bridge refuses the next `begin`, ends the run below it, accepts a lease of the new generation, and a missing file refuses.
- Not run: this order end to end, a Broker that signs WSL2 leases, and the service names and ACLs on an installed PC.
- The bridge's service name and the `leaseFloorPath` location come from the phase 5 installer. Fill them in here when it exists.
- Phase 5 must limit reading the floor to Administrators and the bridge's owner. Until then, a compromised Control Plane can hold the file open and keep the reaper from reading it, which is why step 4 exists.
