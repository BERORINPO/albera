import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { createRuntimeApi } from '../src/runtime/api.mjs';
import { RuntimeGateway } from '../src/runtime/gateway.mjs';

function fakeGateway(overrides = {}) {
  const calls = [];
  const gateway = {
    async start(input) { calls.push(['start', input]); return { id: '12345678-1234-4234-8234-123456789abc', provider: 'claude', status: 'starting', cwd: 'secret-path', prompt: 'secret-prompt' }; },
    async stop(id) { calls.push(['stop', id]); return { id, provider: 'claude', status: 'stopped', args: ['secret'] }; },
    list() { return [{ id: '12345678-1234-4234-8234-123456789abc', provider: 'claude', status: 'running', command: 'secret' }]; },
    events({ after = 0 } = {}) { return [{ id: 1, runId: '12345678-1234-4234-8234-123456789abc', provider: 'claude', type: 'started', at: 1, prompt: 'secret', path: 'secret' }].filter((event) => event.id > after); },
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

async function apiFixture(overrides = {}, gatewayOverrides = {}) {
  const f = fakeGateway(gatewayOverrides);
  const runtimeApi = createRuntimeApi({ gateway: f.gateway, ...overrides });
  const api = { ...runtimeApi, credential: runtimeApi.createCredential(['health', 'runs:read', 'events:read', 'runs:start', 'runs:stop']) };
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
  assert.throws(() => api.createCredential(['runs:read'], { ttlMs: 86_400_001 }), /ttlMs/);
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
  const first = http.request({ host: address.host, port: address.port, path: '/v1/events/stream?after=0', headers: { Host: `${address.host}:${address.port}`, Authorization: `Bearer ${api.credential}`, 'Last-Event-ID': '1' } });
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
    const check = () => text.includes('id: 2') ? resolve() : Date.now() > deadline ? resolve() : setTimeout(check, 20);
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
