// Bero's avatar (part D): a floating orb with eyes that look toward what it talks about. It glides over the canvas,
// points at cameras, types one line with chips, places figures and opens cards. Motion copies the v08b mock.
// Text goes in through textContent only. Positions use the CSSOM (no inline style attributes in HTML).
import { sayKey, choiceKey } from './words-bero.mjs';

export const NODE_ID = 'bero';
export const BERO_SIZE = Object.freeze({ w: 360, h: 150 }); // orb + bubble, used to ask the canvas for a free spot
export const HOME = Object.freeze({ x: 24, y: 24 });
export const CHAR_MS = 38;
export const PAUSE_MS = 160;
export const MAX_TYPING_MS = 3600;
export const GLIDE_MS = 1400;
export const POINT_MS = 1800;
const EYE_MAX = 3;
const PAUSE_CHARS = new Set(['。', '、', '.', ',', '?', '!', '?', '!']);

/** Delays (ms) before each character appears. Punctuation waits longer; long lines speed up so the whole line stays under MAX_TYPING_MS. */
export function typingSchedule(text, { reduced = false } = {}) {
  const chars = [...String(text)];
  if (reduced) return chars.map(() => 0);
  const raw = chars.map((c) => (PAUSE_CHARS.has(c) ? PAUSE_MS : CHAR_MS));
  const total = raw.reduce((a, b) => a + b, 0);
  const k = total > MAX_TYPING_MS ? MAX_TYPING_MS / total : 1;
  return raw.map((ms) => Math.round(ms * k));
}

