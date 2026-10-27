const $ = (id) => document.getElementById(id);
let csrfToken;
let lastEventId = 0;
let refreshTimer;
let eventStream;
let approvalSignature;
let runSignature;

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (method !== 'GET' && csrfToken) headers['X-ALBERA-CSRF'] = csrfToken;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `request_failed_${response.status}`);
  return data;
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = String(value ?? '');
  if (className) element.className = className;
  return element;
}

function button(label, action, secondary = false) {
  const element = text('button', label, secondary ? 'secondary' : '');
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

async function refresh() {
  try {
    const [approvals, runs] = await Promise.all([
      request('/api/approvals'), request('/api/runs'),
    ]);
    renderApprovals(approvals.approvals);
    renderRuns(runs.runs);
    $('connection').textContent = 'Connected to the local Runtime host';
  } catch (error) {
    $('connection').textContent = `Runtime unavailable: ${error.message}`;
  } finally {
    refreshTimer = setTimeout(refresh, 1500);
  }
}

function renderApprovals(items) {
  const signature = JSON.stringify(items);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  const root = $('approvals');
  root.replaceChildren();
  if (!items.length) return root.append(text('p', 'No pending decisions.', 'empty'));
  for (const item of items) {
    const card = text('article', '', 'card');
    card.append(text('h3', `${item.request.action} · ${item.request.provider}`));
    card.append(text('p', `Decision expires at ${new Date(item.expiresAt).toLocaleTimeString()}`, 'muted'));
    const details = document.createElement('dl');
    for (const key of ['profile', 'executable', 'cwd', 'runId', 'platform', 'maxDurationMs', 'maxActive', 'force']) {
      if (item.request[key] !== undefined) {
        details.append(text('dt', key), text('dd', item.request[key]));
      }
    }
    if (item.request.args) {
      details.append(text('dt', 'fixed arguments'));
      const args = text('dd', item.request.args.join('\n'));
      details.append(args);
    }
    if (item.request.environment) {
      details.append(text('dt', 'environment names'));
      details.append(text('dd', item.request.environment.providerVariables.join(', ') || 'none'));
      for (const endpoint of item.request.environment.endpointOverrides) {
        details.append(text('dt', `${endpoint.variable} endpoint`), text('dd', `${endpoint.protocol}://${endpoint.host ?? 'invalid'}`));
      }
    }
    card.append(details);
    if (item.request.initialInput !== undefined || item.request.text !== undefined) {
      card.append(text('h4', 'Exact text to send'));
      card.append(text('pre', item.request.initialInput ?? item.request.text));
    }
    const actions = text('div', '', 'actions');
    actions.append(button('Approve', () => decide(item.id, 'approve')), button('Deny', () => decide(item.id, 'deny'), true));
    card.append(actions);
    root.append(card);
  }
}

function renderRuns(items) {
  const signature = JSON.stringify(items);
  if (signature === runSignature) return;
  runSignature = signature;
  const root = $('runs');
  root.replaceChildren();
  if (!items.length) return root.append(text('p', 'No Runtime sessions yet.', 'empty'));
  for (const run of items) {
    const card = text('article', '', 'card');
    card.append(text('h3', `${run.provider} · ${run.status}`));
    card.append(text('p', `Run ${run.id}`, 'muted'));
    card.append(text('p', `Profile: ${run.profile ?? 'unknown'}`));
    if (['starting', 'running', 'stopping'].includes(run.status)) {
      const controls = text('div', '', 'actions');
      controls.append(button('Request stop', () => stop(run.id), true));
      if (run.inputMode === 'claude-stream-json' && run.status === 'running') {
        const form = document.createElement('form');
        const input = document.createElement('textarea');
        input.required = true;
        input.maxLength = 16000;
        input.setAttribute('aria-label', 'Exact follow-up text');
        const send = text('button', 'Request approved input');
        send.type = 'submit';
        form.append(input, send);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          try { await request(`/api/runs/${run.id}/input`, { method: 'POST', body: { text: input.value } }); input.value = ''; }
          catch (error) { $('form-status').textContent = error.message; }
        });
        controls.append(form);
      }
      card.append(controls);
    }
    root.append(card);
  }
}

function renderEvents(items) {
  const root = $('events');
  for (const event of items) {
    lastEventId = Math.max(lastEventId, event.id);
    if (root.querySelector(`[data-event-id="${event.id}"]`)) continue;
    const item = text('li', `${new Date(event.at).toLocaleTimeString()} · ${event.provider} · ${event.type} · ${event.runId}`);
    item.dataset.eventId = String(event.id);
    root.prepend(item);
  }
  while (root.children.length > 100) root.lastElementChild.remove();
}

async function decide(id, decision) {
  try { await request(`/api/approvals/${id}`, { method: 'POST', body: { decision } }); await refreshOnce(); }
  catch (error) { $('connection').textContent = `Decision not accepted: ${error.message}`; }
}

async function stop(id) {
  try { await request(`/api/runs/${id}/stop`, { method: 'POST' }); }
  catch (error) { $('form-status').textContent = error.message; }
}

async function refreshOnce() {
  clearTimeout(refreshTimer);
  await refresh();
}

async function start(event) {
  event.preventDefault();
  const buttonElement = event.submitter;
  buttonElement.disabled = true;
  $('form-status').textContent = 'Waiting for the host approval decision…';
  try {
    await request('/api/runs', { method: 'POST', body: {
      provider: 'claude', cwd: $('root').value, prompt: $('prompt').value,
      profile: $('profile').value,
    } });
    $('prompt').value = '';
    $('form-status').textContent = 'Run started. Provider output is not collected.';
  } catch (error) {
    $('form-status').textContent = `Run was not started: ${error.message}`;
  } finally {
    buttonElement.disabled = false;
    await refreshOnce();
  }
}

async function initialize() {
  $('bootstrap-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = $('bootstrap-code').value;
    $('bootstrap-code').value = '';
    try { await useSession(await request('/api/session', { method: 'POST', body: { bootstrapCode: code } })); }
    catch (error) { $('bootstrap-status').textContent = `Could not unlock this host: ${error.message}`; }
  });
  try {
    const session = await request('/api/session');
    await useSession(session);
  } catch {
    $('connection').textContent = 'Enter the one-time code printed by the Runtime host.';
  }
}

async function useSession(session) {
  csrfToken = session.csrfToken;
  const root = $('root');
  root.replaceChildren();
  for (const allowedRoot of session.roots) {
    const option = document.createElement('option');
    option.value = allowedRoot;
    option.textContent = allowedRoot;
    root.append(option);
  }
  if (!session.roots.length) throw new Error('No allowed project roots were configured.');
  $('bootstrap').hidden = true;
  $('controls').hidden = false;
  $('start-form').addEventListener('submit', start);
  eventStream = new EventSource('/api/events/stream?after=0');
  eventStream.addEventListener('lifecycle', (event) => {
    try { renderEvents([JSON.parse(event.data)]); } catch { $('connection').textContent = 'A lifecycle event could not be displayed.'; }
  });
  eventStream.addEventListener('error', () => { $('connection').textContent = 'Reconnecting to lifecycle events…'; });
  await refresh();
}

window.addEventListener('pagehide', () => { clearTimeout(refreshTimer); eventStream?.close(); }, { once: true });
void initialize();
