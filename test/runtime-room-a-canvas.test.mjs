import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lookTransform, zoomAround, fitAll, findFreeSpot, overlaps, wirePath, clampZoom, ZOOM_MAX,
} from '../src/runtime/room-ui/canvas.mjs';
import { makeWords, pickLang, fill } from '../src/runtime/room-ui/i18n.mjs';
import * as api from '../src/runtime/room-ui/api.mjs';
import { gridLayout, createPlayer, createCtrlTwice, pickDict, loadParts, countRunning, CAM_W, CAM_H } from '../src/runtime/room-ui/app.mjs';
import canvasDict from '../src/runtime/room-ui/words-canvas.mjs';
import { validEvent } from '../src/runtime/room-contract.mjs';

const cam = (x, y) => ({ x, y, w: CAM_W, h: CAM_H });

test('lookAt puts the world point in the middle of the viewport', () => {
  const v = lookTransform({ x: 500, y: 300, zoom: 2 }, 1000, 800);
  assert.deepEqual(v, { tx: 1000 / 2 - 500 * 2, ty: 800 / 2 - 300 * 2, z: 2 });
  assert.equal(500 * v.z + v.tx, 500); // world x 500 lands on screen x 500 (= vw / 2)
  assert.equal(clampZoom(99), ZOOM_MAX);
  assert.equal(lookTransform({ x: 0, y: 0, zoom: Number.NaN }, 10, 10).z, 1);
});

test('wheel zoom keeps the world point under the pointer still', () => {
  const view = { tx: 40, ty: -20, z: 1 };
  const next = zoomAround(view, 300, 200, 1.5);
  const before = { x: (300 - view.tx) / view.z, y: (200 - view.ty) / view.z };
  const after = { x: (300 - next.tx) / next.z, y: (200 - next.ty) / next.z };
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
});

test('lookAll fits every node and never zooms past 1', () => {
  const rects = gridLayout(4).map(({ x, y }) => cam(x, y));
  const look = fitAll(rects, 1200, 800);
  assert.ok(look.zoom <= 1);
  const v = lookTransform(look, 1200, 800);
  for (const r of rects) {
    assert.ok(r.x * v.z + v.tx >= 0 && (r.x + r.w) * v.z + v.tx <= 1200);
    assert.ok(r.y * v.z + v.ty >= 0 && (r.y + r.h) * v.z + v.ty <= 800);
  }
  assert.ok(fitAll([cam(0, 0)], 3000, 3000).zoom === 1);
});

test('cameras are laid out in a grid without overlap', () => {
  const slots = gridLayout(5);
  assert.equal(slots.length, 5);
  assert.deepEqual(slots[0], { x: 0, y: 0 });
  assert.equal(slots[3].y, slots[0].y + CAM_H + 48); // 3 columns for 5 cameras
  const rects = slots.map(({ x, y }) => cam(x, y));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlaps(rects[i], rects[j]));
});

test('freeSpot never lands on a camera, and avoids other nodes when it can', () => {
  const cams = gridLayout(9).map(({ x, y }) => cam(x, y));
  const box = { w: 330, h: 200 };
  for (const near of [cams[0], cams[4], cams[8], null]) {
    const spot = findFreeSpot(near, box, cams);
    assert.ok(cams.every((c) => !overlaps({ ...spot, ...box }, c)), `spot near ${JSON.stringify(near)} is over a camera`);
  }
  const figure = { ...findFreeSpot(cams[2], box, cams), ...box };
  const second = findFreeSpot(cams[2], box, [...cams, figure]);
  assert.ok(!overlaps({ ...second, ...box }, figure));
  assert.ok(cams.every((c) => !overlaps({ ...second, ...box }, c)));
});

