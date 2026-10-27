import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';
import { createRuntimeHost } from '../src/runtime/host.mjs';
import { parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';
import { loadOrCreateRuntimeSessionId } from '../src/runtime/session-identity.mjs';

const openTestJournal = (filePath, options = {}) => openRuntimeAuditJournal(filePath, { ...options, verifyWindowsAcl: async () => {} });
const loadTestSessionId = (journalPath) => loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl: async () => {} });

function fakeChild() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    setTimeout(() => { child.signalCode = signal; child.emit('close', null, signal); }, 10);
    return true;
  };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

async function fixture(t, hostOptions = {}, { authenticate = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-approval-host-'));
  const journal = await openTestJournal(path.join(root, 'runtime.audit.jsonl'));
  const runtime = createRuntimeHost({
    roots: [root],
    journal,
    hostOptions,
    gatewayOptions: {
      resolveExecutableImpl: async () => process.execPath,
      buildLaunchImpl: (_provider, profile) => ({ profile, args: [] }),
      spawnImpl: () => fakeChild(),
      signalTreeImpl: (_pid, signal, child) => child.kill(signal),
      env: {},
    },
  });
  const address = await runtime.listen();
  const base = address.url.slice(0, -1);
  const origin = new URL(base).origin;
  let session;
  let cookie;
  let headers;
  let postHeaders;
  if (authenticate) {
    const sessionResponse = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ bootstrapCode: address.bootstrapCode }),
    });
    session = await sessionResponse.json();
    cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
    headers = { Cookie: cookie };
    postHeaders = { ...headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-ALBERA-CSRF': session.csrfToken };
  }
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, journal, address, base, origin, session, cookie, headers, postHeaders, root };
}

test('concurrent bootstrap requests can consume the one-time code only once', async (t) => {
  const f = await fixture(t, {}, { authenticate: false });
  const headers = { Origin: f.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
  const body = JSON.stringify({ bootstrapCode: f.address.bootstrapCode });
  const responses = await Promise.all([1, 2].map(() => fetch(`${f.base}/api/session`, { method: 'POST', headers, body })));

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
  assert.equal(responses.filter((response) => response.headers.has('set-cookie')).length, 1);
});

test('approval-host POST bodies time out without consuming a bootstrap code', async (t) => {
  const f = await fixture(t, { requestBodyTimeoutMs: 100 }, { authenticate: false });
  const request = http.request(new URL(`${new URL(f.base).pathname}/api/session`, f.base), {
    method: 'POST',
    headers: {
      Origin: f.origin,
      'Content-Type': 'application/json',
      'Content-Length': '100',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  const outcome = new Promise((resolve) => {
    request.once('response', (response) => { response.resume(); resolve({ type: 'response', status: response.statusCode }); });
    request.once('error', (error) => resolve({ type: 'error', code: error.code }));
  });
  request.write('{"bootstrapCode":');

  assert.equal((await outcome).type, 'error');
  const retry = await fetch(`${f.base}/api/session`, {
    method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ bootstrapCode: f.address.bootstrapCode }),
  });
  assert.equal(retry.status, 200);

  const session = await retry.json();
  const authenticatedPost = http.request(new URL(`${new URL(f.base).pathname}/api/runs`, f.base), {
    method: 'POST',
    headers: {
      Origin: f.origin,
      'Content-Type': 'application/json',
      'Content-Length': '100',
      Cookie: retry.headers.get('set-cookie').split(';', 1)[0],
      'Sec-Fetch-Site': 'same-origin',
      'X-ALBERA-CSRF': session.csrfToken,
    },
  });
  const authenticatedOutcome = new Promise((resolve) => {
    authenticatedPost.once('response', (response) => { response.resume(); resolve({ type: 'response', status: response.statusCode }); });
    authenticatedPost.once('error', (error) => resolve({ type: 'error', code: error.code }));
  });
  authenticatedPost.write('{"provider":');
  assert.equal((await authenticatedOutcome).type, 'error');
});

async function connectRuntime(root, journal, sessionId, gatewayOverrides = {}) {
  const runtime = createRuntimeHost({
    roots: [root], journal, hostOptions: { sessionId },
    gatewayOptions: {
      resolveExecutableImpl: async () => process.execPath,
      buildLaunchImpl: (_provider, profile) => ({ profile, args: [] }),
      spawnImpl: () => fakeChild(),
      signalTreeImpl: (_pid, signal, child) => child.kill(signal),
      env: {},
      ...gatewayOverrides,
    },
  });
  const address = await runtime.listen();
  const base = address.url.slice(0, -1);
  const origin = new URL(base).origin;
  const sessionResponse = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ bootstrapCode: address.bootstrapCode }),
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie };
  const postHeaders = { ...headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-ALBERA-CSRF': session.csrfToken };
  return { runtime, journal, address, base, origin, session, cookie, headers, postHeaders, root };
}

