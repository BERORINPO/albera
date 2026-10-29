import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createGuestScreenSource, runGuestCaptureSetup, GUEST_CAPTURE_PWSH_ARGS,
} from '../src/runtime/hyperv-guest-capture-prototype.mjs';
import { createHyperVDesktopBrokerPrototype } from '../src/runtime/hyperv-desktop-broker-prototype.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { syntheticPng } from '../src/runtime/mock-desktop-broker.mjs';
import { parseWorkspace } from '../src/runtime/workspace.mjs';
import { loadRoomWorkspace, parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';

const SECRET = 'S3cret-Guest-Pa55word!';
const PWSH = process.execPath; // any existing absolute file stands in for pwsh.exe when openProcess is faked
const VM = 'albera-clone-03';
const SCREEN = Object.freeze({ width: 64, height: 48 });
const LEASE = Object.freeze({ desktopSessionId: 'agent-x', ownerType: 'AI', ownerId: 'albera-agent', generation: 1, expiresAt: '2999-01-01T00:00:00.000Z' });

function passwordFile(t, text = `${SECRET}\r\n`) {
  const dir = mkdtempSync(path.join(tmpdir(), 'albera-guest-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'admin-password.txt');
  writeFileSync(file, text);
  return file;
}

/**
 * In-memory capture-io.ps1: records every process and every stdin line. `reply(request, proc)` returns the object
 * printed as the answer line, or undefined to stay silent (a hang).
 */
function fakeProcesses(reply) {
  const procs = [];
  const openProcess = ({ command, args }) => {
    const proc = { command, args, lines: [], killed: false, lineFns: [], closeFns: [] };
    procs.push(proc);
    return {
      write: (text) => {
        for (const line of text.split('\n').filter(Boolean)) {
          proc.lines.push(line);
          const out = reply(JSON.parse(line), proc);
          if (out !== undefined) queueMicrotask(() => { if (!proc.killed) for (const fn of proc.lineFns) fn(JSON.stringify(out)); });
        }
      },
      onLine: (fn) => proc.lineFns.push(fn),
      onClose: (fn) => proc.closeFns.push(fn),
      kill: () => { proc.killed = true; },
    };
  };
  return { procs, openProcess };
}

const frame = (width = SCREEN.width, height = SCREEN.height) => ({ ok: true, realWidth: width, realHeight: height, png: syntheticPng(width, height).toString('base64') });
const healthy = (request) => (request.op === 'serve' ? { ok: true } : frame(request.width, request.height));
const codeOf = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code ?? error.message; } };

test('guest screens: fixed argv, the password only in the first stdin line, one process reused for every frame', async (t) => {
  const fake = fakeProcesses(healthy);
  const source = createGuestScreenSource({ vms: [VM], passwordFile: passwordFile(t), pwsh: PWSH, openProcess: fake.openProcess });
  const a = await source.capture({ vmId: VM, ...SCREEN });
  const b = await source.capture({ vmId: VM, ...SCREEN });
  assert.ok(a.equals(syntheticPng(64, 48)) && b.equals(a));
  assert.equal(fake.procs.length, 1);
  const [proc] = fake.procs;
  assert.equal(proc.command, PWSH);
  assert.deepEqual(proc.args, GUEST_CAPTURE_PWSH_ARGS);
  assert.ok(!proc.args.join(' ').includes(SECRET), 'argv never holds the password');
  assert.deepEqual(JSON.parse(proc.lines[0]), { op: 'serve', vmName: VM, user: 'Administrator', password: SECRET });
  assert.deepEqual(proc.lines.slice(1).map((l) => JSON.parse(l)), [{ op: 'read', ...SCREEN }, { op: 'read', ...SCREEN }]);
  assert.ok(proc.lines.slice(1).every((l) => !l.includes(SECRET)), 'only the first line carries it');
  source.close();
  assert.equal(proc.killed, true);
  assert.equal(await codeOf(source.capture({ vmId: VM, ...SCREEN })), 'desktop_unavailable');
});

test('guest screens: only the named VMs, one request in flight per VM', async (t) => {
  let inFlight = 0;
  let most = 0;
  const pending = [];
  const fake = fakeProcesses((request) => {
    if (request.op === 'serve') return { ok: true };
    inFlight++;
    most = Math.max(most, inFlight);
    pending.push(() => { inFlight--; return frame(); });
    return undefined;
  });
  const source = createGuestScreenSource({ vms: [VM], passwordFile: passwordFile(t), pwsh: PWSH, openProcess: fake.openProcess });
  assert.equal(source.handles(VM), true);
  assert.equal(source.handles('albera-clone-01'), false);
  assert.equal(await codeOf(source.capture({ vmId: 'albera-clone-01', ...SCREEN })), 'desktop_vm_not_found');
  assert.equal(await codeOf(source.capture({ vmId: VM, width: 0, height: 48 })), 'desktop_input_rejected');
  const both = [source.capture({ vmId: VM, ...SCREEN }), source.capture({ vmId: VM, ...SCREEN })];
  // answer each read when it arrives
  const proc = () => fake.procs[0];
  for (let i = 0; i < 2; i++) {
    while (pending.length === 0) await new Promise((r) => setTimeout(r, 1));
    const out = pending.shift()();
    for (const fn of proc().lineFns) fn(JSON.stringify(out));
  }
  await Promise.all(both);
  assert.equal(most, 1);
  source.close();
});

test('guest screens: codes from the VM are fixed codes; anything else (even holding the password) is desktop_unavailable', async (t) => {
  const file = passwordFile(t);
  const run = async (answer) => {
    const fake = fakeProcesses((request) => (request.op === 'serve' ? { ok: true } : answer));
    const source = createGuestScreenSource({ vms: [VM], passwordFile: file, pwsh: PWSH, openProcess: fake.openProcess });
    try { await source.capture({ vmId: VM, ...SCREEN }); return 'ok'; }
    catch (error) {
      assert.ok(!String(error.message).includes(SECRET) && !JSON.stringify(error).includes(SECRET));
      return error.code;
    } finally { source.close(); }
  };
  assert.equal(await run({ ok: false, code: 'desktop_guest_frame_stale' }), 'desktop_guest_frame_stale');
  assert.equal(await run({ ok: false, code: 'desktop_guest_frame_missing' }), 'desktop_guest_frame_missing');
  assert.equal(await run({ ok: false, code: `wrong password ${SECRET}` }), 'desktop_unavailable');
  assert.equal(await run({ ok: true }), 'desktop_unavailable'); // no png
});

test('guest screens: a failed start pauses before the next try; a hung read is killed and a new process starts', async (t) => {
  let clock = 0;
  let serveAnswer = { ok: false, code: 'desktop_guest_auth_failed' };
  let hang = false;
  const fake = fakeProcesses((request) => (request.op === 'serve' ? serveAnswer : hang ? undefined : frame()));
  const source = createGuestScreenSource({
    vms: [VM], passwordFile: passwordFile(t), pwsh: PWSH, openProcess: fake.openProcess, now: () => clock, retryMs: 10_000, readTimeoutMs: 20,
  });
  assert.equal(await codeOf(source.capture({ vmId: VM, ...SCREEN })), 'desktop_guest_auth_failed');
  assert.equal(await codeOf(source.capture({ vmId: VM, ...SCREEN })), 'desktop_guest_auth_failed');
  assert.equal(fake.procs.length, 1, 'no new process within the pause');
  assert.equal(fake.procs[0].killed, true);
  clock = 10_000;
  serveAnswer = { ok: true };
  assert.equal(await codeOf(source.capture({ vmId: VM, ...SCREEN })), 'ok');
  hang = true;
  assert.equal(await codeOf(source.capture({ vmId: VM, ...SCREEN })), 'desktop_broker_timeout');
  assert.equal(fake.procs[1].killed, true);
  hang = false;
  assert.equal(await codeOf(source.capture({ vmId: VM, ...SCREEN })), 'ok');
  assert.equal(fake.procs.length, 3);
  source.close();
});

test('guest screens: an unreadable password file never starts pwsh; bad options are refused', async (t) => {
  const fake = fakeProcesses(healthy);
  for (const text of ['', 'x'.repeat(2000)]) {
    const source = createGuestScreenSource({ vms: [VM], passwordFile: passwordFile(t, text), pwsh: PWSH, openProcess: fake.openProcess });
    assert.equal(await codeOf(source.capture({ vmId: VM, ...SCREEN })), 'desktop_guest_password_unreadable');
  }
  assert.equal(fake.procs.length, 0);
  assert.throws(() => createGuestScreenSource({ vms: [VM] }), /guest_password_file_required/);
  assert.throws(() => createGuestScreenSource({ vms: ['a b'], passwordFile: 'p' }), /invalid_guest_capture_vms/);
  assert.throws(() => createGuestScreenSource({ vms: [VM], passwordFile: 'p', pwsh: 'pwsh' }), /invalid_guest_capture_options/);
  assert.throws(() => createGuestScreenSource({ vms: [VM], passwordFile: 'p', user: 'a; b' }), /invalid_guest_capture_user/);
});

test('broker: a guest-capture VM takes its screen from the guest, every other VM from the host thumbnail', async (t) => {
  const fake = fakeProcesses(healthy);
  const guestScreens = createGuestScreenSource({ vms: [VM], passwordFile: passwordFile(t), pwsh: PWSH, openProcess: fake.openProcess });
  t.after(() => guestScreens.close());
  // A pwsh that does not exist: any host-side capture fails, so a success can only come from the guest source.
  const broker = createHyperVDesktopBrokerPrototype({ pwsh: path.join(tmpdir(), 'no-such-pwsh.exe'), guestScreens });
  const png = await broker.captureVmScreen({ vmId: VM, ...SCREEN });
  assert.ok(png.equals(syntheticPng(64, 48)));
  assert.equal(await codeOf(broker.captureVmScreen({ vmId: 'albera-clone-01', ...SCREEN })), 'desktop_unavailable');
  assert.equal(fake.procs[0].lines.filter((l) => JSON.parse(l).op === 'read').length, 1);
  assert.throws(() => createHyperVDesktopBrokerPrototype({ guestScreens: {} }), /invalid_hyperv_desktop_prototype_options/);
});

test('driver: a guest frame is untrusted screen data (size, signature, IHDR); guest codes pass through, others do not', async () => {
  let next;
  const guestScreens = { handles: () => true, capture: async () => next() };
  const broker = createHyperVDesktopBrokerPrototype({ guestScreens });
  const driver = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => LEASE, now: () => 0, screen: SCREEN });
  next = () => syntheticPng(64, 48);
  const shot = await driver.capture({ vmId: VM, lease: LEASE });
  assert.deepEqual([shot.width, shot.height], [64, 48]);
  for (const bad of [() => syntheticPng(1024, 768), () => Buffer.from('not a png at all, just some guest text'), () => Buffer.alloc(9 * 1024 * 1024)]) {
    next = bad;
    assert.equal(await codeOf(driver.capture({ vmId: VM, lease: LEASE })), 'invalid_desktop_screen_data');
  }
  next = () => { throw Object.assign(new Error('x'), { code: 'desktop_guest_frame_stale' }); };
  assert.equal(await codeOf(driver.capture({ vmId: VM, lease: LEASE })), 'desktop_guest_frame_stale');
  next = () => { throw Object.assign(new Error(SECRET), { code: SECRET }); };
  const error = await driver.capture({ vmId: VM, lease: LEASE }).catch((e) => e);
  assert.equal(error.code, 'desktop_unknown');
  assert.ok(!String(error.message).includes(SECRET));
});

