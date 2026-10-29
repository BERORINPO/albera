// Bero, the main AI of the control room (spec/room.md §3 part D). Rules + dictionaries, no LLM.
// Pure: no node: imports, no clock, no I/O. Time comes in as `now`; figures come from the injected buildFigure (part C).
// One situation (a "story") is told at a time: its acts are emitted together in one tick, the rest wait in a queue.
import { cleanParams, validAct, validCard, validLedgerEntry } from './room-contract.mjs';

/** What each card offers. The first choice is the primary button. Choice codes are D's own (words in room-ui/words-bero.mjs). */
export const CARD_CHOICES = Object.freeze({
  stalled: [['close_it', 'nudge'], ['stop_it', 'stop'], ['later', 'dismiss']],
  claimed_done: [['check_again', 'recheck'], ['mark_done', 'accept'], ['later', 'dismiss']],
  claimed_failed: [['check_again', 'recheck'], ['noted', 'accept'], ['later', 'dismiss']],
  limit_reached: [['check_again', 'recheck'], ['noted', 'accept'], ['later', 'dismiss']],
  error: [['check_again', 'recheck'], ['later', 'dismiss']],
});
export const CHOICE_CODES = Object.freeze([...new Set(Object.values(CARD_CHOICES).flat().map(([code]) => code))]);

const ENDED_CARDS = new Set(['claimed_done', 'claimed_failed', 'limit_reached', 'error']);
const RUN_EFFECTS = new Set(['stop', 'nudge', 'recheck']);
const PER_VM_ENTRIES = 60;
const RECENT_ENTRIES = 80;
const CLOSED_KEPT = 200;
const PATROL_MAX_CAMS = 4;

/** Choice ids are ids (no underscore allowed), so `close_it` becomes `close-it`. */
export const choiceIdOf = (code) => code.replace(/_/g, '-');

