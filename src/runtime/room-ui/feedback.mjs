// Feedback panel (docs/architecture/feedback-intake.md): one box and one button. The browser sends the text to the intake Worker (api.mjs sendFeedback, the only call that leaves this PC), only when
// the person presses send. While they type, findSecrets runs on every change: a secret shape stops the button and is painted in the box (a layer behind the text), and the only way on is to delete it.
// The draft lives in this page's memory only: the text is never put in storage (the one stored thing is a random install secret, see loadInstallSecret).
// All text goes through textContent / DOM APIs. The pure parts are exported for tests; the browser part runs only where there is a document.
import { makeWords } from './i18n.mjs';
import * as api from './api.mjs';
import panelWords from './words-panels.mjs';
import feedbackWords from './words-feedback.mjs';
import { FEEDBACK_MAX_CHARS, FEEDBACK_RESULT_CODES, RECEIPT_RE, findSecrets, secretRanges as contractRanges } from './feedback-contract.mjs';

export const INSTALL_KEY = 'albera:v1:feedback-install';
export const REQUEST_VERSION = 1;
export const TOAST_MS = 30_000;
const INSTALL_SECRET_RE = /^[A-Za-z0-9_-]{43}$/u;
const VERSION_RE = /^[\x20-\x7e]{1,64}$/u; // the version the room reports: printable ASCII, 1 to 64
const SEND_FAILURES = FEEDBACK_RESULT_CODES.filter((code) => code !== 'created' && code !== 'duplicate');

// ---- ids: a draft id (one per draft) and an install id that changes every UTC day ----

export const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const fromBase64url = (text) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const newDraftId = (random = randomBytes) => base64url(random(16)); // 22 characters
export const utcDay = (date) => date.toISOString().slice(0, 10);

/** What makes two sends "the same draft": the text as it is sent. A changed text is a new draft (a retry of an unseen send must not carry an old id with new words). */
export const draftKey = (text) => String(text).trim();
/** The draft after asking for `key`: the same draft (same id) when nothing changed, else a new id. */
export const nextDraft = (draft, key, makeId = newDraftId) => (draft.key === null || draft.key === key ? { id: draft.id, key } : { id: makeId(), key });

/** HMAC-SHA256(install secret, 'YYYY-MM-DD' in UTC) as base64url (43 characters): the same install on two days gives two values nobody can join. */
export async function installDayOf(secret, date, subtle = globalThis.crypto.subtle) {
  const key = await subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await subtle.sign('HMAC', key, new TextEncoder().encode(utcDay(date)))));
}

const browserStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

/** The install secret: 32 random bytes kept in localStorage. When storage is unusable (or holds something else) a fresh one is made, good for this page only. */
export function loadInstallSecret(storage, random = randomBytes) {
  try {
    const saved = storage?.getItem(INSTALL_KEY);
    if (INSTALL_SECRET_RE.test(saved ?? '')) return fromBase64url(saved);
  } catch { /* storage is unusable: a page-only secret below */ }
  const bytes = random(32);
  try { storage?.setItem(INSTALL_KEY, base64url(bytes)); } catch { /* not kept: good for this page only */ }
  return bytes;
}

// ---- the text: where the secrets are, and whether it may be sent ----

/** [start, end) of every secret shape in `text`, in order, from the contract's own ranges (the same rules the Worker refuses with). Only the painting uses this. */
export const secretRanges = (text) => contractRanges(String(text)).map(({ start, end }) => [start, end]);

/** null, or why the text is not sendable on its own account: empty_text, text_too_long. (What else the Worker refuses, such as unsafe_text, comes back as its answer.) */
export const textProblem = (text) => {
  const trimmed = String(text).trim();
  return trimmed === '' ? 'empty_text' : trimmed.length > FEEDBACK_MAX_CHARS ? 'text_too_long' : null;
};

/** @returns {{ ranges: number[][], blocked: boolean, problem: string|null, canSend: boolean }} `blocked` = a secret shape is in the text; the button waits until it is gone. */
export function assessText(text) {
  const blocked = findSecrets(text).length > 0;
  const problem = textProblem(text);
  return { ranges: blocked ? secretRanges(text) : [], blocked, problem, canSend: !blocked && problem === null };
}

/** The request the Worker expects: { v: 1, text, draftId, installDay, version }. The text is sent trimmed. */
export const buildRequest = ({ text, draftId, installDay, version }) => Object.freeze({ v: REQUEST_VERSION, text: String(text).trim(), draftId, installDay, version });

/** The words key of a result code; anything the panel has no words for is said as intake_unavailable (the contract's rule). */
export const resultKey = (code) => `feedback.result.${code === 'unreachable' || FEEDBACK_RESULT_CODES.includes(code) ? code : 'intake_unavailable'}`;

/** What GET api/feedback means for the panel: on (with the version to send), off (404: no route), locked (401), or down. */
export function roomState({ ok, status, body }) {
  if (status === 404) return { state: 'off', version: null };
  if (status === 401) return { state: 'locked', version: null };
  const version = body?.version;
  return ok && body?.ok === true && typeof version === 'string' && VERSION_RE.test(version) ? { state: 'on', version } : { state: 'down', version: null };
}

/**
 * Send one request. `send(request)` is api.sendFeedback. A receipt is believed only when it has the receipt shape.
 * @returns {Promise<{ code: 'created'|'duplicate', receipt: string } | { code: string }>} a failure code is one of the contract's, or `unreachable`
 */
