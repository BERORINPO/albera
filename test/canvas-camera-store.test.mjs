import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCameraView, parseCameraView, saveCameraView } from '../public/canvas-camera-store.mjs';

function storage() {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('camera view stores only numeric viewport state and restores separate width classes', () => {
  const s = storage();
  const wide = { x: 120, y: 340, z: 0.8 };
  const narrow = { x: 12, y: 34, z: 0.62 };
  assert.equal(saveCameraView(false, wide, false, s), true);
  assert.equal(saveCameraView(true, narrow, true, s), true);
  assert.deepEqual(loadCameraView(false, s), { fit: false, camera: wide });
  assert.deepEqual(loadCameraView(true, s), { fit: true, camera: narrow });
  assert.deepEqual([...s.data.keys()].sort(), ['pigeonholes:v1:canvas-camera', 'pigeonholes:v1:canvas-camera:narrow']);
  assert.equal([...s.data.values()].some((raw) => /prompt|session|path|token/i.test(raw)), false);
});

test('invalid, malformed, and out-of-range camera records fail closed', () => {
  for (const value of [null, '{', '{}', JSON.stringify({ v: 2, fit: false, camera: { x: 0, y: 0, z: 1 } }), JSON.stringify({ v: 1, fit: false, camera: { x: 1e9, y: 0, z: 1 } }), JSON.stringify({ v: 1, fit: false, camera: { x: 0, y: 0, z: 0 } })]) {
    assert.equal(parseCameraView(value), null);
  }
  assert.equal(saveCameraView(false, { x: 0, y: 0, z: 0 }, false, storage()), false);
});

test('storage errors are ignored without breaking the canvas', () => {
  const blocked = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } };
  assert.equal(loadCameraView(false, blocked), null);
  assert.equal(saveCameraView(false, { x: 0, y: 0, z: 1 }, false, blocked), false);
});
