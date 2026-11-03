// Room UI authentication for the service launch route (docs/architecture/control-plane-service.md section 4, "Files and ACLs" in section 3).
// Real hosts on 127.0.0.1 with a Fake sink; the real ACL store is tried only in a temporary folder, never in ProgramData.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BOOTSTRAP_ROTATE_MS, createRoomHost } from '../src/runtime/room-host.mjs';
import { createRoomBootstrapFile, createWindowsFileStore, roomBootstrapAcl, validBootstrapAcl } from '../src/runtime/room-bootstrap-file.mjs';
import { createFakeBootstrapStore } from '../src/runtime/fake-room-bootstrap-file.mjs';
import { inspectWindowsAcl } from '../src/runtime/windows-acl.mjs';
import { bootstrapFromHash } from '../src/runtime/room-ui/api.mjs';

const CP_SID = 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555';
const APPROVER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
const FILE = path.resolve(os.tmpdir(), 'albera-fake-ui', 'room.json');
const PNG = new Uint8Array([137, 80, 78, 71]);

function stubs() {
  return {
    vms: [{ vmId: 'vm-a', label: 'Alpha' }],
    board: { snapshot: () => ({}) },
    journal: { record: () => null, recordFleetEvent: () => null, since: () => [], lastSeq: () => 0 },
    director: { tick: () => ({ acts: [], ledger: [] }), decide: () => ({ ok: false, code: 'card_unknown' }) },
    fleet: { startJob: () => ({ ok: true }), stopVm: () => false },
    driver: { capture: async () => ({ png: PNG }) },
  };
}

/** A host on the service route (Fake store) or the CLI route (`sink: false`), with a clock the test moves. */
async function start(t, { sink = true, ...options } = {}) {
  const clock = { t: Date.parse('2026-11-03T09:00:00.000Z') };
  const store = createFakeBootstrapStore();
  const errors = [];
  const file = createRoomBootstrapFile({ filePath: FILE, acl: roomBootstrapAcl({ cpSid: CP_SID, approverSid: APPROVER_SID }), store, pid: 4242, now: () => clock.t });
  const host = createRoomHost({
    ...stubs(), now: () => clock.t, captureIntervalMs: 60_000, tickMs: 60_000,
    ...(sink ? { bootstrapSink: file, onBootstrapError: (code) => errors.push(code) } : {}), ...options,
  });
  const address = await host.listen(0);
  t.after(() => host.close());
  const origin = new URL(address.url).origin;
  const writeHeaders = { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
  const post = (code, headers = {}) => fetch(`${address.url}api/session`, { method: 'POST', headers: { ...writeHeaders, ...headers }, body: JSON.stringify({ bootstrapCode: code }) });
  const get = (p, headers = {}) => fetch(`${address.url}${p}`, { headers });
  const current = () => store.read(FILE);
  const unlock = async (code = current().code) => { const res = await post(code); assert.equal(res.status, 200); return res.headers.get('set-cookie').split(';')[0]; };
  return { host, address, store, errors, clock, origin, post, get, current, unlock };
}

const settle = async (check, what) => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => { setTimeout(resolve, 20); }); }
  assert.fail(`timed out: ${what}`);
};

// ---- the file and the service route ----

test('service route: the code goes to the file, not to the caller; the file has port, code, pid and writtenAt', async (t) => {
  const r = await start(t);
  assert.equal(r.address.bootstrapCode, undefined);
  assert.deepEqual(Object.keys(r.address).sort(), ['host', 'port', 'url']);
  const body = r.current();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'pid', 'port', 'writtenAt']);
  assert.equal(body.port, r.address.port);
  assert.equal(body.pid, 4242);
  assert.equal(body.writtenAt, '2026-11-03T09:00:00.000Z');
  assert.match(body.code, /^[A-Za-z0-9_-]{43}$/);
  const [{ acl, filePath }] = r.store.writes;
  assert.equal(filePath, FILE);
  assert.deepEqual(acl, { protectedDacl: true, entries: [{ sid: CP_SID, right: 'Modify' }, { sid: APPROVER_SID, right: 'Read' }] });
});

