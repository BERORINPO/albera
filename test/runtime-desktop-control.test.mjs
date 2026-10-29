import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_ACTIONS,
  DesktopControlError,
  MAX_TYPE_LENGTH,
  assertLeaseCurrent,
  validateDesktopAction,
  validateDesktopLease,
} from '../src/runtime/desktop-control.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { createMockDesktopBroker, syntheticPng } from '../src/runtime/mock-desktop-broker.mjs';

const screen = Object.freeze({ width: 64, height: 48 });
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const lease = Object.freeze({
  desktopSessionId: 'desktop-1',
  ownerType: 'AI',
  ownerId: 'agent-1',
  generation: 3,
  expiresAt: '2026-10-29T12:05:00.000Z',
});

function makeDriver(overrides = {}) {
  const broker = overrides.broker ?? createMockDesktopBroker(screen);
  let current = overrides.current ?? { ...lease };
  const driver = new HyperVDesktopDriver({
    broker,
    resolveCurrentLease: async () => current,
    now: () => NOW,
    screen,
  });
  return { driver, broker, setCurrent(value) { current = value; } };
}

test('the action list is frozen and covers the documented operations', () => {
  assert.equal(Object.isFrozen(DESKTOP_ACTIONS), true);
  assert.deepEqual([...DESKTOP_ACTIONS].sort(), [
    'double_click', 'key', 'left_click', 'left_mouse_down', 'left_mouse_up', 'mouse_move',
    'right_click', 'screenshot', 'scroll', 'type', 'wait',
  ]);
});

test('validateDesktopAction accepts well-formed actions and returns frozen copies', () => {
  const accepted = [
    { action: 'screenshot' },
    { action: 'left_click', coordinate: [0, 0] },
    { action: 'right_click', coordinate: [63, 47] },
    { action: 'double_click' },
    { action: 'mouse_move', coordinate: [10, 10] },
    { action: 'left_mouse_down' },
    { action: 'left_mouse_up' },
    { action: 'type', text: 'hello world 123' },
    { action: 'key', key: 'ctrl+shift+a', repeat: 2 },
    { action: 'key', key: 'F5' },
    { action: 'scroll', direction: 'down', amount: 5, coordinate: [1, 1] },
    { action: 'wait', durationMs: 500 },
  ];
  for (const input of accepted) {
    const out = validateDesktopAction(input, screen);
    assert.equal(Object.isFrozen(out), true);
    assert.equal(out.action, input.action);
  }
  assert.equal(validateDesktopAction({ action: 'key', key: 'CTRL+C' }, screen).key, 'ctrl+c');
});

test('validateDesktopAction rejects unknown actions, extra fields, bad coordinates, text and keys', () => {
  const rejected = [
    null, 'left_click', [], {},
    { action: 'middle_click' },
    { action: 'screenshot', extra: 1 },
    { action: 'left_click', coordinate: [64, 0] },
    { action: 'left_click', coordinate: [0, 48] },
    { action: 'left_click', coordinate: [-1, 0] },
    { action: 'left_click', coordinate: [1.5, 0] },
    { action: 'left_click', coordinate: [1] },
    { action: 'mouse_move' },
    { action: 'left_mouse_down', coordinate: [1, 1] },
    { action: 'type' },
    { action: 'type', text: '' },
    { action: 'type', text: 'caf\u00e9' },
    { action: 'type', text: 'a\nb' },
    { action: 'type', text: 'x'.repeat(MAX_TYPE_LENGTH + 1) },
    { action: 'key', key: 'ctrl+' },
    { action: 'key', key: 'ctrl+alt+shift+super+a' },
    { action: 'key', key: 'ctrl+ctrl+a' },
    { action: 'key', key: 'a+ctrl' },
    { action: 'key', key: 'printscreen' },
    { action: 'key', key: 'f13' },
    { action: 'key', key: 'a', repeat: 0 },
    { action: 'key', key: 'a', repeat: 11 },
    { action: 'scroll', direction: 'left' },
    { action: 'scroll', direction: 'up', amount: 11 },
    { action: 'wait', durationMs: 0 },
    { action: 'wait', durationMs: 10_001 },
    { action: 'wait' },
    Object.assign(Object.create({ action: 'screenshot' }), {}),
  ];
  for (const input of rejected) {
    assert.throws(() => validateDesktopAction(input, screen), /invalid_desktop_action/, JSON.stringify(input));
  }
  assert.throws(() => validateDesktopAction({ action: 'screenshot' }, { width: 0, height: 10 }), /invalid_desktop_screen/);
  let getterCalled = false;
  const hostile = { action: 'screenshot' };
  Object.defineProperty(hostile, 'coordinate', { enumerable: true, get() { getterCalled = true; return [0, 0]; } });
  assert.throws(() => validateDesktopAction(hostile, screen), /invalid_desktop_action/);
  assert.equal(getterCalled, false);
});

