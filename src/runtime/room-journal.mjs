// Room journal (spec/room.md §3 part C): an in-memory ring buffer of ledger entries.
// Loop events never carry typed text, key names or screen data; only the fields listed below are copied, so
// anything else a future event carries is dropped here again.
import { cleanParams, cleanText, validLedgerEntry, HAND_OUTCOMES, MAX_NOTE, MAX_TEXT } from './room-contract.mjs';

/** @param {{max?: number, now?: () => number}} [options] */
export function createRoomJournal({ max = 500, now = Date.now } = {}) {
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('journal max must be a positive integer');
  /** @type {object[]} */
  let entries = [];
  let seq = 0;
  /** vmId -> the name of the last action that VM's hands ran ('' until one ran). */
  const lastAction = new Map();

  /** @param {{vmId?: string|null, actor: string, code: string, params?: object}} input */
  function record({ vmId = null, actor, code, params }) {
    const entry = Object.freeze({ seq: seq + 1, at: now(), vmId, actor, code, params: Object.freeze(cleanParams(params)) });
    if (!validLedgerEntry(entry)) throw new TypeError(`invalid ledger entry: ${String(code)}`);
    seq = entry.seq;
    entries = entries.length >= max ? [...entries.slice(entries.length - max + 1), entry] : [...entries, entry];
    return entry;
  }

  /** @param {string} vmId @param {any} ev */
  function recordFleetEvent(vmId, ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (ev.type === 'action') {
      if (typeof ev.action === 'string') lastAction.set(vmId, cleanText(ev.action, 32));
      return null;
    }
    if (ev.type === 'step') {
      return record({ vmId, actor: 'hands', code: 'hands_step', params: {
        step: num(ev.step), usd: num(ev.usd), action: lastAction.get(vmId) ?? '', note: cleanText(ev.note, MAX_NOTE),
      } });
    }
    if (ev.type === 'end') {
      lastAction.delete(vmId);
      return record({ vmId, actor: 'hands', code: 'hands_ended', params: {
        outcome: HAND_OUTCOMES.includes(ev.outcome) ? ev.outcome : 'error', claim: cleanText(ev.claim, MAX_TEXT), steps: num(ev.steps), usd: num(ev.usd),
      } });
    }
    return null;
  }

  return {
    record,
    recordFleetEvent,
    since: (/** @type {number} */ after) => entries.filter((e) => e.seq > after),
    all: () => [...entries],
    lastSeq: () => seq,
  };
}

const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
