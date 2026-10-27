const $ = (id) => document.getElementById(id);
const locale = /^ja(?:-|$)/i.test(globalThis.navigator?.language ?? '') ? 'ja' : 'en';
const messages = {
  en: {
    title: 'Runtime control', lede: 'A separate local control surface. Every start, input, and stop waits for your decision.',
    connected: 'Connected to the local Runtime host', connectCode: 'Enter the one-time code printed by the Runtime host.',
    expired: 'Runtime browser session expired. Restart ALBERA Runtime and open the new URL printed in its terminal.',
    unavailable: 'Runtime unavailable: {0}', bootstrapTitle: 'Unlock this Runtime host',
    bootstrapDescription: 'Enter the one-time code printed by the terminal that started ALBERA Runtime. The code is not saved.',
    codeLabel: 'One-time terminal code', unlock: 'Unlock local controls', startTitle: 'Start a read-only Claude session',
    rootLabel: 'Allowed project root', promptLabel: 'Task prompt', profileLabel: 'Session profile', readOnly: 'Read only',
    readOnlyInput: 'Read only with approved input', requestStart: 'Request start', approvalsTitle: 'Waiting for your decision',
    runsTitle: 'Runtime sessions', runsWarning: 'Provider output is discarded. Send follow-up text only when you independently know the provider is waiting for it.',
    eventsTitle: 'Recent lifecycle events', footer: 'Local loopback only · prompts and paths are not saved by this screen · provider output is not collected',
    noApprovals: 'No pending decisions.', expires: 'Decision expires at {0}', fixedArguments: 'fixed arguments',
    environmentNames: 'environment names', none: 'none', endpoint: 'endpoint', exactText: 'Exact text to send',
    providerDisclosure: 'The configured Claude account may send approved text to an external provider and may incur charges. Runtime cannot identify the account or estimate cost. Check your CLI account before approval.',
    approve: 'Approve', deny: 'Deny', noRuns: 'No Runtime sessions yet.', run: 'Run {0}', profile: 'Profile: {0}',
    action_start: 'Start request', action_stop: 'Stop request', action_input: 'Input request',
    field_executable: 'executable', field_cwd: 'working directory', field_runId: 'run ID', field_platform: 'platform',
    field_maxDurationMs: 'maximum duration (ms)', field_maxActive: 'maximum active runs', field_force: 'force stop',
    status_starting: 'starting', status_running: 'running', status_stopping: 'stopping', status_stopped: 'stopped',
    status_exited: 'exited', status_failed: 'failed', status_interrupted: 'interrupted', status_started: 'started',
    status_stop_requested: 'stop requested', status_input_sent: 'input sent', status_stop_failed: 'stop failed',
    stop: 'Request stop', followupLabel: 'Exact follow-up text', requestInput: 'Request approved input',
    decisionError: 'Decision not accepted: {0}', waitingApproval: 'Waiting for the host approval decision…',
    runStarted: 'Run started. Provider output is not collected.', runFailed: 'Run was not started: {0}',
    unlockFailed: 'Could not unlock this host: {0}', noRoots: 'No allowed project roots were configured.',
    eventDisplayFailed: 'A lifecycle event could not be displayed.', reconnecting: 'Reconnecting to lifecycle events…',
  },
  ja: {
    title: 'Runtime 操作', lede: '読み取り専用Observerから独立したローカル操作画面です。起動・入力・停止は毎回あなたの承認を待ちます。',
    connected: 'ローカルRuntimeホストに接続しました', connectCode: 'Runtimeホストの端末に表示された一回限りのコードを入力してください。',
    expired: 'Runtimeのブラウザーセッションが期限切れです。ALBERA Runtimeを再起動し、端末に表示された新しいURLを開いてください。',
    unavailable: 'Runtimeを利用できません: {0}', bootstrapTitle: 'Runtimeホストのロック解除',
    bootstrapDescription: 'ALBERA Runtimeを起動した端末に表示された一回限りのコードを入力してください。コードは保存されません。',
    codeLabel: '端末の一回限りコード', unlock: 'ローカル操作を開始', startTitle: '読み取り専用Claudeセッションを起動',
    rootLabel: '許可されたプロジェクトルート', promptLabel: 'タスク指示', profileLabel: 'セッションプロファイル', readOnly: '読み取り専用',
    readOnlyInput: '承認済み入力を使う読み取り専用', requestStart: '起動を申請', approvalsTitle: 'あなたの判断待ち',
    runsTitle: 'Runtimeセッション', runsWarning: 'プロバイダーの出力は破棄されます。プロバイダーが入力待ちだと自分で確認できた場合にのみ、追加テキストを送ってください。',
    eventsTitle: '最近のライフサイクルイベント', footer: 'ローカルループバックのみ · この画面は指示文やパスを保存しません · プロバイダー出力は収集しません',
    noApprovals: '判断待ちの要求はありません。', expires: '判断期限: {0}', fixedArguments: '固定引数',
    environmentNames: '環境変数名', none: 'なし', endpoint: 'エンドポイント', exactText: '送信するテキスト',
    providerDisclosure: '設定されたClaudeアカウントから、承認したテキストが外部プロバイダーへ送信され、費用が発生する場合があります。Runtimeはアカウントや費用を確認できません。承認前にCLIのアカウント設定を確認してください。',
    approve: '承認', deny: '拒否', noRuns: 'Runtimeセッションはまだありません。', run: '実行 {0}', profile: 'プロファイル: {0}',
    action_start: '起動要求', action_stop: '停止要求', action_input: '入力要求',
    field_executable: '実行ファイル', field_cwd: '作業ディレクトリ', field_runId: '実行ID', field_platform: 'OS',
    field_maxDurationMs: '最大実行時間 (ms)', field_maxActive: '同時実行上限', field_force: '強制停止',
    status_starting: '起動中', status_running: '実行中', status_stopping: '停止中', status_stopped: '停止済み',
    status_exited: '終了', status_failed: '失敗', status_interrupted: '中断', status_started: '起動',
    status_stop_requested: '停止要求', status_input_sent: '入力送信済み', status_stop_failed: '停止失敗',
    stop: '停止を申請', followupLabel: '送信する追加テキスト', requestInput: '入力を申請',
    decisionError: '判断を受け付けられませんでした: {0}', waitingApproval: 'ホストの承認を待っています…',
    runStarted: '実行を開始しました。プロバイダー出力は収集されません。', runFailed: '実行を開始できませんでした: {0}',
    unlockFailed: 'ホストのロックを解除できませんでした: {0}', noRoots: '許可されたプロジェクトルートが設定されていません。',
    eventDisplayFailed: 'ライフサイクルイベントを表示できませんでした。', reconnecting: 'ライフサイクルイベントに再接続しています…',
  },
};
function t(key, ...values) {
  const template = messages[locale][key] ?? messages.en[key] ?? key;
  return values.reduce((result, value, index) => result.replaceAll(`{${index}}`, String(value)), template);
}
function describe(key, value) {
  if (value === 'read-only') return t('readOnly');
  if (value === 'read-only-streaming') return t('readOnlyInput');
  return messages[locale][`${key}_${value}`] ?? value;
}
function translateStaticText() {
  if (document.documentElement) document.documentElement.lang = locale;
  const ids = {
    'runtime-control-title': 'title', 'runtime-control-lede': 'lede', 'bootstrap-title': 'bootstrapTitle',
    'bootstrap-description': 'bootstrapDescription', 'bootstrap-code-label': 'codeLabel', 'unlock-button': 'unlock',
    'start-title': 'startTitle', 'root-label': 'rootLabel', 'prompt-label': 'promptLabel', 'profile-label': 'profileLabel',
    'start-button': 'requestStart', 'approvals-title': 'approvalsTitle', 'runs-title': 'runsTitle',
    'provider-disclosure': 'providerDisclosure', 'runs-warning': 'runsWarning', 'events-title': 'eventsTitle', 'runtime-footer': 'footer',
  };
  for (const [id, key] of Object.entries(ids)) $(id).textContent = t(key);
  const profile = $('profile');
  if (profile.options?.[0]) profile.options[0].textContent = t('readOnly');
  if (profile.options?.[1]) profile.options[1].textContent = t('readOnlyInput');
}
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
  if (!response.ok) {
    const error = new Error(data.error || `request_failed_${response.status}`);
    error.status = response.status;
    throw error;
  }
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
  let retry = true;
  try {
    const [approvals, runs] = await Promise.all([
      request('/api/approvals'), request('/api/runs'),
    ]);
    renderApprovals(approvals.approvals);
    renderRuns(runs.runs);
    $('connection').textContent = t('connected');
  } catch (error) {
    if (error.status === 401) {
      retry = false;
      eventStream?.close();
      $('controls').hidden = true;
      $('connection').textContent = t('expired');
    } else {
      $('connection').textContent = t('unavailable', error.message);
    }
  } finally {
    if (retry) refreshTimer = setTimeout(refresh, 1500);
  }
}