test('guest-capture setup: install / remove send the password on stdin only and return fixed codes', async (t) => {
  const file = passwordFile(t);
  const fake = fakeProcesses((request) => (request.op === 'install' ? { ok: true } : { ok: false, code: `boom ${SECRET}` }));
  assert.deepEqual(await runGuestCaptureSetup({ op: 'install', vmId: VM, passwordFile: file, pwsh: PWSH, openProcess: fake.openProcess }), { ok: true });
  const removed = await runGuestCaptureSetup({ op: 'remove', vmId: VM, passwordFile: file, pwsh: PWSH, openProcess: fake.openProcess });
  assert.deepEqual(removed, { ok: false, code: 'desktop_unavailable' });
  assert.deepEqual(fake.procs.map((p) => JSON.parse(p.lines[0])), [
    { op: 'install', vmName: VM, user: 'Administrator', password: SECRET },
    { op: 'remove', vmName: VM, user: 'Administrator', password: SECRET },
  ]);
  assert.ok(fake.procs.every((p) => p.killed && !p.args.join(' ').includes(SECRET)));
  assert.deepEqual(await runGuestCaptureSetup({ op: 'format-c', vmId: VM, passwordFile: file, pwsh: PWSH, openProcess: fake.openProcess }), { ok: false, code: 'desktop_input_rejected' });
  assert.deepEqual(await runGuestCaptureSetup({ op: 'install', vmId: VM, passwordFile: passwordFile(t, ''), pwsh: PWSH, openProcess: fake.openProcess }), { ok: false, code: 'guest_password_unreadable' });
  assert.equal(fake.procs.length, 2);
});