test('freeSpot grows the world outward when nothing beside the node is free', () => {
  // a node boxed in on every side by cameras: the spot goes right of everything, never on top of anything
  const ring = [];
  for (let gx = -2; gx <= 2; gx++) for (let gy = -2; gy <= 2; gy++) if (gx || gy) ring.push({ x: gx * 110, y: gy * 110, w: 100, h: 100 });
  const near = { x: 0, y: 0, w: 100, h: 100 };
  const box = { w: 2000, h: 2000 };
  const spot = findFreeSpot(near, box, [...ring, near]);
  assert.ok([...ring, near].every((r) => !overlaps({ ...spot, ...box }, r)));
  assert.ok(spot.x >= 2 * 110 + 100);
  // many figures in a row, each placed next to the same camera, never overlap each other or a camera
  const cams = gridLayout(4).map(({ x, y }) => cam(x, y));
  const placed = [];
  for (let i = 0; i < 6; i++) {
    const s = { ...findFreeSpot(cams[0], { w: 440, h: 260 }, [...cams, ...placed]), w: 440, h: 260 };
    assert.ok([...cams, ...placed].every((r) => !overlaps(s, r)), `figure ${i} overlaps`);
    placed.push(s);
  }
});

test('wires leave from the facing edges', () => {
  assert.equal(wirePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 }), 'M100 25 C200 25, 200 25, 300 25');
  assert.match(wirePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 300, w: 100, h: 50 }), /^M50 50 C50 175, 50 175, 50 300$/);
});

test('words fill params, fall back to en, then to the code', () => {
  assert.equal(fill('CAM {cam} · {seconds} s', { cam: '03', seconds: 240 }), 'CAM 03 · 240 s');
  assert.equal(fill('{missing} ok', {}), '{missing} ok');
  assert.equal(pickLang('?lang=ja', ['en-US'], ['en', 'ja']), 'ja');
  assert.equal(pickLang('?lang=xx', ['ja-JP', 'en'], ['en', 'ja']), 'ja');
  assert.equal(pickLang('', ['fr-FR'], ['en', 'ja']), 'en');
  const words = makeWords(canvasDict, { en: { only_en: 'hi {name}' } }); // Node has no ?lang=; navigator may say anything
  assert.ok(['en', 'ja'].includes(words.lang));
  assert.equal(words.t('only_en', { name: 'Bero' }), 'hi Bero');
  assert.equal(words.t('not_a_word'), 'not_a_word');
  assert.deepEqual(Object.keys(canvasDict.en).sort(), Object.keys(canvasDict.ja).sort());
});

test('api builds the host routes and posts JSON', async () => {
  assert.equal(api.stateUrl(12), 'api/state?since=12');
  assert.equal(api.stateUrl(-3), 'api/state?since=0');
  assert.equal(api.screenUrl('albera-clone-01', '2026-10-29T10:00:00.000Z'), 'api/vms/albera-clone-01/screen.png?t=2026-10-29T10%3A00%3A00.000Z');
  assert.equal(api.screenUrl('a/b', 1), 'api/vms/a%2Fb/screen.png?t=1');
  assert.equal(api.frameUrl('fr1'), 'api/frames/fr1.png');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({ ok: true }) };
  };
  try {
    assert.deepEqual(await api.decide('c1', 'a'), { ok: true, status: 200, body: { ok: true } });
    await api.unlock('1234');
    await api.getState(5);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls[0].url, 'api/decide');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { cardId: 'c1', choiceId: 'a' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { bootstrapCode: '1234' });
  assert.equal(calls[2].url, 'api/state?since=5');
  assert.equal(calls[2].init.credentials, 'same-origin');
  globalThis.fetch = async () => { throw new Error('down'); };
  try { assert.deepEqual(await api.getState(0), { ok: false, status: 0, body: null }); } finally { globalThis.fetch = realFetch; }
});

// A recorded slice of GET /room/api/state events (shapes from room-contract.mjs), played with fakes of B/C/D.
const entry = (seq, code, params = {}) => ({ seq, at: 1000 + seq, vmId: 'albera-clone-03', actor: code.startsWith('hands') ? 'hands' : 'bero', code, params });
const card = { cardId: 'c1', vmId: 'albera-clone-03', code: 'stalled', params: { seconds: 240 }, figure: null, openedAt: 5,
  choices: [{ choiceId: 'a', code: 'close_it', effect: 'nudge' }, { choiceId: 'b', code: 'later', effect: 'dismiss' }] };
