// Talk panel (docs/architecture/mission-approval.md, roadmap Phase 1; spec/room.md section 10): say something to Bero, read the answer, and when Bero proposes a job, press "Ask to start" on its card.
// The card sends the proposal's goal to the EXISTING job route as the task (api.startJob, the same call as the Jobs panel), so the person approves that one task in the approval window as always.
// This panel never starts anything by itself, and it shows no number of runs or minutes: in this version nothing enforces one, so saying it would be a promise.
// All text, the model's included, goes through textContent / DOM APIs. The pure parts are exported for tests; the browser part runs only where there is a document.
import { makeWords } from './i18n.mjs';
import * as api from './api.mjs';
import { codeOf, failureText as jobFailureText, requestFlow } from './jobs.mjs';
import panelWords from './words-panels.mjs';
import talkWords from './words-talk.mjs';

export const TALK_WORDS_MAX = 1000;
export const TALK_POLL_MS = 2000;
// Control characters (newline and tab allowed here: it is the person's own text) and the marks that can make text look different from what it is; the host's check is the real one.
const UNSAFE_RANGES = Object.freeze([[0, 8], [0x0b, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]);

const hasUnsafeChar = (text) => {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (UNSAFE_RANGES.some(([first, last]) => code >= first && code <= last)) return true;
  }
  return false;
};

/** Why these words cannot be sent, as the host's fixed code, or null when they can. */
export function wordsProblem(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return 'words_empty';
  if (text.length > TALK_WORDS_MAX) return 'words_too_long';
  return !text.isWellFormed() || hasUnsafeChar(text) ? 'words_unsafe' : null;
}

/** The failure of an api.mjs result as a code: `locked`, `unreachable`, the host's fixed error code, or `request_failed`. null when it worked. */
export function resultCode(result) {
  if (result?.ok) return null;
  if (result?.status === 401) return 'locked';
  if (!result || result.status === 0) return 'unreachable';
  return typeof result.body?.error === 'string' ? result.body.error : 'request_failed';
}

/** One fixed line for a failure code. A code with no line of its own is said with the code, never as a bare key. */
export function failureLine(words, code) {
  if (code === 'locked') return words.t('panel.locked');
  if (code === 'unreachable') return words.t('panel.unreachable');
  const key = `talk.err.${code}`;
  const line = words.t(key);
  return line === key ? words.t('talk.err.generic', { code: String(code).slice(0, 40) }) : line;
}

/**
 * Send the person's words. `send(text)` is api.sendTalk.
 * @returns {Promise<{ code: 'sent', body: object } | { code: string }>} the host's body (with the whole conversation) or a failure code
 */
