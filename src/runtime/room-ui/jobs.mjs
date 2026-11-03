// Job panel (control-plane-service.md section 4, "Routes added to the room"): a task and a computer in, "ask to start" out, then the 4-digit match code in large type for the approval window.
// Also "stop everything" and the approval test (one harmless synthetic.noop). All text goes through textContent / DOM APIs. The pure parts are exported for tests.
// The host decides what is accepted; the checks here only save a round trip and say why.
import { makeWords } from './i18n.mjs';
import * as api from './api.mjs';
import panelWords from './words-panels.mjs';

export const TASK_MAX_BYTES = 256;
export const JOBS_POLL_MS = 2000;
// Control characters and the marks that can make text look different from what is hashed (the host's isSafeText ranges; the host's check is the real one).
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export const taskBytes = (text) => new TextEncoder().encode(String(text ?? '')).length;

/** Why a task cannot be sent, as a words code, or null when it can. */
export function taskProblem(text) {
  if (typeof text !== 'string' || text.length === 0) return 'panel.jobs.task_empty';
  if (UNSAFE_RE.test(text) || !text.isWellFormed()) return 'panel.jobs.task_unsafe';
  return taskBytes(text) > TASK_MAX_BYTES ? 'panel.jobs.task_too_long' : null;
}

/** One line for the job list: what it is, on which computer, and where it stands (with the host's fixed code when there is one). */
export function jobLine(words, job) {
  const what = job?.kind === 'test' ? words.t('panel.jobs.kind_test') : String(job?.task ?? '');
  const where = typeof job?.computerId === 'string' && job.computerId ? ` [${job.computerId}]` : '';
  const state = words.t(`panel.jobs.state_${job?.state}`);
  return `${what}${where} \u2014 ${state}${job?.code ? ` (${job.code})` : ''}`;
}

/** The match code to show beside a job: only a job still waiting for its approval has one worth pressing. */
export const codeOf = (job) => (job?.state === 'awaiting_approval' && /^\d{4}$/.test(String(job.matchCode)) ? job.matchCode : null);

/**
 * Ask to start a task. `start(computerId, task)` is api.startJob.
 * @returns {Promise<{ code: 'requested'|'locked'|'unreachable'|string, job?: object }>} a words code from taskProblem, or the host's fixed error code
 */
export async function requestFlow({ computerId, task, start }) {
  const problem = taskProblem(task);
  if (problem) return { code: problem };
  const result = await start(computerId, task);
  if (result.status === 401) return { code: 'locked' };
  if (result.status === 0) return { code: 'unreachable' };
  if (!result.ok || !result.body?.job) return { code: typeof result.body?.error === 'string' ? result.body.error : 'request_failed' };
  return { code: 'requested', job: result.body.job };
}

