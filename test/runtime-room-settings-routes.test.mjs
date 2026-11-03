// The room's credential field (control-plane-service.md section 5): write-only routes on the real room host over the Fake secret store.
// Nothing here uses DPAPI, a helper or a real secret; the values are made up.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SecretStoreError } from '../src/runtime/control-plane-secret-store.mjs';
import { createFakeControlPlaneSecretStore } from '../src/runtime/fake-control-plane-secret-store.mjs';
import { createRoomHost } from '../src/runtime/room-host.mjs';
import { CREDENTIAL_MAX_BODY_BYTES, createRoomSettingsRoutes } from '../src/runtime/room-settings-routes.mjs';
import { roomStubs, startRouteHost } from './helpers/room-route-host.mjs';

const NOW = new Date('2026-11-03T09:00:00.000Z');
const TOKEN = 'sk-ant-oat01-FAKE-test-token_0123456789abcdefghijklmnopqrstuvwxyz';
const SHA8 = createHash('sha256').update(TOKEN).digest('hex').slice(0, 8);
const SAVE = 'api/settings/credential';
const ERASE = 'api/settings/credential/erase';
const LIST = 'api/settings/credentials';

async function start(t, { secretStore = createFakeControlPlaneSecretStore({ now: () => NOW }) } = {}) {
  const r = await startRouteHost(t, createRoomSettingsRoutes({ secretStore }));
  return { ...r, secretStore };
}

/** Everything the process printed while `run` ran (console and the two streams): the value must never be in it. */
async function captureOutput(run) {
  const seen = [];
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = names.map((name) => console[name]);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  names.forEach((name) => { console[name] = (...args) => { seen.push(args.map(String).join(' ')); }; });
  process.stdout.write = (chunk, ...rest) => { seen.push(String(chunk)); return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true; };
  process.stderr.write = (chunk, ...rest) => { seen.push(String(chunk)); return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true; };
  try { await run(); } finally {
    names.forEach((name, i) => { console[name] = saved[i]; });
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return seen.join('\n');
}

test('save: stores the value and answers with the hash prefix and the date only, never the value', async (t) => {
  const r = await start(t);
  const res = await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value: TOKEN } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, credential: { name: 'claude-oauth-token', present: true, sha256Prefix: SHA8, savedAt: NOW.toISOString() } });
  assert.ok(!res.text.includes(TOKEN) && !res.text.includes(TOKEN.slice(10, 40)), 'the reply carries no part of the value');
  assert.equal((await r.secretStore.load('claude-oauth-token')).toString('utf8'), TOKEN, 'it reached the store');
});

test('status: both names, from the store status; the value is in no read either', async (t) => {
  const r = await start(t);
  const before = await r.call('GET', LIST);
  assert.deepEqual(before.json.credentials, [
    { name: 'claude-oauth-token', present: false, sha256Prefix: null, savedAt: null },
    { name: 'anthropic-api-key', present: false, sha256Prefix: null, savedAt: null },
  ]);
  await r.call('POST', SAVE, { body: { name: 'anthropic-api-key', value: 'key-FAKE-1234567890' } });
  const after = await r.call('GET', LIST);
  assert.equal(after.json.credentials[1].present, true);
  assert.equal(after.json.credentials[1].sha256Prefix, createHash('sha256').update('key-FAKE-1234567890').digest('hex').slice(0, 8));
  assert.ok(!after.text.includes('key-FAKE'));
});

test('erase removes the credential, says whether there was one, and only the two known names are accepted', async (t) => {
  const r = await start(t);
  await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value: TOKEN } });
  assert.deepEqual((await r.call('POST', ERASE, { body: { name: 'claude-oauth-token' } })).json, { ok: true, erased: true });
  assert.deepEqual((await r.call('POST', ERASE, { body: { name: 'claude-oauth-token' } })).json, { ok: true, erased: false });
  assert.equal((await r.secretStore.status('claude-oauth-token')).present, false);
  for (const name of ['../escape', 'ANTHROPIC_API_KEY', 'claude-oauth-token ', 7, null]) {
    const res = await r.call('POST', ERASE, { body: { name } });
    assert.equal(res.status, 400, `name ${JSON.stringify(name)}`);
    assert.equal(res.json.error, 'invalid_name');
  }
});