test('args: --guest-capture names VMs of the command and needs the password file; guest-capture install|remove', () => {
  const pw = ['--guest-password-file', 'pw.txt'];
  const agent = parseRuntimeArgs(['agent', '--vm', VM, '--task', 't', '--guest-capture', VM, ...pw]);
  assert.deepEqual([agent.guestCapture, agent.guestPasswordFile], [[VM], 'pw.txt']);
  assert.deepEqual(parseRuntimeArgs(['agent', '--vm', VM, '--task', 't']).guestCapture, []);
  const wall = parseRuntimeArgs(['wall', '--vm', `${VM}:GPU`, '--vm', 'albera-clone-01', '--guest-capture', VM, ...pw]);
  assert.deepEqual(wall.guestCapture, [VM]);
  const fleet = parseRuntimeArgs(['fleet', '--job', `${VM}=t`, '--guest-capture', VM, ...pw]);
  assert.deepEqual(fleet.guestCapture, [VM]);
  const room = parseRuntimeArgs(['room', '--job', `${VM}=t`, '--guest-capture', VM, ...pw]);
  assert.deepEqual([room.guestCapture, room.guestPasswordFile, room.checksFile], [[VM], 'pw.txt', null]);
  const bad = (argv, re) => assert.throws(() => parseRuntimeArgs(argv), re);
  bad(['agent', '--vm', VM, '--task', 't', '--guest-capture', 'other', ...pw], /runtime_guest_capture_unknown_vm/);
  bad(['agent', '--vm', VM, '--task', 't', '--guest-capture', VM], /runtime_guest_capture_needs_password_file/);
  bad(['agent', '--vm', VM, '--task', 't', ...pw], /runtime_guest_password_file_needs_guest_capture/);
  bad(['agent', '--vm', VM, '--task', 't', '--guest-capture', VM, '--guest-capture', VM, ...pw], /runtime_option_must_be_unique/);
  bad(['agent', '--vm', VM, '--task', 't', '--guest-capture', 'a b', ...pw], /runtime_guest_capture_vm_invalid/);
  bad(['room', '--job', `${VM}=t`, '--guest-capture', 'other', ...pw], /runtime_guest_capture_unknown_vm/);
  bad(['room', '--job', `${VM}=t`, ...pw], /runtime_room_checks_need_both_files/);
  bad(['room', '--workspace', 'w.json', '--guest-capture', VM], /runtime_room_workspace_takes_no_other_options/);
  bad(['room', '--demo', '--guest-capture', VM], /invalid_runtime_option/);
  const install = parseRuntimeArgs(['guest-capture', 'install', '--vm', VM, ...pw]);
  assert.deepEqual([install.command, install.op, install.vm, install.guestPasswordFile], ['guest-capture', 'install', VM, 'pw.txt']);
  bad(['guest-capture', 'start', '--vm', VM, ...pw], /runtime_guest_capture_op_invalid/);
  bad(['guest-capture', 'remove', '--vm', VM], /runtime_guest_capture_needs_vm_and_password_file/);
  bad(['guest-capture', 'remove', '--vm', VM, ...pw, '--password', 'x'], /invalid_runtime_option/);
  assert.ok(RUNTIME_HELP.includes('guest-capture install|remove --vm'));
});

