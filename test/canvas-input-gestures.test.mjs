import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCanvas } from '../public/canvas-input.mjs';

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: (value) => this.classes.add(value),
      remove: (value) => this.classes.delete(value),
    };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 400 }; }
  closest() { return null; }
  matches() { return false; }
}

class ConnectHandle extends FakeElement {
  constructor() { super(); this.dataset = { id: 'source-card', endpoint: 'graph' }; }
  closest(selector) { return selector.includes('.graph-connect-handle') ? this : null; }
}

class GraphTarget extends FakeElement {
  constructor() { super(); this.dataset = { id: 'target-card' }; }
  closest(selector) { return selector.startsWith('.graph-node') ? this : null; }
}

class SessionMoveHandle extends FakeElement {
  constructor(id = 'session-card') { super(); this.dataset = { id }; }
  closest(selector) { return selector.includes('.canvas-session-move') ? this : null; }
}

test('starting a two-finger pinch clears the single-pointer pan cursor and zooms around the midpoint', () => {
  const priorElement = globalThis.Element;
  const priorHTMLElement = globalThis.HTMLElement;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  try {
    const viewport = new FakeElement();
    const zooms = [];
    bindCanvas(viewport, {
      pan() {}, zoomBy: (...args) => zooms.push(args), dragSheet() {}, dropSheet() {},
      cancelSheet() {}, dragGraph() {}, dropGraph() {}, cancelGraph() {}, openGraph() {}, connectGraph() {}, graphConnectHover() {},
      dragSession() {}, dropSession() {}, cancelSession() {}, openSession() {}, focusHead() {},
    });
    const pointer = (pointerId, clientX, clientY) => ({ pointerId, pointerType: 'touch', button: 0, clientX, clientY, target: viewport, type: 'pointermove' });

    viewport.listeners.get('pointerdown')(pointer(1, 100, 100));
    viewport.listeners.get('pointermove')(pointer(1, 110, 100));
    assert.equal(viewport.classes.has('is-panning'), true, 'one-finger drag marks the viewport as panning');

    viewport.listeners.get('pointerdown')(pointer(2, 210, 100));
    assert.equal(viewport.classes.has('is-panning'), false, 'pinch must clear the obsolete grabbing cursor');
    viewport.listeners.get('pointermove')(pointer(2, 230, 100));
    assert.equal(zooms.length, 1);
    assert.deepEqual(zooms[0], [120 / 100, 170, 100]);

    viewport.listeners.get('pointerup')({ ...pointer(2, 230, 100), type: 'pointerup' });
    viewport.listeners.get('pointerup')({ ...pointer(1, 110, 100), type: 'pointerup' });
    assert.equal(viewport.classes.has('is-panning'), false);
  } finally {
    if (priorElement === undefined) delete globalThis.Element;
    else globalThis.Element = priorElement;
    if (priorHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = priorHTMLElement;
  }
});

test('a second pointer cancels a pending graph-connection preview before pinch takeover', () => {
  const priorElement = globalThis.Element;
  const priorHTMLElement = globalThis.HTMLElement;
  const priorDocument = globalThis.document;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  const target = new GraphTarget();
  globalThis.document = { elementFromPoint: () => target };
  try {
    const viewport = new FakeElement();
    const hover = [];
    bindCanvas(viewport, {
      pan() {}, zoomBy() {}, dragSheet() {}, dropSheet() {}, dragGraph() {}, dropGraph() {}, openGraph() {},
      cancelSheet() {}, cancelGraph() {}, dragSession() {}, dropSession() {}, cancelSession() {}, openSession() {},
      connectGraph() {}, graphConnectHover: (...args) => hover.push(args), focusHead() {},
    });
    const pointer = (pointerId, clientX, targetEl) => ({ pointerId, pointerType: 'touch', button: 0, clientX, clientY: 100, target: targetEl, type: 'pointermove' });
    viewport.listeners.get('pointerdown')(pointer(1, 100, new ConnectHandle()));
    viewport.listeners.get('pointermove')(pointer(1, 120, viewport));
    assert.deepEqual(hover.at(-1), ['graph', 'source-card', 'graph', 'target-card']);
    assert.equal(viewport.classes.has('is-connecting'), true);

    viewport.listeners.get('pointerdown')(pointer(2, 220, viewport));
    assert.deepEqual(hover.at(-1), ['graph', 'source-card', null, null]);
    assert.equal(viewport.classes.has('is-connecting'), false);
  } finally {
    if (priorElement === undefined) delete globalThis.Element;
    else globalThis.Element = priorElement;
    if (priorHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = priorHTMLElement;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});

test('pointer cancellation restores a moved session preview without committing it', () => {
  const priorElement = globalThis.Element;
  globalThis.Element = FakeElement;
  try {
    const viewport = new FakeElement();
    const cancelled = [];
    const dropped = [];
    bindCanvas(viewport, {
      pan() {}, zoomBy() {}, dragSheet() {}, dropSheet() {}, cancelSheet() {},
      dragGraph() {}, dropGraph() {}, cancelGraph() {}, openGraph() {},
      dragSession: (...args) => dropped.push(['preview', ...args]),
      dropSession: (...args) => dropped.push(['commit', ...args]),
      cancelSession: (id) => cancelled.push(id), openSession() {},
      connectGraph() {}, graphConnectHover() {}, focusHead() {},
    });
    const move = new SessionMoveHandle();
    const pointer = (type, pointerId, clientX) => ({ type, pointerId, pointerType: 'touch', button: 0, clientX, clientY: 100, target: move });
    viewport.listeners.get('pointerdown')(pointer('pointerdown', 1, 100));
    viewport.listeners.get('pointermove')(pointer('pointermove', 1, 132));
    assert.deepEqual(dropped, [['preview', 'session-card', 32, 0]]);

    viewport.listeners.get('pointercancel')(pointer('pointercancel', 1, 132));
    assert.deepEqual(cancelled, ['session-card']);
    assert.equal(dropped.some(([kind]) => kind === 'commit'), false, 'cancelled movement must not be saved');
  } finally {
    if (priorElement === undefined) delete globalThis.Element;
    else globalThis.Element = priorElement;
  }
});

test('a second touch cancels a session-card preview before taking over as a pinch', () => {
  const priorElement = globalThis.Element;
  globalThis.Element = FakeElement;
  try {
    const viewport = new FakeElement();
    const cancelled = [];
    const zooms = [];
    bindCanvas(viewport, {
      pan() {}, zoomBy: (...args) => zooms.push(args), dragSheet() {}, dropSheet() {}, cancelSheet() {},
      dragGraph() {}, dropGraph() {}, cancelGraph() {}, openGraph() {},
      dragSession() {}, dropSession() {}, cancelSession: (id) => cancelled.push(id), openSession() {},
      connectGraph() {}, graphConnectHover() {}, focusHead() {},
    });
    const move = new SessionMoveHandle();
    const pointer = (type, pointerId, clientX, target = move) => ({ type, pointerId, pointerType: 'touch', button: 0, clientX, clientY: 100, target });
    viewport.listeners.get('pointerdown')(pointer('pointerdown', 1, 100));
    viewport.listeners.get('pointermove')(pointer('pointermove', 1, 132));
    viewport.listeners.get('pointerdown')(pointer('pointerdown', 2, 220, viewport));
    assert.deepEqual(cancelled, ['session-card']);
    viewport.listeners.get('pointermove')(pointer('pointermove', 2, 240, viewport));
    assert.equal(zooms.length, 1);
  } finally {
    if (priorElement === undefined) delete globalThis.Element;
    else globalThis.Element = priorElement;
  }
});
