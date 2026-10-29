# SQLite Operation Store Recovery Owner Runbook

**Status:** Proposal for review only. The repository now contains prototype backup/restore helpers, but this is not an approved production procedure.
**Scope:** Prototype SQLite `recovery-owner` marker and same-host snapshot/restore behavior.

The store defaults `recoverInterruptedRequests` to `false`. If recovery is enabled, it exclusively creates `<databasePath>.recovery-owner`, writes a versioned marker containing a PID and random nonce, and holds the file handle until the store closes. If that path already exists, startup fails closed with `recovery_owner_locked`. The process never decides that an existing marker is stale and never removes it automatically.

Recovery converts operations still in `REQUESTED` to `UNKNOWN` and records `host_interrupted`. It does not prove that a provider-side effect did not happen and does not retry it. The Store blocks later mutations and Lease release for that Computer generation until the operation is reconciled to a terminal state; reconciliation must inspect provider state and cannot prove an unobservable in-flight call has stopped.

`SqliteEnvironmentOperationStore.backupTo(path)` creates a consistent SQLite `VACUUM INTO` snapshot inside the live database's private directory, validates full SQLite integrity, foreign keys, schema version and required tables, then publishes without replacing an existing destination. `restoreSqliteEnvironmentStore(backupPath, newDatabasePath, options)` accepts only a private same-directory snapshot and a new destination. It creates `<newDatabasePath>.restore-incomplete` exclusively before copying; ordinary Store opens reject any destination with this marker. The restore owner starts exclusive interrupted-operation recovery and, before returning the Store handle, marks unresolved requested work `UNKNOWN`, revokes all nonreleased Leases and advances every Computer generation with unknown observed state. Only after that transaction commits does it verify and remove its own marker. On error or abrupt host exit, it preserves the marker and copied bytes for diagnosis, keeping the destination fail-closed. Existing source/destination files are preserved. This primitive is only a local same-host testable capability: it does not encrypt/off-host backup data, rotate Guest credentials, restore provider/VM state, repair ACLs, or provide an operator CLI.

## Current limitation

There is no supported service startup integration, operator recovery CLI, or production process-owner identity. The marker PID is diagnostic text only: it can be stale, reused, malformed, or forged. Gated real Windows tests cover private DACLs on the temporary backup/restore path, but cross-platform filesystem behavior, crash/power-loss guarantees, encrypted backup handling and credential rotation are unverified. Do not use the helpers or this runbook as a production recovery procedure or to unlock a live or ambiguously owned database.

## Required operator sequence before a recovery command exists

1. **Stop and quiesce every ALBERA process that can open the exact database.** Use the deployment's normal shutdown path and confirm each process exited. Do not terminate a process just because its PID appears in the marker.
2. **If any process owner or database path is uncertain, stop here.** Do not rename the marker, remove it, or start a second recovery owner. Escalate to the system owner and preserve the current state.
3. **Preserve evidence in the same protected storage boundary.** Record the exact database and marker paths, file metadata, and marker bytes. With all users stopped, preserve copies of the database and any `-wal` / `-shm` sidecars together. Keep original ACLs and access restrictions. Do not upload, email, or paste marker/database contents into tickets or logs.
4. **Review the marker as untrusted diagnostic data.** Check the marker version and PID for context only. Do not treat either as proof that the referenced process is the owner or is stopped.
5. **Use only a future, reviewed recovery command.** It must acquire exclusive ownership, verify the exact database identity and storage ACLs, preserve the old marker as evidence, run recovery once, and report counts of affected operations without printing payloads. If ownership acquisition or validation fails, leave the database and marker unchanged.
6. **After recovery, reconcile every `UNKNOWN` operation against provider observations.** Do not infer stop, deletion, or failed creation from Lease expiry, process exit, missing marker, or a timeout. Keep capacity reserved until an authoritative current-generation observation permits release.

## Prohibited shortcuts

- Do not delete the database, WAL/SHM sidecars, marker, or operation rows to clear an error.
- Do not edit the marker PID/nonce or manufacture a replacement marker.
- Do not launch multiple recovery owners or enable recovery on ordinary API/Observer startup.
- Do not automatically replay `REQUESTED` or `UNKNOWN` provider mutations.
- Do not interpret marker removal or Lease expiry as evidence that a VM or process stopped.

## Gate to operational use

Before this becomes an executable runbook, ADR-002 must select the service identity and host process model. A reviewed service integration must provide single-owner startup, clean shutdown, ownership diagnostics, backup/restore validation, and tests for stale/live marker refusal, crash during recovery, restart, ACL failure, and provider-side ambiguity. The recovery CLI and service startup path must remain separate from the read-only Observer and must not accept generic shell or PowerShell input.