/** Eyes shift toward the target, at most EYE_MAX px each way. */
export function eyeOffset(from, to) {
  if (!from || !to) return { dx: 0, dy: 0 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { dx: 0, dy: 0 };
  return { dx: Math.round((dx / len) * EYE_MAX), dy: Math.round((dy / len) * EYE_MAX) };
}

/** The bubble opens to the right of the orb unless that would leave the world; then it opens to the left. */
export function bubbleSide(pos, { worldW = Infinity, bubbleW = BERO_SIZE.w } = {}) {
  return pos.x + bubbleW > worldW && pos.x - bubbleW >= 0 ? 'left' : 'right';
}

/** Glide time grows with distance, between 600 ms and GLIDE_MS; reduced motion moves at once. */
export function glideMs(from, to, { reduced = false } = {}) {
  if (reduced || !from || !to) return 0;
  return Math.round(Math.min(GLIDE_MS, Math.max(600, Math.hypot(to.x - from.x, to.y - from.y) * 1.6)));
}

/** One figure per camera (and one summary): a figure's slot is its VM, or 'all'. */
export const figureSlot = (spec, near) => near?.vmId ?? spec?.vmId ?? 'all';
const centerOf = (r) => (r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null);
const targetNode = (to) => (to?.vmId ? `cam:${to.vmId}` : to?.figureId ? `fig:${to.figureId}` : null);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** frameUrl / labelOf are optional and passed on to renderFigure; figure words fall back to Bero's words. */
export function createBero(canvas, { words, figureWords, renderFigure, cards, frameUrl, labelOf } = {}) {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduced ? Math.min(ms, 60) : ms));
  const t = (code, params) => (words ? words.t(code, params) : code);

  const root = el('div', 'bero');
  const orb = el('div', 'bero-orb');
  const eyes = el('div', 'bero-eyes');
  eyes.append(el('i'), el('i'));
  orb.append(eyes);
  const bubble = el('div', 'bero-bubble hide');
  const name = el('div', 'bero-name', t('bero.ui.name'));
  const wave = el('span', 'bero-wave');
  for (let i = 0; i < 4; i += 1) wave.append(el('i'));
  name.append(wave);
  const text = el('div', 'bero-text');
  const chips = el('div', 'bero-chips');
  bubble.append(name, text, chips);
  root.append(orb, bubble);
  if (reduced) root.classList.add('reduced');

  let pos = { ...HOME };
  let sayingCard = null; // cardId whose choices belong under the bubble
  const pointed = []; // wires and glows from Bero: removed when it moves on or hushes
  const figures = new Map(); // slot (vmId, or 'all' for the summary) -> nodeId: one figure per slot
  canvas.place(NODE_ID, root, pos);

  function lookToward(point) {
    const { dx, dy } = eyeOffset({ x: pos.x + 23, y: pos.y + 23 }, point);
    eyes.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  async function glide(to) {
    const ms = glideMs(pos, to, { reduced });
    root.style.setProperty('--bero-glide', `${ms}ms`);
    const worldW = canvas.world?.scrollWidth || Infinity;
    root.classList.toggle('left', bubbleSide(to, { worldW }) === 'left');
    pos = { x: Math.round(to.x), y: Math.round(to.y) };
    canvas.place(NODE_ID, root, pos);
    await wait(ms);
  }

  function clearPoints() {
    while (pointed.length) {
      const p = pointed.pop();
      p.wire?.remove();
      if (p.glowId) canvas.remove(p.glowId);
    }
  }

  function renderChips(card) {
    chips.replaceChildren();
    if (!card) return;
    for (const choice of card.choices) {
      const chip = el('button', 'bero-chip', t(choiceKey(choice.code)));
      chip.type = 'button';
      chip.addEventListener('click', () => {
        if (!cards?.choose?.(card.cardId, choice.choiceId)) return;
        chip.classList.add('on');
        for (const c of chips.children) c.disabled = true;
      });
      chips.append(chip);
    }
  }

  async function doLook(at) {
    if (at === 'all') {
      canvas.lookAll();
      eyes.style.transform = '';
    } else {
      const r = canvas.rectOf(`cam:${at.vmId}`);
      if (r) canvas.lookAt({ x: r.x + r.w / 2, y: r.y + r.h / 2, zoom: 1.1 });
      lookToward(centerOf(r));
    }
    await wait(reduced ? 0 : 600);
  }

  async function doMove(to) {
    clearPoints();
    if (to === 'home') return glide(HOME);
    const nodeId = targetNode(to);
    if (!nodeId || !canvas.rectOf(nodeId)) return undefined;
    await glide(canvas.freeSpot(nodeId, BERO_SIZE));
    lookToward(centerOf(canvas.rectOf(nodeId)));
    return undefined;
  }

  async function doPoint(vmId) {
    const camId = `cam:${vmId}`;
    const r = canvas.rectOf(camId);
    if (!r) return;
    clearPoints();
    lookToward(centerOf(r));
    const glow = el('div', 'bero-glow');
    glow.style.width = `${r.w}px`;
    glow.style.height = `${r.h}px`;
    const glowId = `glow:${vmId}`;
    canvas.place(glowId, glow, { x: r.x, y: r.y });
    const point = { glowId, wire: canvas.wire(NODE_ID, camId, { tone: 'me' }) };
    pointed.push(point);
    await wait(reduced ? 0 : 700);
    // a point is a gesture: the glow fades and the wire goes away on their own (or earlier, when Bero moves on)
    setTimeout(() => {
      glow.classList.add('fade');
      point.wire?.remove();
    }, reduced ? 0 : POINT_MS);
  }

  async function doSay(code, params, cardId) {
    sayingCard = cardId;
    renderChips(cardId && cards?.get ? cards.get(cardId) : null);
    bubble.classList.remove('hide');
    root.classList.add('talk');
    text.textContent = '';
    text.classList.add('typing');
    const line = t(sayKey(code), params);
    const delays = typingSchedule(line, { reduced });
    if (reduced) text.textContent = line;
    else for (const [i, ch] of [...line].entries()) { await wait(delays[i]); text.textContent += ch; }
    text.classList.remove('typing');
    root.classList.remove('talk');
    await wait(reduced ? 0 : 400);
  }

  function hush() {
    bubble.classList.add('hide');
    chips.replaceChildren();
    sayingCard = null;
    clearPoints();
  }

  async function doFigure(spec, near) {
    if (typeof renderFigure !== 'function') return;
    const node = renderFigure(spec, { words: figureWords ?? words, frameUrl, labelOf });
    if (!node) return;
    const nodeId = `fig:${spec.figureId}`;
    const slot = figureSlot(spec, near);
    const old = figures.get(slot);
    if (old) canvas.remove(old); // the new figure replaces the old one beside the same camera
    const size = { w: 340, h: 220 };
    const at = canvas.freeSpot(near?.vmId ? `cam:${near.vmId}` : NODE_ID, size);
    canvas.place(nodeId, node, at);
    figures.set(slot, nodeId);
    pointed.push({ wire: canvas.wire(NODE_ID, nodeId, { dashed: true, tone: 'me' }) });
    await wait(reduced ? 0 : 1200);
  }

  async function doCard(card) {
    cards?.open(card);
    if (sayingCard === card.cardId && chips.children.length === 0) renderChips(card);
    await wait(reduced ? 0 : 500);
  }

  /** Plays one act; resolves when its motion or typing has finished. Unknown acts resolve at once. */
  async function perform(act) {
    switch (act?.type) {
      case 'look': return doLook(act.at);
      case 'move': return doMove(act.to);
      case 'point': return doPoint(act.vmId);
      case 'say': return doSay(act.code, act.params ?? {}, act.cardId ?? null);
      case 'hush': return hush();
      case 'figure': return doFigure(act.figure, act.near);
      case 'card': return doCard(act.card);
      default: return undefined;
    }
  }

  return Object.freeze({ el: root, perform });
}
