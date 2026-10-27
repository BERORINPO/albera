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

function request(address, api, { method = 'GET', route = '/v1/health', body, token = api.credential, host = `${address.host}:${address.port}`, origin, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
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
  const api = createRuntimeApi({ gateway: f.gateway, ...overrides });
  const address = await api.listen();
  return { ...f, api, address, close: () => api.close() };
}

test('Runtime API requires a valid Gateway and bounded stream configuration', () => {
  assert.throws(() => createRuntimeApi(), /requires a Gateway/);
  const gateway = fakeGateway().gateway;
  assert.throws(() => createRuntimeApi({ gateway, maxStreams: 5 }), /maxStreams/);
  assert.throws(() => createRuntimeApi({ gateway, pollIntervalMs: 10 }), /pollIntervalMs/);
  assert.throws(() => createRuntimeApi({ gateway, streamLifetimeMs: 60_001 }), /streamLifetimeMs/);
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
  assert.deepEqual(JSON.parse(list.text), { runs: [{ id: '12345678-1234-4234-8234-123456789abc', provider: 'claude', status: 'running' }] });
  const events = await request(f.address, f.api, { route: '/v1/events?after=0&limit=1' });
  assert.deepEqual(JSON.parse(events.text), { events: [{ id: 1, runId: '12345678-1234-4234-8234-123456789abc', provider: 'claude', type: 'started', at: 1 }] });
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

  const stopped = await request(f.address, f.api, { method: 'POST', route: '/v1/runs/12345678-1234-4234-8234-123456789abc/stop' });
  assert.equal(stopped.status, 200);
  assert.deepEqual(f.calls.at(-1), ['stop', '12345678-1234-4234-8234-123456789abc']);
  assert.equal(stopped.text.includes('secret'), false);
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
  const api = createRuntimeApi({ gateway: f.gateway, maxStreams: 1, pollIntervalMs: 100, streamLifetimeMs: 1000 });
  const address = await api.listen();
  t.after(() => api.close());
  const first = http.request({ host: address.host, port: address.port, path: '/v1/events/stream?after=0', headers: { Host: `${address.host}:${address.port}`, Authorization: `Bearer ${api.credential}` } });
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
  const api = createRuntimeApi({ gateway });
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