export function createBeroDirector({
  buildFigure,
  stallMs = 45_000,
  patrolMs = 20_000,
  labelOf = (vmId) => vmId,
  storyGapMs = 6_000,
  progressEvery = 8,
  progressMinMs = 60_000,
  summaryQuietMs = 10_000,
} = {}) {
  if (typeof buildFigure !== 'function') throw new TypeError('buildFigure is required');
  const open = new Map(); // cardId -> card (one per VM at most)
  const closed = [];
  const queue = []; // waiting situations, FIFO; replies jump ahead
  const vmEntries = new Map(); // vmId -> recent ledger entries
  const recent = [];
  const stepsSinceFigure = new Map();
  const lastProgressAt = new Map(); // vmId -> when its last flow figure was drawn
  const noticedStall = new Map(); // vmId -> lastActionAt already told
  const snoozeUntil = new Map(); // vmId -> no stall notice before this time
  let seq = 0;
  let lastStoryAt = null;
  let idleSince = null; // patrol counts from here
  let choicesSinceSummary = 0;
  let lastChoiceAt = null;

  const nextId = (prefix) => `${prefix}-${++seq}`;
  const cam = (vmId) => String(labelOf(vmId) ?? vmId);
  const cardFor = (vmId) => [...open.values()].find((c) => c.vmId === vmId) ?? null;
  const queued = (pred) => queue.some(pred);
  const entriesOf = (vmId) => [...(vmEntries.get(vmId) ?? [])];

  function remember(entry) {
    push(recent, entry, RECENT_ENTRIES);
    if (entry.vmId === null) return;
    if (!vmEntries.has(entry.vmId)) vmEntries.set(entry.vmId, []);
    push(vmEntries.get(entry.vmId), entry, PER_VM_ENTRIES);
    if (entry.code === 'hands_step') stepsSinceFigure.set(entry.vmId, (stepsSinceFigure.get(entry.vmId) ?? 0) + 1);
    if (entry.code === 'hands_started') stepsSinceFigure.set(entry.vmId, 0);
    if (entry.code !== 'hands_ended') return;
    // The run is over: a stall story still waiting for it is no longer true.
    noticedStall.delete(entry.vmId);
    stepsSinceFigure.set(entry.vmId, 0);
    for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i].kind === 'stall' && queue[i].vmId === entry.vmId) queue.splice(i, 1);
    const outcome = entry.params?.outcome;
    if (ENDED_CARDS.has(outcome) && !queued((s) => s.entrySeq === entry.seq)) {
      queue.push({ kind: 'ended', code: outcome, vmId: entry.vmId, entrySeq: entry.seq, params: entry.params });
    }
  }

  function noticeStalls(now, agents) {
    for (const [vmId, a] of Object.entries(agents ?? {})) {
      if (!a || a.state !== 'running' || !Number.isFinite(a.lastActionAt)) continue;
      if (now - a.lastActionAt < stallMs || (snoozeUntil.get(vmId) ?? -Infinity) > now) continue;
      if (noticedStall.get(vmId) === a.lastActionAt || cardFor(vmId) || queued((s) => s.vmId === vmId && s.kind === 'stall')) continue;
      noticedStall.set(vmId, a.lastActionAt);
      queue.push({ kind: 'stall', code: 'stalled', vmId, since: a.lastActionAt });
    }
  }

  function openCard(vmId, code, params, figure, now) {
    const card = {
      cardId: nextId('card'), vmId, code, params: cleanParams(params), figure: figure ?? null, openedAt: now,
      choices: CARD_CHOICES[code].map(([c, effect]) => ({ choiceId: choiceIdOf(c), code: c, effect })),
    };
    if (!validCard(card)) return null;
    open.set(card.cardId, card);
    return card;
  }

  function cardStory(s, now) {
    let params;
    let figure = null;
    const ledger = [];
    if (s.kind === 'stall') {
      const seconds = Math.max(1, Math.round((now - s.since) / 1000));
      params = { cam: cam(s.vmId), seconds };
      figure = buildFigure('ba', entriesOf(s.vmId), { vmId: s.vmId, figureId: nextId('fig'), frames: { before: null, after: null } });
      ledger.push(line(s.vmId, 'hands_stalled', { seconds }));
    } else {
      const p = s.params ?? {};
      params = { cam: cam(s.vmId), claim: p.claim ?? '', steps: num(p.steps), usd: num(p.usd) };
    }
    const card = openCard(s.vmId, s.code, params, figure, now);
    if (!card) return null;
    ledger.push(line(s.vmId, 'bero_noticed', { what: s.code }), line(s.vmId, 'bero_card', { cardCode: s.code }));
    const acts = [
      { type: 'look', at: { vmId: s.vmId } },
      { type: 'move', to: { vmId: s.vmId } },
      { type: 'point', vmId: s.vmId },
      { type: 'say', code: s.code, params: card.params, cardId: card.cardId },
      { type: 'card', card },
    ];
    return { acts, ledger };
  }

  function replyStory(s) {
    const code = RUN_EFFECTS.has(s.effect) ? 'doing_it' : 'thanks';
    return { acts: [{ type: 'say', code, params: { cam: cam(s.vmId) }, cardId: null }], ledger: [] };
  }

  /** Rare on purpose: only with no card open anywhere, and at most once per progressMinMs per VM. */
  function progressStory(now) {
    if (open.size > 0) return null;
    let best = null;
    for (const [vmId, n] of stepsSinceFigure) {
      if (n < progressEvery || now - (lastProgressAt.get(vmId) ?? -Infinity) < progressMinMs) continue;
      if (!best || n > best.n) best = { vmId, n };
    }
    if (!best) return null;
    stepsSinceFigure.set(best.vmId, 0);
    lastProgressAt.set(best.vmId, now);
    const figure = buildFigure('flow', entriesOf(best.vmId), { vmId: best.vmId, figureId: nextId('fig') });
    if (!figure) return null;
    return {
      acts: [
        { type: 'look', at: { vmId: best.vmId } },
        { type: 'move', to: { vmId: best.vmId } },
        { type: 'say', code: 'progress', params: { cam: cam(best.vmId), steps: best.n }, cardId: null },
        { type: 'figure', figure, near: { vmId: best.vmId } },
      ],
      ledger: [line(best.vmId, 'bero_figure', { kind: 'flow' })],
    };
  }

  function summaryStory(now) {
    if (choicesSinceSummary < 1 || lastChoiceAt === null || now - lastChoiceAt < summaryQuietMs) return null;
    const count = choicesSinceSummary;
    choicesSinceSummary = 0;
    const figure = buildFigure('who', [...recent], { vmId: null, figureId: nextId('fig') });
    if (!figure) return null;
    return {
      acts: [
        { type: 'hush' },
        { type: 'look', at: 'all' },
        { type: 'figure', figure, near: null },
        { type: 'move', to: { figureId: figure.figureId } },
        { type: 'say', code: 'summary', params: { count }, cardId: null },
      ],
      ledger: [line(null, 'bero_figure', { kind: 'who' })],
    };
  }

  /** Looks around without words: running cameras first, at most four. */
  function patrolStory(agents) {
    const ids = Object.keys(agents ?? {}).filter((id) => agents[id]);
    if (ids.length === 0) return null;
    const ordered = [...ids.filter((id) => agents[id].state === 'running'), ...ids.filter((id) => agents[id].state !== 'running')];
    const points = ordered.slice(0, PATROL_MAX_CAMS).map((vmId) => ({ type: 'point', vmId }));
    return { acts: [{ type: 'hush' }, { type: 'look', at: 'all' }, ...points], ledger: [] };
  }

  /** Replies first, then waiting cards (FIFO, skipping VMs that still have an open card), then figures, then patrol. */
  function nextStory(now, agents) {
    const r = queue.findIndex((s) => s.kind === 'reply');
    if (r >= 0) return replyStory(queue.splice(r, 1)[0]);
    if (now - lastStoryAt < storyGapMs) return null;
    for (let i = 0; i < queue.length; i += 1) {
      if (cardFor(queue[i].vmId)) continue;
      const story = cardStory(queue.splice(i, 1)[0], now);
      if (story) return story;
      i -= 1;
    }
    const nothingWaiting = queue.length === 0;
    if (nothingWaiting && now - lastStoryAt >= storyGapMs * 2) {
      const told = summaryStory(now) ?? progressStory(now);
      if (told) return told;
    }
    if (now - idleSince >= patrolMs) return patrolStory(agents);
    return null;
  }

  function tick({ now, agents = {}, entries = [] } = {}) {
    if (!Number.isFinite(now)) throw new TypeError('now must be a number');
    for (const e of Array.isArray(entries) ? entries : []) if (validLedgerEntry(e)) remember(e);
    noticeStalls(now, agents);
    if (lastStoryAt === null) {
      lastStoryAt = now - storyGapMs; // a card may open at once
      idleSince = now; // patrol waits a full patrolMs
    }
    const story = nextStory(now, agents);
    if (!story) return { acts: [], ledger: [] };
    lastStoryAt = now;
    idleSince = now;
    return { acts: story.acts.filter(validAct), ledger: story.ledger };
  }

  function decide(cardId, choiceId, now) {
    const card = open.get(cardId);
    if (!card) return { ok: false, code: closed.includes(cardId) ? 'card_closed' : 'card_unknown' };
    const choice = card.choices.find((c) => c.choiceId === choiceId);
    if (!choice) return { ok: false, code: 'choice_unknown' };
    open.delete(cardId);
    push(closed, cardId, CLOSED_KEPT);
    const at = Number.isFinite(now) ? now : (lastChoiceAt ?? 0);
    if (card.code === 'stalled') {
      snoozeUntil.set(card.vmId, at + stallMs); // "later" (or any answer) means: do not ask again right away
      noticedStall.delete(card.vmId);
    }
    choicesSinceSummary += 1;
    lastChoiceAt = at;
    queue.unshift({ kind: 'reply', vmId: card.vmId, effect: choice.effect });
    const effect = { effect: choice.effect, vmId: card.vmId, cardId, choiceId };
    const params = { cardCode: card.code, choiceCode: choice.code, effect: choice.effect };
    return { ok: true, effect, ledger: [{ vmId: card.vmId, actor: 'human', code: 'human_choice', params }] };
  }

  const openCards = () => [...open.values()].map((c) => ({ ...c, params: { ...c.params }, choices: c.choices.map((x) => ({ ...x })) }));

  return Object.freeze({ tick, decide, openCards });
}

function push(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}
const line = (vmId, code, params) => ({ vmId, actor: 'bero', code, params });
const num = (v) => (Number.isFinite(v) ? v : 0);
