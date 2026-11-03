// Test doubles for the ports of room-job-routes.mjs: `approvals` (what the approval flow will be in the room service) and `hands` (the Claude Code driver).
// The test decides when and how each request is decided, so it can try a denial, a late approval, a lying port or a stop in the middle.
// Nothing here talks to a pipe or starts a process.

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const APPROVAL_IDS = ['0b6c9d5e-7f21-4c3a-9e48-5d1a2b3c4d5e', '1c7d0e6f-8a32-4d4b-8f59-6e2b3c4d5e6f', '2d8e1f70-9b43-4e5c-9a6a-7f3c4d5e6f70', '3e9f2081-ac54-4f6d-8b7b-804d5e6f7081'];

/**
 * @param {{ projectId?: string, change?: (submitted: object, ask: object) => object }} [options] `change` rewrites what the port answers (to play a port that lies)
 */
export function createFakeApprovals({ projectId = 'proj-alpha', change = (submitted) => submitted } = {}) {
  const asked = []; // every request, as the port received it
  const open = []; // { decide(result) } in the order the requests were made
  let n = 0;
  function answer(ask, purpose, action) {
    asked.push(ask);
    const decided = deferred();
    open.push({ decide: decided.resolve });
    const approvalId = APPROVAL_IDS[n++ % APPROVAL_IDS.length];
    return change({ ok: true, approvalId, purpose, action, decided: decided.promise }, ask);
  }
  return {
    asked,
    hold: null, // a promise: startTask / noop do not answer until it settles (the request is "in flight")
    failNext: null, // set to { ok: false, code } or an Error to make the next request fail
    async startTask(ask) {
      if (this.hold) await this.hold;
      if (this.failNext) { const f = this.failNext; this.failNext = null; if (f instanceof Error) throw f; return f; }
      return answer(ask, 'guest.command', { action: 'task.start', projectId, computerId: ask.computerId, args: { task: ask.task } });
    },
    async noop() {
      if (this.hold) await this.hold;
      if (this.failNext) { const f = this.failNext; this.failNext = null; if (f instanceof Error) throw f; return f; }
      return answer({}, 'broker.operation', { action: 'synthetic.noop', projectId: 'proj-alpha', computerId: 'pc-01', args: {} });
    },
    /** The person approved request `index`: the Broker claimed it. */
    approve(index = 0, ...rest) { open[index].decide({ ok: true, operationId: rest.length > 0 ? rest[0] : `op-${index + 1}` }); }, // an explicit undefined is passed on as is
    deny(index = 0, code = 'start_denied') { open[index].decide({ ok: false, code }); },
  };
}

export function createFakeHands({ startResult = { ok: true }, stopped = 1 } = {}) {
  const started = []; // exactly what start() received
  const stops = [];
  const gate = { block: null };
  return {
    started, stops, gate,
    async start(arg) {
      started.push(arg);
      if (gate.block) await gate.block;
      return typeof startResult === 'function' ? startResult(arg) : startResult;
    },
    async stopAll() { stops.push(Date.now()); return stopped; },
  };
}

export const TARGETS = Object.freeze([{ computerId: 'pc-01', label: 'Alpha PC' }, { computerId: 'pc-02', label: 'Beta PC' }]);
