// Small in-memory board of what each VM's AI is doing, fed by desktop-agent-loop's onEvent.
// It copies only allowed fields: typed text, key names and screen data are never kept (the loop
// does not emit them; this board refuses them again). Nothing is written to disk or the network.
const MAX_CLAIM_LENGTH = 200;
const MAX_VMS = 16;
const VM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_RE = /^[a-z_]{1,32}$/;
const OUTCOME_RE = /^[a-z_]{1,32}$/;

const fresh = () => ({ state: 'idle', step: 0, actions: 0, usd: 0, cursor: null, lastAction: null, outcome: null, claim: '' });

const count = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback);
const usdOf = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
const cursorOf = (value, fallback) => (Array.isArray(value) && value.length === 2 && value.every((n) => Number.isSafeInteger(n) && n >= 0) ? [value[0], value[1]] : fallback);
const claimOf = (value) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_CLAIM_LENGTH) : '');

export function createAgentStatusBoard() {
  const entries = new Map();

  function record(vmId, event) {
    if (typeof vmId !== 'string' || !VM_RE.test(vmId) || typeof event !== 'object' || event === null) return;
    if (!entries.has(vmId) && entries.size >= MAX_VMS) return;
    const prev = entries.get(vmId) ?? fresh();
    let next = prev;
    if (event.type === 'step') {
      next = { ...prev, state: 'running', step: count(event.step, prev.step), usd: usdOf(event.usd, prev.usd) };
    } else if (event.type === 'action') {
      const lastAction = typeof event.action === 'string' && ACTION_RE.test(event.action) ? event.action : prev.lastAction;
      next = { ...prev, state: 'running', actions: prev.actions + 1, lastAction, cursor: cursorOf(event.cursor, prev.cursor) };
    } else if (event.type === 'end') {
      next = {
        ...prev, state: 'done', step: count(event.steps, prev.step), actions: count(event.actions, prev.actions), usd: usdOf(event.usd, prev.usd),
        outcome: typeof event.outcome === 'string' && OUTCOME_RE.test(event.outcome) ? event.outcome : 'error', claim: claimOf(event.claim),
      };
    }
    entries.set(vmId, next);
  }

  /** A fresh copy: callers cannot change the board through it. */
  function snapshot() {
    return Object.fromEntries([...entries].map(([vmId, e]) => [vmId, { ...e, cursor: e.cursor ? [...e.cursor] : null }]));
  }

  return Object.freeze({ record, snapshot });
}
