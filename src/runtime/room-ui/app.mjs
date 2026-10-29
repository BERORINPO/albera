// Control room app (spec/room.md §2, §5, part A): unlock -> poll state every second -> lay cameras out in a grid ->
// play room events strictly in order (Bero acts are awaited one by one). Other parts are loaded with guarded dynamic
// imports, so the page still renders (a cameras-less canvas) while a part is a stub or fails to load.
// All text goes through textContent / DOM APIs.
import { createCanvas } from './canvas.mjs';
import { makeWords } from './i18n.mjs';
import * as api from './api.mjs';
import canvasDict from './words-canvas.mjs';

export const POLL_MS = 1000;
export const CAM_W = 320;
export const CAM_H = 310; // a camera with its claim line is about 300 px tall
export const CAM_GAP = 48;
export const CTRL_TWICE_MS = 450;
const EVENT_KINDS = ['bero', 'ledger', 'card_closed'];

/** Grid slots for n cameras: about as many columns as rows, left to right, top to bottom. */
export function gridLayout(count, { w = CAM_W, h = CAM_H, gap = CAM_GAP, x0 = 0, y0 = 0 } = {}) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  return Array.from({ length: count }, (_, i) => ({ x: x0 + (i % cols) * (w + gap), y: y0 + Math.floor(i / cols) * (h + gap) }));
}

export const countRunning = (vms) => vms.filter((vm) => vm?.agent?.state === 'running').length;

/** A words module may export its dictionary as default or under any name; take the first { en | ja } object. */
export function pickDict(mod) {
  const looksLikeDict = (v) => v && typeof v === 'object' && (typeof v.en === 'object' || typeof v.ja === 'object');
  if (!mod) return null;
  if (looksLikeDict(mod.default)) return mod.default;
  return Object.values(mod).find(looksLikeDict) ?? null;
}

/**
 * Plays room events in seq order, one at a time. A 'bero' event is awaited before the next event starts.
 * Events at or below the last seq played are skipped, so a poll that repeats events is harmless.
 */
export function createPlayer({ perform, addLedger, closeCard, onError = () => {} }) {
  const queue = [];
  let lastSeq = 0;
  let running = null;

  async function playOne(ev) {
    if (ev.kind === 'bero') await perform(ev.act);
    else if (ev.kind === 'ledger') addLedger(ev.entry);
    else if (ev.kind === 'card_closed') closeCard(ev.cardId, ev.choiceId ?? null);
  }

  async function drain() {
    while (queue.length) {
      const ev = queue.shift();
      try { await playOne(ev); } catch (error) { onError(error, ev); }
    }
    running = null;
  }

  return {
    push(events) {
      const fresh = (Array.isArray(events) ? events : [])
        .filter((ev) => ev && Number.isSafeInteger(ev.seq) && EVENT_KINDS.includes(ev.kind))
        .sort((a, b) => a.seq - b.seq);
      for (const ev of fresh) {
        if (ev.seq <= lastSeq) continue;
        lastSeq = ev.seq;
        queue.push(ev);
      }
      if (!running && queue.length) running = drain();
      return running ?? Promise.resolve();
    },
    idle: () => running ?? Promise.resolve(),
    lastSeq: () => lastSeq,
  };
}

/** Ctrl pressed twice (alone, within windowMs) calls onTwice. Any other key in between resets it. */
export function createCtrlTwice(onTwice, { windowMs = CTRL_TWICE_MS, now = () => performance.now() } = {}) {
  let last = -Infinity;
  return (event) => {
    if (event.key !== 'Control' || event.repeat) { last = -Infinity; return; }
    const t = now();
    if (t - last <= windowMs) { last = -Infinity; onTwice(); } else last = t;
  };
}

async function loadPart(path) {
  try { return await import(path); } catch { return {}; }
}

/** Load B/C/D (guarded). Returns the functions that exist and the dictionaries that were found. */
export async function loadParts(load = loadPart) {
  const [cam, figure, ledger, bero, cards, wCam, wFigure, wBero] = await Promise.all(
    ['./cam.mjs', './figure.mjs', './ledger.mjs', './bero.mjs', './cards.mjs', './words-cam.mjs', './words-figure.mjs', './words-bero.mjs'].map(load),
  );
  const fn = (mod, name) => (typeof mod?.[name] === 'function' ? mod[name] : null);
  return {
    createCam: fn(cam, 'createCam'), spotlight: fn(cam, 'spotlight'), renderFigure: fn(figure, 'renderFigure'),
    createLedger: fn(ledger, 'createLedger'), createBero: fn(bero, 'createBero'), createCards: fn(cards, 'createCards'),
    dicts: { cam: pickDict(wCam), figure: pickDict(wFigure), bero: pickDict(wBero) },
  };
}

// ---- browser part ----