test('validateDesktopLease checks shape, owner type and generation', () => {
  assert.equal(validateDesktopLease(lease).generation, 3);
  for (const bad of [
    null, { ...lease, ownerType: 'ROBOT' }, { ...lease, generation: 0 }, { ...lease, generation: 1.5 },
    { ...lease, desktopSessionId: '../x' }, { ...lease, expiresAt: 'tomorrow' }, { ...lease, extra: true },
    { desktopSessionId: lease.desktopSessionId },
  ]) {
    assert.throws(() => validateDesktopLease(bad), /invalid_desktop_lease/);
  }
});

test('assertLeaseCurrent rejects old generations, other owners, other sessions and expired leases', () => {
  assert.equal(assertLeaseCurrent(lease, { ...lease }, NOW).generation, 3);
  const code = (held, current, now = NOW) => {
    try { assertLeaseCurrent(held, current, now); } catch (error) { assert.ok(error instanceof DesktopControlError); assert.equal(error.outcome, 'not_applied'); return error.code; }
    return 'accepted';
  };
  assert.equal(code({ ...lease, generation: 2 }, lease), 'desktop_lease_stale');
  assert.equal(code({ ...lease, generation: 4 }, lease), 'desktop_lease_stale');
  assert.equal(code({ ...lease, ownerType: 'HUMAN' }, lease), 'desktop_lease_owner_mismatch');
  assert.equal(code({ ...lease, ownerId: 'agent-2' }, lease), 'desktop_lease_owner_mismatch');
  assert.equal(code({ ...lease, desktopSessionId: 'desktop-2' }, lease), 'desktop_lease_session_mismatch');
  assert.equal(code(lease, lease, Date.parse(lease.expiresAt)), 'desktop_lease_expired');
  assert.equal(code(lease, { ...lease, expiresAt: '2026-10-29T11:00:00.000Z' }), 'desktop_lease_expired');
  assert.equal(code({ nope: 1 }, lease), 'invalid_desktop_lease');
  assert.equal(code(lease, lease, Number.NaN), 'invalid_desktop_clock');
});

test('driver binds only the two fixed broker methods and rejects hostile clients', () => {
  const ok = createMockDesktopBroker(screen);
  const resolveCurrentLease = async () => lease;
  assert.doesNotThrow(() => new HyperVDesktopDriver({ broker: ok, resolveCurrentLease, screen }));
  assert.throws(() => new HyperVDesktopDriver({ broker: { captureVmScreen: async () => {} }, resolveCurrentLease }), /invalid_hyperv_desktop_broker_client/);
  assert.throws(() => new HyperVDesktopDriver({ broker: Object.create(ok), resolveCurrentLease }), /invalid_hyperv_desktop_broker_client/);
  assert.throws(() => new HyperVDesktopDriver({ broker: { ...ok, get sendVmInput() { return async () => {}; } }, resolveCurrentLease }), /invalid_hyperv_desktop_broker_client/);
  assert.throws(() => new HyperVDesktopDriver({ broker: ok }), /invalid_hyperv_desktop_broker_client/);
  // Replacing a method after construction does not redirect the driver.
  const { driver, broker } = makeDriver();
  const original = broker.sendVmInput;
  broker.sendVmInput = async () => { throw new Error('replaced'); };
  return driver.act({ vmId: 'vm-1', lease, action: { action: 'left_mouse_up' } }).then((result) => {
    assert.deepEqual(result, { ok: true });
    broker.sendVmInput = original;
  });
});

test('driver runs capture and input through the mock broker', async () => {
  const { driver, broker } = makeDriver();
  const shot = await driver.capture({ vmId: 'vm-1', lease });
  assert.equal(shot.width, 64);
  assert.equal(shot.height, 48);
  assert.ok(Buffer.isBuffer(shot.png));
  assert.deepEqual(broker.captures[0], { vmId: 'vm-1', width: 64, height: 48 });

  await driver.act({ vmId: 'vm-1', lease, action: { action: 'left_click', coordinate: [5, 6] } });
  await driver.act({ vmId: 'vm-1', lease, action: { action: 'type', text: 'abc' } });
  await driver.act({ vmId: 'vm-1', lease, action: { action: 'key', key: 'Ctrl+S' } });
  assert.deepEqual(broker.inputs.map((entry) => entry.action), [
    { action: 'left_click', coordinate: [5, 6] },
    { action: 'type', text: 'abc' },
    { action: 'key', key: 'ctrl+s' },
  ]);
  assert.ok(broker.inputs.every((entry) => entry.vmId === 'vm-1'));
  const viaAct = await driver.act({ vmId: 'vm-1', lease, action: { action: 'screenshot' } });
  assert.equal(viaAct.width, 64);
  assert.equal(broker.inputs.length, 3);
});

