import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { createRuntimeApi } from '../src/runtime/api.mjs';
import { createRuntimeApprovalBroker } from '../src/runtime/approval-broker.mjs';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';
import { buildProviderLaunch, RuntimeGateway } from '../src/runtime/gateway.mjs';

const openTestJournal = (filePath, options = {}) => openRuntimeAuditJournal(filePath, { ...options, verifyWindowsAcl: async () => {} });

function fakeGateway(overrides = {}) {
  const calls = [];
  const gateway = {
    async start(input) { calls.push(['start', input]); return { id: '12345678-1234-4234-8234-123456789abc', provider: 'claude', status: 'starting', cwd: 'secret-path', prompt: 'secret-prompt' }; },
    async stop(id) { calls.push(['stop', id]); return { id, provider: 'claude', status: 'stopped', args: ['secret'] }; },
    async sendInput(id, text) { calls.push(['input', id, text]); return { id, provider: 'claude', status: 'running' }; },
    list() { return [{ id: '12345678-1234-4234-8234-123456789abc', provider: 'claude', status: 'running', command: 'secret' }]; },
    events({ after = 0 } = {}) { return [{ id: 1, runId: '12345678-1234-4234-8234-123456789abc', provider: 'claude', type: 'started', at: 1, prompt: 'secret', path: 'secret' }].filter((event) => event.id > after); },
    async close() { calls.push(['close']); },
    ...overrides,
  };
  return { gateway, calls };
}