function boot() {
  const $ = (id) => document.getElementById(id);
  const words = makeWords(canvasDict);
  document.documentElement.lang = words.lang;
  document.title = words.t('title');
  for (const el of document.querySelectorAll('[data-w]')) el.textContent = words.t(el.dataset.w);
  for (const el of document.querySelectorAll('[data-w-label]')) el.setAttribute('aria-label', words.t(el.dataset.wLabel));

  const phase = (code, params) => { $('phase').textContent = words.t(code, params); };
  let since = 0;
  let timer;
  let room = null;

  async function openRoom() {
    const parts = await loadParts();
    const canvas = createCanvas($('viewport'));
    const camWords = makeWords(parts.dicts.cam);
    const figureWords = makeWords(parts.dicts.figure);
    const beroWords = makeWords(parts.dicts.bero);
    const labels = new Map(); // vmId -> camera label, from the latest poll
    const labelOf = (vmId) => labels.get(vmId) ?? String(vmId ?? '');
    // Every figure gets the camera labels and frame URLs, whoever draws it (Bero or a card).
    const renderFigure = parts.renderFigure
      ? (spec, opts = {}) => parts.renderFigure(spec, { frameUrl: api.frameUrl, ...opts, labelOf })
      : () => document.createElement('div');
    const cards = parts.createCards?.(canvas, {
      words: beroWords, renderFigure, frameUrl: api.frameUrl, labelOf,
      onChoose: async (cardId, choiceId) => {
        const result = await api.decide(cardId, choiceId);
        if (!result.ok) phase('choose_failed');
      },
    }) ?? null;
    const bero = parts.createBero?.(canvas, { words: beroWords, figureWords, renderFigure, cards, labelOf }) ?? null;
    const ledger = parts.createLedger?.($('ledger'), { words: figureWords, labelOf }) ?? null;
    const cams = new Map(); // vmId -> { update(vm) }

    // Without Bero (part D), still follow 'look' so the canvas moves with the host.
    const fallbackPerform = async (act) => {
      if (act?.type === 'card') cards?.open(act.card);
      if (act?.type !== 'look') return;
      if (act.at === 'all') { canvas.lookAll(); return; }
      const r = canvas.rectOf(`cam:${act.at?.vmId}`);
      if (r) canvas.lookAt({ x: r.x + r.w / 2, y: r.y + r.h / 2, zoom: 1.1 });
    };
    const player = createPlayer({
      perform: (act) => (bero ? bero.perform(act) : fallbackPerform(act)),
      addLedger: (entry) => ledger?.add(entry),
      closeCard: (cardId) => cards?.close(cardId),
      onError: () => {}, // one broken act must not stop the room
    });

    function missingCam(vm) {
      const el = document.createElement('div');
      el.className = 'cam-missing';
      el.textContent = String(vm.label ?? vm.vmId);
      return { el, update() {} };
    }

    function syncCams(vms) {
      const slots = gridLayout(vms.length);
      const first = cams.size === 0;
      let added = false;
      vms.forEach((vm, index) => {
        if (typeof vm?.vmId !== 'string') return;
        labels.set(vm.vmId, String(vm.label ?? vm.vmId));
        let cam = cams.get(vm.vmId);
        if (!cam) {
          cam = parts.createCam ? parts.createCam(vm, { index, words: camWords }) : missingCam(vm);
          cams.set(vm.vmId, cam);
          canvas.place(`cam:${vm.vmId}`, cam.el, slots[index]);
          added = true;
        }
        cam.update(vm);
      });
      const live = new Set(vms.map((vm) => vm?.vmId));
      for (const vmId of [...cams.keys()]) if (!live.has(vmId)) { canvas.remove(`cam:${vmId}`); cams.delete(vmId); }
      // The first frame after unlock jumps straight to all cameras; later cameras glide into view.
      if (added) canvas.lookAll({ smooth: !first });
    }

    const onKey = createCtrlTwice(() => parts.spotlight?.(canvas, [...cams.keys()]));
    document.addEventListener('keydown', onKey); // Bero places itself (node id 'bero'), so it is not placed here
    return { syncCams, player, cams, stop: () => document.removeEventListener('keydown', onKey) };
  }

  async function poll() {
    const result = await api.getState(since);
    if (result.status === 401) { showBootstrap(); return; }
    if (!result.ok || !result.body) phase('offline');
    else {
      const body = result.body;
      const vms = Array.isArray(body.vms) ? body.vms : [];
      $('counts').textContent = words.t('counts', { vms: vms.length, ais: countRunning(vms) });
      room.syncCams(vms);
      room.player.push(body.events);
      if (Number.isSafeInteger(body.nextSince)) since = body.nextSince;
      phase(vms.length ? 'watching' : 'no_cams', { count: vms.length });
    }
    timer = setTimeout(() => { void poll(); }, POLL_MS);
  }

  function showBootstrap() {
    clearTimeout(timer);
    $('room').hidden = true;
    $('bootstrap').hidden = false;
    phase('locked');
    $('bootstrap-code').focus();
  }

  async function startRoom() {
    $('bootstrap').hidden = true;
    $('room').hidden = false;
    room ??= await openRoom();
    void poll();
  }

  $('bootstrap-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('bootstrap-code');
    const result = await api.unlock(input.value);
    input.value = '';
    if (!result.ok) { $('bootstrap-status').textContent = words.t('unlock_failed'); return; }
    $('bootstrap-status').textContent = '';
    void startRoom();
  });

  phase('connecting');
  void (async () => {
    const first = await api.getState(0);
    if (first.ok) void startRoom();
    else showBootstrap();
  })();
}

if (typeof document !== 'undefined') boot();
