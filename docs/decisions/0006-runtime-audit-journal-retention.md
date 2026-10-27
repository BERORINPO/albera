# ADR 0006: Runtime audit journal retention and capacity

## Status

Implemented for the local prototype; production retention, backup, and encryption remain open.

## Decision

- Keep the Runtime audit journal append-only. ALBERA does not rotate, compact, expire, or delete journal records automatically.
- Enforce a 16 MiB default capacity, a configurable limit no greater than 64 MiB, 20,000 records, and a per-record size bound.
- When the byte or record limit is reached, reject the write. The Runtime host treats audit-write failure as fatal and shuts down the API and Gateway rather than continuing without an audit trail.
- Preserve all bytes written before capacity is reached. Reopening the journal must recover those records without rewriting the file.
- Do not create automatic backups. The journal contains local control metadata, is not encrypted, and remains at the user-selected path. Operators who need backup or longer retention must use a reviewed local backup process that preserves the journal's access controls. No external upload is performed by ALBERA.

## Rationale

Automatic rotation or retention expiry could destroy audit and recovery evidence without an explicit user decision. Failing closed at a fixed bound keeps disk use finite while preserving earlier records and making loss of continued audit visible. A backup mechanism would create additional copies with separate confidentiality, access-control, and deletion semantics; it is deferred until those behaviors have a dedicated threat model.

## Verification

`test/runtime-audit-journal.test.mjs` exercises capacity rejection, confirms previous records remain byte-for-byte intact after the failed write and close, reopens the journal, and confirms all prior records are still readable. The test uses a temporary synthetic journal and does not touch user data.

## Consequences and limits

- This is not an indefinite retention or durability guarantee. Disk loss, corruption, and manual deletion remain possible.
- The journal is unencrypted. Windows DACL and POSIX mode checks protect access at the selected storage objects, but a production backup workflow and encryption policy are not implemented.
- At capacity, Runtime stops rather than pruning data or continuing without audit.
