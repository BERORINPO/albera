// Contract for the ALBERA control room (spec/room.md). Pure: no I/O, no clock, no process.
// Every part (A canvas, B cameras + host, C journal + figures, D Bero) builds on these shapes only.
// Words never travel on the wire: everything carries a code + params, and each UI part owns the words for its codes.

export const MAX_TEXT = 200;
export const MAX_NOTE = 160;
export const MAX_FIGURE_ROWS = 8;
export const MAX_CHOICES = 3;

/** Who did something. `hands` = a computer-use agent loop, `bero` = the main AI, `human` = the person. */
export const ACTORS = Object.freeze(['hands', 'bero', 'human']);

/** Journal / ledger codes (owner of the words: C, room-ui/words-figure.mjs). Params per code in spec/room.md §4. */
export const LEDGER_CODES = Object.freeze([
  'hands_started', 'hands_step', 'hands_ended', 'hands_stalled',
  'bero_noticed', 'bero_figure', 'bero_card',
  'human_choice',
]);

/** Outcomes copied from desktop-agent-loop (never a verdict: claimed_* are claims). */
export const HAND_OUTCOMES = Object.freeze(['claimed_done', 'claimed_failed', 'limit_reached', 'stopped', 'refused', 'error']);

/** Bero speech codes (owner of the words: D, room-ui/words-bero.mjs). */
export const SAY_CODES = Object.freeze(['patrol', 'stalled', 'claimed_done', 'claimed_failed', 'limit_reached', 'error', 'progress', 'summary', 'ask', 'doing_it', 'thanks']);

/** Decision card codes and what a choice does (owner of the words: D). Effects are executed by the host (B). */
export const CARD_CODES = Object.freeze(['stalled', 'claimed_done', 'claimed_failed', 'limit_reached', 'error']);
export const EFFECTS = Object.freeze(['stop', 'nudge', 'recheck', 'accept', 'dismiss']);

/** Figures (owner of the words and drawing: C). */
export const FIGURE_KINDS = Object.freeze(['flow', 'who', 'ba']);
export const STEP_STATES = Object.freeze(['done', 'now']);

/** Bero's acts, played in order by room-ui/bero.mjs (D). */
export const ACT_TYPES = Object.freeze(['look', 'move', 'point', 'say', 'hush', 'figure', 'card']);

