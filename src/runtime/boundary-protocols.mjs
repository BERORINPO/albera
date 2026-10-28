// Transport-independent schemas for future Control Plane/Broker and Control Plane/Guest links.
// These validators do not authenticate callers, authorize operations, or execute commands.
const PROTOCOL_VERSION = 1;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BROKER_ERROR_CODES = new Set([
  'authorization_denied', 'generation_mismatch', 'operation_unknown', 'operation_conflict',
  'provider_unavailable', 'provider_timeout', 'provider_state_unknown', 'invalid_provider_state',
]);
const GUEST_ACTIONS = new Set(['task.start', 'task.cancel', 'workspace.inspect']);
const GUEST_EVENT_TYPES = new Set(['heartbeat', 'operation.accepted', 'operation.completed', 'artifact.proposed']);
const OBSERVED_STATES = new Set(['missing', 'off', 'running', 'paused', 'failed', 'unknown']);

export class BoundaryProtocolError extends Error {
  constructor(code) { super(code); this.name = 'BoundaryProtocolError'; this.code = code; }
}

/** Minimal Broker request: authority and operation content must be reloaded from trusted Control Plane state. */
export function validateBrokerRequest(input) {
  const data = readRecord(input, new Set(['protocolVersion', 'type', 'requestId', 'operationId', 'expectedGeneration', 'actionDigest']), 'invalid_broker_request');
  if (data.protocolVersion !== PROTOCOL_VERSION || data.type !== 'broker.operation.request'
    || !UUID_RE.test(data.requestId) || !isId(data.operationId)
    || !isGeneration(data.expectedGeneration) || !DIGEST_RE.test(data.actionDigest)) {
    throw new BoundaryProtocolError('invalid_broker_request');
  }
  return Object.freeze({ ...data });
}

/** Compare an untrusted wire request against one authorization record loaded from the trusted journal. */
export function assertBrokerRequestMatchesAuthorization(requestInput, authorization) {
  const request = validateBrokerRequest(requestInput);
  const trusted = readRecord(authorization,
    new Set(['operationId', 'expectedGeneration', 'actionDigest']), 'invalid_broker_authorization');
  if (!isId(trusted.operationId) || !isGeneration(trusted.expectedGeneration) || !DIGEST_RE.test(trusted.actionDigest)) {
    throw new BoundaryProtocolError('invalid_broker_authorization');
  }
  if (request.operationId !== trusted.operationId || request.expectedGeneration !== trusted.expectedGeneration
    || request.actionDigest !== trusted.actionDigest) {
    throw new BoundaryProtocolError('broker_authorization_mismatch');
  }
  return request;
}

/** Broker response contains typed state only; never provider output, host paths or credentials. */
export function validateBrokerResponse(input) {
  const data = readRecord(input, new Set([
    'protocolVersion', 'type', 'requestId', 'operationId', 'expectedGeneration', 'status',
    'observedState', 'observedAt', 'errorCode',
  ]), 'invalid_broker_response');
  if (data.protocolVersion !== PROTOCOL_VERSION || data.type !== 'broker.operation.response'
    || !UUID_RE.test(data.requestId) || !isId(data.operationId) || !isGeneration(data.expectedGeneration)
    || !['accepted', 'denied', 'succeeded', 'failed', 'unknown'].includes(data.status)
    || !OBSERVED_STATES.has(data.observedState)
    || (data.observedAt !== undefined && !isTimestamp(data.observedAt))
    || (data.errorCode !== undefined && !BROKER_ERROR_CODES.has(data.errorCode))) {
    throw new BoundaryProtocolError('invalid_broker_response');
  }
  if (['denied', 'failed', 'unknown'].includes(data.status) && data.errorCode === undefined) {
    throw new BoundaryProtocolError('invalid_broker_response');
  }
  if (['accepted', 'succeeded'].includes(data.status) && data.errorCode !== undefined) {
    throw new BoundaryProtocolError('invalid_broker_response');
  }
  return Object.freeze({ ...data });
}

/** Typed downlink contains a digest, never a shell line, prompt, arbitrary path or credential. */
export function validateGuestCommand(input) {
  const data = readRecord(input, new Set([
    'protocolVersion', 'type', 'messageId', 'operationId', 'computerId', 'runId',
    'generation', 'action', 'payloadDigest', 'deadlineAt',
  ]), 'invalid_guest_command');
  if (data.protocolVersion !== PROTOCOL_VERSION || data.type !== 'guest.command'
    || !UUID_RE.test(data.messageId) || !isId(data.operationId)
    || !isId(data.computerId) || !isId(data.runId) || !isGeneration(data.generation)
    || !GUEST_ACTIONS.has(data.action) || !DIGEST_RE.test(data.payloadDigest) || !isTimestamp(data.deadlineAt)) {
    throw new BoundaryProtocolError('invalid_guest_command');
  }
  return Object.freeze({ ...data });
}