async function get(f, route, headers = f.headers) { return fetch(`${f.base}${route}`, { headers }); }
async function post(f, route, body, headers = f.postHeaders) {
  return fetch(`${f.base}${route}`, {
    method: 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition_timeout');
}

test('approval host issues one-time HttpOnly SameSite sessions and never serves Runtime API credentials', async (t) => {
  const f = await fixture(t);
  const cookieResponse = await fetch(`${f.base}/api/session`, { headers: f.headers });
  const cookie = cookieResponse.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.ok(cookie.includes(`Path=${new URL(`${f.base}/`).pathname}`));
  assert.equal(cookie.includes(f.session.csrfToken), false);
  const activityResponse = await get(f, '/api/approvals');
  assert.equal(activityResponse.status, 200);
  const refreshedCookie = activityResponse.headers.get('set-cookie');
  assert.ok(refreshedCookie.includes(`Path=${new URL(`${f.base}/`).pathname}`));
  assert.doesNotMatch(refreshedCookie, /Path=undefined/);
  assert.ok(refreshedCookie.endsWith('Max-Age=1200'));
  assert.equal((await fetch(`${f.origin}/api/session`, { headers: f.headers })).status, 404);
  assert.equal((await fetch(`${f.base}/api/session`)).status, 401);
  assert.equal((await fetch(`${f.base}/api/session`, {
    method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapCode: f.address.bootstrapCode }),
  })).status, 403);
  assert.equal((await get(f, '/api/approvals', {})).status, 401);
  assert.equal((await get(f, '/api/approvals', { Cookie: f.cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const html = await fetch(`${f.base}/`);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await html.text(), /ALBERA Runtime approvals/);
  const script = await (await fetch(`${f.base}/approval.mjs`)).text();
  const stylesheet = await (await fetch(`${f.base}/approval.css`)).text();
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(script, /Bearer\s|localStorage|sessionStorage/);
  assert.match(script, /Runtime browser session expired\. Restart ALBERA Runtime/);
  assert.match(script, /eventStream\?\.close\(\)/);
  assert.match(script, /if \(retry\) refreshTimer = setTimeout\(refresh, 1500\)/);
  assert.match(stylesheet, /main\[hidden\]\s*\{\s*display:\s*none;/);
});

test('approval UI closes its lifecycle stream and stops polling when the browser session expires', async () => {
  class FakeElement {
    children = [];
    listeners = new Map();
    hidden = false;
    value = '';
    textContent = '';

    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute() {}
  }

  const elements = new Map();
  const timers = [];
  const calls = [];
  let eventSource;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement() { return new FakeElement(); },
  };
  const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'api/session' && options.method === 'POST') {
      return response(200, { csrfToken: 'synthetic-csrf', roots: ['C:\\project'] });
    }
    if (url === 'api/session') return response(401, { error: 'session_expired' });
    if (url === 'api/approvals' || url === 'api/runs') return response(401, { error: 'session_expired' });
    throw new Error(`unexpected_request_${url}`);
  };
  class FakeEventSource {
    closed = false;
    listeners = new Map();
    constructor(url) { this.url = url; eventSource = this; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
  }

  const source = await readFile(new URL('../src/runtime/approval-ui/approval.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document,
    window: { addEventListener() {} },
    EventSource: FakeEventSource,
    fetch,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  await new Promise((resolve) => {
    const waitForBootstrap = () => {
      if (elements.get('bootstrap-form')?.listeners.has('submit')
        && /one-time code/.test(elements.get('connection')?.textContent ?? '')) return resolve();
      setImmediate(waitForBootstrap);
    };
    waitForBootstrap();
  });
  assert.match(elements.get('connection').textContent, /one-time code/);

  const submit = elements.get('bootstrap-form').listeners.get('submit');
  document.getElementById('bootstrap-code');
  elements.get('bootstrap-code').value = 'synthetic-bootstrap-code';
  await submit({ preventDefault() {} });

  assert.equal(eventSource.url, 'api/events/stream?after=0');
  assert.equal(eventSource.closed, true);
  assert.equal(elements.get('controls').hidden, true);
  assert.match(elements.get('connection').textContent, /Runtime browser session expired/);
  assert.equal(timers.length, 0, 'expired session must not schedule another polling cycle');
  assert.equal(calls.filter((call) => call.url === 'api/runs').length, 1);
});

test('approval UI localizes the control screen for Japanese browsers', async () => {
  class FakeElement {
    children = [];
    listeners = new Map();
    hidden = false;
    value = '';
    textContent = '';
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
  }
  const elements = new Map();
  const document = {
    documentElement: { lang: 'en' },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement() { return new FakeElement(); },
  };
  const response = { ok: false, status: 401, json: async () => ({ error: 'session_expired' }) };
  const source = await readFile(new URL('../src/runtime/approval-ui/approval.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document,
    navigator: { language: 'ja-JP' },
    window: { addEventListener() {} },
    fetch: async () => response,
    setTimeout() { return 1; },
    clearTimeout() {},
  });
  await new Promise((resolve) => {
    const waitForLocalization = () => {
      if (elements.get('bootstrap-form')?.listeners.has('submit')
        && elements.get('connection')?.textContent.includes('一回限りのコード')) return resolve();
      setImmediate(waitForLocalization);
    };
    waitForLocalization();
  });
  assert.equal(document.documentElement.lang, 'ja');
  assert.equal(elements.get('runtime-control-title').textContent, 'Runtime 操作');
  assert.equal(elements.get('start-button').textContent, '起動を申請');
  assert.match(elements.get('filesystem-disclosure').textContent, /OSのサンドボックスではありません/);
  assert.match(elements.get('filesystem-disclosure').textContent, /OSユーザー権限/);
  assert.match(elements.get('provider-disclosure').textContent, /外部プロバイダーへ送信され、費用が発生する場合があります/);
  assert.match(elements.get('connection').textContent, /一回限りのコード/);
});

test('approval UI discloses external transmission, charges, and filesystem scope before approval', async () => {
  class FakeElement {
    children = [];
    listeners = new Map();
    attributes = new Map();
    hidden = false;
    value = '';
    textContent = '';
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute(name, value) { this.attributes.set(name, value); }
  }
  const elements = new Map();
  const document = {
    documentElement: { lang: 'en' },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    createElement() { return new FakeElement(); },
  };
  const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data });
  const fetch = async (url) => {
    if (url === 'api/session') return jsonResponse({ csrfToken: 'synthetic', roots: ['C:\\project'] });
    if (url === 'api/approvals') return jsonResponse({ approvals: [
      {
        id: '12345678-1234-4234-8234-123456789abc', expiresAt: Date.now() + 10000,
        request: { action: 'start', provider: 'claude', executable: 'C:\\tools\\claude.exe', minimumCliVersion: '2.1.259', versionCheck: true, initialInput: 'synthetic task text', args: ['--restricted'] },
      },
      {
        id: '22345678-1234-4234-8234-123456789abc', expiresAt: Date.now() + 10000,
        request: { action: 'input', provider: 'claude', text: 'synthetic follow-up text', runId: '32345678-1234-4234-8234-123456789abc' },
      },
    ] });
    if (url === 'api/runs') return jsonResponse({ runs: [] });
    throw new Error(`unexpected_request_${url}`);
  };
  class FakeEventSource { addEventListener() {} close() {} }
  const source = await readFile(new URL('../src/runtime/approval-ui/approval.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document, window: { addEventListener() {} }, EventSource: FakeEventSource, fetch,
    setTimeout() { return 1; }, clearTimeout() {},
  });
  await new Promise((resolve) => {
    const waitForApproval = () => {
      if (elements.get('approvals')?.children.length) return resolve();
      setImmediate(waitForApproval);
    };
    waitForApproval();
  });
  const cards = elements.get('approvals').children;
  const flatten = (element) => [element.textContent, ...element.children.flatMap(flatten)].join(' ');
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.match(flatten(card), /The allowed root sets only the working directory; it is not a sandbox/);
    assert.match(flatten(card), /runs with your OS account permissions and may access other local files and resources/);
    assert.match(flatten(card), /may send approved text to an external provider and may incur charges/);
    const notices = card.children.filter((element) => element.className === 'notice');
    assert.ok(notices.length >= 2);
    assert.ok(notices.every((notice) => notice.attributes.get('role') === 'note'));
  }
  assert.match(flatten(cards[0]), /synthetic task text/);
  assert.match(flatten(cards[0]), /After approval, ALBERA runs C:\\tools\\claude\.exe --version before launch and requires Claude Code 2\.1\.259 or later\./);
  assert.match(flatten(cards[1]), /synthetic follow-up text/);
});

test('approval UI warns in English and Japanese when a recovered run may still be active', async () => {
  for (const language of ['en-US', 'ja-JP']) {
    class FakeElement {
      children = [];
      listeners = new Map();
      attributes = new Map();
      hidden = false;
      value = '';
      textContent = '';
      className = '';
      tagName = '';
      append(...items) { this.children.push(...items); }
      replaceChildren(...items) { this.children = [...items]; }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      setAttribute(name, value) { this.attributes.set(name, value); }
    }
    const elements = new Map();
    const document = {
      documentElement: { lang: 'en' },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new FakeElement());
        return elements.get(id);
      },
      createElement(tag) { const element = new FakeElement(); element.tagName = tag; return element; },
    };
    const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data });
    const fetch = async (url) => {
      if (url === 'api/session') return jsonResponse({ csrfToken: 'synthetic', roots: ['C:\\project'] });
      if (url === 'api/approvals') return jsonResponse({ approvals: [] });
      if (url === 'api/runs') return jsonResponse({ runs: [
        { id: '12345678-1234-4234-8234-123456789abc', provider: 'claude', profile: 'read-only', status: 'interrupted' },
      ] });
      throw new Error(`unexpected_request_${url}`);
    };
    class FakeEventSource { addEventListener() {} close() {} }
    const source = await readFile(new URL('../src/runtime/approval-ui/approval.mjs', import.meta.url), 'utf8');
    vm.runInNewContext(source, {
      document, navigator: { language }, window: { addEventListener() {} }, EventSource: FakeEventSource, fetch,
      setTimeout() { return 1; }, clearTimeout() {},
    });
    await new Promise((resolve) => {
      const waitForRun = () => elements.get('runs')?.children.length ? resolve() : setImmediate(waitForRun);
      waitForRun();
    });

    const [card] = elements.get('runs').children;
    const all = (element) => [element, ...element.children.flatMap(all)];
    const descendants = all(card);
    const warning = descendants.find((element) => element.className === 'notice');
    assert.ok(warning);
    assert.equal(warning.attributes.get('role'), 'note');
    if (language.startsWith('ja')) {
      assert.match(warning.textContent, /プロバイダープロセスを再起動しておらず、現在も動作中か確認できません/);
      assert.match(warning.textContent, /同じ作業を再開する前にプロセス状態を確認/);
    } else {
      assert.match(warning.textContent, /did not restart its provider process and cannot confirm whether it is still running/);
      assert.match(warning.textContent, /Check the process before starting equivalent work again/);
    }
    assert.equal(descendants.some((element) => element.tagName === 'button'), false);
  }
});

