// The persistence port of the approved-operation flow (approved-operation-flow.mjs) and an in-memory implementation of it.
//
// The flow writes its intent here BEFORE every step that has an effect outside this process (fence, submit, claim), and moves a record only forward
// by compare-and-set on the phase it believes the record is in. A durable implementation (the SQLite operation store, ADR-003) must keep the same
// semantics; this in-memory one is for tests and for a single process whose restart may forget everything (it then restarts the whole flow, which is safe:
// the Authority and the Broker keep their own single-use state).
//
//   begin(record)                       -> { created: boolean, record }   insert when operationId is new; otherwise return the stored record unchanged
//   advance(operationId, from, patch)   -> record                          set the patch when the stored phase is one of `from`; otherwise reject with code 'conflict'
//   get(operationId)                    -> record | null
//
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
      records.set(record.operationId, structuredClone(record));
      history.push({ operationId: record.operationId, phase: record.phase });
      return { created: true, record: copy(record) };
    },
    advance(operationId, from, patch) {
      const stored = records.get(operationId);
      if (!stored) throw new FlowJournalError('unknown_operation');
      if (!from.includes(stored.phase)) throw new FlowJournalError('conflict');
      const next = { ...stored, ...structuredClone(patch) };
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