const FIXTURE = [
  { seq: 1, kind: 'ledger', entry: entry(1, 'hands_step', { step: 3, usd: 0.01, action: 'left_click', note: 'open notepad' }) },
  { seq: 2, kind: 'bero', act: { type: 'look', at: { vmId: 'albera-clone-03' } } },
  { seq: 3, kind: 'bero', act: { type: 'say', code: 'stalled', params: { cam: 'CAM 03', seconds: 240 }, cardId: 'c1' } },
  { seq: 4, kind: 'ledger', entry: entry(2, 'hands_stalled', { seconds: 240 }) },
  { seq: 5, kind: 'bero', act: { type: 'card', card } },
  { seq: 6, kind: 'card_closed', cardId: 'c1', choiceId: 'a' },
];

test('the player plays the fixture in order and waits for each Bero act', async () => {
  assert.ok(FIXTURE.every(validEvent));
  const log = [];
  const player = createPlayer({
    perform: async (act) => { log.push(`start ${act.type}`); await new Promise((r) => setTimeout(r, 5)); log.push(`end ${act.type}`); },
    addLedger: (e) => log.push(`ledger ${e.code}`),
    closeCard: (cardId, choiceId) => log.push(`close ${cardId} ${choiceId}`),
  });
  player.push(FIXTURE.slice(3).reverse()); // out of order within a poll
  player.push(FIXTURE.slice(0, 3)); // older events after newer ones are skipped
  await player.idle();
  assert.deepEqual(log, ['ledger hands_stalled', 'start card', 'end card', 'close c1 a']);

  const log2 = [];
  const fresh = createPlayer({
    perform: async (act) => { log2.push(`start ${act.type}`); await new Promise((r) => setTimeout(r, 5)); log2.push(`end ${act.type}`); },
    addLedger: (e) => log2.push(`ledger ${e.code}`),
    closeCard: (cardId) => log2.push(`close ${cardId}`),
  });
  fresh.push(FIXTURE.slice(0, 3));
  fresh.push(FIXTURE); // a repeated poll: 1-3 are skipped
  await fresh.idle();
  assert.deepEqual(log2, ['ledger hands_step', 'start look', 'end look', 'start say', 'end say', 'ledger hands_stalled', 'start card', 'end card', 'close c1']);
  assert.equal(fresh.lastSeq(), 6);
});

test('one failing act does not stop the events after it', async () => {
  const seen = [];
  const errors = [];
  const player = createPlayer({
    perform: async () => { throw new Error('broken act'); },
    addLedger: (e) => seen.push(e.code),
    closeCard: () => {},
    onError: (error) => errors.push(error.message),
  });
  await player.push(FIXTURE.slice(1, 4));
  assert.deepEqual(errors, ['broken act', 'broken act']);
  assert.deepEqual(seen, ['hands_stalled']);
});

test('Ctrl twice fires once; another key in between resets', () => {
  let t = 0;
  let fired = 0;
  const onKey = createCtrlTwice(() => { fired++; }, { now: () => t });
  onKey({ key: 'Control' }); t = 200; onKey({ key: 'Control' });
  assert.equal(fired, 1);
  t = 300; onKey({ key: 'Control' }); onKey({ key: 'c' }); t = 350; onKey({ key: 'Control' });
  assert.equal(fired, 1);
  t = 1000; onKey({ key: 'Control' }); t = 1600; onKey({ key: 'Control' });
  assert.equal(fired, 1);
  onKey({ key: 'Control', repeat: true });
  assert.equal(fired, 1);
});

test('stub parts load as missing, and words modules are found by shape', async () => {
  const parts = await loadParts(async () => ({})); // every part still a stub
  assert.equal(parts.createCam, null);
  assert.equal(parts.createBero, null);
  assert.equal(parts.dicts.cam, null);
  const real = await loadParts(); // the real files: stubs today, implementations once B/C/D land
  for (const name of ['createCam', 'spotlight', 'renderFigure', 'createLedger', 'createBero', 'createCards']) {
    assert.ok(real[name] === null || typeof real[name] === 'function');
  }
  assert.deepEqual(pickDict({ default: { en: { a: 'A' } } }), { en: { a: 'A' } });
  assert.deepEqual(pickDict({ WORDS_CAM: { ja: { a: 'あ' } } }), { ja: { a: 'あ' } });
  assert.equal(pickDict({}), null);
  assert.equal(countRunning([{ agent: { state: 'running' } }, { agent: { state: 'done' } }, {}]), 1);
});