function renderApprovals(items) {
  const signature = JSON.stringify(items);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  const root = $('approvals');
  root.replaceChildren();
  if (!items.length) return root.append(text('p', t('noApprovals'), 'empty'));
  for (const item of items) {
    const card = text('article', '', 'card');
    card.append(text('h3', `${describe('action', item.request.action)} · ${item.request.provider}`));
    card.append(text('p', t('expires', new Date(item.expiresAt).toLocaleTimeString(locale)), 'muted'));
    if (['start', 'input'].includes(item.request.action)) {
      const disclosure = text('p', t('providerDisclosure'), 'notice');
      disclosure.setAttribute('role', 'note');
      card.append(disclosure);
    }
    const details = document.createElement('dl');
    const fieldLabels = { profile: t('profileLabel'), executable: t('field_executable'), cwd: t('field_cwd'), runId: t('field_runId'), platform: t('field_platform'), maxDurationMs: t('field_maxDurationMs'), maxActive: t('field_maxActive'), force: t('field_force') };
    for (const key of ['profile', 'executable', 'cwd', 'runId', 'platform', 'maxDurationMs', 'maxActive', 'force']) {
      if (item.request[key] !== undefined) {
        details.append(text('dt', fieldLabels[key] ?? key), text('dd', key === 'profile' ? describe('profile', item.request[key]) : item.request[key]));
      }
    }
    if (item.request.args) {
      details.append(text('dt', t('fixedArguments')));
      const args = text('dd', item.request.args.join('\n'));
      details.append(args);
    }
    if (item.request.environment) {
      details.append(text('dt', t('environmentNames')));
      details.append(text('dd', item.request.environment.providerVariables.join(', ') || t('none')));
      for (const endpoint of item.request.environment.endpointOverrides) {
        details.append(text('dt', `${endpoint.variable} ${t('endpoint')}`), text('dd', `${endpoint.protocol}://${endpoint.host ?? 'invalid'}`));
      }
    }
    card.append(details);
    if (item.request.initialInput !== undefined || item.request.text !== undefined) {
      card.append(text('h4', t('exactText')));
      card.append(text('pre', item.request.initialInput ?? item.request.text));
    }
    const actions = text('div', '', 'actions');
    actions.append(button(t('approve'), () => decide(item.id, 'approve')), button(t('deny'), () => decide(item.id, 'deny'), true));
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
  if (!items.length) return root.append(text('p', t('noRuns'), 'empty'));
  for (const run of items) {
    const card = text('article', '', 'card');
    card.append(text('h3', `${run.provider} · ${describe('status', run.status)}`));
    card.append(text('p', t('run', run.id), 'muted'));
    card.append(text('p', t('profile', run.profile ?? 'unknown')));
    if (['starting', 'running', 'stopping'].includes(run.status)) {
      const controls = text('div', '', 'actions');
      controls.append(button(t('stop'), () => stop(run.id), true));
      if (run.inputMode === 'claude-stream-json' && run.status === 'running') {
        const form = document.createElement('form');
        const input = document.createElement('textarea');
        input.required = true;
        input.maxLength = 16000;
        input.setAttribute('aria-label', t('followupLabel'));
        const send = text('button', t('requestInput'));
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
    const item = text('li', `${new Date(event.at).toLocaleTimeString(locale)} · ${event.provider} · ${describe('status', event.type)} · ${event.runId}`);
    item.dataset.eventId = String(event.id);
    root.prepend(item);
  }
  while (root.children.length > 100) root.lastElementChild.remove();
}

async function decide(id, decision) {
  try { await request(`/api/approvals/${id}`, { method: 'POST', body: { decision } }); await refreshOnce(); }
  catch (error) { $('connection').textContent = t('decisionError', error.message); }
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
  $('form-status').textContent = t('waitingApproval');
  try {
    await request('/api/runs', { method: 'POST', body: {
      provider: 'claude', cwd: $('root').value, prompt: $('prompt').value,
      profile: $('profile').value,
    } });
    $('prompt').value = '';
    $('form-status').textContent = t('runStarted');
  } catch (error) {
    $('form-status').textContent = t('runFailed', error.message);
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
    catch (error) { $('bootstrap-status').textContent = t('unlockFailed', error.message); }
  });
  translateStaticText();
  try {
    const session = await request('/api/session');
    await useSession(session);
  } catch {
    $('connection').textContent = t('connectCode');
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
  if (!session.roots.length) throw new Error(t('noRoots'));
  $('bootstrap').hidden = true;
  $('controls').hidden = false;
  $('start-form').addEventListener('submit', start);
  eventStream = new EventSource('/api/events/stream?after=0');
  eventStream.addEventListener('lifecycle', (event) => {
    try { renderEvents([JSON.parse(event.data)]); } catch { $('connection').textContent = t('eventDisplayFailed'); }
  });
  eventStream.addEventListener('error', () => { $('connection').textContent = t('reconnecting'); });
  await refresh();
}

window.addEventListener('pagehide', () => { clearTimeout(refreshTimer); eventStream?.close(); }, { once: true });
void initialize();
