// A real room host on 127.0.0.1 (CLI launch route) with registered `apiRoutes`, a session cookie already obtained, and a `call()` that sends what the page sends.
// For the tests of room-settings-routes.mjs and room-job-routes.mjs. Nothing here is a Fake of the host: the checks under test run in the real one.
import { createRoomHost } from '../../src/runtime/room-host.mjs';

const PNG = new Uint8Array([137, 80, 78, 71]);

export function roomStubs() {
  return {
    vms: [{ vmId: 'vm-a', label: 'Alpha' }],
    board: { snapshot: () => ({}) },
    journal: { record: () => null, recordFleetEvent: () => null, since: () => [], lastSeq: () => 0 },
    director: { tick: () => ({ acts: [], ledger: [] }), decide: () => ({ ok: false, code: 'card_unknown' }) },
    fleet: { startJob: () => ({ ok: true }), stopVm: () => false },
    driver: { capture: async () => ({ png: PNG }) },
  };
}

/**
 * @returns {Promise<{ host, address, origin, cookie, call: (method: string, path: string, options?: { body?: unknown, rawBody?: string, headers?: object, cookie?: string|null }) => Promise<{ status: number, text: string, json: any, headers: Headers }> }>}
 * `call` sends Origin, Sec-Fetch-Site: same-origin, a JSON content type (for POST) and the session cookie. A header set to `undefined` in `options.headers` is left out; `cookie: null` sends none.
 */
export async function startRouteHost(t, apiRoutes, options = {}) {
  const host = createRoomHost({ ...roomStubs(), captureIntervalMs: 60_000, tickMs: 60_000, apiRoutes, ...options });
  const address = await host.listen(0);
  t.after(() => host.close());
  const origin = new URL(address.url).origin;
  const unlock = await fetch(`${address.url}api/session`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ bootstrapCode: address.bootstrapCode }),
  });
  if (unlock.status !== 200) throw new Error('test host: unlock failed');
  const cookie = unlock.headers.get('set-cookie').split(';')[0];

  async function call(method, path, { body, rawBody, headers = {}, cookie: cookieOverride } = {}) {
    const sent = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers };
    const useCookie = cookieOverride === undefined ? cookie : cookieOverride;
    if (useCookie) sent.Cookie = useCookie;
    for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
    const res = await fetch(`${address.url}${path.replace(/^\//, '')}`, {
      method, headers: sent, ...(method === 'POST' ? { body: rawBody ?? JSON.stringify(body ?? {}) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json, headers: res.headers };
  }
  return { host, address, origin, cookie, call };
}