function request(address, api, { method = 'GET', route = '/v1/health', body, token = api.credential, host = `${address.host}:${address.port}`, origin, contentType = 'application/json', extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    if (body !== undefined) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: address.host, port: address.port, method, path: route, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function apiFixture(overrides = {}, gatewayOverrides = {}, credentialOptions = {}) {
  const f = fakeGateway(gatewayOverrides);
  const runtimeApi = createRuntimeApi({ gateway: f.gateway, ...overrides });
  const api = { ...runtimeApi, credential: runtimeApi.createCredential(['health', 'providers:read', 'runs:read', 'events:read', 'runs:start', 'runs:stop'], credentialOptions) };
  const address = await api.listen();
  return { ...f, api, address, close: () => api.close() };
}

test('Runtime API requires a valid Gateway and bounded stream configuration', () => {
  assert.throws(() => createRuntimeApi(), /requires a Gateway/);
  const gateway = fakeGateway().gateway;
  assert.throws(() => createRuntimeApi({ gateway, maxStreams: 5 }), /maxStreams/);
  assert.throws(() => createRuntimeApi({ gateway, pollIntervalMs: 10 }), /pollIntervalMs/);
  assert.throws(() => createRuntimeApi({ gateway, streamLifetimeMs: 60_001 }), /streamLifetimeMs/);
  const api = createRuntimeApi({ gateway });
  assert.throws(() => api.createCredential(['admin']), /scopes/);
  assert.throws(() => api.createCredential(['provider:read']), /scopes/);
  assert.throws(() => api.createCredential(['approvals:read']), /approval broker/);
  assert.throws(() => api.createCredential(['runs:read'], { ttlMs: 86_400_001 }), /ttlMs/);
  assert.throws(() => api.createCredential(['runs:read'], { sessionId: 'caller supplied identity' }), /sessionId/);
  for (let i = 0; i < 256; i++) api.createCredential(['runs:read']);
  assert.throws(() => api.createCredential(['runs:read']), /credential_capacity/);
});

test('closing the API invalidates session credentials and prevents new credentials', async () => {
  const gateway = fakeGateway().gateway;
  const api = createRuntimeApi({ gateway });
  const credential = api.createCredential(['runs:read']);
  await api.close();
  assert.equal(api.revokeCredential(credential), false);
  assert.throws(() => api.createCredential(['runs:read']), /api_closed/);
});

test('API binds to IPv4 loopback, requires bearer auth, validates host/origin, and emits restrictive headers', async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  assert.equal(f.address.host, '127.0.0.1');
  assert.equal(f.api.credential.length, 64);

  const missing = await request(f.address, f.api, { token: null });
  assert.equal(missing.status, 401);
  assert.deepEqual(JSON.parse(missing.text), { error: 'unauthorized' });
  const wrongHost = await request(f.address, f.api, { host: `attacker.example:${f.address.port}` });
  assert.equal(wrongHost.status, 403);
  const wrongOrigin = await request(f.address, f.api, { origin: `https://attacker.example:${f.address.port}` });
  assert.equal(wrongOrigin.status, 403);

  const ok = await request(f.address, f.api, { origin: `http://127.0.0.1:${f.address.port}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { status: 'ok' });
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
});

test('API projects run/event data and only forwards allowlisted start and stop requests', async (t) => {
  const f = await apiFixture();
  t.after(f.close);

  const list = await request(f.address, f.api, { route: '/v1/runs' });
  assert.deepEqual(JSON.parse(list.text), { runs: [] });
  const events = await request(f.address, f.api, { route: '/v1/events?after=0&limit=1' });
  assert.deepEqual(JSON.parse(events.text), { events: [] });
  assert.equal((await request(f.address, f.api, { route: '/v1/events?after=-1' })).status, 400);

  const rejected = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'x', confirmed: true }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(f.calls.length, 0);
  const rawArgv = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'x', args: ['--dangerously-skip-permissions'] }),
  });
  assert.equal(rawArgv.status, 400);
  assert.equal(f.calls.length, 0);

  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'task', profile: 'read-only' }),
  });
  assert.equal(started.status, 202);
  assert.equal(f.calls[0][0], 'start');
  assert.deepEqual(f.calls[0][1], { provider: 'claude', cwd: 'C:\\work', prompt: 'task', profile: 'read-only' });
  assert.equal(started.text.includes('secret-path'), false);
  assert.equal(started.text.includes('secret-prompt'), false);
  const ownedRuns = await request(f.address, f.api, { route: '/v1/runs' });
  assert.deepEqual(JSON.parse(ownedRuns.text), { runs: [{ id: '12345678-1234-4234-8234-123456789abc', provider: 'claude', status: 'running' }] });
  const ownedEvents = await request(f.address, f.api, { route: '/v1/events?after=0&limit=1' });
  assert.deepEqual(JSON.parse(ownedEvents.text), { events: [{ id: 1, runId: '12345678-1234-4234-8234-123456789abc', provider: 'claude', type: 'started', at: 1 }] });

  const stopped = await request(f.address, f.api, { method: 'POST', route: '/v1/runs/12345678-1234-4234-8234-123456789abc/stop' });
  assert.equal(stopped.status, 200);
  assert.deepEqual(f.calls.at(-1), ['stop', '12345678-1234-4234-8234-123456789abc']);
  assert.equal(stopped.text.includes('secret'), false);
});

test('provider catalog is read-only, scope-protected, and reports profile verification honestly', async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const limitedToken = f.api.createCredential(['health']);

  const forbidden = await request(f.address, f.api, { route: '/v1/providers', token: limitedToken });
  assert.equal(forbidden.status, 401);

  const response = await request(f.address, f.api, { route: '/v1/providers' });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.deepEqual(Object.keys(body.providers[0]).sort(), ['eventTransport', 'id', 'inputTransport', 'profiles', 'runtimeValidation', 'status', 'unavailableReason'].sort());
  assert.deepEqual(body.providers.map(({ id, status, profiles, runtimeValidation, inputTransport, eventTransport, unavailableReason }) => ({
    id, status, profiles, runtimeValidation, inputTransport, eventTransport, unavailableReason,
  })), [
    { id: 'claude', status: 'profile-only', profiles: ['read-only', 'read-only-streaming'], runtimeValidation: 'synthetic-transport-only', inputTransport: true, eventTransport: 'lifecycle-only', unavailableReason: null },
    { id: 'codex', status: 'unavailable', profiles: [], runtimeValidation: 'not-tested', inputTransport: false, eventTransport: 'none', unavailableReason: 'profile_unavailable' },
    { id: 'opencode', status: 'unavailable', profiles: [], runtimeValidation: 'not-tested', inputTransport: false, eventTransport: 'none', unavailableReason: 'profile_unavailable' },
  ]);
  for (const provider of body.providers) {
    if (provider.status === 'profile-only') {
      for (const profile of provider.profiles) assert.equal(buildProviderLaunch(provider.id, 'catalog contract', profile).profile, profile);
    } else {
      assert.throws(() => buildProviderLaunch(provider.id, 'catalog contract'), (error) => error.code === provider.unavailableReason);
    }
  }
  body.providers[0].profiles.push('workspace-write');
  const fresh = JSON.parse((await request(f.address, f.api, { route: '/v1/providers' })).text);
  assert.deepEqual(fresh.providers[0].profiles, ['read-only', 'read-only-streaming']);
  assert.equal(f.calls.length, 0);
});

test('follow-up input route requires runs:input, enforces ownership, and never audits message text', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-input-audit-'));
  const journal = await openTestJournal(path.join(root, 'audit.jsonl'));
  const sessionId = 'a'.repeat(32);
  const f = await apiFixture({ journal }, {}, { sessionId });
  t.after(async () => { await f.close(); await journal.close(); await rm(root, { recursive: true, force: true }); });

  const noInputScope = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs/12345678-1234-4234-8234-123456789abc/input', body: JSON.stringify({ text: 'should not pass' }),
  });
  assert.equal(noInputScope.status, 401);
  const inputToken = f.api.createCredential(['runs:input'], { sessionId });
  const foreignToken = f.api.createCredential(['runs:input'], { sessionId: 'b'.repeat(32) });
  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'initial' }),
  });
  assert.equal(started.status, 202);
  const runId = JSON.parse(started.text).run.id;
  const foreign = await request(f.address, f.api, {
    method: 'POST', route: `/v1/runs/${runId}/input`, token: foreignToken, body: JSON.stringify({ text: 'foreign session' }),
  });
  assert.equal(foreign.status, 404);

  const privateText = 'private follow-up that must never enter the journal';
  const accepted = await request(f.address, f.api, {
    method: 'POST', route: `/v1/runs/${runId}/input`, token: inputToken, body: JSON.stringify({ text: privateText }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(f.calls.at(-1), ['input', runId, privateText]);
  const invalid = await request(f.address, f.api, {
    method: 'POST', route: `/v1/runs/${runId}/input`, token: inputToken, body: JSON.stringify({ text: 'text', extra: true }),
  });
  assert.equal(invalid.status, 400);
  const records = journal.list().filter((record) => record.action === 'run.input');
  assert.deepEqual(records.map(({ phase }) => phase), ['requested', 'accepted']);
  assert.equal(JSON.stringify(journal.list()).includes(privateText), false);
});

test('session credentials enforce least-privilege scopes and can be revoked independently', async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const readToken = f.api.createCredential(['runs:read']);
  const startToken = f.api.createCredential(['runs:start']);
  const expiringToken = f.api.createCredential(['runs:read'], { ttlMs: 1000 });

  const read = await request(f.address, f.api, { route: '/v1/runs', token: readToken });
  assert.equal(read.status, 200);
  const cannotStart = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', token: readToken,
    body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'task' }),
  });
  assert.equal(cannotStart.status, 401);
  assert.equal(f.calls.length, 0);

  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', token: startToken,
    body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'task' }),
  });
  assert.equal(started.status, 202);
  const cannotRead = await request(f.address, f.api, { route: '/v1/runs', token: startToken });
  assert.equal(cannotRead.status, 401);

  assert.equal(f.api.revokeCredential(readToken), true);
  assert.equal((await request(f.address, f.api, { route: '/v1/runs', token: readToken })).status, 401);
  assert.equal(f.api.revokeCredential(readToken), false);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal((await request(f.address, f.api, { route: '/v1/runs', token: expiringToken })).status, 401);
});

test('session capabilities cannot inspect or stop runs owned by another session', async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const scopes = ['runs:read', 'events:read', 'runs:start', 'runs:stop'];
  const firstSession = f.api.createCredential(scopes);
  const secondSession = f.api.createCredential(scopes);
  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', token: firstSession,
    body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'session one' }),
  });
  assert.equal(started.status, 202);

  const firstRuns = await request(f.address, f.api, { route: '/v1/runs', token: firstSession });
  const secondRuns = await request(f.address, f.api, { route: '/v1/runs', token: secondSession });
  assert.equal(JSON.parse(firstRuns.text).runs.length, 1);
  assert.deepEqual(JSON.parse(secondRuns.text), { runs: [] });
  const firstEvents = await request(f.address, f.api, { route: '/v1/events', token: firstSession });
  const secondEvents = await request(f.address, f.api, { route: '/v1/events', token: secondSession });
  assert.equal(JSON.parse(firstEvents.text).events.length, 1);
  assert.deepEqual(JSON.parse(secondEvents.text), { events: [] });

  const foreignStream = http.request({
    host: f.address.host,
    port: f.address.port,
    path: '/v1/events/stream',
    headers: { Host: `${f.address.host}:${f.address.port}`, Authorization: `Bearer ${secondSession}` },
  });
  let foreignStreamText = '';
  let foreignResponse;
  foreignStream.on('response', (response) => {
    foreignResponse = response;
    response.setEncoding('utf8');
    response.on('data', (chunk) => { foreignStreamText += chunk; });
  });
  foreignStream.on('error', () => {});
  foreignStream.end();
  await new Promise((resolve, reject) => { foreignStream.once('response', resolve); foreignStream.once('error', reject); });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(foreignStreamText.includes('data:'), false);
  const foreignClosed = new Promise((resolve) => foreignResponse.once('close', resolve));
  foreignResponse.destroy();
  await foreignClosed;

  const runId = JSON.parse(started.text).run.id;
  const foreignStop = await request(f.address, f.api, { method: 'POST', route: `/v1/runs/${runId}/stop`, token: secondSession });
  assert.equal(foreignStop.status, 404);
  assert.deepEqual(f.calls.filter(([action]) => action === 'stop'), []);
  const ownedStop = await request(f.address, f.api, { method: 'POST', route: `/v1/runs/${runId}/stop`, token: firstSession });
  assert.equal(ownedStop.status, 200);
});

test('unaudited API event cursors are dense and isolated per session', async (t) => {
  const runs = [];
  const sourceEvents = [];
  const f = await apiFixture({}, {
    async start() {
      const index = runs.length + 1;
      const id = `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`;
      const run = { id, provider: 'claude', status: 'running' };
      runs.push(run);
      sourceEvents.push({ id: sourceEvents.length + 1, runId: id, provider: 'claude', type: 'started', at: index });
      return run;
    },
    list() { return runs; },
    events({ after = 0, limit = 100 } = {}) { return sourceEvents.filter((event) => event.id > after).slice(0, limit); },
  });
  t.after(f.close);
  const scopes = ['runs:start', 'runs:read', 'events:read'];
  const first = f.api.createCredential(scopes);
  const second = f.api.createCredential(scopes);
  const firstStart = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', token: first,
    body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'first' }),
  });
  const secondStart = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', token: second,
    body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'second' }),
  });
  assert.equal(firstStart.status, 202);
  assert.equal(secondStart.status, 202);

  const firstRunId = JSON.parse(firstStart.text).run.id;
  sourceEvents.push({ id: 3, runId: firstRunId, provider: 'claude', type: 'exited', at: 3 });
  const firstEvents = await request(f.address, f.api, { route: '/v1/events?after=1', token: first });
  const secondEvents = await request(f.address, f.api, { route: '/v1/events', token: second });
  assert.deepEqual(JSON.parse(firstEvents.text).events.map(({ id, type }) => ({ id, type })), [{ id: 2, type: 'exited' }]);
  assert.deepEqual(JSON.parse(secondEvents.text).events.map(({ id, type }) => ({ id, type })), [{ id: 1, type: 'started' }]);
  for (let index = 0; index < 260; index++) {
    sourceEvents.push({ id: sourceEvents.length + 1, runId: firstRunId, provider: 'claude', type: 'exited', at: index + 4 });
  }
  const boundedEvents = await request(f.address, f.api, { route: '/v1/events?after=0&limit=100', token: first });
  const boundedIds = JSON.parse(boundedEvents.text).events.map((event) => event.id);
  assert.equal(boundedIds.length, 100);
  assert.deepEqual([boundedIds[0], boundedIds.at(-1)], [7, 106]);
});

test('unaudited event capture can recover from a transient Gateway read error', async (t) => {
  const runId = '32345678-1234-4234-8234-123456789abc';
  let failOnce = true;
  const events = [{ id: 1, runId, provider: 'claude', type: 'started', at: 1 }];
  const f = await apiFixture({}, {
    async start() { return { id: runId, provider: 'claude', status: 'running' }; },
    events({ after = 0 } = {}) {
      if (failOnce) { failOnce = false; throw new Error('synthetic transient event read failure'); }
      return events.filter((event) => event.id > after);
    },
  });
  t.after(f.close);
  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'transient event read' }),
  });
  assert.equal(started.status, 202);
  const captured = await request(f.address, f.api, { route: '/v1/events' });
  assert.deepEqual(JSON.parse(captured.text).events.map(({ id, type }) => ({ id, type })), [{ id: 1, type: 'started' }]);
  assert.equal(f.calls.some(([action]) => action === 'close'), false);
});

test('SSE retains lifecycle events emitted before a session start is registered', async (t) => {
  const run = { id: '22345678-1234-4234-8234-123456789abc', provider: 'claude', status: 'starting' };
  const event = { id: 1, runId: run.id, provider: 'claude', type: 'started', at: 1 };
  const f = await apiFixture({ pollIntervalMs: 100, streamLifetimeMs: 1200 }, {
    async start() {
      events.push(event);
      await new Promise((resolve) => setTimeout(resolve, 350));
      return run;
    },
    list() { return [run]; },
    events({ after = 0, limit = 100 } = {}) { return events.filter((entry) => entry.id > after).slice(0, limit); },
  });
  const events = [];
  t.after(f.close);
  const stream = http.request({
    host: f.address.host,
    port: f.address.port,
    path: '/v1/events/stream',
    headers: { Host: `${f.address.host}:${f.address.port}`, Authorization: `Bearer ${f.api.credential}` },
  });
  let streamResponse;
  let streamText = '';
  stream.on('response', (response) => {
    streamResponse = response;
    response.setEncoding('utf8');
    response.on('data', (chunk) => { streamText += chunk; });
  });
  stream.end();
  await new Promise((resolve, reject) => { stream.once('response', resolve); stream.once('error', reject); });

  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'delayed owner registration' }),
  });
  assert.equal(started.status, 202);
  const deadline = Date.now() + 1000;
  while (!streamText.includes('id: 1') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(streamText, /id: 1\nevent: lifecycle/);
  const closed = new Promise((resolve) => streamResponse.once('close', resolve));
  await f.api.close();
  await closed;
});

test('injected audit journal records only redacted start and stop decisions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-audit-'));
  const journal = await openTestJournal(path.join(root, 'audit.jsonl'));
  const f = await apiFixture({ journal });
  t.after(async () => { await f.close(); await journal.close(); await rm(root, { recursive: true, force: true }); });
  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\private\\project', prompt: 'private task text' }),
  });
  assert.equal(started.status, 202);
  const runId = JSON.parse(started.text).run.id;
  const stopped = await request(f.address, f.api, { method: 'POST', route: `/v1/runs/${runId}/stop` });
  assert.equal(stopped.status, 200);

  const records = journal.list().filter((record) => record.action);
  assert.deepEqual(records.map(({ action, phase }) => [action, phase]), [
    ['run.start', 'requested'], ['run.start', 'accepted'], ['run.stop', 'requested'], ['run.stop', 'accepted'],
  ]);
  assert.equal(records[1].runId, runId);
  const stored = JSON.stringify(records);
  for (const secret of ['private task text', 'private\\project', f.api.credential]) assert.equal(stored.includes(secret), false);
});

test('journal restart replays session events and restores unfinished runs as interrupted', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-recovery-'));
  const file = path.join(root, 'audit.jsonl');
  const journal = await openTestJournal(file);
  const first = await apiFixture({ journal }, {}, { sessionId: 'c'.repeat(32) });
  const started = await request(first.address, first.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'recovery fixture' }),
  });
  assert.equal(started.status, 202);
  const startEvent = journal.list({ kind: 'event', sessionId: 'c'.repeat(32) })[0];
  assert.ok(startEvent);
  await first.close();
  await journal.close();

  const reopened = await openTestJournal(file);
  const emptyGateway = fakeGateway({ list: () => [], events: () => [] });
  const runtimeApi = createRuntimeApi({ gateway: emptyGateway.gateway, journal: reopened });
  const api = { ...runtimeApi, credential: runtimeApi.createCredential(['health', 'runs:read', 'events:read', 'runs:stop'], { sessionId: 'c'.repeat(32) }) };
  const foreignCredential = runtimeApi.createCredential(['runs:read', 'events:read'], { sessionId: 'd'.repeat(32) });
  const address = await api.listen();
  t.after(async () => { await api.close(); await reopened.close(); await rm(root, { recursive: true, force: true }); });

  const runsResponse = await request(address, api, { route: '/v1/runs' });
  const recovered = JSON.parse(runsResponse.text).runs;
  assert.equal(runsResponse.status, 200);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'interrupted');
  assert.equal(recovered[0].id, JSON.parse(started.text).run.id);
  const eventsResponse = await request(address, api, { route: `/v1/events?after=${startEvent.eventId - 1}` });
  const replayed = JSON.parse(eventsResponse.text).events;
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].id, startEvent.eventId);
  assert.equal(replayed[0].type, 'started');
  const foreignRuns = await request(address, api, { route: '/v1/runs', token: foreignCredential });
  const foreignEvents = await request(address, api, { route: '/v1/events', token: foreignCredential });
  assert.deepEqual(JSON.parse(foreignRuns.text).runs, []);
  assert.deepEqual(JSON.parse(foreignEvents.text).events, []);
  const stop = await request(address, api, { method: 'POST', route: `/v1/runs/${recovered[0].id}/stop` });
  assert.equal(stop.status, 409);
  assert.deepEqual(JSON.parse(stop.text), { error: 'run_not_active' });
});

test('background lifecycle capture persists events without an open event stream', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-event-poll-'));
  const journal = await openTestJournal(path.join(root, 'audit.jsonl'));
  let sourceEvents = [];
  const f = await apiFixture({ journal }, { events: ({ after = 0 } = {}) => sourceEvents.filter((event) => event.id > after) });
  t.after(async () => { await f.close(); await journal.close(); await rm(root, { recursive: true, force: true }); });
  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'background capture fixture' }),
  });
  assert.equal(started.status, 202);
  const runId = JSON.parse(started.text).run.id;
  sourceEvents = [
    { id: 1, runId, provider: 'claude', type: 'started', at: 1 },
    { id: 2, runId, provider: 'claude', type: 'exited', at: 2, code: 0, signal: null },
  ];
  const deadline = Date.now() + 1500;
  let persisted;
  while (Date.now() < deadline) {
    persisted = journal.list({ kind: 'event' });
    if (persisted.some((event) => event.eventType === 'exited')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(persisted.map((event) => event.eventType), ['started', 'exited']);
});

test('Gateway event notifications persist lifecycle changes before the next safety poll', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-event-subscription-'));
  const journal = await openTestJournal(path.join(root, 'audit.jsonl'));
  const runId = '12345678-1234-4234-8234-123456789abc';
  let subscriber;
  let unsubscribed = false;
  let sourceEvents = [];
  const f = await apiFixture({ journal, pollIntervalMs: 1000 }, {
    subscribeEvents(listener) {
      subscriber = listener;
      return () => { unsubscribed = true; subscriber = undefined; };
    },
    async start() { return { id: runId, provider: 'claude', status: 'starting' }; },
    events: ({ after = 0 } = {}) => sourceEvents.filter((event) => event.id > after),
  }, { sessionId: 'a'.repeat(32) });
  t.after(async () => { await f.close(); await journal.close(); await rm(root, { recursive: true, force: true }); });
  const started = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'event subscription fixture' }),
  });
  assert.equal(started.status, 202);
  assert.equal(typeof subscriber, 'function');
  sourceEvents = [{ id: 1, runId, provider: 'claude', type: 'exited', at: 2, code: 0, signal: null }];
  subscriber(sourceEvents[0]);
  const deadline = Date.now() + 500;
  let persisted = [];
  while (Date.now() < deadline) {
    persisted = journal.list({ kind: 'event' });
    if (persisted.some((event) => event.eventType === 'exited')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(persisted.map((event) => event.eventType), ['exited']);
  await f.close();
  assert.equal(unsubscribed, true);
});

test('lifecycle event persistence failure fails the API closed and shuts down the Gateway', async (t) => {
  let writes = 0;
  let gatewayClosed = false;
  const f = await apiFixture({ journal: {
    append: async () => { writes++; if (writes === 3) throw new Error('event disk full'); }, list: () => [],
  } }, { async close() { gatewayClosed = true; } });
  t.after(f.close);
  const response = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'event persistence fail' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.text), { error: 'audit_unavailable' });
  assert.equal(gatewayClosed, true);
  const health = await request(f.address, f.api, { route: '/v1/health' });
  assert.equal(health.status, 503);
  assert.equal(writes, 3);
});

test('audit persistence failure prevents a run from being started', async (t) => {
  const f = await apiFixture({ journal: { append: async () => { throw new Error('storage unavailable'); }, list: () => [] } });
  t.after(f.close);
  const response = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'never start' }),
  });
  assert.equal(response.status, 503);
  assert.equal(f.calls.some(([action]) => action === 'start'), false);
  assert.equal(f.calls.some(([action]) => action === 'close'), true);
});

test('audit failure after a Gateway start closes the Gateway to stop unrecorded execution', async (t) => {
  let writes = 0;
  let gatewayClosed = false;
  const f = await apiFixture({ journal: { append: async () => { writes++; if (writes === 2) throw new Error('disk full'); }, list: () => [] } }, {
    async close() { gatewayClosed = true; },
  });
  t.after(f.close);
  const response = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'may start then fail audit' }),
  });
  assert.equal(response.status, 503);
  assert.equal(writes, 2);
  assert.deepEqual(f.calls.map(([action]) => action), ['start']);
  assert.equal(gatewayClosed, true);
});

test('real journal capacity exhaustion after launch fails the API closed and shuts down the Gateway', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-journal-capacity-api-'));
  const file = path.join(root, 'audit.jsonl');
  const maxBytes = 2048;
  const journal = await openTestJournal(file, { maxBytes });
  let sequence = 0;
  while (true) {
    const size = (await readFile(file)).byteLength;
    const remaining = maxBytes - size;
    const at = Date.now();
    const requestId = '12345678-1234-4234-8234-123456789abc';
    const sessionId = 'a'.repeat(32);
    const requestedBytes = Buffer.byteLength(`${JSON.stringify({
      version: 1, sequence: sequence + 1, sessionId, requestId, action: 'run.start', phase: 'requested', at, provider: 'claude',
    })}\n`);
    const acceptedBytes = Buffer.byteLength(`${JSON.stringify({
      version: 1, sequence: sequence + 2, sessionId, requestId, action: 'run.start', phase: 'accepted', at, provider: 'claude', runId: requestId,
    })}\n`);
    if (remaining < requestedBytes + acceptedBytes) {
      assert.ok(remaining >= requestedBytes, 'capacity must admit the request audit record before rejecting its result');
      break;
    }
    sequence++;
    await journal.append({
      sessionId, requestId: `${String(sequence).padStart(8, '0')}-1234-4234-8234-123456789abc`,
      action: 'run.start', phase: 'requested', at,
    });
  }
  const bytesBeforeApiRequest = await readFile(file);

  let gatewayClosed = false;
  const f = await apiFixture({ journal }, { async close() { gatewayClosed = true; } });
  t.after(async () => { await f.close(); await journal.close(); await rm(root, { recursive: true, force: true }); });
  const response = await request(f.address, f.api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'synthetic capacity case' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.text), { error: 'audit_unavailable' });
  assert.equal(gatewayClosed, true);
  assert.deepEqual(f.calls.map(([action]) => action), ['start']);
  const records = journal.list();
  assert.equal(records.at(-1).phase, 'requested');
  assert.equal(records.some((record) => record.phase === 'accepted' && record.action === 'run.start'), false);
  const health = await request(f.address, f.api, { route: '/v1/health' });
  assert.equal(health.status, 503);
  const bytesAfterFailure = await readFile(file);
  assert.deepEqual(bytesAfterFailure.subarray(0, bytesBeforeApiRequest.byteLength), bytesBeforeApiRequest);
  await journal.close();
  const recovered = await openTestJournal(file, { maxBytes });
  assert.equal(recovered.list().length, records.length);
  assert.equal(recovered.list().at(-1).phase, 'requested');
  assert.equal(recovered.list().some((record) => record.phase === 'accepted' && record.action === 'run.start'), false);
  await recovered.close();
});

test('failure to audit a denied Gateway request permanently fails the API closed', async (t) => {
  let writes = 0;
  let starts = 0;
  let gatewayClosed = false;
  const f = await apiFixture({ journal: { append: async () => { writes++; if (writes === 2) throw new Error('disk full'); }, list: () => [] } }, {
    async start() { starts++; const error = new Error('denied'); error.code = 'confirmation_required'; throw error; },
    async close() { gatewayClosed = true; },
  });
  t.after(f.close);
  const payload = JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'denied task' });
  const denied = await request(f.address, f.api, { method: 'POST', route: '/v1/runs', body: payload });
  assert.equal(denied.status, 503);
  assert.deepEqual(JSON.parse(denied.text), { error: 'audit_unavailable' });
  const health = await request(f.address, f.api, { route: '/v1/health' });
  assert.equal(health.status, 503);
  assert.deepEqual(JSON.parse(health.text), { error: 'audit_unavailable' });
  assert.equal(writes, 2);
  assert.equal(starts, 1);
  assert.equal(gatewayClosed, true);
});

test('invalid content type, malformed JSON, oversized body, and unsupported method fail with stable responses', async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const invalidType = await request(f.address, f.api, { method: 'POST', route: '/v1/runs', body: '{}', contentType: 'text/plain' });
  assert.equal(invalidType.status, 415);
  const invalidJson = await request(f.address, f.api, { method: 'POST', route: '/v1/runs', body: '{' });
  assert.equal(invalidJson.status, 400);
  const oversized = await request(f.address, f.api, { method: 'POST', route: '/v1/runs', body: ' '.repeat(21 * 1024) });
  assert.equal(oversized.status, 413);
  const unsupported = await request(f.address, f.api, { method: 'PUT', route: '/v1/runs' });
  assert.equal(unsupported.status, 404);
});

test('unrecognized Gateway errors never expose message or caller-controlled error codes', async (t) => {
  const f = await apiFixture({}, { start: async () => { const error = new Error('private path and key'); error.code = 'api_key_secret'; throw error; } });
  t.after(f.close);
  const response = await request(f.address, f.api, { method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'task' }) });
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.text), { error: 'runtime_error' });
  assert.equal(response.text.includes('private'), false);
  assert.equal(response.text.includes('api_key_secret'), false);
});

test('bounded authenticated SSE streams expose lifecycle projections and close with the API', async (t) => {
  let events = [];
  const f = fakeGateway({ events: ({ after = 0 } = {}) => events.filter((event) => event.id > after) });
  const runtimeApi = createRuntimeApi({ gateway: f.gateway, maxStreams: 1, pollIntervalMs: 100, streamLifetimeMs: 1000 });
  const api = { ...runtimeApi, credential: runtimeApi.createCredential(['health', 'runs:read', 'events:read', 'runs:start', 'runs:stop']) };
  const address = await api.listen();
  t.after(() => api.close());
  const started = await request(address, api, {
    method: 'POST', route: '/v1/runs', body: JSON.stringify({ provider: 'claude', cwd: 'C:\\work', prompt: 'stream test' }),
  });
  assert.equal(started.status, 202);
  const invalidCursor = await request(address, api, { route: '/v1/events/stream', extraHeaders: { 'Last-Event-ID': '-1' } });
  assert.equal(invalidCursor.status, 400);
  const first = http.request({ host: address.host, port: address.port, path: '/v1/events/stream?after=1', headers: { Host: `${address.host}:${address.port}`, Authorization: `Bearer ${api.credential}`, 'Last-Event-ID': '0' } });
  let response;
  let text = '';
  first.on('response', (res) => { response = res; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); });
  first.end();
  await new Promise((resolve, reject) => { first.once('response', resolve); first.once('error', reject); });
  assert.equal(response.statusCode, 200);
  const capped = await request(address, api, { route: '/v1/events/stream?after=0' });
  assert.equal(capped.status, 429);
  events = [{ id: 2, runId: '12345678-1234-4234-8234-123456789abc', provider: 'claude', type: 'exited', at: 2, secret: 'never-wire' }];
  await new Promise((resolve) => {
    const deadline = Date.now() + 1500;
    const check = () => text.includes('id: 1') ? resolve() : Date.now() > deadline ? resolve() : setTimeout(check, 20);
    check();
  });
  assert.match(text, /event: lifecycle/);
  assert.equal(text.includes('never-wire'), false);
  const expired = new Promise((resolve) => response.once('close', resolve));
  let expiryTimer;
  await Promise.race([expired, new Promise((_, reject) => { expiryTimer = setTimeout(() => reject(new Error('SSE lifetime was not enforced')), 1500); })]);
  clearTimeout(expiryTimer);
  assert.equal(response.destroyed, true);

  const second = http.request({ host: address.host, port: address.port, path: '/v1/events/stream?after=2', headers: { Host: `${address.host}:${address.port}`, Authorization: `Bearer ${api.credential}` } });
  let secondResponse;
  second.on('response', (res) => { secondResponse = res; res.resume(); });
  second.end();
  await new Promise((resolve, reject) => { second.once('response', resolve); second.once('error', reject); });
  const closed = new Promise((resolve) => secondResponse.once('close', resolve));
  await api.close();
  await closed;
  assert.equal(secondResponse.destroyed, true);
});

test('valid API credentials cannot bypass the Gateway default-deny approval callback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-runtime-api-'));
  const spawned = [];
  const gateway = new RuntimeGateway({
    roots: [root],
    resolveExecutableImpl: async () => process.execPath,
    spawnImpl: (...args) => { spawned.push(args); throw new Error('must_not_spawn'); },
  });
  const runtimeApi = createRuntimeApi({ gateway });
  const api = { ...runtimeApi, credential: runtimeApi.createCredential(['health', 'runs:read', 'events:read', 'runs:start', 'runs:stop']) };
  const address = await api.listen();
  t.after(async () => { await api.close(); await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const payload = JSON.stringify({ provider: 'claude', cwd: root, prompt: 'fixture task' });
  const unauthorized = await request(address, api, { method: 'POST', route: '/v1/runs', body: payload, token: null });
  assert.equal(unauthorized.status, 401);
  const denied = await request(address, api, { method: 'POST', route: '/v1/runs', body: payload });
  assert.equal(denied.status, 403);
  assert.deepEqual(JSON.parse(denied.text), { error: 'confirmation_required' });
  assert.equal(spawned.length, 0);
});

test('approval routes require separate host-only scopes and decide one pending request once', async (t) => {
  const broker = createRuntimeApprovalBroker();
  const pending = broker.authorize({
    action: 'input', provider: 'claude', profile: 'read-only-streaming', runId: '12345678-1234-4234-8234-123456789abc',
    text: 'exact synthetic text for human approval',
  });
  const gateway = fakeGateway().gateway;
  const runtimeApi = createRuntimeApi({ gateway, approvalBroker: broker });
  const api = {
    ...runtimeApi,
    credential: runtimeApi.createCredential(['health']),
    taskCredential: runtimeApi.createCredential(['runs:start', 'runs:input']),
    approvalReader: runtimeApi.createCredential(['approvals:read']),
    approvalDecider: runtimeApi.createCredential(['approvals:decide']),
  };
  const address = await api.listen();
  t.after(async () => { await api.close(); });

  assert.equal((await request(address, api, { route: '/v1/approvals', token: api.taskCredential })).status, 401);
  assert.equal((await request(address, api, {
    method: 'POST', route: '/v1/approvals/12345678-1234-4234-8234-123456789abc', token: api.taskCredential,
    body: JSON.stringify({ decision: 'approve' }),
  })).status, 401);
  const listed = await request(address, api, { route: '/v1/approvals', token: api.approvalReader });
  assert.equal(listed.status, 200);
  const item = JSON.parse(listed.text).approvals[0];
  assert.equal(item.request.text, 'exact synthetic text for human approval');
  assert.equal((await request(address, api, { route: '/v1/approvals', token: api.approvalDecider })).status, 401);
  const invalid = await request(address, api, {
    method: 'POST', route: `/v1/approvals/${item.id}`, token: api.approvalDecider,
    body: JSON.stringify({ decision: 'approve', confirmed: true }),
  });
  assert.equal(invalid.status, 400);
  const decided = await request(address, api, {
    method: 'POST', route: `/v1/approvals/${item.id}`, token: api.approvalDecider,
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(decided.status, 200);
  assert.equal(await pending, true);
  assert.equal((await request(address, api, {
    method: 'POST', route: `/v1/approvals/${item.id}`, token: api.approvalDecider,
    body: JSON.stringify({ decision: 'deny' }),
  })).status, 404);
});

test('closing Runtime API denies pending host approval requests', async (t) => {
  const broker = createRuntimeApprovalBroker();
  const pending = broker.authorize({ action: 'input', provider: 'claude', runId: '12345678-1234-4234-8234-123456789abc', text: 'pending synthetic approval' });
  const runtimeApi = createRuntimeApi({ gateway: fakeGateway().gateway, approvalBroker: broker });
  const address = await runtimeApi.listen();
  t.after(() => runtimeApi.close());
  assert.equal(broker.size, 1);
  await runtimeApi.close();
  assert.equal(await pending, false);
  assert.equal(address.host, '127.0.0.1');
});

test('Runtime API host approval routes carry a synthetic launch from request through human decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-host-approval-e2e-'));
  const broker = createRuntimeApprovalBroker();
  let child;
  const gateway = new RuntimeGateway({
    roots: [root],
    authorize: broker.authorize,
    resolveExecutableImpl: async () => process.execPath,
    buildLaunchImpl: (provider, profile, prompt) => buildProviderLaunch(provider, prompt, profile),
    env: {},
    spawnImpl: () => {
      child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => {
        child.signalCode = signal;
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    signalTreeImpl: (_pid, signal, target) => target.kill(signal),
  });
  const runtimeApi = createRuntimeApi({ gateway, approvalBroker: broker });
  const api = {
    ...runtimeApi,
    runToken: runtimeApi.createCredential(['runs:start', 'runs:read', 'runs:stop']),
    approvalRead: runtimeApi.createCredential(['approvals:read']),
    approvalDecide: runtimeApi.createCredential(['approvals:decide']),
  };
  const address = await api.listen();
  t.after(async () => { await api.close(); await gateway.close({ timeoutMs: 100 }); await rm(root, { recursive: true, force: true }); });

  const startResponse = request(address, api, {
    method: 'POST', route: '/v1/runs', token: api.runToken,
    body: JSON.stringify({ provider: 'claude', cwd: root, prompt: 'synthetic end-to-end approval task', profile: 'read-only-streaming' }),
  });
  let approval;
  for (let i = 0; i < 100 && !approval; i++) {
    const listed = await request(address, api, { route: '/v1/approvals', token: api.approvalRead });
    approval = JSON.parse(listed.text).approvals[0];
    if (!approval) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(approval);
  assert.equal(approval.request.action, 'start');
  assert.equal(approval.request.initialInput, 'ALBERA task:\nsynthetic end-to-end approval task');
  assert.equal(JSON.stringify(approval.request.args).includes('synthetic end-to-end approval task'), false);
  assert.equal((await request(address, api, { route: '/v1/approvals', token: api.runToken })).status, 401);
  const approved = await request(address, api, {
    method: 'POST', route: `/v1/approvals/${approval.id}`, token: api.approvalDecide,
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(approved.status, 200);
  const started = await startResponse;
  assert.equal(started.status, 202);
  const runId = JSON.parse(started.text).run.id;

  const stopResponse = request(address, api, { method: 'POST', route: `/v1/runs/${runId}/stop`, token: api.runToken });
  approval = undefined;
  for (let i = 0; i < 100 && !approval; i++) {
    const listed = await request(address, api, { route: '/v1/approvals', token: api.approvalRead });
    approval = JSON.parse(listed.text).approvals[0];
    if (!approval) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(approval.request.action, 'stop');
  assert.equal(approval.request.runId, runId);
  const denied = await request(address, api, {
    method: 'POST', route: `/v1/approvals/${approval.id}`, token: api.approvalDecide,
    body: JSON.stringify({ decision: 'deny' }),
  });
  assert.equal(denied.status, 200);
  assert.equal((await stopResponse).status, 403);
  assert.equal(gateway.get(runId).status, 'running');
});