test('save: a value that is not printable ASCII without whitespace is refused and not echoed', async (t) => {
  const r = await start(t);
  const bad = ['', ' ', 'two words', 'tab\tinside', 'line\nbreak', 'trailing ', 'ctrl\u0001char', 'non-ascii-\u3042', 'dquote\u0000', 5, null, ['a'], { a: 1 }];
  for (const value of bad) {
    const res = await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value } });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.equal(res.json.error, 'invalid_value');
    assert.ok(!res.text.includes('inside') && !res.text.includes('words'), 'the refusal does not echo the value');
  }
  assert.equal((await r.secretStore.status('claude-oauth-token')).present, false);
});

test('save: only { name, value } is read; a missing, extra or renamed field is refused', async (t) => {
  const r = await start(t);
  for (const body of [{ name: 'claude-oauth-token' }, { value: TOKEN }, { name: 'claude-oauth-token', value: TOKEN, extra: 1 }, { name: 'claude-oauth-token', token: TOKEN }]) {
    const res = await r.call('POST', SAVE, { body });
    assert.equal(res.status, 400);
    assert.ok(['invalid_request', 'invalid_name'].includes(res.json.error));
  }
  assert.equal((await r.call('POST', SAVE, { body: { name: 'unknown-name', value: TOKEN } })).json.error, 'invalid_name');
  assert.equal((await r.call('POST', SAVE, { rawBody: '[1,2]' })).status, 400);
  assert.equal((await r.call('POST', SAVE, { rawBody: 'not json' })).status, 400);
});

test('save: a body over 1 KiB is refused with 413 before it is read, whether it declares its size or not', async (t) => {
  assert.equal(CREDENTIAL_MAX_BODY_BYTES, 1024);
  const r = await start(t);
  const big = JSON.stringify({ name: 'claude-oauth-token', value: 'a'.repeat(1100) });
  assert.ok(big.length > 1024);
  const declared = await r.call('POST', SAVE, { rawBody: big });
  assert.equal(declared.status, 413);
  assert.deepEqual(declared.json, { error: 'body_too_large' });
  // A body of the same size sent in chunks without a Content-Length (the host counts what arrives).
  const chunks = [Buffer.from(big.slice(0, 600)), Buffer.from(big.slice(600))];
  const res = await fetch(`${r.address.url}api/settings/credential`, {
    method: 'POST', headers: { Origin: r.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: r.cookie }, duplex: 'half',
    body: new ReadableStream({ start(controller) { chunks.forEach((c) => controller.enqueue(c)); controller.close(); } }),
  });
  assert.equal(res.status, 413);
  assert.equal((await r.secretStore.status('claude-oauth-token')).present, false);
  // The largest value that still fits the body is accepted.
  const room = 1024 - JSON.stringify({ name: 'claude-oauth-token', value: '' }).length;
  assert.equal((await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value: 'a'.repeat(room) } })).status, 200);
  assert.equal((await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value: 'a'.repeat(room + 1) } })).status, 413);
});

