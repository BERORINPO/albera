// Figures built from the ledger (spec/room.md §3 part C, §6 figures-from-log). Pure: no I/O, no clock.
// A figure only shows what ledger entries and pinned frames say, and always carries the entries it came from.
import { validFigure, MAX_FIGURE_ROWS } from './room-contract.mjs';

export const FLOW_STEPS = 5;
export const MAX_LABEL = 40;
export const MAX_SOURCES = 4;
const BA_SOURCE_CODES = ['bero_card', 'human_choice', 'hands_ended', 'hands_stalled'];
/** Effects that make Bero start or stop the hands (the "resulting job" row of a `who` figure). */
const JOB_EFFECTS = ['stop', 'nudge', 'recheck'];

/** Cut a label to `max` chars; a cut label ends with an ellipsis. @param {string} text */
export function cutLabel(text, max = MAX_LABEL) {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * @param {'flow'|'who'|'ba'} kind
 * @param {object[]} entries ledger entries, oldest first
 * @param {{vmId?: string|null, figureId: string, frames?: {before?: string|null, after?: string|null}}} options
 * @returns {object|null} a FigureSpec that passes validFigure, or null when there is not enough to draw
 */
export function buildFigure(kind, entries, { vmId = null, figureId, frames = {} }) {
  const list = Array.isArray(entries) ? [...entries].sort((a, b) => a.seq - b.seq) : [];
  const build = BUILDERS[kind];
  if (!build) return null;
  const body = build(list, vmId, frames ?? {});
  if (!body) return null;
  const spec = { figureId, kind, vmId, ...body };
  return validFigure(spec) ? spec : null;
}

const BUILDERS = {
  /** The last steps of one VM's hands; the newest is `now`. */
  flow(list, vmId) {
    if (!vmId) return null;
    const used = list.filter((e) => e.vmId === vmId && e.code === 'hands_step').slice(-FLOW_STEPS);
    if (used.length === 0) return null;
    const steps = used.map((e, i) => ({ label: stepLabel(e.params), state: i === used.length - 1 ? 'now' : 'done', source: e.seq }));
    return { steps, sources: used.slice(-MAX_SOURCES) };
  },

  /** Who asked whom what (lanes: human / bero / hands). */
  who(list, vmId) {
    const rows = [];
    for (const e of list) {
      if (vmId && e.vmId !== vmId) continue;
      rows.push(...whoRows(e));
    }
    const shown = rows.slice(-MAX_FIGURE_ROWS);
    if (shown.length === 0) return null;
    const seqs = [...new Set(shown.map((r) => r.source))].slice(-MAX_SOURCES);
    const bySeq = new Map(list.map((e) => [e.seq, e]));
    return { rows: shown, sources: seqs.map((s) => bySeq.get(s)) };
  },

  /** Two pinned frames of one VM; `after` may not be taken yet. */
  ba(list, vmId, frames) {
    if (!vmId || !frames.before) return null;
    const sources = list.filter((e) => e.vmId === vmId && BA_SOURCE_CODES.includes(e.code)).slice(-MAX_SOURCES);
    return { before: { frameId: frames.before }, after: { frameId: frames.after ?? null }, sources };
  },
};

/** @param {any} p hands_step params */
function stepLabel(p) {
  const note = cutLabel(p?.note);
  if (note) return note;
  const action = cutLabel(p?.action);
  if (action) return action;
  return Number.isFinite(p?.step) ? `#${p.step}` : '#';
}

/** The rows one ledger entry adds to a `who` figure (oldest first). @param {any} e */
export function whoRows(e) {
  const row = (from, to, params = e.params) => ({ from, to, code: e.code, params, source: e.seq });
  switch (e.code) {
    case 'hands_stalled': return [row('hands', 'bero')];
    case 'hands_ended': return [row('hands', 'bero')];
    case 'bero_noticed': return [row('bero', 'bero')];
    case 'bero_card': return [row('bero', 'human')];
    case 'human_choice': {
      const rows = [row('human', 'bero')];
      if (JOB_EFFECTS.includes(e.params?.effect)) rows.push(row('bero', 'hands', { effect: e.params.effect }));
      return rows;
    }
    default: return [];
  }
}
