// @ts-check
// ブラウザー内のキャンバス視点だけを保存する。カードやセッションの情報は扱わない。

const KEY = 'pigeonholes:v1:canvas-camera';
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** 壊れた値・古い形式は安全に無視する。 @param {string|null} raw */
export function parseCameraView(raw) {
  try {
    const v = JSON.parse(raw ?? 'null');
    if (!v || v.v !== 1 || typeof v.fit !== 'boolean' || !v.camera) return null;
    const { x, y, z } = v.camera;
    if (![x, y, z].every(finite) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7 || z < 0.05 || z > 4) return null;
    return { fit: v.fit, camera: { x, y, z } };
  } catch { return null; }
}

/** @param {boolean} narrow @param {Pick<Storage,'getItem'>} [storage] */
export function loadCameraView(narrow = false, storage) {
  try { const store = storage ?? localStorage; return parseCameraView(store.getItem(`${KEY}${narrow ? ':narrow' : ''}`)); }
  catch { return null; }
}

/** @param {boolean} fit @param {{x:number,y:number,z:number}} camera @param {boolean} narrow @param {Pick<Storage,'setItem'>} [storage] */
export function saveCameraView(fit, camera, narrow = false, storage) {
  try {
    if (![camera.x, camera.y, camera.z].every(finite) || Math.abs(camera.x) > 1e7 || Math.abs(camera.y) > 1e7 || camera.z < 0.05 || camera.z > 4) return false;
    const store = storage ?? localStorage;
    store.setItem(`${KEY}${narrow ? ':narrow' : ''}`, JSON.stringify({ v: 1, fit, camera }));
    return true;
  } catch { return false; }
}
