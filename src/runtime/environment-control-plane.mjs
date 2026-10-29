// Opt-in authenticated use-case boundary. This is a local API composition seam, not a
// privileged Broker transport or proof of human approval.
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DTO_KEYS = new Set([
  'operationId', 'idempotencyKey', 'projectId', 'taskId', 'runId', 'computerId',
  'providerId', 'leaseId', 'expectedGeneration', 'action', 'spec',
]);
const SNAPSHOT_KEYS = [
  'operationId', 'subjectId', 'projectId', 'taskId', 'runId', 'computerId', 'leaseId',
  'generation', 'action', 'status', 'desiredState', 'observedState', 'observedAt',
  'errorCode', 'createdAt', 'updatedAt',
];
const SAFE_COORDINATOR_ERRORS = new Set([
  'authorization_denied', 'authorization_invalid', 'authorization_expired', 'lease_not_authorized',
  'lease_expired', 'stale_generation', 'idempotency_conflict', 'operation_id_conflict', 'provider_mismatch',
]);

/**
 * Bind typed environment operations to an authenticated Runtime API session.
 * policyVersionForProject and the coordinator authorization callback remain trusted host seams.
 */
export function createEnvironmentControlPlane({ coordinator, store, policyVersionForProject } = {}) {
  const execute = captureMethod(coordinator, 'execute');
  const reconcile = captureMethod(coordinator, 'reconcile');
  const getOperation = captureMethod(store, 'getOperation');
  if (typeof policyVersionForProject !== 'function') throw new TypeError('policy_version_resolver_required');

  return Object.freeze({
    async execute({ sessionId, input } = {}) {
      assertSessionId(sessionId);
      if (!isPlainRecord(input) || Object.keys(input).some((key) => !DTO_KEYS.has(key))) throw safeError('invalid_request');
      let policyVersion;
      try { policyVersion = await policyVersionForProject(Object.freeze({ subjectId: sessionId, projectId: input.projectId })); }
      catch { throw safeError('policy_unavailable'); }
      if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) throw safeError('policy_unavailable');
      let operation;
      try { operation = await execute({ ...input, subjectId: sessionId, policyVersion }); }
      catch (error) { throw safeError(safeCoordinatorErrorCode(error)); }
      return projectSnapshot(operation, sessionId);
    },

    async reconcile({ sessionId, operationId } = {}) {
      assertSessionId(sessionId);
      if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) throw safeError('unknown_operation');
      let record;
      try { record = getOperation(operationId); } catch { throw safeError('operation_unavailable'); }
      const owner = record?.subjectId ?? record?.request?.subjectId;
      if (!record || owner !== sessionId) throw safeError('unknown_operation');
      let result;
      try { result = await reconcile(operationId); }
      catch (error) { throw safeError(safeCoordinatorErrorCode(error)); }
      return projectSnapshot(result, sessionId);
    },
  });
}

function safeCoordinatorErrorCode(error) {
  try {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return 'operation_unavailable';
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    return SAFE_COORDINATOR_ERRORS.has(code) ? code : 'operation_unavailable';
  } catch {
    return 'operation_unavailable';
  }
}

function captureMethod(target, name) {
  if (!target || typeof target !== 'object') throw new TypeError(`invalid_${name}_target`);
  let current = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw new TypeError(`invalid_${name}_method`);
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError(`invalid_${name}_method`);
}

function projectSnapshot(value, sessionId) {
  if (!isPlainRecord(value) || value.subjectId !== sessionId) throw safeError('operation_unavailable');
  const projected = {};
  for (const key of SNAPSHOT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) projected[key] = descriptor.value;
  }
  return Object.freeze(projected);
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) throw safeError('unauthorized');
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value'));
}

function safeError(code) { return Object.assign(new Error(code), { code }); }
