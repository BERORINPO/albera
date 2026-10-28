/**
 * Provider-neutral contracts for future project computers.
 * These validators do not authorize operations or connect a provider to the Runtime API.
 */

export const ENVIRONMENT_ACTIONS = Object.freeze(['create', 'inspect', 'start', 'stop', 'destroy']);
export const ENVIRONMENT_STATES = Object.freeze(['missing', 'off', 'running', 'paused', 'failed', 'unknown']);
export const ENVIRONMENT_KINDS = Object.freeze(['persistent', 'ephemeral', 'verification']);
export const ENVIRONMENT_CAPABILITIES = Object.freeze(['terminal', 'browser', 'desktop']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;
const ACTION_SET = new Set(ENVIRONMENT_ACTIONS);
const KIND_SET = new Set(ENVIRONMENT_KINDS);
const CAPABILITY_SET = new Set(ENVIRONMENT_CAPABILITIES);
const SPEC_KEYS = new Set(['projectId', 'kind', 'os', 'architecture', 'imageDigest', 'capabilities', 'networkProfileId', 'securityProfileId', 'resources']);
const OPERATION_KEYS = new Set(['operationId', 'idempotencyKey', 'subjectId', 'projectId', 'taskId', 'runId', 'computerId', 'providerId', 'leaseId', 'expectedGeneration', 'policyVersion', 'action', 'spec']);

export class EnvironmentProviderError extends Error {
  constructor(code, { outcome = 'unknown' } = {}) {
    super(code);
    this.name = 'EnvironmentProviderError';
    this.code = code;
    this.outcome = outcome === 'not_applied' ? 'not_applied' : 'unknown';
  }
}

/** Implementations must expose typed lifecycle methods; generic host command execution is forbidden. */
export class EnvironmentProvider {
  constructor(providerId) {
    if (!isId(providerId)) throw new TypeError('invalid_provider_id');
    Object.defineProperty(this, 'providerId', { value: providerId, enumerable: true });
  }

  async create(_operation) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
  async inspect(_operation) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
  async start(_operation) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
  async stop(_operation) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
  async destroy(_operation) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
}

export function validateEnvironmentSpec(spec) {
  if (!isRecord(spec)
    || Object.keys(spec).some((key) => !SPEC_KEYS.has(key))
    || !isId(spec.projectId)
    || !KIND_SET.has(spec.kind)
    || !['linux', 'windows'].includes(spec.os)
    || !['x64', 'arm64'].includes(spec.architecture)
    || !DIGEST_RE.test(spec.imageDigest)
    || !isId(spec.networkProfileId)
    || !isId(spec.securityProfileId)
    || !isRecord(spec.resources)
    || !Number.isSafeInteger(spec.resources.vcpu) || spec.resources.vcpu < 1 || spec.resources.vcpu > 128
    || !Number.isSafeInteger(spec.resources.memoryMiB) || spec.resources.memoryMiB < 256 || spec.resources.memoryMiB > 1_048_576
    || !Number.isSafeInteger(spec.resources.diskGiB) || spec.resources.diskGiB < 1 || spec.resources.diskGiB > 1_048_576
    || !Array.isArray(spec.capabilities)
    || spec.capabilities.some((capability) => !CAPABILITY_SET.has(capability))) {
    throw new TypeError('invalid_environment_spec');
  }
  return Object.freeze({
    projectId: spec.projectId,
    kind: spec.kind,
    os: spec.os,
    architecture: spec.architecture,
    imageDigest: spec.imageDigest.toLowerCase(),
    networkProfileId: spec.networkProfileId,
    securityProfileId: spec.securityProfileId,
    resources: Object.freeze({ ...spec.resources }),
    capabilities: Object.freeze([...new Set(spec.capabilities)].sort()),
  });
}

export function validateEnvironmentOperation(operation) {
  if (!isRecord(operation)
    || Object.keys(operation).some((key) => !OPERATION_KEYS.has(key))
    || !isId(operation.operationId)
    || !isId(operation.subjectId)
    || !isId(operation.projectId)
    || !isId(operation.taskId)
    || !isId(operation.runId)
    || !isId(operation.computerId)
    || !isId(operation.providerId)
    || !isId(operation.leaseId)
    || !isId(operation.idempotencyKey)
    || !Number.isSafeInteger(operation.expectedGeneration) || operation.expectedGeneration < 1
    || !Number.isSafeInteger(operation.policyVersion) || operation.policyVersion < 1
    || !ACTION_SET.has(operation.action)) {
    throw new TypeError('invalid_environment_operation');
  }
  const normalized = { ...operation };
  if (operation.action === 'create') {
    normalized.spec = validateEnvironmentSpec(operation.spec);
    if (normalized.spec.projectId !== operation.projectId) throw new TypeError('environment_project_mismatch');
  }
  else if (Object.hasOwn(operation, 'spec')) throw new TypeError('unexpected_environment_spec');
  return Object.freeze(normalized);
}

export function validateObservedEnvironment(observed, expected) {
  if (!isRecord(observed)
    || observed.computerId !== expected.computerId
    || !isId(observed.providerId) || observed.providerId !== expected.providerId
    || !ENVIRONMENT_STATES.includes(observed.state)
    || !Number.isSafeInteger(observed.generation) || observed.generation < 1
    || typeof observed.observedAt !== 'string' || !Number.isFinite(Date.parse(observed.observedAt))) {
    throw new EnvironmentProviderError('invalid_provider_observation');
  }
  return Object.freeze({
    computerId: observed.computerId,
    providerId: observed.providerId,
    state: observed.state,
    generation: observed.generation,
    observedAt: observed.observedAt,
  });
}

export function isEnvironmentId(value) { return isId(value); }

function isId(value) { return typeof value === 'string' && ID_RE.test(value); }
function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value'));
}
