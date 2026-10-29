import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';
import { createDesktopWallHost } from '../src/runtime/desktop-wall-host.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { createMockDesktopBroker } from '../src/runtime/mock-desktop-broker.mjs';

const screen = Object.freeze({ width: 64, height: 48 });
const VMS = [{ vmId: 'vm-a', label: 'Alpha' }, { vmId: 'vm-b', label: 'Beta' }];

async function start(t, { vms = VMS, broker = createMockDesktopBroker(screen), ...options } = {}) {
  const clock = { t: Date.parse('2026-10-29T12:00:00.000Z') };
  const now = () => clock.t;
  const host = createDesktopWallHost({
    vms, now, captureIntervalMs: 60_000, staleAfterMs: 10_000, ...options,
    driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease, now, screen }),
  });
  const address = await host.listen(0);
  t.after(() => host.close());
  const origin = new URL(address.url).origin;
  const post = (code) => fetch(`${address.url}api/session`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ bootstrapCode: code }),
  });
  const unlock = async () => {
    const res = await post(address.bootstrapCode);
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
  };
  const get = (p, cookie, init = {}) => fetch(`${address.url}${p}`, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers } });
  return { host, broker, address, clock, unlock, post, get };
}

test('captures every VM, never sends input, and serves list and PNG after unlock', async (t) => {
  const w = await start(t);
  await w.host.captureOnce();
  await w.host.captureOnce();
  assert.equal(w.broker.inputs.length, 0);
  assert.ok(w.broker.captures.length >= 4);
  const cookie = await w.unlock();
  const list = await (await w.get('api/vms', cookie)).json();
  assert.equal(list.vms.length, 2);
  for (const vm of list.vms) {
    assert.deepEqual(Object.keys(vm).sort(), ['capturedAt', 'error', 'label', 'status', 'vmId']);
    assert.equal(vm.status, 'live');
  }
  const png = await w.get('api/vms/vm-a/screen.png', cookie);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
});

test('only the newest frame is served', async (t) => {
  const w = await start(t, { vms: [VMS[0]] });
  await w.host.captureOnce();
  const cookie = await w.unlock();
  const first = Buffer.from(await (await w.get('api/vms/vm-a/screen.png', cookie)).arrayBuffer());
  const changed = Buffer.from(first);
  changed[changed.length - 1] ^= 1; // same size, valid PNG header, different bytes
  w.broker.returnNextScreen(changed);
  await w.host.captureOnce();
  const latest = Buffer.from(await (await w.get('api/vms/vm-a/screen.png', cookie)).arrayBuffer());
  assert.deepEqual(latest, changed);
  assert.notDeepEqual(latest, first);
});

test('bootstrap is required and one-shot, unknown VM ids are 404, writes are refused', async (t) => {
  const w = await start(t);
  await w.host.captureOnce();
  assert.equal((await w.get('api/vms')).status, 401);
  assert.equal((await w.get('api/vms/vm-a/screen.png')).status, 401);
  assert.equal((await w.post('nope')).status, 403);
  const cookie = await w.unlock();
  assert.equal((await w.post(w.address.bootstrapCode)).status, 403);
  for (const id of ['vm-z', '..%2F..%2Fetc', 'constructor', '%E0%A4%A']) {
    assert.equal((await w.get(`api/vms/${id}/screen.png`, cookie)).status, 404, id);
  }
  assert.equal((await w.get('api/vms', cookie, { method: 'POST' })).status, 405);
  assert.equal((await w.get('api/vms/vm-a/screen.png', cookie, { method: 'DELETE' })).status, 405);
});