test('every settings route refuses a request with no session, no Origin, a wrong Origin, no Sec-Fetch-Site, or the wrong content type', async (t) => {
  const r = await start(t);
  const writes = [[SAVE, { name: 'claude-oauth-token', value: TOKEN }], [ERASE, { name: 'claude-oauth-token' }]];
  for (const [path, body] of writes) {
    const cases = [
      ['no cookie', { cookie: null }, 401],
      ['a cookie that is not ours', { cookie: 'albera_room_x=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 401],
      ['no Origin', { headers: { Origin: undefined } }, 403],
      ['another Origin', { headers: { Origin: 'http://127.0.0.1:1' } }, 403],
      ['no Sec-Fetch-Site', { headers: { 'Sec-Fetch-Site': undefined } }, 403],
      ['same-site', { headers: { 'Sec-Fetch-Site': 'same-site' } }, 403],
      ['cross-site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
      ['text/plain', { headers: { 'Content-Type': 'text/plain' } }, 415],
      ['form data', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 415],
    ];
    for (const [what, options, status] of cases) {
      const res = await r.call('POST', path, { body, ...options });
      assert.equal(res.status, status, `${path}: ${what}`);
      assert.ok(!res.text.includes(TOKEN));
    }
  }
  for (const [what, options, status] of [['no cookie', { cookie: null }, 401], ['no Sec-Fetch-Site', { headers: { 'Sec-Fetch-Site': undefined } }, 403], ['cross-site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403]]) {
    assert.equal((await r.call('GET', LIST, options)).status, status, `GET: ${what}`);
  }
  assert.equal((await r.call('GET', LIST, { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200, 'a person navigating to the address is served');
  assert.equal((await r.secretStore.status('claude-oauth-token')).present, false, 'none of the refused saves reached the store');
});

test('a store failure is reported by its fixed code, or store_failed; the message and the value are never in the reply or the output', async (t) => {
  const failing = (error) => ({ save: async () => { throw error; }, erase: async () => { throw error; }, status: async () => { throw error; } });
  const leaky = Object.assign(new Error(`could not protect ${TOKEN} at C:\\secret\\path`), { code: 'ENOENT' });
  const cases = [
    [new SecretStoreError('store_unavailable'), 503, 'store_unavailable'],
    [new SecretStoreError('protect_failed'), 500, 'protect_failed'],
    [new SecretStoreError('invalid_value'), 400, 'invalid_value'],
    [leaky, 500, 'store_failed'],
    [{ code: 'not_in_the_list' }, 500, 'store_failed'],
  ];
  for (const [error, status, code] of cases) {
    const r = await start(t, { secretStore: failing(error) });
    const seen = await captureOutput(async () => {
      const res = await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value: TOKEN } });
      assert.equal(res.status, status);
      assert.deepEqual(res.json, { error: code });
      assert.equal((await r.call('GET', LIST)).json.error, code);
    });
    assert.ok(!seen.includes(TOKEN) && !seen.includes('C:\\secret'), 'nothing was printed that carries the value');
  }
});

test('nothing is printed or logged while a value is saved, refused or erased', async (t) => {
  const r = await start(t);
  const seen = await captureOutput(async () => {
    await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value: TOKEN } });
    await r.call('POST', SAVE, { body: { name: 'claude-oauth-token', value: `${TOKEN} with space` } });
    await r.call('POST', SAVE, { cookie: null, body: { name: 'claude-oauth-token', value: TOKEN } });
    await r.call('POST', ERASE, { body: { name: 'claude-oauth-token' } });
  });
  assert.ok(!seen.includes(TOKEN) && !seen.includes('with space'));
});

test('the host takes the routes only when they are well formed, and never over its own paths', async () => {
  const route = { method: 'GET', path: '/api/x-ok', handle: () => ({ status: 200, body: {} }) };
  const make = (apiRoutes) => () => createRoomHost({ ...roomStubs(), apiRoutes });
  make([route])();
  const refused = [
    [{ ...route, path: '/api/session' }], [{ ...route, path: '/api/decide' }], [{ ...route, path: '/api/state' }], [{ ...route, path: '/api/vms/vm-a' }],
    [{ ...route, path: '/api/Bad' }], [{ ...route, path: '/api/a/../b' }], [{ ...route, path: '/other/x' }], [{ ...route, path: '/api/' }],
    [{ ...route, method: 'DELETE' }], [{ ...route, method: 'get' }], [{ ...route, handle: undefined }], [{ ...route, method: 'POST', maxBody: 0 }], [{ ...route, method: 'POST', maxBody: 4097 }],
    [route, route], null, 'x', [null], [{}],
  ];
  for (const apiRoutes of refused) assert.throws(make(apiRoutes), /invalid_room_api_routes/, JSON.stringify(apiRoutes));
  assert.throws(() => createRoomSettingsRoutes({}), /invalid_room_settings_dependencies/);
});

test('a handler that throws or answers nonsense is a bare 500, and a handler never sees the request', async (t) => {
  let seen;
  const r = await startRouteHost(t, [
    { method: 'GET', path: '/api/boom', handle: () => { throw new Error(`secret ${TOKEN}`); } },
    { method: 'GET', path: '/api/nonsense', handle: () => ({ status: 99, body: 'x' }) },
    { method: 'POST', path: '/api/peek', handle: (arg) => { seen = arg; return { status: 200, body: { ok: true } }; } },
  ]);
  const boom = await r.call('GET', 'api/boom');
  assert.deepEqual([boom.status, boom.json], [500, { error: 'route_failed' }]);
  assert.ok(!boom.text.includes(TOKEN));
  assert.equal((await r.call('GET', 'api/nonsense')).status, 500);
  assert.equal((await r.call('POST', 'api/peek', { body: { a: 1 } })).status, 200);
  assert.deepEqual(Object.keys(seen), ['body']);
  assert.deepEqual(seen.body, { a: 1 });
});
