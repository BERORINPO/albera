import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-approval-host-'));
  const journal = await openTestJournal(path.join(root, 'runtime.audit.jsonl'));
  const runtime = createRuntimeHost({
    roots: [root],
    journal,
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
  const sessionResponse = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ bootstrapCode: address.bootstrapCode }),
  });
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie };
  const postHeaders = { ...headers, Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-ALBERA-CSRF': session.csrfToken };
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, journal, address, base, session, cookie, headers, postHeaders, root };
}

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
  const sessionResponse = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ bootstrapCode: address.bootstrapCode }),
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie };
  const postHeaders = { ...headers, Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-ALBERA-CSRF': session.csrfToken };
  return { runtime, journal, address, base, session, cookie, headers, postHeaders, root };
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
  assert.equal(cookie.includes(f.session.csrfToken), false);
  assert.equal((await fetch(`${f.base}/api/session`)).status, 401);
  assert.equal((await fetch(`${f.base}/api/session`, {
    method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapCode: f.address.bootstrapCode }),
  })).status, 403);
  assert.equal((await get(f, '/api/approvals', {})).status, 401);
  assert.equal((await get(f, '/api/approvals', { Cookie: f.cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const html = await fetch(`${f.base}/`);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await html.text(), /ALBERA Runtime approvals/);
  const script = await (await fetch(`${f.base}/approval.mjs`)).text();
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(script, /Bearer\s|localStorage|sessionStorage/);
});

test('approval host refreshes the browser session expiry and rejects an expired cookie', async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const f = await fixture(t);

  now += 1000;
  const refreshedResponse = await get(f, '/api/session');
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json();
  assert.ok(refreshed.expiresAt > f.session.expiresAt);
  now = refreshed.expiresAt + 1;
  assert.equal((await get(f, '/api/runs')).status, 401);
});

test('approval host rejects cross-origin and forged CSRF control requests', async (t) => {
  const f = await fixture(t);
  const start = { provider: 'claude', cwd: f.root, prompt: 'synthetic prompt' };
  assert.equal((await post(f, '/api/runs', start, { ...f.postHeaders, Origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await post(f, '/api/runs', start, { ...f.postHeaders, 'X-ALBERA-CSRF': 'incorrect' })).status, 403);
  const noOriginHeaders = { ...f.postHeaders };
  delete noOriginHeaders.Origin;
  assert.equal((await post(f, '/api/runs', start, noOriginHeaders)).status, 403);
  assert.equal((await get(f, '/api/runs')).status, 200);
  assert.deepEqual((await (await get(f, '/api/approvals')).json()).approvals, []);
});

test('approval host rejects forged and mismatched loopback Host headers', async (t) => {
  const f = await fixture(t);
  const requestWithHost = (host) => new Promise((resolve, reject) => {
    const req = http.request(f.base, { path: '/api/session', headers: { Cookie: f.cookie, Host: host } }, (res) => {
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
  await Promise.race([
    closing,
    new Promise((_, reject) => setTimeout(() => reject(new Error('host_shutdown_timeout')), 5000)),
  ]);
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
  assert.deepEqual(journal.list({ sessionId }), [
    { version: 1, sequence: 1, sessionId, requestId: 'a7d13ae0-836a-4d0e-b006-6a684bdc4d10', action: 'run.start', phase: 'accepted', at: 100, provider: 'claude', runId },
    { version: 1, sequence: 2, kind: 'event', sessionId, eventType: 'started', at: 101, provider: 'claude', runId, eventId: 1 },
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