export async function sendFlow({ request, send }) {
  const result = await send(request);
  if (result.status === 0) return { code: 'unreachable' };
  if (result.ok) {
    const receipt = result.body?.receipt;
    return typeof receipt === 'string' && RECEIPT_RE.test(receipt) ? { code: result.body.duplicate === true ? 'duplicate' : 'created', receipt } : { code: 'intake_unavailable' };
  }
  return { code: SEND_FAILURES.includes(result.body?.error) ? result.body.error : 'intake_unavailable' };
}

// ---- the screen ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The layer behind the text: the same characters, the secret ranges wrapped in <mark>. Its text is transparent; only the marks' colour shows through the box. */
function paint(layer, text, ranges) {
  const parts = [];
  let at = 0;
  for (const [start, end] of ranges) {
    parts.push(document.createTextNode(text.slice(at, start)), el('mark', '', text.slice(start, end)));
    at = end;
  }
  parts.push(document.createTextNode(`${text.slice(at)}\n`)); // the same last line as the box, so both scroll to the same height
  layer.replaceChildren(...parts);
}

function boot() {
  const words = makeWords(panelWords, feedbackWords);
  const panel = document.getElementById('feedback-panel');
  const opener = document.getElementById('open-feedback');
  if (!panel || !opener) return;
  opener.textContent = words.t('feedback.open');
  const close = el('button', 'panel-close', words.t('panel.close'));
  close.type = 'button';
  const layer = el('div', 'fb-layer');
  layer.setAttribute('aria-hidden', 'true');
  const text = el('textarea');
  Object.assign(text, { name: 'text', maxLength: FEEDBACK_MAX_CHARS, spellcheck: false, autocomplete: 'off', placeholder: words.t('feedback.placeholder') });
  text.setAttribute('aria-label', words.t('feedback.title'));
  const field = el('div', 'fb-field');
  field.append(layer, text);
  const stop = el('p', 'fb-stop', words.t('feedback.stop'));
  stop.setAttribute('role', 'alert');
  const send = el('button', 'primary', words.t('feedback.send'));
  send.type = 'button';
  const more = el('a', '', words.t('feedback.more_link'));
  more.href = '#';
  const note = el('p', 'fb-note', `${words.t('feedback.note')} `);
  note.append(more);
  const foot = el('div', 'fb-foot');
  foot.append(send, note);
  const details = el('div', 'fb-more');
  details.append(...['sent', 'where', 'ip'].map((key) => el('p', '', words.t(`feedback.more.${key}`))));
  const status = el('p', 'fb-status sm'); // the room says no / locked / unreachable
  status.setAttribute('role', 'status');
  const err = el('p', 'fb-err', '');
  err.setAttribute('role', 'status');
  const toast = el('div', 'fb-toast');
  toast.setAttribute('role', 'status');
  const form = el('div');
  form.append(field, stop, foot, details, err);
  stop.hidden = true;
  details.hidden = true;
  err.hidden = true;
  toast.hidden = true;
  panel.replaceChildren(close, el('h2', '', words.t('feedback.title')), status, form);
  document.body.append(toast);

  const state = { room: 'down', version: null, draft: { id: newDraftId(), key: null }, sending: false };
  let secret = null;
  let toastTimer;
  const installSecret = () => (secret ??= loadInstallSecret(browserStorage()));

  function refresh() {
    const a = assessText(text.value);
    paint(layer, text.value, a.ranges);
    stop.hidden = !a.blocked;
    field.classList.toggle('bad', a.blocked);
    send.disabled = !a.canSend || state.room !== 'on' || state.sending;
  }

  /** Ask the room (same origin) whether feedback is on, and for the version to send. Off hides the box; locked or unreachable keeps it but the button waits. */
  async function probe() {
    const { state: room, version } = roomState(await api.getFeedback());
    Object.assign(state, { room, version });
    status.textContent = room === 'off' ? words.t('feedback.off') : room === 'locked' ? words.t('panel.locked') : room === 'down' ? words.t('panel.unreachable') : '';
    form.hidden = room === 'off';
    refresh();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, TOAST_MS);
  }

  async function submit() {
    // The text is read ONCE: the same string is checked, keyed and sent (a paste during the awaits below cannot slip past the check), and the box is read-only meanwhile.
    const value = text.value;
    if (state.sending || !assessText(value).canSend || state.room !== 'on') return; // one press, one send
    state.sending = true;
    text.readOnly = true;
    send.textContent = words.t('feedback.sending');
    err.hidden = true;
    refresh();
    state.draft = nextDraft(state.draft, draftKey(value));
    let out = { code: 'intake_unavailable' };
    try {
      const installDay = await installDayOf(installSecret(), new Date());
      out = await sendFlow({ request: buildRequest({ text: value, draftId: state.draft.id, installDay, version: state.version }), send: api.sendFeedback });
    } catch { /* it stays intake_unavailable */ }
    state.sending = false;
    text.readOnly = false;
    send.textContent = words.t('feedback.send');
    if (out.code === 'created' || out.code === 'duplicate') {
      text.value = ''; // sent: the text goes from this page too, and the next draft has its own id
      state.draft = { id: newDraftId(), key: null };
      refresh();
      panel.hidden = true;
      showToast(words.t('feedback.done', { receipt: out.receipt }));
      return;
    }
    err.textContent = words.t('feedback.failed', { reason: words.t(resultKey(out.code)) });
    err.hidden = false;
    refresh();
  }

  text.addEventListener('input', refresh);
  text.addEventListener('scroll', () => { layer.scrollTop = text.scrollTop; });
  send.addEventListener('click', () => { void submit(); });
  more.addEventListener('click', (event) => { event.preventDefault(); details.hidden = !details.hidden; });
  close.addEventListener('click', () => { panel.hidden = true; });
  opener.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    toast.hidden = true;
    void probe();
  });
  refresh();
}

if (typeof document !== 'undefined') boot();
