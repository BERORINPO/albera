// @ts-check
// Browser storage adapter for user-authored Agent Canvas notes and relations. Nothing is sent to the server.

import { normalizeGraph } from './graph-model.mjs';

export const GRAPH_STORAGE_KEY = 'pigeonholes:v1:agent-canvas';

/** @returns {import('./graph-model.mjs').GraphDoc} */
export function loadGraph() {
  try {
    const raw = localStorage.getItem(GRAPH_STORAGE_KEY);
    return normalizeGraph(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeGraph(null);
  }
}

/** @param {unknown} value @returns {boolean} */
export function saveGraph(value) {
  try {
    localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(normalizeGraph(value)));
    return true;
  } catch {
    return false;
  }
}