test('service route: a code works once, is replaced after use, and the old one is refused', async (t) => {
  const r = await start(t);
  const first = r.current().code;
  const cookie = await r.unlock(first);
  await settle(() => r.current().code !== first, 'the file holds a new code');
  const second = r.current().code;
  assert.equal(r.store.writes.length, 2);
  assert.equal((await r.post(first)).status, 403);
  assert.equal((await r.get('api/state', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  await r.unlock(second);
  await settle(() => r.current().code !== second, 'rotated again');
});

test('service route: a code nobody used is replaced after the rotation time (10 minutes by default)', async (t) => {
  assert.equal(BOOTSTRAP_ROTATE_MS, 10 * 60 * 1000);
  const r = await start(t, { bootstrapRotateMs: 60 });
  const first = r.current().code;
  await settle(() => r.current().code !== first, 'rotation without any use');
  assert.equal((await r.post(first)).status, 403);
  assert.equal(r.errors.length, 0);
});

test('service route: the cookie is HttpOnly, SameSite=Strict, Path=/room/, with a name unique to this host', async (t) => {
  const r = await start(t);
  const res = await r.post(r.current().code);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie.startsWith(`${r.host.cookieName}=`));
  assert.match(r.host.cookieName, /^albera_room_\d+_[0-9a-f]{12}$/);
  for (const attribute of [/HttpOnly/, /SameSite=Strict/, /Path=\/room\//, /Max-Age=28800/]) assert.match(setCookie, attribute);
  assert.doesNotMatch(setCookie, /Secure|Domain/);
});

test('service route: close() deletes the file, and nothing is written after that', async (t) => {
  const r = await start(t, { bootstrapRotateMs: 30 });
  await settle(() => r.store.writes.length >= 2, 'one rotation');
  await r.host.close();
  assert.equal(r.store.files.size, 0);
  assert.deepEqual(r.store.removes, [FILE]);
  const writes = r.store.writes.length;
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  assert.equal(r.store.writes.length, writes);
});

test('service route: a failed first write stops listen(); a failed rotation is reported and the old code is already refused', async (t) => {
  const store = createFakeBootstrapStore();
  store.failWrites(1);
  const sink = createRoomBootstrapFile({ filePath: FILE, acl: roomBootstrapAcl({ cpSid: CP_SID, approverSid: APPROVER_SID }), store });
  const host = createRoomHost({ ...stubs(), bootstrapSink: sink });
  await assert.rejects(host.listen(0), /room_bootstrap_publish_failed/);
  assert.equal(store.files.size, 0);

  const r = await start(t);
  const first = r.current().code;
  r.store.failWrites(1);
  await r.unlock(first);
  await settle(() => r.errors.length === 1, 'the failure is reported');
  assert.deepEqual(r.errors, ['bootstrap_publish_failed']);
  assert.equal(r.current().code, first); // the file still has the used code, which no longer works
  assert.equal((await r.post(first)).status, 403);
});

test('service route: sink calls never overlap, even when a write is slower than the rotation', async (t) => {
  const store = createFakeBootstrapStore({ writeDelayMs: 25 });
  const file = createRoomBootstrapFile({ filePath: FILE, acl: roomBootstrapAcl({ cpSid: CP_SID, approverSid: APPROVER_SID }), store });
  let inFlight = 0;
  let most = 0;
  const sink = {
    async publish(arg) { inFlight++; most = Math.max(most, inFlight); try { await file.publish(arg); } finally { inFlight--; } },
    clear: () => file.clear(),
  };
  const host = createRoomHost({ ...stubs(), bootstrapSink: sink, bootstrapRotateMs: 10 });
  await host.listen(0);
  await settle(() => store.writes.length >= 4, 'several rotations');
  await host.close();
  assert.equal(most, 1);
  assert.equal(store.files.size, 0, 'the last publish ends before the file is cleared');
});

// ---- the CLI route does not change ----

test('CLI route: listen() returns the code, it works once, nothing rotates and no file is written', async (t) => {
  const r = await start(t, { sink: false, bootstrapRotateMs: 20 });
  assert.match(r.address.bootstrapCode, /^[A-Za-z0-9_-]{43}$/);
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  const res = await r.post(r.address.bootstrapCode);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/room\//);
  const again = await r.post(r.address.bootstrapCode);
  assert.equal(again.status, 403);
  assert.deepEqual(await again.json(), { error: 'bootstrap_consumed' });
  assert.equal(r.store.writes.length, 0);
});

// ---- rate limit ----

test('/api/session: 10 calls a minute, then 429 until the minute has passed', async (t) => {
  const r = await start(t);
  for (let i = 0; i < 10; i++) assert.equal((await r.post('wrong-code-wrong-code')).status, 403, `call ${i + 1}`);
  const limited = await r.post('wrong-code-wrong-code');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(await limited.json(), { error: 'rate_limited' });
  assert.equal((await r.post(r.current().code)).status, 429, 'the right code is limited too');
  r.clock.t += 60_001;
  assert.equal((await r.post(r.current().code)).status, 200);
});

test('/api/session: the limit also holds on the CLI route', async (t) => {
  const r = await start(t, { sink: false });
  for (let i = 0; i < 10; i++) assert.equal((await r.post('wrong-code-wrong-code')).status, 403);
  assert.equal((await r.post(r.address.bootstrapCode)).status, 429);
});

// ---- reads need Sec-Fetch-Site same-origin or none ----

test('read APIs: no Sec-Fetch-Site, cross-site and same-site are refused even with a valid cookie; same-origin and none are served', async (t) => {
  const r = await start(t);
  const cookie = await r.unlock();
  const routes = ['api/state', 'api/session', 'api/vms/vm-a/screen.png', 'api/frames/nope.png'];
  for (const route of routes) {
    for (const site of [undefined, 'cross-site', 'same-site', 'bogus']) {
      const res = await r.get(route, { Cookie: cookie, ...(site ? { 'Sec-Fetch-Site': site } : {}) });
      assert.equal(res.status, 403, `${route} with ${site ?? 'no header'}`);
      assert.deepEqual(await res.json(), { error: 'forbidden' });
    }
  }
  for (const site of ['same-origin', 'none']) {
    assert.equal((await r.get('api/state', { Cookie: cookie, 'Sec-Fetch-Site': site })).status, 200, site);
    assert.equal((await r.get('api/session', { Cookie: cookie, 'Sec-Fetch-Site': site })).status, 200, site);
  }
  assert.equal((await r.get('api/state', { 'Sec-Fetch-Site': 'same-origin' })).status, 401, 'no cookie still needs the code');
  assert.equal((await r.get('api/frames/nope.png', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })).status, 404);
});

test('read APIs: the same rule on the CLI route', async (t) => {
  const r = await start(t, { sink: false });
  const cookie = (await r.post(r.address.bootstrapCode)).headers.get('set-cookie').split(';')[0];
  assert.equal((await r.get('api/state', { Cookie: cookie })).status, 403);
  assert.equal((await r.get('api/state', { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await r.get('api/state', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('the page and its files still load on a navigation (Sec-Fetch-Site none) and from the page itself', async (t) => {
  const r = await start(t);
  for (const site of ['none', 'same-origin', undefined]) {
    const res = await r.get('', site ? { 'Sec-Fetch-Site': site } : {});
    assert.equal(res.status, 200, site ?? 'no header');
    await res.arrayBuffer();
  }
  assert.equal((await r.get('', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

// ---- Host and Origin ----

test('Host check: a name other than 127.0.0.1 / localhost with this port is refused', async (t) => {
  const r = await start(t);
  const hostStatus = (host) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: '/room/', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await hostStatus('evil.example:80'), 403);
  assert.equal(await hostStatus(`evil.example:${r.address.port}`), 403);
  assert.equal(await hostStatus(`127.0.0.1:${r.address.port + 1}`), 403);
  assert.equal(await hostStatus(`localhost:${r.address.port}`), 200);
});

test('Origin check: /api/session and /api/decide need this origin; any other Origin is refused on every route', async (t) => {
  const r = await start(t);
  const code = r.current().code;
  assert.equal((await r.post(code, { Origin: 'http://127.0.0.1:1' })).status, 403);
  assert.equal((await r.post(code, { Origin: 'null' })).status, 403);
  const withoutOrigin = await fetch(`${r.address.url}api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapCode: code }) });
  assert.equal(withoutOrigin.status, 403);
  assert.equal((await r.post(code, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal(r.current().code, code, 'refused calls do not use the code');
  const cookie = await r.unlock(code);
  const decide = (headers) => fetch(`${r.address.url}api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify({ cardId: 'c', choiceId: 'd' }) });
  assert.equal((await decide({})).status, 403);
  assert.equal((await decide({ Origin: 'http://127.0.0.1:1', 'Sec-Fetch-Site': 'same-origin' })).status, 403);
  assert.equal((await decide({ Origin: r.origin, 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await decide({ Origin: r.origin, 'Sec-Fetch-Site': 'same-origin' })).status, 404, 'this origin gets to the card lookup');
  assert.equal((await r.get('api/state', { Cookie: cookie, Origin: 'http://127.0.0.1:1', 'Sec-Fetch-Site': 'same-origin' })).status, 403);
});

// ---- the page takes the code from the address ----

test('page: only a plain #b=<code> fragment is a code', () => {
  const code = 'A'.repeat(43);
  assert.equal(bootstrapFromHash(`#b=${code}`), code);
  assert.equal(bootstrapFromHash('#b=abc-_DEF1234567890xyz'), 'abc-_DEF1234567890xyz');
  for (const bad of ['', '#', '#b=', '#b=short', `#b=${code}&x=1`, `#c=${code}`, `b=${code}`, `#b=${code}/`, `#b=${'A'.repeat(129)}`, '#b=a b a b a b a b a b a b', undefined, null, 5]) {
    assert.equal(bootstrapFromHash(bad), '', String(bad));
  }
});

// ---- the sink and its ACL ----

test('room-bootstrap-file: ACL is protected, CP Modify, approver Read; bad SIDs and bad inputs are refused', () => {
  const acl = roomBootstrapAcl({ cpSid: CP_SID, approverSid: APPROVER_SID });
  assert.ok(validBootstrapAcl(acl));
  assert.throws(() => roomBootstrapAcl({ cpSid: CP_SID, approverSid: CP_SID }), /bootstrap_acl_invalid/);
  assert.throws(() => roomBootstrapAcl({ cpSid: 'Users', approverSid: APPROVER_SID }), /bootstrap_acl_invalid/);
  assert.throws(() => roomBootstrapAcl({ cpSid: CP_SID }), /bootstrap_acl_invalid/);
  assert.ok(!validBootstrapAcl({ ...acl, protectedDacl: false }));
  assert.ok(!validBootstrapAcl({ protectedDacl: true, entries: [{ sid: CP_SID, right: 'FullControl' }] }));
  assert.ok(!validBootstrapAcl({ protectedDacl: true, entries: [{ sid: CP_SID, right: 'Read' }, { sid: CP_SID, right: 'Modify' }] }));
  const store = createFakeBootstrapStore();
  assert.throws(() => createRoomBootstrapFile({ filePath: 'room.json', acl, store }), /absolute/);
  assert.throws(() => createRoomBootstrapFile({ filePath: FILE, acl: { protectedDacl: false, entries: [] }, store }), /acl/);
  assert.throws(() => createRoomBootstrapFile({ filePath: FILE, acl, store: {} }), /store/);
});

test('room-bootstrap-file: publish validates port and code, write errors are a fixed code, clear tolerates a missing file', async () => {
  const store = createFakeBootstrapStore();
  const sink = createRoomBootstrapFile({ filePath: FILE, acl: roomBootstrapAcl({ cpSid: CP_SID, approverSid: APPROVER_SID }), store, pid: 7 });
  for (const bad of [{ port: 0, code: 'A'.repeat(43) }, { port: 70000, code: 'A'.repeat(43) }, { port: 80, code: 'short' }, { port: 80, code: `${'A'.repeat(42)}!` }, {}]) {
    await assert.rejects(sink.publish(bad), /bootstrap_file_invalid/);
  }
  assert.equal(store.writes.length, 0);
  await sink.publish({ port: 8123, code: 'B'.repeat(43) });
  assert.deepEqual(store.read(FILE), { port: 8123, code: 'B'.repeat(43), pid: 7, writtenAt: store.read(FILE).writtenAt });
  store.failWrites(1);
  await assert.rejects(sink.publish({ port: 8123, code: 'C'.repeat(43) }), (error) => error.code === 'bootstrap_file_write_failed' && !String(error.message).includes(FILE));
  await sink.clear();
  await sink.clear();
  assert.equal(store.files.size, 0);
});

// ---- the real store, in a temporary folder only ----

test('windows store: the file is created with exactly the two ACEs, replaced in place, and removed', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-room-bootstrap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'room.json');
  const probe = path.join(dir, 'probe.txt');
  fs.writeFileSync(probe, 'x');
  const mine = (await inspectWindowsAcl(probe)).currentUser;
  const inherited = (await inspectWindowsAcl(probe)).rules.map((rule) => rule.sid);
  const system = 'S-1-5-18'; // stands in for the shareholder (read only); the temp folder gives other principals access, which a protected DACL must drop
  const acl = roomBootstrapAcl({ cpSid: mine, approverSid: system });
  const store = createWindowsFileStore();
  const sink = createRoomBootstrapFile({ filePath: file, acl, store, pid: process.pid });

  await sink.publish({ port: 8123, code: 'D'.repeat(43) });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).code, 'D'.repeat(43));
  const rules = (await inspectWindowsAcl(file)).rules;
  assert.deepEqual(rules.map((rule) => rule.sid).sort(), [mine, system].sort(), `the folder gave ${inherited.join(', ')}; none of it may remain`);
  assert.ok(rules.every((rule) => rule.allow));
  const rightsOf = (sid) => rules.find((rule) => rule.sid === sid).rights;
  assert.equal(rightsOf(mine) & 0x1301bf, 0x1301bf, 'Modify');
  assert.equal(rightsOf(system) & 0x1, 0x1, 'the shareholder can read');
  assert.equal(rightsOf(system) & (0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000), 0, 'and cannot write, delete, change the ACL or take ownership');

  await sink.publish({ port: 8124, code: 'E'.repeat(43) });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 8124);
  assert.deepEqual((await inspectWindowsAcl(file)).rules.map((rule) => rule.sid).sort(), [mine, system].sort());
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');

  await sink.clear();
  assert.equal(fs.existsSync(file), false);
  await sink.clear();
});