test('approval host refreshes active browser sessions and rejects an expired idle cookie', async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const f = await fixture(t);

  now += 1000;
  const activeResponse = await get(f, '/api/runs');
  assert.equal(activeResponse.status, 200);
  const refreshedCookie = activeResponse.headers.get('set-cookie');
  assert.match(refreshedCookie, /HttpOnly/);
  assert.match(refreshedCookie, /SameSite=Strict/);
  const ttlMs = Number(refreshedCookie.match(/Max-Age=(\d+)/)?.[1]) * 1000;
  assert.ok(Number.isFinite(ttlMs) && ttlMs >= 60_000);

  now = f.session.expiresAt + 1;
  assert.equal((await get(f, '/api/runs')).status, 200);
  now += ttlMs + 1;
  assert.equal((await get(f, '/api/runs')).status, 401);
});

test('approval host uses a twenty-minute idle TTL and refreshes it on authenticated requests', async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const f = await fixture(t);
  const createdAt = now;
  const idleTtlMs = 20 * 60 * 1000;

  assert.equal(f.session.expiresAt, createdAt + idleTtlMs);
  now = createdAt + 19 * 60 * 1000;
  const refreshed = await get(f, '/api/runs');
  assert.equal(refreshed.status, 200);
  assert.equal(Number(refreshed.headers.get('set-cookie').match(/Max-Age=(\d+)/)?.[1]) * 1000, idleTtlMs);

  now = createdAt + 39 * 60 * 1000 + 1;
  assert.equal((await get(f, '/api/runs')).status, 401);
});

