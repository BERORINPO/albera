// The only fetch in room-ui (spec/room.md §5, part A). Paths are relative to the page (/room/), same origin only.
// Every call resolves to { ok, status, body } and never throws: status 0 = the host could not be reached.

const enc = encodeURIComponent;

export const stateUrl = (since) => `api/state?since=${Number.isSafeInteger(since) && since > 0 ? since : 0}`;
export const screenUrl = (vmId, capturedAt) => `api/vms/${enc(vmId)}/screen.png?t=${enc(String(capturedAt ?? ''))}`;
export const frameUrl = (frameId) => `api/frames/${enc(frameId)}.png`;

async function call(url, init = {}) {
  try {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init });
    let body = null;
    if ((response.headers.get('content-type') ?? '').includes('application/json')) body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const postJson = (url, payload) => call(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export const getState = (since) => call(stateUrl(since));
export const decide = (cardId, choiceId) => postJson('api/decide', { cardId, choiceId });
export const unlock = (code) => postJson('api/session', { bootstrapCode: String(code ?? '') });
