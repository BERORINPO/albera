import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionPositionActions } from '../public/canvas-session-position-act.mjs';
import { loadSessionPositions } from '../public/session-position-store.mjs';

const sessionId = 'codex_00000000-0000-4000-8000-000000000001';
const layout = { sheets: [{ x: 100, y: 200, slips: [{ id: sessionId, x: 20, y: 30, h: 140 }] }] };

class Storage {
  value = null;
  getItem() { return this.value; }
  setItem(_key, value) { this.value = value; }
}

function withCanvasGlobals(run) {
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const priorCss = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
  const storage = new Storage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value) => value } });
  try { return run(storage); }
  finally {
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage);
    else delete globalThis.localStorage;
    if (priorCss) Object.defineProperty(globalThis, 'CSS', priorCss);
    else delete globalThis.CSS;
  }
}

test('keyboard movement persists the selected session card and reset restores its generated position', () => withCanvasGlobals((storage) => {
  const announcements = [];
  let renders = 0;
  let focusedSlip = '';
  const actions = createSessionPositionActions({
    cv: { layout, cam: { z: 1 } },
    render: () => { renders++; },
    world: () => ({ querySelector: () => ({ focus() {} }) }),
    focusSlip: (id) => { focusedSlip = id; },
    announce: (value) => announcements.push(value),
    getT: () => (key) => key,
  });

  assert.equal(actions.moveBy(sessionId, 0, 24), true);
  assert.deepEqual(loadSessionPositions(storage), { [sessionId]: { x: 120, y: 254 } });
  assert.equal(renders, 1);
  assert.equal(announcements.at(-1), 'canvas.sessionMoved');

  assert.equal(actions.reset(sessionId), true);
  assert.deepEqual(loadSessionPositions(storage), {});
  assert.equal(focusedSlip, sessionId);
  assert.equal(renders, 2);
  assert.equal(announcements.at(-1), 'canvas.sessionPositionReset');
}));

test('pointer drag uses world coordinates and commits only on drop', () => withCanvasGlobals((storage) => {
  const elements = new Map();
  let renders = 0;
  const cv = { layout, cam: { z: 2 }, sessionPositions: {} };
  const actions = createSessionPositionActions({
    cv,
    render: () => {
      renders++;
      elements.set(sessionId, {
        classList: { add() {} },
        style: { setProperty() {} },
      });
    },
    world: () => ({ querySelector: (selector) => selector.includes('session-positioned') ? (elements.get(sessionId) ?? null) : null }),
    focusSlip() {},
    announce() {},
    getT: () => (key) => key,
  });

  actions.drag(sessionId, 80, -40);
  assert.equal(renders, 1, 'unpositioned slips are promoted into the movable overlay');
  assert.deepEqual(cv.sessionDrag, { id: sessionId, x: 160, y: 210, startX: 120, startY: 230 });
  assert.deepEqual(loadSessionPositions(storage), {}, 'drag preview is not persisted before pointer release');
  actions.drop(sessionId);
  assert.deepEqual(loadSessionPositions(storage), { [sessionId]: { x: 160, y: 210 } });
}));

test('keyboard and pointer movement stay within the storage world bounds', () => withCanvasGlobals((storage) => {
  const cv = {
    layout: { sheets: [{ x: 1_000_000, y: 0, slips: [{ id: sessionId, x: 0, y: 0, h: 140 }] }] },
    cam: { z: 1 }, sessionPositions: {},
  };
  const actions = createSessionPositionActions({
    cv, render() {}, world: () => ({ querySelector: () => null }), focusSlip() {}, announce() {}, getT: () => (key) => key,
  });
  assert.equal(actions.moveBy(sessionId, 100, 0), true);
  assert.deepEqual(loadSessionPositions(storage), { [sessionId]: { x: 1_000_000, y: 0 } });
  actions.drag(sessionId, 100, 0);
  assert.equal(cv.sessionDrag.x, 1_000_000);
  actions.drop(sessionId);
  assert.deepEqual(loadSessionPositions(storage), { [sessionId]: { x: 1_000_000, y: 0 } });
}));

test('failed browser storage does not report a moved card or leave an unsaved live position', () => withCanvasGlobals((storage) => {
  storage.setItem = () => { throw new Error('blocked storage'); };
  const announcements = [];
  let renders = 0;
  const cv = { layout, cam: { z: 1 } };
  const actions = createSessionPositionActions({
    cv, render: () => { renders++; }, world: () => ({ querySelector: () => null }), focusSlip() {},
    announce: (value) => announcements.push(value), getT: () => (key) => key,
  });

  assert.equal(actions.moveBy(sessionId, 12, 0), false);
  assert.deepEqual(cv.sessionPositions, {});
  assert.equal(renders, 0);
  assert.deepEqual(announcements, ['canvas.positionSaveError']);
}));