export async function sendFlow({ text, send }) {
  const problem = wordsProblem(text);
  if (problem) return { code: problem };
  const result = await send(text);
  if (result.ok && Array.isArray(result.body?.messages)) return { code: 'sent', body: result.body };
  return { code: resultCode(result) ?? 'request_failed' };
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const button = (doc, className, text) => { const b = el(doc, 'button', className, text); b.type = 'button'; return b; };

/** The match code of a requested job, in large type, like the Jobs panel shows it (the job list there keeps it up to date). */
function matchNode(doc, words, code) {
  const box = el(doc, 'div', 'match');
  const big = el(doc, 'p', 'match-code', code);
  big.setAttribute('aria-label', words.t('talk.card_match'));
  box.append(el(doc, 'span', 'sm', words.t('talk.card_match')), big);
  return box;
}

/** "Ask to start": the existing job route with the goal as the task. The result is told on the card; the approval itself happens in the approval window. */
async function askToStart({ doc, words, proposal, parts }) {
  parts.ask.disabled = true;
  const result = await requestFlow({ computerId: proposal.computerId, task: proposal.goal, start: api.startJob });
  if (result.code !== 'requested') {
    parts.note.textContent = jobFailureText(words, result.code);
    parts.ask.disabled = false;
    return;
  }
  parts.note.textContent = words.t('talk.card_sent');
  const code = codeOf(result.job);
  if (code) parts.card.append(matchNode(doc, words, code));
}

/** The job request card: the goal and the computer, nothing else (no count, no minutes), and the button. */
export function cardNode(doc, words, proposal) {
  const card = el(doc, 'div', 'talk-card');
  const ask = button(doc, 'primary', words.t('talk.card_ask'));
  const note = el(doc, 'p', 'sm');
  note.setAttribute('role', 'status');
  card.append(
    el(doc, 'h3', '', words.t('talk.card_title')),
    el(doc, 'p', 'sm sub', words.t('talk.card_goal')), el(doc, 'p', 'talk-goal', String(proposal.goal ?? '')),
    el(doc, 'p', 'sm sub', words.t('talk.card_computer')), el(doc, 'p', 'talk-computer', String(proposal.label ?? '')),
    ask, note,
  );
  ask.addEventListener('click', () => { void askToStart({ doc, words, proposal, parts: { card, ask, note } }); });
  return card;
}

/** One message of the conversation: who said it, the text, and the card when it carries a proposal. */
export function messageNode(doc, words, message) {
  const you = message?.who === 'you';
  const item = el(doc, 'div', `talk-msg ${you ? 'you' : 'bero'}`);
  item.append(el(doc, 'p', 'sm sub', words.t(you ? 'talk.you' : 'talk.bero')), el(doc, 'p', 'talk-text', String(message?.text ?? '')));
  if (message?.proposal && typeof message.proposal === 'object') item.append(cardNode(doc, words, message.proposal));
  return item;
}

function buildPanel(doc, words) {
  const ui = {
    close: button(doc, 'panel-close', words.t('panel.close')),
    log: el(doc, 'div', 'talk-log'),
    status: el(doc, 'p', 'sm'),
    input: doc.createElement('textarea'),
    counter: el(doc, 'span', 'sm sub'),
    send: button(doc, 'primary', words.t('talk.send')),
    reset: button(doc, '', words.t('talk.reset')),
  };
  ui.status.setAttribute('role', 'status');
  ui.input.name = 'words';
  ui.input.rows = 4;
  ui.input.maxLength = TALK_WORDS_MAX;
  ui.input.spellcheck = false;
  const label = doc.createElement('label');
  label.append(el(doc, 'span', '', words.t('talk.words_label')), ui.input);
  const row = el(doc, 'div', 'panel-row');
  row.append(ui.send, ui.reset);
  ui.nodes = [el(doc, 'h2', '', words.t('talk.title')), ui.close, el(doc, 'p', 'sm sub', words.t('talk.how')), ui.log, ui.status, label, ui.counter, row, el(doc, 'p', 'sm sub', words.t('talk.memory'))];
  return ui;
}

/** What the panel does: show the conversation the host keeps, send words, clear. `mode` is the little state it needs (poll timer, a send in flight, whether the main AI is switched on). */
function createController(words, ui, panel) {
  const mode = { timer: undefined, sending: false, available: true };
  const showCounter = () => { ui.counter.textContent = words.t('talk.chars', { chars: ui.input.value.length }); };
  const setSending = (on) => {
    mode.sending = on;
    ui.send.disabled = on || !mode.available;
    ui.reset.disabled = on;
    ui.status.textContent = on ? words.t('talk.thinking') : '';
  };
  /** The conversation the host sent: every message again (a card keeps its own state only until the next render), and the "not available" line when the main AI is off. */
  function show(body) {
    mode.available = body.available !== false;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    ui.log.replaceChildren(...(messages.length ? messages.map((m) => messageNode(document, words, m)) : [el(document, 'p', 'sub', words.t('talk.none'))]));
    ui.log.scrollTop = ui.log.scrollHeight;
    ui.send.disabled = mode.sending || !mode.available;
    ui.status.textContent = !mode.available ? failureLine(words, 'main_ai_disabled') : body.busy ? words.t('talk.thinking') : '';
  }
  async function refresh() {
    clearTimeout(mode.timer);
    const result = await api.getTalk();
    if (!result.ok || !result.body) { ui.status.textContent = failureLine(words, resultCode(result) ?? 'request_failed'); return; }
    show(result.body);
    if (result.body.busy && !panel.hidden) mode.timer = setTimeout(() => { void refresh(); }, TALK_POLL_MS);
  }
  async function onSend() {
    if (mode.sending || !mode.available) return;
    setSending(true);
    const result = await sendFlow({ text: ui.input.value, send: api.sendTalk });
    setSending(false);
    if (result.code !== 'sent') { ui.status.textContent = failureLine(words, result.code); return; } // the words stay in the box, to be sent again
    ui.input.value = '';
    showCounter();
    show(result.body);
  }
  async function onReset() {
    const result = await api.resetTalk();
    if (!result.ok || !result.body) { ui.status.textContent = failureLine(words, resultCode(result) ?? 'request_failed'); return; }
    show(result.body);
  }
  return { showCounter, refresh, onSend, onReset, stopPolling: () => clearTimeout(mode.timer) };
}

function boot() {
  const words = makeWords(talkWords, panelWords);
  const panel = document.getElementById('talk-panel');
  const opener = document.getElementById('open-talk');
  if (!panel || !opener) return;
  opener.textContent = words.t('talk.open');
  const ui = buildPanel(document, words);
  panel.replaceChildren(...ui.nodes);
  const talk = createController(words, ui, panel);
  talk.showCounter();
  ui.input.addEventListener('input', talk.showCounter);
  ui.input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault?.(); void talk.onSend(); } });
  ui.send.addEventListener('click', () => { void talk.onSend(); });
  ui.reset.addEventListener('click', () => { void talk.onReset(); });
  ui.close.addEventListener('click', () => { panel.hidden = true; talk.stopPolling(); });
  opener.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    talk.stopPolling();
    if (!panel.hidden) void talk.refresh();
  });
}

if (typeof document !== 'undefined') boot();
