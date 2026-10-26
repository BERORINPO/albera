// Browser-local positions for movable session cards. Provider session data remains read-only and these coordinates never enter an API.

import { SESSION_ID_RE } from '../src/shared/constants.mjs';

const KEY = 'pigeonholes:v1:canvas-session-positions';
const LIMIT = 1000;
const WORLD_MAX = 1_000_000;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} input @returns {Record<string,{x:number,y:number}>} */
export function normalizeSessionPositions(input) {
  const source = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return null; } })() : input;
  const raw = plain(source) && source.v === 1 && plain(source.positions) ? source.positions : null;
  if (!raw) return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= LIMIT) break;
    if (!SESSION_ID_RE.test(id) || !plain(value)) continue;
    const { x, y } = value;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -WORLD_MAX || x > WORLD_MAX || y < -WORLD_MAX || y > WORLD_MAX) continue;
    out[id] = { x: Math.round(x), y: Math.round(y) };
  }
  return out;
}

/** Browser storage adapter. @param {Storage|undefined} storage */
export function loadSessionPositions(storage = globalThis.localStorage) {
  try { return normalizeSessionPositions(storage?.getItem(KEY)); } catch { return {}; }
}

/** Persist only opaque provider IDs and bounded coordinates. @param {Record<string,{x:number,y:number}>} positions @param {Storage|undefined} storage */
export function saveSessionPositions(positions, storage = globalThis.localStorage) {
  try {
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify({ v: 1, positions: normalizeSessionPositions({ v: 1, positions }) }));
    return true;
  } catch { return false; }
}

/** @param {Record<string,{x:number,y:number}>} positions @param {string} id @param {Storage|undefined} storage */
export function forgetSessionPosition(positions, id, storage = globalThis.localStorage) {
  if (!SESSION_ID_RE.test(id) || !Object.hasOwn(positions ?? {}, id)) return false;
  const next = { ...positions };
  delete next[id];
  if (!saveSessionPositions(next, storage)) return false;
  Object.assign(positions, next);
  for (const key of Object.keys(positions)) if (!Object.hasOwn(next, key)) delete positions[key];
  return true;
}
