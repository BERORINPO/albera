// Decision cards (part D): who it is for, the question, an optional before / after figure, and the choices.
// The first choice is the primary button. A card answers once: after a choice every button is disabled.
// A DONE claim is shown as a claim, with a note that nobody has checked it.
import { cardKey, choiceKey } from './words-bero.mjs';

export const CARD_SIZE = Object.freeze({ w: 300, h: 220 });
export const CLOSE_MS = 450;
const CLAIM_CARDS = new Set(['claimed_done', 'claimed_failed']);

export const nodeIdOf = (cardId) => `card:${cardId}`;

/** One answer per card: the first call wins, later calls (and unknown choices) are refused. */
export function createAnswerGate() {
  const answered = new Set();
  return Object.freeze({
    take(card, choiceId) {
      if (!card || answered.has(card.cardId) || !card.choices.some((c) => c.choiceId === choiceId)) return false;
      answered.add(card.cardId);
      return true;
    },
    answered: (cardId) => answered.has(cardId),
    release: (cardId) => answered.delete(cardId),
  });
}

/** Keeps a card from landing on Bero: if the spot overlaps `other`, it moves just below it. */
export function avoidRect(spot, size, other, gap = 12) {
  if (!other) return spot;
  const overlap = spot.x < other.x + other.w && spot.x + size.w > other.x && spot.y < other.y + other.h && spot.y + size.h > other.y;
  return overlap ? { x: spot.x, y: other.y + other.h + gap } : spot;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** figureWords / labelOf are optional: without them the card figure uses Bero's words and VM ids. */
export function createCards(canvas, { words, figureWords, renderFigure, frameUrl, labelOf, onChoose } = {}) {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t = (code, params) => (words ? words.t(code, params) : code);
  const open = new Map(); // cardId -> { card, root, buttons }
  const gate = createAnswerGate();

  function build(card) {
    const root = el('section', 'bero-card');
    root.setAttribute('role', 'group');
    root.append(el('div', 'bero-card-for', t('bero.ui.for', card.params)));
    const q = el('p', 'bero-card-q', t(cardKey(card.code), card.params));
    root.append(q);
    root.setAttribute('aria-label', q.textContent);
    if (CLAIM_CARDS.has(card.code)) {
      if (card.params.claim) root.append(el('blockquote', 'bero-card-claim', card.params.claim));
      root.append(el('div', 'bero-card-note', t('bero.ui.claim_note')));
    }
    if (card.figure && typeof renderFigure === 'function') {
      const fig = renderFigure(card.figure, { words: figureWords ?? words, frameUrl, labelOf });
      if (fig) root.append(fig);
    }
    const row = el('div', 'bero-card-choices');
    const buttons = card.choices.map((choice, i) => {
      const b = el('button', i === 0 ? 'primary' : '', t(choiceKey(choice.code)));
      b.type = 'button';
      b.dataset.choice = choice.choiceId;
      b.addEventListener('click', () => choose(card.cardId, choice.choiceId));
      row.append(b);
      return b;
    });
    root.append(row);
    return { root, buttons };
  }

  function openCard(card) {
    if (!card || open.has(card.cardId)) return;
    const { root, buttons } = build(card);
    open.set(card.cardId, { card, root, buttons });
    const at = avoidRect(canvas.freeSpot(`cam:${card.vmId}`, CARD_SIZE), CARD_SIZE, canvas.rectOf('bero'));
    canvas.place(nodeIdOf(card.cardId), root, at);
    if (reduced) root.classList.add('in');
    else requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('in')));
  }

  /** Answers a card (from its buttons or from Bero's chips). Returns false when it was already answered. */
  function choose(cardId, choiceId) {
    const entry = open.get(cardId);
    if (!entry || !gate.take(entry.card, choiceId)) return false;
    for (const b of entry.buttons) {
      b.disabled = true;
      if (b.dataset.choice === choiceId) b.classList.add('on');
    }
    entry.root.classList.add('answered');
    const sent = onChoose?.(cardId, choiceId);
    // If sending fails (onChoose rejects or resolves false), the card can be answered again.
    if (sent && typeof sent.then === 'function') sent.then((ok) => { if (ok === false) reopen(entry); }, () => reopen(entry));
    return true;
  }

  function reopen(entry) {
    if (open.get(entry.card.cardId) !== entry) return;
    gate.release(entry.card.cardId);
    entry.root.classList.remove('answered');
    for (const b of entry.buttons) { b.disabled = false; b.classList.remove('on'); }
  }

  function close(cardId) {
    const entry = open.get(cardId);
    if (!entry) return;
    open.delete(cardId);
    for (const b of entry.buttons) b.disabled = true;
    entry.root.classList.remove('in');
    setTimeout(() => canvas.remove(nodeIdOf(cardId)), reduced ? 0 : CLOSE_MS);
  }

  const get = (cardId) => open.get(cardId)?.card ?? null;

  return Object.freeze({ open: openCard, close, choose, get });
}
