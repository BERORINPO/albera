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

/**
 * The one-time code in a page address of the form `#b=<code>` ("Open ALBERA" puts it there; a fragment is never sent to the host).
 * Returns '' when the fragment is anything else, so only a plain code is ever posted.
 */
export function bootstrapFromHash(hash) {
  const match = (typeof hash === 'string' ? hash : '').match(/^#b=([A-Za-z0-9_-]{16,128})$/);
  return match ? match[1] : '';
}

// Credential field and job screen (settings.mjs, jobs.mjs). The credential call is write-only: no call here ever receives the value back.
export const getCredentials = () => call('api/settings/credentials');
export const saveCredential = (name, value) => postJson('api/settings/credential', { name, value });
export const eraseCredential = (name) => postJson('api/settings/credential/erase', { name });
export const getJobs = () => call('api/jobs');
export const startJob = (computerId, task) => postJson('api/jobs', { computerId, task });
export const stopAllJobs = () => postJson('api/jobs/stop-all', {});
export const approvalTest = () => postJson('api/jobs/approval-test', {});
