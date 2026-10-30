// The persistence port of the approved-operation flow (approved-operation-flow.mjs) and an in-memory implementation of it.
//
// The flow writes its intent here BEFORE every step that has an effect outside this process (fence, submit, claim), and moves a record only forward
// by compare-and-set on the record's `revision` AND on the phase it believes the record is in. Phases repeat across cycles (a new cycle goes back to INTENT), so the
// phase alone cannot tell a stale step of cycle 1 from a current step of cycle 2; the revision can. A durable implementation (the SQLite operation store, ADR-003) must keep the same
// semantics; this in-memory one is for tests and for a single process whose restart may forget everything (it then restarts the whole flow, which is safe:
// the Authority and the Broker keep their own single-use state).
//
//   begin(record)                                     -> { created: boolean, record }   insert when operationId is new (with revision 0); otherwise return the stored record unchanged
//   advance(operationId, expectedRevision, from, patch) -> record                       atomically, when stored.revision === expectedRevision AND the stored phase is one of `from`:
//                                                                                       set the patch and revision + 1; otherwise reject with code 'conflict' and change nothing
//   get(operationId)                    -> record | null
//
// The durable (SQLite) store must keep exactly these semantics: one transaction, both checks, `revision` owned by the store (a patch can set neither it nor `operationId`).
// The SQLite implementation is `flowJournal()` of the operation store (sqlite-operation-store.mjs, schema v5); test/runtime-approved-operation-journal.test.mjs runs one contract over both.
// Records are plain JSON-able objects. Every method may be sync or async. A rejection means "not persisted": the flow stops before the next side effect.

export class FlowJournalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FlowJournalError';
    this.code = code;
  }
}

const copy = (record) => Object.freeze(structuredClone(record));

/** A journal that lives in this process only. `history` lists every phase transition, in order, for assertions. */
export function createMemoryFlowJournal() {
  const records = new Map();
  const history = [];
  return {
    history,
    begin(record) {
      const stored = records.get(record.operationId);
      if (stored) return { created: false, record: copy(stored) };
      records.set(record.operationId, { ...structuredClone(record), revision: 0 });
      history.push({ operationId: record.operationId, phase: record.phase });
      return { created: true, record: copy(records.get(record.operationId)) };
    },
    advance(operationId, expectedRevision, from, patch) {
      const stored = records.get(operationId);
      if (!stored) throw new FlowJournalError('unknown_operation');
      if (stored.revision !== expectedRevision || !from.includes(stored.phase)) throw new FlowJournalError('conflict');
      const next = { ...stored, ...structuredClone(patch), operationId, revision: stored.revision + 1 }; // a patch can set neither
      records.set(operationId, next);
      history.push({ operationId, phase: next.phase });
      return copy(next);
    },
    get(operationId) {
      const stored = records.get(operationId);
      return stored ? copy(stored) : null;
    },
  };
}