test('driver validates before touching the broker', async () => {
  const { driver, broker, setCurrent } = makeDriver();
  const expectCode = async (promise, code) => {
    await assert.rejects(promise, (error) => error instanceof DesktopControlError && error.code === code && error.outcome === 'not_applied');
  };
  await expectCode(driver.act({ vmId: 'vm-1', lease, action: { action: 'left_click', coordinate: [999, 0] } }), 'invalid_desktop_action');
  await expectCode(driver.act({ vmId: '../vm', lease, action: { action: 'wait', durationMs: 1 } }), 'invalid_desktop_vm');
  await expectCode(driver.capture({ vmId: 'vm-1', lease: { ...lease, generation: 0 } }), 'invalid_desktop_lease');
  setCurrent({ ...lease, generation: 4 });
  await expectCode(driver.act({ vmId: 'vm-1', lease, action: { action: 'wait', durationMs: 1 } }), 'desktop_lease_stale');
  await expectCode(driver.capture({ vmId: 'vm-1', lease }), 'desktop_lease_stale');
  setCurrent({ ...lease, ownerType: 'HUMAN', ownerId: 'yosuke' });
  await expectCode(driver.act({ vmId: 'vm-1', lease, action: { action: 'left_mouse_down' } }), 'desktop_lease_owner_mismatch');
  assert.equal(broker.inputs.length, 0);
  assert.equal(broker.captures.length, 0);
  const missing = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => { throw new Error('C:\\secret\\path'); }, now: () => NOW, screen });
  await expectCode(missing.capture({ vmId: 'vm-1', lease }), 'desktop_lease_unavailable');
});

test('driver maps broker errors to a safe code set and hides messages', async () => {
  const { driver, broker } = makeDriver();
  broker.failNext('desktop_vm_not_found', 'not_applied');
  await assert.rejects(driver.capture({ vmId: 'vm-1', lease }), (error) => error.code === 'desktop_vm_not_found' && error.outcome === 'not_applied');
  broker.failNext('desktop_broker_timeout');
  await assert.rejects(driver.act({ vmId: 'vm-1', lease, action: { action: 'left_mouse_up' } }), (error) => error.code === 'desktop_broker_timeout' && error.outcome === 'unknown');
  broker.failNext('C:\\Users\\secret\\token');
  await assert.rejects(driver.act({ vmId: 'vm-1', lease, action: { action: 'left_mouse_up' } }), (error) => {
    return error.code === 'desktop_unknown' && error.outcome === 'unknown' && !/secret/.test(`${error.message}${error.code}`);
  });
  // A hostile error whose properties are getters is also contained.
  const hostileBroker = { async captureVmScreen() { throw new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('boom'); } }); }, async sendVmInput() {} };
  const hostile = new HyperVDesktopDriver({ broker: hostileBroker, resolveCurrentLease: async () => lease, now: () => NOW, screen });
  await assert.rejects(hostile.capture({ vmId: 'vm-1', lease }), (error) => error.code === 'desktop_unknown');
});

test('driver treats screen data as untrusted input', async () => {
  const { driver, broker } = makeDriver();
  const cases = [
    'not bytes',
    Buffer.alloc(10),
    Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]),
    syntheticPng(32, 24),
    Buffer.concat([syntheticPng(64, 48), Buffer.alloc(9 * 1024 * 1024)]),
  ];
  for (const bytes of cases) {
    broker.returnNextScreen(bytes);
    await assert.rejects(driver.capture({ vmId: 'vm-1', lease }), (error) => error.code === 'invalid_desktop_screen_data' && error.outcome === 'not_applied');
  }
  const bytes = syntheticPng(64, 48);
  broker.returnNextScreen(bytes);
  const shot = await driver.capture({ vmId: 'vm-1', lease });
  bytes[40] ^= 0xff; // the driver returned its own copy
  assert.notEqual(shot.png[40], bytes[40]);
});

// Real-machine test: opt in with ALBERA_HYPERV_DESKTOP_VM=<vm name>. Skipped (e.g. in CI) otherwise.
const realVm = process.env.ALBERA_HYPERV_DESKTOP_VM;
test('real Hyper-V VM: capture a screenshot through the prototype broker', { skip: realVm ? false : 'ALBERA_HYPERV_DESKTOP_VM is not set' }, async () => {
  const { createHyperVDesktopBrokerPrototype } = await import('../src/runtime/hyperv-desktop-broker-prototype.mjs');
  const driver = new HyperVDesktopDriver({
    broker: createHyperVDesktopBrokerPrototype(),
    resolveCurrentLease: async () => lease,
    now: () => NOW,
  });
  const shot = await driver.capture({ vmId: realVm, lease });
  assert.equal(shot.width, 1024);
  assert.equal(shot.height, 768);
  assert.deepEqual(await driver.act({ vmId: realVm, lease, action: { action: 'mouse_move', coordinate: [512, 384] } }), { ok: true });
});