test('approval host enforces an eight-hour absolute session lifetime during active polling', async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const f = await fixture(t, { sessionLifetimeMs: 60 * 60 * 1000 });
  const createdAt = now;
  const renewalIntervalMs = 59 * 60 * 1000;

  for (let hour = 1; hour <= 8; hour++) {
    now = createdAt + hour * renewalIntervalMs;
    const response = await get(f, '/api/runs');
    assert.equal(response.status, 200, `active request ${hour} should renew the idle timeout`);
    if (hour === 8) assert.match(response.headers.get('set-cookie'), /Max-Age=480(?:;|$)/);
  }

  now = createdAt + 8 * 60 * 60 * 1000 + 1;
  assert.equal((await get(f, '/api/runs')).status, 401);
});

test('approval host rejects cross-origin and forged CSRF control requests', async (t) => {
  const f = await fixture(t);
  const start = { provider: 'claude', cwd: f.root, prompt: 'synthetic prompt' };
  assert.equal((await post(f, '/api/runs', start, { ...f.postHeaders, Origin: 'http://attacker.invalid' })).status, 403);
  const forgedCsrf = await post(f, '/api/runs', start, { ...f.postHeaders, 'X-ALBERA-CSRF': 'incorrect' });
  assert.equal(forgedCsrf.status, 403);
  assert.equal(forgedCsrf.headers.get('set-cookie'), null);
  const noOriginHeaders = { ...f.postHeaders };
  delete noOriginHeaders.Origin;
  const noOrigin = await post(f, '/api/runs', start, noOriginHeaders);
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.headers.get('set-cookie'), null);
  assert.equal((await get(f, '/api/runs')).status, 200);
  assert.deepEqual((await (await get(f, '/api/approvals')).json()).approvals, []);
});

