import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertBrokerRequestMatchesAuthorization,
  assertGuestEventFenced,
  BoundaryProtocolError,
  validateBrokerRequest,
  validateBrokerResponse,
  validateGuestCommand,
  validateGuestEvent,
} from '../src/runtime/boundary-protocols.mjs';

const requestId = '00000000-0000-4000-8000-000000000001';
const operationId = '00000000-0000-4000-8000-000000000002';
const messageId = '00000000-0000-4000-8000-000000000003';
const digest = `sha256:${'a'.repeat(64)}`;
const at = '2026-10-28T00:00:00.000Z';

function brokerRequest(overrides = {}) {
  return { protocolVersion: 1, type: 'broker.operation.request', requestId, operationId, expectedGeneration: 4, actionDigest: digest, ...overrides };
}
function guestEvent(overrides = {}) {
  return {
    protocolVersion: 1, type: 'guest.event', messageId, computerId: 'computer-1', runId: 'run-1',
    generation: 4, sequence: 8, occurredAt: at, eventType: 'operation.completed', operationId,
    claimedOutcome: 'succeeded', ...overrides,
  };
}

test('Broker requests carry only a bounded operation reference and immutable-action fence', () => {
  const normalized = validateBrokerRequest(brokerRequest());
  assert.equal(normalized.operationId, operationId);
  assert.equal(Object.isFrozen(normalized), true);
  assertBrokerRequestMatchesAuthorization(brokerRequest(), { operationId, expectedGeneration: 4, actionDigest: digest });
  for (const overrides of [
    { subjectId: 'claimed-human' }, { action: 'destroy' }, { nativeVmId: 'host-id' },
    { path: 'C:\\vm.vhdx' }, { powershell: 'Remove-VM' }, { command: 'anything' },
    { approval: true },
  ]) assert.throws(() => validateBrokerRequest(brokerRequest(overrides)), (error) => error instanceof BoundaryProtocolError);
  assert.throws(() => assertBrokerRequestMatchesAuthorization(brokerRequest(), {
    operationId, expectedGeneration: 3, actionDigest: digest,
  }), (error) => error.code === 'broker_authorization_mismatch');
  assert.throws(() => assertBrokerRequestMatchesAuthorization(brokerRequest({ actionDigest: `sha256:${'b'.repeat(64)}` }), {
    operationId, expectedGeneration: 4, actionDigest: digest,
  }), (error) => error.code === 'broker_authorization_mismatch');
});

test('Broker responses allow typed state only and reject provider output or secret fields', () => {
  const response = validateBrokerResponse({
    protocolVersion: 1, type: 'broker.operation.response', requestId, operationId,
    expectedGeneration: 4, status: 'succeeded', observedState: 'running', observedAt: at,
  });
  assert.equal(response.observedState, 'running');
  for (const extra of [{ stdout: 'secret output' }, { token: 'secret' }, { hostPath: 'C:\\VM' }, { powershell: '...' }]) {
    assert.throws(() => validateBrokerResponse({
      protocolVersion: 1, type: 'broker.operation.response', requestId, operationId,
      expectedGeneration: 4, status: 'succeeded', observedState: 'running', ...extra,
    }), (error) => error.code === 'invalid_broker_response');
  }
  assert.throws(() => validateBrokerResponse({
    protocolVersion: 1, type: 'broker.operation.response', requestId, operationId,
    expectedGeneration: 4, status: 'unknown', observedState: 'unknown', errorCode: 'provider_timeout',
    stdout: 'must not cross boundary',
  }), (error) => error.code === 'invalid_broker_response');
});

test('Guest commands are typed, generation-fenced and contain no executable text or credentials', () => {
  const command = validateGuestCommand({
    protocolVersion: 1, type: 'guest.command', messageId, operationId, computerId: 'computer-1', runId: 'run-1',
    generation: 4, action: 'task.start', payloadDigest: digest, deadlineAt: at,
  });
  assert.equal(command.action, 'task.start');
  for (const extra of [{ script: 'whoami' }, { command: 'bash -c ...' }, { executable: 'powershell' }, { token: 'credential' }, { path: 'C:\\host' }]) {
    assert.throws(() => validateGuestCommand({
      protocolVersion: 1, type: 'guest.command', messageId, operationId, computerId: 'computer-1', runId: 'run-1',
      generation: 4, action: 'task.start', payloadDigest: digest, deadlineAt: at, ...extra,
    }), (error) => error.code === 'invalid_guest_command');
  }
  assert.throws(() => validateGuestCommand({
    protocolVersion: 1, type: 'guest.command', messageId, operationId, computerId: 'computer-1', runId: 'run-1',
    generation: 0, action: 'task.start', payloadDigest: digest, deadlineAt: at,
  }), (error) => error.code === 'invalid_guest_command');
});

test('Guest event normalization assigns untrusted provenance and only accepts digest references', () => {
  const event = validateGuestEvent(guestEvent());
  assert.equal(event.claimedOutcome, 'succeeded');
  assert.equal(event.provenance, 'untrusted_guest');
  assert.equal(Object.isFrozen(event), true);
  assert.throws(() => validateGuestEvent(guestEvent({ provenance: 'trusted_host' })),
    (error) => error.code === 'invalid_guest_event');
  assert.throws(() => validateGuestEvent(guestEvent({ verified: true })),
    (error) => error.code === 'invalid_guest_event');
  assert.throws(() => validateGuestEvent(guestEvent({ artifactDigest: 'C:\\host\\secret.txt' })),
    (error) => error.code === 'invalid_guest_event');
  assert.throws(() => validateGuestEvent(guestEvent({ output: 'unbounded process output' })),
    (error) => error.code === 'invalid_guest_event');
});

test('Guest intake fences computer/run/generation and rejects replay or sequence gaps', () => {
  const context = { computerId: 'computer-1', runId: 'run-1', generation: 4, lastAcceptedSequence: 7 };
  const accepted = assertGuestEventFenced(guestEvent(), context);
  assert.equal(accepted.provenance, 'untrusted_guest');
  assert.throws(() => assertGuestEventFenced(guestEvent({ generation: 3 }), context),
    (error) => error.code === 'stale_guest_generation');
  assert.throws(() => assertGuestEventFenced(guestEvent({ computerId: 'computer-2' }), context),
    (error) => error.code === 'stale_guest_generation');
  assert.throws(() => assertGuestEventFenced(guestEvent({ sequence: 7 }), context),
    (error) => error.code === 'replayed_guest_event');
  assert.throws(() => assertGuestEventFenced(guestEvent({ sequence: 9 }), context),
    (error) => error.code === 'guest_event_sequence_mismatch');
});

test('Boundary validators reject accessors and nested executable payloads without invoking getters', () => {
  let invoked = false;
  const getterRequest = brokerRequest();
  Object.defineProperty(getterRequest, 'operationId', { get() { invoked = true; return operationId; } });
  assert.throws(() => validateBrokerRequest(getterRequest), (error) => error.code === 'invalid_broker_request');
  assert.equal(invoked, false);
  assert.throws(() => validateGuestEvent(guestEvent({ payload: { command: 'not allowed' } })),
    (error) => error.code === 'invalid_guest_event');
  assert.throws(() => validateGuestCommand({
    protocolVersion: 1, type: 'guest.command', messageId, operationId, computerId: 'computer-1', runId: 'run-1',
    generation: 4, action: 'task.start', payloadDigest: digest, deadlineAt: at, extras: { token: 'secret' },
  }), (error) => error.code === 'invalid_guest_command');
});