function failureText(words, code) {
  if (typeof code === 'string' && code.startsWith('panel.')) return words.t(code);
  if (code === 'locked') return words.t('panel.locked');
  if (code === 'unreachable') return words.t('panel.unreachable');
  return words.t('panel.jobs.request_failed', { code: typeof code === 'string' ? code : 'request_failed' });
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function boot() {
  const words = makeWords(panelWords);
  const panel = document.getElementById('jobs-panel');
  const opener = document.getElementById('open-jobs');
  if (!panel || !opener) return;
  opener.textContent = words.t('panel.open_jobs');

  const close = el(document, 'button', 'panel-close', words.t('panel.close'));
  close.type = 'button';
  const select = document.createElement('select');
  select.name = 'computerId';
  const task = document.createElement('textarea');
  task.name = 'task';
  task.rows = 3;
  task.maxLength = 512;
  task.spellcheck = false;
  const counter = el(document, 'span', 'sm sub');
  const request = el(document, 'button', 'primary', words.t('panel.jobs.request'));
  request.type = 'button';
  const message = el(document, 'p', 'sm');
  message.setAttribute('role', 'status');
  const matchHelp = el(document, 'p', 'sm', words.t('panel.jobs.match_help'));
  matchHelp.hidden = true;
  const stopAll = el(document, 'button', 'danger', words.t('panel.jobs.stop_all'));
  stopAll.type = 'button';
  const test = el(document, 'button', '', words.t('panel.jobs.test'));
  test.type = 'button';
  const list = el(document, 'ul', 'job-list');
  const label = (text, control) => { const l = document.createElement('label'); l.append(el(document, 'span', '', text), control); return l; };

  panel.replaceChildren(
    el(document, 'h2', '', words.t('panel.jobs.title')), close,
    label(words.t('panel.jobs.computer'), select), label(words.t('panel.jobs.task'), task), counter, request, message, matchHelp,
    el(document, 'div', 'panel-row', undefined), el(document, 'p', 'sm sub', words.t('panel.jobs.stop_all_help')),
    el(document, 'p', 'sm sub', words.t('panel.jobs.test_help')), el(document, 'h3', '', words.t('panel.jobs.list')), list,
  );
  panel.querySelector('.panel-row').append(stopAll, test);

  let timer;
  const showCounter = () => { counter.textContent = words.t('panel.jobs.bytes', { bytes: taskBytes(task.value) }); };
  task.addEventListener('input', showCounter);
  showCounter();

  /** One list entry. Every job still waiting shows ITS OWN code in large type, next to its task and computer, so two waiting jobs are never confused. */
  function jobItem(job) {
    const item = el(document, 'li', '', jobLine(words, job));
    const code = codeOf(job);
    if (code) {
      const box = el(document, 'div', 'match');
      const big = el(document, 'p', 'match-code', code);
      big.setAttribute('aria-label', words.t('panel.jobs.match_title'));
      box.append(el(document, 'span', 'sm', words.t('panel.jobs.match_title')), big);
      item.append(box);
    }
    return item;
  }

  async function refresh() {
    const result = await api.getJobs();
    if (!result.ok) { message.textContent = failureText(words, result.status === 401 ? 'locked' : 'unreachable'); return; }
    const targets = Array.isArray(result.body?.targets) ? result.body.targets : [];
    const chosen = select.value;
    select.replaceChildren(...targets.map((t) => { const o = document.createElement('option'); o.value = t.computerId; o.textContent = t.label; return o; }));
    if (targets.some((t) => t.computerId === chosen)) select.value = chosen;
    if (targets.length === 0) message.textContent = words.t('panel.jobs.no_targets');
    const jobs = Array.isArray(result.body?.jobs) ? result.body.jobs : [];
    list.replaceChildren(...(jobs.length ? [...jobs].reverse().map((job) => jobItem(job)) : [el(document, 'li', 'sub', words.t('panel.jobs.none'))]));
    matchHelp.hidden = !jobs.some((job) => codeOf(job));
  }
  const loop = async () => { await refresh(); timer = setTimeout(() => { void loop(); }, JOBS_POLL_MS); };

  request.addEventListener('click', async () => {
    const result = await requestFlow({ computerId: select.value, task: task.value, start: api.startJob });
    if (result.code !== 'requested') { message.textContent = failureText(words, result.code); return; }
    message.textContent = '';
    task.value = '';
    showCounter();
    void refresh();
  });
  test.addEventListener('click', async () => {
    const result = await api.approvalTest();
    if (!result.ok || !result.body?.job) { message.textContent = failureText(words, result.status === 401 ? 'locked' : result.status === 0 ? 'unreachable' : result.body?.error); return; }
    message.textContent = '';
    void refresh();
  });
  stopAll.addEventListener('click', async () => {
    const result = await api.stopAllJobs();
    message.textContent = result.ok
      ? words.t('panel.jobs.stopped', { cancelled: result.body?.cancelled ?? 0, stopped: result.body?.stopped ?? '?' })
      : words.t('panel.jobs.stop_failed', { code: result.body?.error ?? (result.status === 0 ? 'unreachable' : 'stop_failed') });
    void refresh();
  });
  opener.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    clearTimeout(timer);
    if (!panel.hidden) void loop();
  });
  close.addEventListener('click', () => { panel.hidden = true; clearTimeout(timer); });
}

if (typeof document !== 'undefined') boot();