test('approval host rejects forged and mismatched loopback Host headers', async (t) => {
  const f = await fixture(t);
  const requestWithHost = (host) => new Promise((resolve, reject) => {
    const path = new URL(`${f.base}/api/session`).pathname;
    const req = http.request(f.base, { path, headers: { Cookie: f.cookie, Host: host } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(await requestWithHost('attacker.invalid'), 403);
  const mismatchedPort = new URL(f.base).port === '65535' ? '1' : String(Number(new URL(f.base).port) + 1);
  assert.equal(await requestWithHost(`127.0.0.1:${mismatchedPort}`), 403);
});

test('separate approval host gates a synthetic start and streams allowlisted lifecycle events', async (t) => {
  const f = await fixture(t);
  const pendingStart = post(f, '/api/runs', {
    provider: 'claude', cwd: f.root, prompt: '<img src=x onerror=alert(1)>', profile: 'read-only',
  });
  let approval;
  await waitFor(async () => {
    const response = await get(f, '/api/approvals');
    approval = (await response.json()).approvals[0];
    return Boolean(approval);
  });
  assert.equal(approval.request.action, 'start');
  assert.equal(approval.request.initialInput, undefined);
  assert.equal(approval.request.args.includes('<img src=x onerror=alert(1)>'), false);
  assert.equal((await post(f, `/api/approvals/${approval.id}`, { decision: 'approve' })).status, 200);
  const started = await pendingStart;
  assert.equal(started.status, 202);
  const runId = (await started.json()).run.id;

  const streamAbort = new AbortController();
  const stream = await fetch(`${f.base}/api/events/stream?after=0`, { headers: f.headers, signal: streamAbort.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = stream.body.getReader();
  let chunk = '';
  for (let i = 0; i < 10 && !chunk.includes('event: lifecycle'); i++) {
    const next = await reader.read();
    if (next.done) break;
    chunk += new TextDecoder().decode(next.value);
  }
  streamAbort.abort();
  assert.match(chunk, /event: lifecycle/);
  assert.match(chunk, /"type":"started"/);
  assert.equal(chunk.includes('<img src=x onerror=alert(1)>'), false);

  const stop = post(f, `/api/runs/${runId}/stop`);
  await waitFor(async () => (await (await get(f, '/api/approvals')).json()).approvals.some((item) => item.request.action === 'stop'));
  const stopApproval = (await (await get(f, '/api/approvals')).json()).approvals[0];
  assert.equal((await post(f, `/api/approvals/${stopApproval.id}`, { decision: 'deny' })).status, 200);
  assert.equal((await stop).status, 403);
  assert.equal(f.runtime.gateway.get(runId).status, 'running');
});

test('closing the approval host ends active event streams and drains the API', async (t) => {
  const f = await fixture(t);
  const pendingStart = post(f, '/api/runs', { provider: 'claude', cwd: f.root, prompt: 'synthetic shutdown task' });
  let approval;
  await waitFor(async () => {
    approval = (await (await get(f, '/api/approvals')).json()).approvals[0];
    return Boolean(approval);
  });
  assert.equal((await post(f, `/api/approvals/${approval.id}`, { decision: 'approve' })).status, 200);
  assert.equal((await pendingStart).status, 202);
  const controller = new AbortController();
  const response = await fetch(`${f.base}/api/events/stream?after=0`, { headers: f.headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const closing = f.runtime.close();
  let shutdownTimer;
  try {
    await Promise.race([
      closing,
      new Promise((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error('host_shutdown_timeout')), 10_000); }),
    ]);
  } finally {
    clearTimeout(shutdownTimer);
  }
  controller.abort();
  const events = f.journal.list({ sessionId: f.runtime.sessionId, kind: 'event' });
  assert.ok(events.some((event) => event.eventType === 'stop_requested'));
  assert.ok(events.some((event) => event.eventType === 'stopped'), JSON.stringify(events.map((event) => event.eventType)));
});

test('standalone host restart reuses the journal identity and replays completed run history', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-host-replay-'));
  const journalPath = path.join(root, 'runtime.audit.jsonl');
  let journal = await openTestJournal(journalPath);
  let sessionId = await loadTestSessionId(journalPath);
  let client = await connectRuntime(root, journal, sessionId);
  let runtime = client.runtime;
  const oldCookie = client.cookie;
  t.after(async () => {
    await runtime?.close().catch(() => {});
    await journal?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const taskText = 'synthetic replay fixture prompt';
  const pendingStart = post(client, '/api/runs', { provider: 'claude', cwd: root, prompt: taskText });
  let startApproval;
  await waitFor(async () => {
    startApproval = (await (await get(client, '/api/approvals')).json()).approvals[0];
    return Boolean(startApproval);
  });
  assert.equal((await post(client, `/api/approvals/${startApproval.id}`, { decision: 'approve' })).status, 200);
  const started = await pendingStart;
  assert.equal(started.status, 202);
  const runId = (await started.json()).run.id;
  await waitFor(async () => journal.list({ kind: 'event', sessionId }).some((event) => event.eventType === 'started'));

  const eventsBeforeRestart = journal.list({ kind: 'event', sessionId });
  assert.ok(eventsBeforeRestart.some((event) => event.eventType === 'started'));
  await runtime.close();
  runtime = undefined;
  journal = undefined;

  journal = await openTestJournal(journalPath);
  const recoveredSessionId = await loadTestSessionId(journalPath);
  assert.equal(recoveredSessionId, sessionId);
  sessionId = recoveredSessionId;
  client = await connectRuntime(root, journal, sessionId);
  runtime = client.runtime;

  const runs = await get(client, '/api/runs');
  assert.equal(runs.status, 200);
  assert.equal((await get(client, '/api/runs', { Cookie: oldCookie })).status, 401);
  const recovered = (await runs.json()).runs;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, runId);
  assert.equal(recovered[0].status, 'stopped');

  const events = await get(client, '/api/events?after=0');
  const replayed = (await events.json()).events;
  assert.deepEqual(replayed.map((event) => event.type), ['started', 'stop_requested', 'stopped']);
  const journalText = await readFile(journalPath, 'utf8');
  assert.equal(journalText.includes(taskText), false);
  assert.equal(journalText.includes(root), false);
});

test('standalone host restart marks a journaled live run interrupted without relaunch or stale stop', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-host-interrupted-'));
  const journalPath = path.join(root, 'runtime.audit.jsonl');
  let journal = await openTestJournal(journalPath);
  const sessionId = await loadTestSessionId(journalPath);
  const runId = 'f3e1a401-63ca-4d19-a31c-953ab6c15ce7';
  await journal.append({
    sessionId, requestId: 'a7d13ae0-836a-4d0e-b006-6a684bdc4d10',
    action: 'run.start', phase: 'accepted', at: 100, provider: 'claude', runId,
  });
  await journal.append({
    kind: 'event', sessionId, eventType: 'started', at: 101, provider: 'claude', runId,
  });
  await journal.close();
  journal = await openTestJournal(journalPath);

  let spawnCount = 0;
  const client = await connectRuntime(root, journal, sessionId, {
    spawnImpl: () => { spawnCount++; return fakeChild(); },
  });
  let runtime = client.runtime;
  t.after(async () => {
    await runtime?.close().catch(() => {});
    await journal?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const runs = await get(client, '/api/runs');
  assert.equal(runs.status, 200);
  assert.deepEqual((await runs.json()).runs.map((run) => ({ id: run.id, status: run.status })), [
    { id: runId, status: 'interrupted' },
  ]);
  assert.equal((await post(client, `/api/runs/${runId}/stop`, {})).status, 409);
  assert.deepEqual((await (await get(client, '/api/approvals')).json()).approvals, []);
  assert.equal(spawnCount, 0);
  assert.deepEqual(journal.list({ sessionId }).map(({ version, sequence, kind, phase, eventType }) => [version, sequence, kind ?? 'audit', phase ?? eventType]), [
    [2, 1, 'audit', 'accepted'],
    [2, 2, 'event', 'started'],
  ]);
});

test('Runtime CLI requires explicit absolute project roots and an audit journal', () => {
  assert.throws(() => parseRuntimeArgs([]), /runtime_root_and_journal_required/);
  assert.throws(() => parseRuntimeArgs(['--root', 'relative', '--journal', 'C:\\data\\audit.jsonl'], 'win32'), /runtime_root_must_be_absolute/);
  assert.throws(() => parseRuntimeArgs(['--root', '/workspace', '--journal', 'relative']), /runtime_journal_must_be_absolute/);
  assert.throws(() => parseRuntimeArgs(['--root', '/workspace', '--journal', '/tmp/audit', '--port', '70000']), /runtime_port_invalid/);
  const options = parseRuntimeArgs(['--root', '/workspace', '--journal', '/tmp/albera.jsonl', '--port', '0']);
  assert.deepEqual({ roots: options.roots, journalPath: options.journalPath, port: options.port }, {
    roots: ['/workspace'], journalPath: '/tmp/albera.jsonl', port: 0,
  });
  assert.match(RUNTIME_HELP, /regular "albera" command remains a read-only/);
  assert.match(RUNTIME_HELP, /Journal storage permissions are checked without repair/);
});

test('Runtime session identity is stable, private on POSIX, and malformed files are preserved', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-session-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = path.join(root, 'runtime.audit.jsonl');
  const first = await loadTestSessionId(journal);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(await loadTestSessionId(journal), first);
  const identityPath = `${journal}.session-id`;
  if (process.platform !== 'win32') {
    const info = await stat(identityPath);
    assert.equal(info.mode & 0o077, 0);
    assert.equal(info.uid, process.getuid());
    await chmod(identityPath, 0o644);
    await assert.rejects(loadTestSessionId(journal), /runtime_session_identity_permissions/);
  }
  const malformed = 'not a session id\n';
  await writeFile(identityPath, malformed, 'utf8');
  if (process.platform !== 'win32') await chmod(identityPath, 0o600);
  await assert.rejects(loadTestSessionId(journal), /runtime_session_identity_invalid/);
  assert.equal(await readFile(identityPath, 'utf8'), malformed);
});
