import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetSessionPosition, loadSessionPositions, normalizeSessionPositions, saveSessionPositions } from '../public/session-position-store.mjs';
import { defaultSessionRect, isPositionedSession, sessionRect } from '../public/session-position.mjs';

class Storage {
  value = null;
  getItem() { return this.value; }
  setItem(_key, value) { this.value = value; }
}

const claude = 'local_00000000-0000-4000-8000-000000000001';
const codex = 'codex_00000000-0000-4000-8000-000000000002';

test('session positions keep only recognized opaque IDs and bounded numeric coordinates', () => {
  assert.deepEqual(normalizeSessionPositions({ v: 1, positions: {
    [claude]: { x: 10.2, y: -40.7 },
    '/sensitive/full/path': { x: 1, y: 2 },
    [codex]: { x: 1_000_001, y: 0 },
    malformed: { x: 1, y: 2 },
  } }), { [claude]: { x: 10, y: -41 } });
});

test('session positions load, save, and forget using browser-local storage only', () => {
  const storage = new Storage();
  assert.deepEqual(loadSessionPositions(storage), {});
  const positions = { [claude]: { x: 20, y: 40 }, [codex]: { x: -80, y: 12 } };
  assert.equal(saveSessionPositions(positions, storage), true);
  assert.equal(storage.value.includes('sensitive'), false);
  assert.deepEqual(loadSessionPositions(storage), positions);
  assert.equal(forgetSessionPosition(positions, claude, storage), true);
  assert.deepEqual(loadSessionPositions(storage), { [codex]: { x: -80, y: 12 } });
});

test('invalid or inaccessible storage fails closed', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadSessionPositions(blocked), {});
  assert.equal(saveSessionPositions({ [claude]: { x: 1, y: 2 } }, blocked), false);
  assert.deepEqual(normalizeSessionPositions('{'), {});
});

test('session cards keep their generated sheet position until the user moves them', () => {
  const layout = { sheets: [{ x: 100, y: 200, slips: [{ id: claude, x: 12, y: 34, h: 140 }] }] };
  const index = new Map([[claude, { card: {}, pile: 'working' }]]);
  assert.deepEqual(defaultSessionRect(layout, claude), { x: 112, y: 234, w: 432, h: 140 });
  assert.deepEqual(sessionRect(layout, claude, {}), { x: 112, y: 234, w: 432, h: 140 });
  assert.deepEqual(sessionRect(layout, claude, { [claude]: { x: 600, y: 700 } }), { x: 600, y: 700, w: 432, h: 140 });
  assert.equal(isPositionedSession(claude, index, {}), false);
  assert.equal(isPositionedSession(claude, index, { [claude]: { x: 600, y: 700 } }), true);
  assert.equal(sessionRect(layout, codex, {}), null);
});
