// @ts-check
// Browser storage adapter for user-authored Agent Canvas notes and relations. Nothing is sent to the server.

import { migrateProviderSessionEndpoints, normalizeGraph } from './graph-model.mjs';

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

/** Migrate old browser-only provider endpoints without sending native IDs to the server.
 * @param {Storage} storage @param {SubtleCrypto|undefined} subtle @returns {Promise<boolean>}
 */
export async function migrateSavedProviderSessionIds(storage = localStorage, subtle = globalThis.crypto?.subtle) {
  try {
    const raw = storage.getItem(GRAPH_STORAGE_KEY);
    const graph = normalizeGraph(raw ? JSON.parse(raw) : null);
    if (graph.v === 2) return true;
    if (!subtle) return false;
    const migrated = await migrateProviderSessionEndpoints(graph, async (source, providerId) => {
      const input = new TextEncoder().encode(`${source}\0${providerId}`);
      const digest = new Uint8Array(await subtle.digest('SHA-256', input));
      const hex = [...digest].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${source}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
    storage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(normalizeGraph(migrated)));
    return true;
  } catch {
    return false;
  }
}