test('Host header, cross-site and out-of-scope paths are refused', async (t) => {
  const w = await start(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: w.address.port, path: '/wall/', headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await w.get('', undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${w.address.port}/other`)).status, 404);
});

test('responses carry the CSP with img-src self and no-store; the UI files are served', async (t) => {
  const w = await start(t);
  const page = await w.get('');
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await w.get('wall.mjs')).status, 200);
  assert.equal((await w.get('wall.css')).status, 200);
  const cookie = await w.unlock();
  await w.host.captureOnce();
  const png = await w.get('api/vms/vm-a/screen.png', cookie);
  assert.equal(png.headers.get('cache-control'), 'no-store');
  assert.match(png.headers.get('content-security-policy'), /img-src 'self'/);
});

test('the session cookie is HttpOnly, SameSite=Strict and scoped to /wall/', async (t) => {
  const w = await start(t);
  const setCookie = (await w.post(w.address.bootstrapCode)).headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/wall\//);
});

test('a frame older than staleAfterMs is reported as stale', async (t) => {
  const w = await start(t, { vms: [VMS[0]] });
  await w.host.captureOnce();
  const cookie = await w.unlock();
  const status = async () => (await (await w.get('api/vms', cookie)).json()).vms[0].status;
  assert.equal(await status(), 'live');
  w.clock.t += 10_001;
  assert.equal(await status(), 'stale');
});

test('a failed capture reports only a safe error code and keeps the last good time', async (t) => {
  const w = await start(t, { vms: [VMS[0]] });
  const cookie = await w.unlock();
  const read = async () => (await (await w.get('api/vms', cookie)).json()).vms[0];
  await w.host.captureOnce();
  const good = (await read()).capturedAt;
  w.broker.failNext('desktop_unavailable');
  await w.host.captureOnce();
  let vm = await read();
  assert.deepEqual([vm.status, vm.error, vm.capturedAt], ['error', 'desktop_unavailable', good]);
  w.broker.failNext('C:\\secret\\path leaked');
  await w.host.captureOnce();
  vm = await read();
  assert.equal(vm.error, 'desktop_unknown');
  assert.doesNotMatch(JSON.stringify(vm), /secret/);
  await w.host.captureOnce();
  assert.equal((await read()).status, 'live');
});

test('a VM with no frame yet is pending and has no PNG', async (t) => {
  const host = createDesktopWallHost({ vms: [VMS[0]], driver: { capture: () => new Promise(() => {}) } });
  const address = await host.listen(0);
  t.after(() => host.close());
  const res = await fetch(`${address.url}api/session`, {
    method: 'POST',
    headers: { Origin: new URL(address.url).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapCode: address.bootstrapCode }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const list = await (await fetch(`${address.url}api/vms`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual([list.vms[0].status, list.vms[0].capturedAt], ['pending', null]);
  assert.equal((await fetch(`${address.url}api/vms/vm-a/screen.png`, { headers: { Cookie: cookie } })).status, 404);
});

test('the periodic timer captures, and close() stops it', async (t) => {
  const broker = createMockDesktopBroker(screen);
  const w = await start(t, { broker, vms: [VMS[0]], captureIntervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(broker.captures.length >= 3, `captures: ${broker.captures.length}`);
  await w.host.close();
  const after = broker.captures.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(broker.captures.length, after);
  await assert.rejects(w.get(''));
});

test('captures are serialized per VM and bounded overall', async () => {
  let running = 0;
  let peak = 0;
  let violated = false;
  const busy = new Set();
  const driver = {
    async capture({ vmId }) {
      running++;
      peak = Math.max(peak, running);
      if (busy.has(vmId)) violated = true;
      busy.add(vmId);
      await new Promise((resolve) => setTimeout(resolve, 15));
      busy.delete(vmId);
      running--;
      throw new Error('boom');
    },
  };
  const vms = Array.from({ length: 6 }, (_, i) => ({ vmId: `vm-${i}` }));
  const host = createDesktopWallHost({ vms, driver });
  await Promise.all([host.captureOnce(), host.captureOnce()]);
  assert.equal(violated, false);
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.ok(peak >= 1);
});

test('construction rejects bad VM lists and drivers', () => {
  const driver = { capture: async () => ({}) };
  assert.throws(() => createDesktopWallHost({ vms: [], driver }), /vms/);
  assert.throws(() => createDesktopWallHost({ vms: Array.from({ length: 17 }, (_, i) => ({ vmId: `v${i}` })), driver }), /vms/);
  assert.throws(() => createDesktopWallHost({ vms: [{ vmId: 'a' }, { vmId: 'a' }], driver }), /invalid_wall_vm/);
  assert.throws(() => createDesktopWallHost({ vms: [{ vmId: '../x' }], driver }), /invalid_wall_vm/);
  assert.throws(() => createDesktopWallHost({ vms: [{ vmId: 'a', label: 'bad\u3042' }], driver }), /invalid_wall_label/);
  assert.throws(() => createDesktopWallHost({ vms: [{ vmId: 'a' }] }), /driver/);
});

test('the wall host source never calls act()', () => {
  const source = fs.readFileSync(new URL('../src/runtime/desktop-wall-host.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /\.act\s*\(|sendVmInput/);
});

test('albera-runtime wall parses --vm name[:label] and --port, and is in the help', () => {
  const options = parseRuntimeArgs(['wall', '--vm', 'dev-1:Dev box', '--vm', 'dev-2', '--port', '8899']);
  assert.deepEqual(options.vms, [{ vmId: 'dev-1', label: 'Dev box' }, { vmId: 'dev-2', label: 'dev-2' }]);
  assert.equal(options.port, 8899);
  assert.throws(() => parseRuntimeArgs(['wall']), /runtime_wall_vm_required/);
  assert.throws(() => parseRuntimeArgs(['wall', '--vm', 'a', '--vm', 'a']), /runtime_wall_vm_duplicate/);
  assert.throws(() => parseRuntimeArgs(['wall', '--vm', '../x']), /runtime_wall_vm_invalid/);
  assert.throws(() => parseRuntimeArgs(['wall', '--vm', 'a', '--port', '70000']), /runtime_port_invalid/);
  assert.throws(() => parseRuntimeArgs(['wall', '--root', '/x']), /invalid_runtime_option/);
  assert.throws(() => parseRuntimeArgs(['wall', ...Array.from({ length: 17 }, (_, i) => ['--vm', `v${i}`]).flat()]), /runtime_wall_vm_too_many/);
  assert.equal(parseRuntimeArgs(['wall', '--help']).help, true);
  assert.match(RUNTIME_HELP, /albera-runtime wall --vm/);
});

test('agent status is shown on /api/vms only when a statusSource is given (read-only)', async (t) => {
  const plain = await start(t);
  await plain.host.captureOnce();
  const plainList = await (await plain.get('api/vms', await plain.unlock())).json();
  for (const vm of plainList.vms) assert.equal(Object.hasOwn(vm, 'agent'), false);

  const state = { 'vm-a': { state: 'running', step: 2, actions: 1, usd: 0.001, cursor: [3, 4], lastAction: 'left_click', outcome: null, claim: '' } };
  const w = await start(t, { statusSource: { snapshot: () => state } });
  await w.host.captureOnce();
  const cookie = await w.unlock();
  const list = await (await w.get('api/vms', cookie)).json();
  assert.deepEqual(list.vms.find((vm) => vm.vmId === 'vm-a').agent, state['vm-a']);
  assert.equal(list.vms.find((vm) => vm.vmId === 'vm-b').agent, null);
  assert.equal((await w.get('api/vms', cookie, { method: 'POST' })).status, 405);
  assert.equal(w.broker.inputs.length, 0);
  assert.throws(() => createDesktopWallHost({ vms: VMS, driver: {}, statusSource: {} }), /statusSource/);
});

test('a throwing statusSource does not break the wall list', async (t) => {
  const w = await start(t, { statusSource: { snapshot: () => { throw new Error('boom'); } } });
  await w.host.captureOnce();
  const res = await w.get('api/vms', await w.unlock());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).vms.length, 2);
});
