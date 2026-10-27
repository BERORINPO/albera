import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';
import { createRuntimeHost } from '../src/runtime/host.mjs';
import { parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';
import { loadOrCreateRuntimeSessionId } from '../src/runtime/session-identity.mjs';

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
  const journal = await openRuntimeAuditJournal(path.join(root, 'runtime.audit.jsonl'));
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
test('approval host rejects cross-origin and forged CSRF control requests', async (t) => {
  const f = await fixture(t);
  const start = { provider: 'claude', cwd: f.root, prompt: 'synthetic prompt' };
  assert.equal((await post(f, '/api/runs', start, { ...f.postHeaders, Origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await post(f, '/api/runs', start, { ...f.postHeaders, 'X-ALBERA-CSRF': 'incorrect' })).status, 403);
  assert.equal((await get(f, '/api/runs')).status, 200);
  assert.deepEqual((await (await get(f, '/api/approvals')).json()).approvals, []);
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
});

test('Runtime session identity is stable, private on POSIX, and malformed files are preserved', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-session-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = path.join(root, 'runtime.audit.jsonl');
  const first = await loadOrCreateRuntimeSessionId(journal);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(await loadOrCreateRuntimeSessionId(journal), first);
  const identityPath = `${journal}.session-id`;
  if (process.platform !== 'win32') {
    const info = await stat(identityPath);
    assert.equal(info.mode & 0o077, 0);
    await chmod(identityPath, 0o644);
    await assert.rejects(loadOrCreateRuntimeSessionId(journal), /runtime_session_identity_permissions/);
  }
  const malformed = 'not a session id\n';
  await writeFile(identityPath, malformed, 'utf8');
  if (process.platform !== 'win32') await chmod(identityPath, 0o600);
  await assert.rejects(loadOrCreateRuntimeSessionId(journal), /runtime_session_identity_invalid/);
  assert.equal(await readFile(identityPath, 'utf8'), malformed);
});