/** Normalize guest reports as untrusted claims; never accept caller-supplied provenance or trust flags. */
export function validateGuestEvent(input) {
  const common = ['protocolVersion', 'type', 'messageId', 'computerId', 'runId', 'generation', 'sequence', 'occurredAt', 'eventType'];
  const eventType = input && typeof input === 'object' ? ownDataValue(input, 'eventType') : undefined;
  const eventFields = eventType === 'heartbeat' ? ['agentVersion']
    : eventType === 'operation.accepted' ? ['operationId']
      : eventType === 'operation.completed' ? ['operationId', 'claimedOutcome']
        : eventType === 'artifact.proposed' ? ['operationId', 'artifactDigest'] : [];
  const data = readRecord(input, new Set([...common, ...eventFields]), 'invalid_guest_event');
  if (data.protocolVersion !== PROTOCOL_VERSION || data.type !== 'guest.event'
    || !UUID_RE.test(data.messageId) || !isId(data.computerId) || !isId(data.runId)
    || !isGeneration(data.generation) || !Number.isSafeInteger(data.sequence) || data.sequence < 1
    || !isTimestamp(data.occurredAt) || !GUEST_EVENT_TYPES.has(data.eventType)) {
    throw new BoundaryProtocolError('invalid_guest_event');
  }
  if (data.eventType === 'heartbeat' && (typeof data.agentVersion !== 'string' || !/^[A-Za-z0-9.+_-]{1,64}$/.test(data.agentVersion))) {
    throw new BoundaryProtocolError('invalid_guest_event');
  }
  if (['operation.accepted', 'operation.completed', 'artifact.proposed'].includes(data.eventType)
    && !isId(data.operationId)) throw new BoundaryProtocolError('invalid_guest_event');
  if (data.eventType === 'operation.completed' && !['succeeded', 'failed', 'unknown'].includes(data.claimedOutcome)) {
    throw new BoundaryProtocolError('invalid_guest_event');
  }
  if (data.eventType === 'artifact.proposed' && !DIGEST_RE.test(data.artifactDigest)) {
    throw new BoundaryProtocolError('invalid_guest_event');
  }
  return Object.freeze({ ...data, provenance: 'untrusted_guest' });
}

/** Apply host-owned computer/run/generation and sequence fences after authenticating the guest transport. */
export function assertGuestEventFenced(eventInput, trustedContext) {
  const event = validateGuestEvent(eventInput);
  const trusted = readRecord(trustedContext, new Set(['computerId', 'runId', 'generation', 'lastAcceptedSequence']), 'invalid_guest_context');
  if (!isId(trusted.computerId) || !isId(trusted.runId) || !isGeneration(trusted.generation)
    || !Number.isSafeInteger(trusted.lastAcceptedSequence) || trusted.lastAcceptedSequence < 0) {
    throw new BoundaryProtocolError('invalid_guest_context');
  }
  if (event.computerId !== trusted.computerId || event.runId !== trusted.runId || event.generation !== trusted.generation) {
    throw new BoundaryProtocolError('stale_guest_generation');
  }
  if (event.sequence <= trusted.lastAcceptedSequence) throw new BoundaryProtocolError('replayed_guest_event');
  if (event.sequence !== trusted.lastAcceptedSequence + 1) throw new BoundaryProtocolError('guest_event_sequence_mismatch');
  return event;
}

function readRecord(input, allowedKeys, errorCode) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new BoundaryProtocolError(errorCode);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new BoundaryProtocolError(errorCode);
  if (Object.getOwnPropertySymbols(input).length > 0) throw new BoundaryProtocolError(errorCode);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors);
  if (keys.length > 16 || keys.some((key) => !allowedKeys.has(key))) throw new BoundaryProtocolError(errorCode);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) throw new BoundaryProtocolError(errorCode);
    const value = descriptor.value;
    if (typeof value === 'string' && value.length > 128) throw new BoundaryProtocolError(errorCode);
    if (!['string', 'number'].includes(typeof value)) throw new BoundaryProtocolError(errorCode);
    result[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2048) throw new BoundaryProtocolError(errorCode);
  return result;
}

function ownDataValue(input, key) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function isId(value) { return typeof value === 'string' && ID_RE.test(value); }
function isGeneration(value) { return Number.isSafeInteger(value) && value > 0; }
function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}