test('workspace: capture "guest" lists the VM, other values and fields are refused, and it needs the password file', () => {
  const MODELS = ['claude-haiku-5-5'];
  const text = (capture) => JSON.stringify({ version: 1, name: 'gpu-room', vms: [{ vm: VM, task: 't', capture }, { vm: 'albera-clone-01', task: 't' }] });
  assert.deepEqual(parseWorkspace(text('guest'), { knownModels: MODELS }).guestCapture, [VM]);
  assert.deepEqual(parseWorkspace(text('host'), { knownModels: MODELS }).guestCapture, []);
  assert.throws(() => parseWorkspace(text('agent'), { knownModels: MODELS }), /workspace_capture_invalid/);
  assert.throws(() => parseWorkspace(text(true), { knownModels: MODELS }), /workspace_capture_invalid/);
  const io = { statSync: (p) => ({ isFile: () => p !== 'missing', size: 10 }), readFileSync: () => text('guest') };
  assert.throws(() => loadRoomWorkspace({ workspaceFile: 'w.json' }, io), /runtime_room_workspace_guest_capture_needs_password_file/);
  const options = loadRoomWorkspace({ workspaceFile: 'w.json', guestPasswordFile: 'pw.txt' }, io);
  assert.deepEqual([options.guestCapture, options.guestPasswordFile], [[VM], 'pw.txt']);
});