/** Events on GET /room/api/state, in seq order. */
export const EVENT_KINDS = Object.freeze(['bero', 'ledger', 'card_closed']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;

export const isId = (v) => typeof v === 'string' && ID_RE.test(v);
export const isCode = (v, list) => typeof v === 'string' && CODE_RE.test(v) && (!list || list.includes(v));

/** Untrusted text (AI notes, AI claims, task text) is cut, and control characters are removed. */
export function cleanText(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

/** Params are flat: string (cleaned) or finite number. Anything else is dropped. */
export function cleanParams(params) {
  const out = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
  for (const [key, value] of Object.entries(params).slice(0, 12)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string') out[key] = cleanText(value);
  }
  return out;
}

/**
 * @typedef {{seq: number, at: number, vmId: string|null, actor: 'hands'|'bero'|'human', code: string, params: object}} LedgerEntry
 *   `at` is epoch ms from the host clock. `seq` grows by 1 per entry (assigned by room-journal).
 */
export function validLedgerEntry(e) {
  return Boolean(e) && Number.isSafeInteger(e.seq) && e.seq > 0 && Number.isFinite(e.at)
    && (e.vmId === null || isId(e.vmId)) && ACTORS.includes(e.actor) && isCode(e.code, LEDGER_CODES)
    && e.params && typeof e.params === 'object';
}

/**
 * @typedef {{label: string, state: 'done'|'now', source: number}} FlowStep
 * @typedef {{from: 'hands'|'bero'|'human', to: 'hands'|'bero'|'human', code: string, params: object, source: number}} WhoRow
 * @typedef {{
 *   figureId: string, kind: 'flow'|'who'|'ba', vmId: string|null,
 *   steps?: FlowStep[], rows?: WhoRow[],
 *   before?: {frameId: string|null}, after?: {frameId: string|null},
 *   sources: LedgerEntry[]
 * }} FigureSpec
 *   flow: the last steps of one VM's hands (label = the AI's own note, cut to 40 chars, or the action name).
 *   who:  who asked whom what, from ledger entries (at most 8 rows).
 *   ba:   two pinned frames of one VM (before the choice / after the effect). frameId null = not taken yet.
 *   sources: the ledger entries the figure was built from (shown under it, max 4).
 */
export function validFigure(f) {
  if (!f || !isId(f.figureId) || !FIGURE_KINDS.includes(f.kind) || !(f.vmId === null || isId(f.vmId))) return false;
  if (!Array.isArray(f.sources) || f.sources.length > 4 || !f.sources.every(validLedgerEntry)) return false;
  if (f.kind === 'flow') return Array.isArray(f.steps) && f.steps.length > 0 && f.steps.length <= MAX_FIGURE_ROWS
    && f.steps.every((s) => typeof s.label === 'string' && s.label.length <= 40 && STEP_STATES.includes(s.state) && Number.isSafeInteger(s.source));
  if (f.kind === 'who') return Array.isArray(f.rows) && f.rows.length > 0 && f.rows.length <= MAX_FIGURE_ROWS
    && f.rows.every((r) => ACTORS.includes(r.from) && ACTORS.includes(r.to) && isCode(r.code, LEDGER_CODES) && Number.isSafeInteger(r.source));
  return isId(f.vmId) && f.before && (f.before.frameId === null || isId(f.before.frameId))
    && f.after && (f.after.frameId === null || isId(f.after.frameId));
}

/**
 * @typedef {{choiceId: string, code: string, effect: 'stop'|'nudge'|'recheck'|'accept'|'dismiss'}} Choice
 * @typedef {{cardId: string, vmId: string, code: string, params: object, choices: Choice[], figure: FigureSpec|null, openedAt: number}} DecisionCard
 *   nudge   = start a short hands job: "something may be blocking the screen; close or answer it, then reply DONE"
 *   recheck = start a short hands job: "look at the screen and say whether <the task> is really done"
 *   stop    = stop the hands on that VM.  accept / dismiss = ledger only, nothing runs.
 */
export function validCard(c) {
  return Boolean(c) && isId(c.cardId) && isId(c.vmId) && isCode(c.code, CARD_CODES) && c.params && typeof c.params === 'object'
    && Array.isArray(c.choices) && c.choices.length > 0 && c.choices.length <= MAX_CHOICES
    && c.choices.every((x) => isId(x.choiceId) && isCode(x.code) && EFFECTS.includes(x.effect))
    && (c.figure === null || validFigure(c.figure)) && Number.isFinite(c.openedAt);
}

/**
 * @typedef {{type: 'look', at: {vmId: string}|'all'}
 *  | {type: 'move', to: {vmId: string}|{figureId: string}|'home'}
 *  | {type: 'point', vmId: string}
 *  | {type: 'say', code: string, params: object, cardId: string|null}
 *  | {type: 'hush'}
 *  | {type: 'figure', figure: FigureSpec, near: {vmId: string}|null}
 *  | {type: 'card', card: DecisionCard}} BeroAct
 *   say.cardId: the chips under the bubble are that card's choices (clicking one = choosing on the card).
 */
export function validAct(a) {
  if (!a || !ACT_TYPES.includes(a.type)) return false;
  switch (a.type) {
    case 'look': return a.at === 'all' || isId(a.at?.vmId);
    case 'move': return a.to === 'home' || isId(a.to?.vmId) || isId(a.to?.figureId);
    case 'point': return isId(a.vmId);
    case 'say': return isCode(a.code, SAY_CODES) && a.params && typeof a.params === 'object' && (a.cardId === null || isId(a.cardId));
    case 'hush': return true;
    case 'figure': return validFigure(a.figure) && (a.near === null || isId(a.near?.vmId));
    case 'card': return validCard(a.card);
    default: return false;
  }
}

/**
 * @typedef {{seq: number, kind: 'bero', act: BeroAct}
 *  | {seq: number, kind: 'ledger', entry: LedgerEntry}
 *  | {seq: number, kind: 'card_closed', cardId: string, choiceId: string|null}} RoomEvent
 *   Event seq is the host's own counter (not the ledger seq).
 */
export function validEvent(ev) {
  if (!ev || !Number.isSafeInteger(ev.seq) || ev.seq < 1 || !EVENT_KINDS.includes(ev.kind)) return false;
  if (ev.kind === 'bero') return validAct(ev.act);
  if (ev.kind === 'ledger') return validLedgerEntry(ev.entry);
  return isId(ev.cardId) && (ev.choiceId === null || isId(ev.choiceId));
}

/**
 * Director tick result (D -> host B).
 * @typedef {{acts: BeroAct[], ledger: {vmId: string|null, actor: 'bero', code: string, params: object}[]}} DirectorOutput
 * Effect asked by a choice (D -> host B).
 * @typedef {{effect: 'stop'|'nudge'|'recheck'|'accept'|'dismiss', vmId: string, cardId: string, choiceId: string}} Effect
 */
