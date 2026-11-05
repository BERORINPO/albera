import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewFollow, followingCanvas, waitingCount } from '../src/runtime/room-ui/view-follow.mjs';
import { createCanvas } from '../src/runtime/room-ui/canvas.mjs';
import canvasDict from '../src/runtime/room-ui/words-canvas.mjs';

const fakeCanvas = () => {
  const calls = [];
  return { calls, rectOf: () => null, lookAt: (spot) => calls.push(['lookAt', spot]), lookAll: (opts) => calls.push(['lookAll', opts]) };
};

/** Just enough of an element for createCanvas: it records listeners so a test can fire them. */
function fakeViewport() {
  const element = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, append() {}, setAttribute() {},
  });
  const listeners = new Map();
  return {
    ...element(),
    ownerDocument: { createElement: element, createElementNS: element },
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type, event) => listeners.get(type)(event),
  };
}
const onDesk = { closest: () => null };

test('the view starts by following Bero, and Bero moves it', () => {
  const canvas = fakeCanvas();
  const view = createViewFollow();
  followingCanvas(canvas, view).lookAt({ x: 1, y: 2 });
  assert.equal(view.mode(), 'follow');
  assert.deepEqual(canvas.calls, [['lookAt', { x: 1, y: 2 }]]);
});

test('once the person moves the view, Bero no longer moves it', () => {
  const canvas = fakeCanvas();
  const view = createViewFollow();
  const followed = followingCanvas(canvas, view);
  view.userMoved();
  followed.lookAt({ x: 1, y: 2 });
  followed.lookAll();
  assert.equal(view.mode(), 'own');
  assert.deepEqual(canvas.calls, []);
});

test('going back to following jumps to where Bero looked last, once', () => {
  const canvas = fakeCanvas();
  const view = createViewFollow();
  const followed = followingCanvas(canvas, view);
  view.userMoved();
  followed.lookAt({ x: 1, y: 2 });
  followed.lookAt({ x: 3, y: 4 });
  view.follow();
  view.follow();
  assert.deepEqual(canvas.calls, [['lookAt', { x: 3, y: 4 }]]);
});

test('going back before Bero looked anywhere goes home', () => {
  let home = 0;
  const view = createViewFollow({ home: () => { home += 1; } });
  view.userMoved();
  view.follow();
  assert.equal(home, 1);
});

test('onChange fires only when the mode really changes', () => {
  const seen = [];
  const view = createViewFollow({ onChange: (mode) => seen.push(mode) });
  view.follow();
  view.userMoved();
  view.userMoved();
  view.follow();
  assert.deepEqual(seen, ['own', 'follow']);
});

test('the wrapped canvas keeps everything else of the canvas', () => {
  const canvas = fakeCanvas();
  assert.equal(followingCanvas(canvas, createViewFollow()).rectOf, canvas.rectOf);
});

test('waitingCount counts the cameras whose tone is wait', () => {
  const tone = (vm) => vm.tone;
  assert.equal(waitingCount([{ vmId: 'a', tone: 'wait' }, { vmId: 'b', tone: 'work' }, { vmId: 'c', tone: 'wait' }], tone), 2);
  assert.equal(waitingCount([{ vmId: 'a', tone: 'wait' }], null), 0);
});

test('a camera and its own card are one thing to do', () => {
  assert.equal(waitingCount([{ vmId: 'a', tone: 'wait' }], (vm) => vm.tone, ['a', 'b']), 2);
  assert.equal(waitingCount([], null, ['a']), 1);
});

test('a camera the host is still checking waits for nobody', () => {
  assert.equal(waitingCount([{ vmId: 'a', tone: 'wait', check: { state: 'checking' } }], (vm) => vm.tone), 0);
});

test('after forget, going back goes home instead of to a camera that is gone', () => {
  let home = 0;
  const canvas = fakeCanvas();
  const view = createViewFollow({ home: () => { home += 1; } });
  view.userMoved();
  followingCanvas(canvas, view).lookAt({ x: 1, y: 2 });
  view.forget();
  view.follow();
  assert.equal(home, 1);
  assert.deepEqual(canvas.calls, []);
});

test('dragging the desk tells the canvas owner once; a small slip does not', () => {
  let moved = 0;
  const viewport = fakeViewport();
  createCanvas(viewport, { onUserMove: () => { moved += 1; } });
  viewport.fire('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0, target: onDesk });
  viewport.fire('pointermove', { pointerId: 1, clientX: 1, clientY: 1 });
  assert.equal(moved, 0);
  viewport.fire('pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
  viewport.fire('pointermove', { pointerId: 1, clientX: 80, clientY: 0 });
  assert.equal(moved, 1);
});

test('the wheel tells the canvas owner', () => {
  let moved = 0;
  const viewport = fakeViewport();
  createCanvas(viewport, { onUserMove: () => { moved += 1; } });
  viewport.fire('wheel', { preventDefault() {}, deltaY: 100, ctrlKey: false, clientX: 10, clientY: 10 });
  assert.equal(moved, 1);
});

test('the view words exist in both languages', () => {
  for (const code of ['view_label', 'view_follow', 'view_own', 'view_waiting']) {
    assert.equal(typeof canvasDict.en[code], 'string', code);
    assert.equal(typeof canvasDict.ja[code], 'string', code);
  }
});
