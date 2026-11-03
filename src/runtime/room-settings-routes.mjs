import { SECRET_NAMES, SECRET_STORE_ERROR_CODES } from './control-plane-secret-store.mjs';

// The room's credential field (docs/architecture/control-plane-service.md section 5, "Entry"; Proposed / NOT VERIFIED). Routes for room-host.mjs `apiRoutes`; the host checks
// Origin, Sec-Fetch-Site, the content type, the session cookie and the body limit before any handler here runs, and the handler never sees the request.
//
//   GET  /api/settings/credentials        -> { ok, credentials: [{ name, present, sha256Prefix, savedAt }] }   both names, from the store's status(): nothing is decrypted
//   POST /api/settings/credential         { name, value }  -> { ok, credential: { name, present, sha256Prefix, savedAt } }   WRITE-ONLY: the value is never returned
//   POST /api/settings/credential/erase   { name }         -> { ok, erased: boolean }
//
// The value is a Claude Code `setup-token` (name `claude-oauth-token`) or an API key (name `anthropic-api-key`). The body is at most 1 KiB; the value is printable ASCII with no whitespace, 1 to
// 1024 bytes. That is the whole check on save: a live check (`claude auth status`) is a measurement item (M3) and would spend a model call, so a token that does not work is found by the first job.
// Nothing here logs, and no reply, error code or exception text carries the value: refusals are fixed codes, and a store failure is reported by its own fixed code or as `store_failed`.
// The store is injected (control-plane-secret-store.mjs in the service, fake-control-plane-secret-store.mjs in tests). A JavaScript string cannot be wiped, so the value lives until it is collected
// (best effort, as the store's own header says).

export const CREDENTIAL_MAX_BODY_BYTES = 1024;
export const CREDENTIAL_MAX_VALUE_CHARS = 1024;
const VALUE_RE = /^[\x21-\x7e]{1,1024}$/u;
const STORE_CODES = new Set(SECRET_STORE_ERROR_CODES);
const fail = (status, error) => ({ status, body: { error } });
const hasExactly = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isName = (name) => typeof name === 'string' && SECRET_NAMES.includes(name);
// What a client may learn about a stored credential: that it exists, the first 8 hex of its SHA-256, and when it was saved.
const view = (name, status) => ({ name, present: status.present === true, sha256Prefix: status.sha256Prefix ?? null, savedAt: status.savedAt ?? null });

/** A failure of the store as a response: its own fixed code (503 for the store not being there, 500 otherwise), or `store_failed`. Never the error's message. */
function storeFailure(error) {
  const code = typeof error?.code === 'string' && STORE_CODES.has(error.code) ? error.code : 'store_failed';
  if (code === 'invalid_value' || code === 'invalid_name') return fail(400, code);
  return fail(code === 'store_unavailable' || code === 'helper_unavailable' || code === 'unsupported_platform' ? 503 : 500, code);
}

/**
 * @param {{ secretStore: { save: Function, erase: Function, status: Function } }} deps
 * @returns {readonly object[]} routes for createRoomHost({ apiRoutes })
 */
export function createRoomSettingsRoutes({ secretStore } = {}) {
  if (!['save', 'erase', 'status'].every((method) => typeof secretStore?.[method] === 'function')) throw new TypeError('invalid_room_settings_dependencies');

  async function list() {
    try {
      const credentials = [];
      for (const name of SECRET_NAMES) credentials.push(view(name, await secretStore.status(name)));
      return { status: 200, body: { ok: true, credentials } };
    } catch (error) { return storeFailure(error); }
  }

  async function save({ body }) {
    if (!hasExactly(body, ['name', 'value'])) return fail(400, 'invalid_request');
    if (!isName(body.name)) return fail(400, 'invalid_name');
    if (typeof body.value !== 'string' || !VALUE_RE.test(body.value)) return fail(400, 'invalid_value'); // the value is not echoed, not even its length
    try {
      const saved = await secretStore.save(body.name, body.value);
      return { status: 200, body: { ok: true, credential: view(body.name, saved) } };
    } catch (error) { return storeFailure(error); }
  }

  async function erase({ body }) {
    if (!hasExactly(body, ['name'])) return fail(400, 'invalid_request');
    if (!isName(body.name)) return fail(400, 'invalid_name');
    try { return { status: 200, body: { ok: true, erased: (await secretStore.erase(body.name)) === true } }; } catch (error) { return storeFailure(error); }
  }

  return Object.freeze([
    Object.freeze({ method: 'GET', path: '/api/settings/credentials', handle: list }),
    Object.freeze({ method: 'POST', path: '/api/settings/credential', maxBody: CREDENTIAL_MAX_BODY_BYTES, handle: save }),
    Object.freeze({ method: 'POST', path: '/api/settings/credential/erase', maxBody: 256, handle: erase }),
  ]);
}
