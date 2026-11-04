// Credential panel (control-plane-service.md section 5, "Entry"). One password field per credential kind, a write-only call, and nothing but the first 8 hex of the SHA-256 and the save time shown back.
// The field is emptied the moment its value is read; after a successful save the page tries to empty the clipboard (best effort, and it says when that fails).
// All text goes through textContent / DOM APIs. The pure parts are exported for tests; the browser part runs only where there is a document.
import { makeWords } from './i18n.mjs';
import * as api from './api.mjs';
import panelWords from './words-panels.mjs';

export const CREDENTIAL_KINDS = Object.freeze([
  Object.freeze({ name: 'claude-oauth-token', label: 'panel.settings.token_label' }),
  Object.freeze({ name: 'anthropic-api-key', label: 'panel.settings.key_label' }),
]);
const VALUE_RE = /^[\x21-\x7e]{1,1024}$/u; // the same rule as the host: printable ASCII, no whitespace (the host decides; this only saves a round trip)

export const isAcceptableValue = (value) => typeof value === 'string' && VALUE_RE.test(value);

/** Drops what a copy from a terminal adds around a token: spaces at the start or end of a line, and the line breaks of a wrapped one. Neither kind ever holds whitespace; a space inside a line stays and is refused. */
export const tidyValue = (value) => (typeof value === 'string' ? value.split(/[\r\n]+/u).map((part) => part.trim()).join('') : value);

/** The line under a field: not saved, or saved with the hash prefix and time. Never anything of the value. */
export function savedLine(words, credential) {
  if (!credential?.present) return words.t('panel.settings.not_saved');
  if (typeof credential.sha256Prefix !== 'string' || typeof credential.savedAt !== 'string') return words.t('panel.settings.saved_unknown');
  return words.t('panel.settings.saved', { prefix: credential.sha256Prefix, at: credential.savedAt });
}

/** Empty the clipboard. Resolves true when the browser accepted it; false when there is no clipboard or it refused (the page then says so). */
export async function clearClipboard(clipboard) {
  try {
    if (typeof clipboard?.writeText !== 'function') return false;
    await clipboard.writeText('');
    return true;
  } catch { return false; }
}

/**
 * Save one value. `save(name, value)` is api.saveCredential. The value is not kept anywhere here, and the clipboard is touched only after the host said it was stored.
 * @returns {Promise<{ code: 'saved'|'empty'|'invalid_value'|'locked'|'unreachable'|string, credential?: object, clipboardCleared?: boolean }>}
 */
export async function saveFlow({ name, value, save, clipboard }) {
  const tidy = tidyValue(value);
  if (typeof tidy !== 'string' || tidy.length === 0) return { code: 'empty' };
  if (!isAcceptableValue(tidy)) return { code: 'invalid_value' };
  const result = await save(name, tidy);
  if (result.status === 401) return { code: 'locked' };
  if (result.status === 0) return { code: 'unreachable' };
  if (!result.ok) return { code: typeof result.body?.error === 'string' ? result.body.error : 'save_failed' };
  return { code: 'saved', credential: result.body?.credential ?? null, clipboardCleared: await clearClipboard(clipboard) };
}

function field(doc, words, kind, onChange) {
  const box = doc.createElement('div');
  box.className = 'panel-field';
  const label = doc.createElement('label');
  const caption = doc.createElement('span');
  caption.textContent = words.t(kind.label);
  const input = doc.createElement('input');
  input.type = 'password';
  input.autocomplete = 'new-password'; // 'off' is ignored for password fields; this one tells the browser not to offer a saved value or to save it
  input.spellcheck = false;
  input.maxLength = 1024;
  input.name = kind.name;
  label.append(caption, input);
  const row = doc.createElement('div');
  row.className = 'panel-row';
  const save = doc.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = words.t('panel.settings.save');
  const erase = doc.createElement('button');
  erase.type = 'button';
  erase.textContent = words.t('panel.settings.erase');
  row.append(save, erase);
  const status = doc.createElement('p');
  status.className = 'sm sub';
  const note = doc.createElement('p');
  note.className = 'sm';
  note.setAttribute('role', 'status');
  box.append(label, row, status, note);

  save.addEventListener('click', async () => {
    const value = input.value;
    input.value = ''; // nothing stays in the page's DOM, whatever the host answers
    const result = await saveFlow({ name: kind.name, value, save: api.saveCredential, clipboard: globalThis.navigator?.clipboard });
    const saved = result.code === 'saved';
    // The field is empty either way, so a refusal must not look like a save: it is marked and announced, and the line above says "Not saved" again.
    note.classList.toggle('bad', !saved);
    note.setAttribute('role', saved ? 'status' : 'alert');
    note.textContent = saved ? words.t('panel.settings.just_saved') + (result.clipboardCleared ? '' : ` ${words.t('panel.settings.clipboard_failed')}`) : failureText(words, result.code);
    onChange();
  });
  erase.addEventListener('click', async () => {
    const result = await api.eraseCredential(kind.name);
    note.textContent = result.ok ? words.t('panel.settings.just_erased') : failureText(words, result.status === 401 ? 'locked' : result.status === 0 ? 'unreachable' : result.body?.error);
    if (result.ok) onChange();
  });
  return { box, status };
}

function failureText(words, code) {
  if (code === 'empty') return words.t('panel.settings.empty');
  if (code === 'invalid_value') return words.t('panel.settings.invalid_value');
  if (code === 'locked') return words.t('panel.locked');
  if (code === 'unreachable') return words.t('panel.unreachable');
  return words.t('panel.settings.failed', { code: typeof code === 'string' ? code : 'save_failed' });
}

function boot() {
  const words = makeWords(panelWords);
  const panel = document.getElementById('settings-panel');
  const opener = document.getElementById('open-settings');
  if (!panel || !opener) return;
  opener.textContent = words.t('panel.open_settings');
  const heading = document.createElement('h2');
  heading.textContent = words.t('panel.settings.title');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.textContent = words.t('panel.close');
  const notes = ['how', 'write_only', 'unchecked', 'revoke', 'clipboard', 'no_browser_save'].map((key) => {
    const p = document.createElement('p');
    p.className = 'sm';
    p.textContent = words.t(`panel.settings.${key}`);
    return p;
  });
  const fields = CREDENTIAL_KINDS.map((kind) => ({ kind, ...field(document, words, kind, refresh) }));
  panel.replaceChildren(heading, close, ...notes, ...fields.map((f) => f.box));

  async function refresh() {
    const result = await api.getCredentials();
    const list = Array.isArray(result.body?.credentials) ? result.body.credentials : [];
    for (const { kind, status } of fields) {
      if (result.status === 401) status.textContent = words.t('panel.locked');
      else if (!result.ok) status.textContent = words.t('panel.unreachable');
      else status.textContent = savedLine(words, list.find((c) => c?.name === kind.name));
    }
  }
  opener.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) void refresh(); });
  close.addEventListener('click', () => { panel.hidden = true; });
}

if (typeof document !== 'undefined') boot();
