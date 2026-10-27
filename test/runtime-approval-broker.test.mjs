import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeApprovalBroker } from '../src/runtime/approval-broker.mjs';

test('approval broker exposes a frozen allowlist projection and resolves exactly once', async () => {
  const broker = createRuntimeApprovalBroker({ makeId: () => 'approval-request-0001' });
  const request = {
    action: 'start', provider: 'claude', profile: 'read-only-streaming', executable: '/opt/claude', cwd: '/work/project', minimumCliVersion: '2.1.259', versionCheck: true,
    args: ['--print', '--input-format', 'stream-json'], initialInput: 'ALBERA task:\nsynthetic prompt',
    environment: { providerVariables: ['ANTHROPIC_API_KEY'], endpointOverrides: [{ variable: 'ANTHROPIC_BASE_URL', protocol: 'https', host: 'api.example.test' }], secretValue: 'must not escape' },
    platform: 'linux', maxDurationMs: 60_000, maxActive: 4, unexpectedSecret: 'must not escape',
  };
  const decision = broker.authorize(request);
  request.args[0] = 'mutated';
  request.initialInput = 'mutated';
  const [item] = broker.listPending();
  assert.equal(item.id, 'approval-request-0001');
  assert.equal(item.request.initialInput, 'ALBERA task:\nsynthetic prompt');
  assert.equal(item.request.minimumCliVersion, '2.1.259');
  assert.equal(item.request.versionCheck, true);
  assert.deepEqual(item.request.args, ['--print', '--input-format', 'stream-json']);
  assert.equal(Object.isFrozen(item.request), true);
  assert.equal(Object.isFrozen(item.request.args), true);
  assert.deepEqual(item.request.environment, {
    providerVariables: ['ANTHROPIC_API_KEY'],
    endpointOverrides: [{ variable: 'ANTHROPIC_BASE_URL', protocol: 'https', host: 'api.example.test' }],
  });
  assert.equal(JSON.stringify(item).includes('must not escape'), false);
  assert.equal(broker.decide(item.id, true), true);
  assert.equal(await decision, true);
  assert.equal(broker.decide(item.id, false), false);
  assert.equal(broker.size, 0);
  broker.close();
});

test('approval broker denies invalid requests, invalid decisions, and queue overflow', async () => {
  let id = 0;
  const broker = createRuntimeApprovalBroker({ makeId: () => `approval-request-${String(++id).padStart(4, '0')}` });
  assert.equal(await broker.authorize({ action: 'launch', provider: 'claude' }), false);
  assert.equal(await broker.authorize({ action: 'start', provider: 'unknown' }), false);
  const pending = Array.from({ length: 32 }, () => broker.authorize({ action: 'stop', provider: 'claude', runId: '12345678-1234-4234-8234-123456789abc', force: false }));
  assert.equal(broker.size, 32);
  assert.equal(await broker.authorize({ action: 'stop', provider: 'claude', runId: '12345678-1234-4234-8234-123456789abc', force: false }), false);
  const [item] = broker.listPending();
  assert.equal(broker.decide(item.id, 'approve'), false);
  broker.close();
  assert.deepEqual(await Promise.all(pending), Array(32).fill(false));
  assert.equal(broker.size, 0);
  assert.equal(await broker.authorize({ action: 'stop', provider: 'claude', runId: '12345678-1234-4234-8234-123456789abc', force: false }), false);
});

test('approval broker fails closed if its ID source collides', async () => {
  const broker = createRuntimeApprovalBroker({ makeId: () => 'approval-request-0001' });
  const first = broker.authorize({ action: 'stop', provider: 'claude', runId: '12345678-1234-4234-8234-123456789abc', force: false });
  assert.equal(await broker.authorize({ action: 'stop', provider: 'claude', runId: '12345678-1234-4234-8234-123456789abc', force: false }), false);
  broker.close();
  assert.equal(await first, false);
});

test('approval broker expires pending decisions and notifies subscribers without leaking secrets', async () => {
  let time = 100;
  let id = 0;
  const broker = createRuntimeApprovalBroker({ now: () => time, makeId: () => `approval-request-${String(++id).padStart(4, '0')}` });
  const snapshots = [];
  const unsubscribe = broker.subscribe((items) => snapshots.push(items));
  const pending = broker.authorize({ action: 'input', provider: 'claude', runId: '12345678-1234-4234-8234-123456789abc', text: 'synthetic private input' });
  const [item] = broker.listPending();
  assert.equal(item.request.text, 'synthetic private input');
  assert.equal(item.expiresAt, 120_100);
  time = item.expiresAt;
  assert.deepEqual(broker.listPending(), []);
  assert.equal(await pending, false);
  assert.equal(broker.size, 0);
  assert.equal(snapshots.length >= 2, true);
  unsubscribe();
  broker.close();
});
