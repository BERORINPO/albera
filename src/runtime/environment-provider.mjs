/**
 * Provider-neutral contracts for future project computers.
 * These validators do not authorize operations or connect a provider to the Runtime API.
 */
import { isVmId } from './broker-contract/network-attestation.mjs';

// destroy keeps its meaning (delete now). retire (undoable: stop, detach, keep the disks) and purge (delete the disks of a RETIRED environment) are separate names, see docs/architecture/approval-tiers.md.
export const ENVIRONMENT_ACTIONS = Object.freeze(['create', 'inspect', 'start', 'stop', 'destroy', 'retire', 'purge']);
// 'retired' is reported only by a provider whose own Broker-side retirement record says so; nothing a Control Plane sends can produce it.
export const ENVIRONMENT_STATES = Object.freeze(['missing', 'off', 'running', 'paused', 'retired', 'failed', 'unknown']);
export const ENVIRONMENT_KINDS = Object.freeze(['persistent', 'ephemeral', 'verification']);
export const ENVIRONMENT_CAPABILITIES = Object.freeze(['terminal', 'browser', 'desktop']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;
const ACTION_SET = new Set(ENVIRONMENT_ACTIONS);
const KIND_SET = new Set(ENVIRONMENT_KINDS);
const CAPABILITY_SET = new Set(ENVIRONMENT_CAPABILITIES);
const SPEC_KEYS = new Set(['projectId', 'kind', 'os', 'architecture', 'imageDigest', 'capabilities', 'networkProfileId', 'securityProfileId', 'resources']);
const CAPACITY_KEYS = new Set(['os', 'architecture', 'capabilities', 'networkProfileIds', 'securityProfileIds', 'resources']);
const QUOTA_KEYS = new Set(['maxComputers', 'vcpu', 'memoryMiB', 'diskGiB']);
const OPERATION_KEYS = new Set(['operationId', 'idempotencyKey', 'subjectId', 'projectId', 'taskId', 'runId', 'computerId', 'providerId', 'leaseId', 'expectedGeneration', 'policyVersion', 'action', 'spec', 'vmId']);

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
  async retire(_operation) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
  async purge(_operation) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
  /** Read-only, not a journaled action: a Broker-signed network attestation for one environment (#115 step 2, broker-contract/network-attestation.mjs). `operation` is an inspect operation; `leaseGeneration` is the caller's claim. */
  async attestNetwork(_operation, _options) { throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' }); }
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

/** Validate trusted, host-registered placement capability. Guest data must never populate this record. */
export function validateEnvironmentCapacity(capacity) {
  if (!isRecord(capacity)
    || Object.keys(capacity).some((key) => !CAPACITY_KEYS.has(key))
    || !['linux', 'windows'].includes(capacity.os)
    || !['x64', 'arm64'].includes(capacity.architecture)
    || !Array.isArray(capacity.capabilities)
    || capacity.capabilities.some((value) => !CAPABILITY_SET.has(value))
    || !isIdList(capacity.networkProfileIds, { minimum: 1 })
    || !isIdList(capacity.securityProfileIds, { minimum: 1 })
    || !isResources(capacity.resources)) throw new TypeError('invalid_environment_capacity');
  return Object.freeze({
    os: capacity.os,
    architecture: capacity.architecture,
    capabilities: Object.freeze([...new Set(capacity.capabilities)].sort()),
    networkProfileIds: Object.freeze([...new Set(capacity.networkProfileIds)].sort()),
    securityProfileIds: Object.freeze([...new Set(capacity.securityProfileIds)].sort()),
    resources: Object.freeze({ ...capacity.resources }),
  });
}

/** Hard per-project admission limits. Every field is required; no implicit unlimited defaults. */
export function validateEnvironmentQuota(quota) {
  if (!isRecord(quota) || Object.keys(quota).some((key) => !QUOTA_KEYS.has(key))
    || !Number.isSafeInteger(quota.maxComputers) || quota.maxComputers < 1 || quota.maxComputers > 10_000
    || !Number.isSafeInteger(quota.vcpu) || quota.vcpu < 1 || quota.vcpu > 1_000_000
    || !Number.isSafeInteger(quota.memoryMiB) || quota.memoryMiB < 256 || quota.memoryMiB > 1_073_741_824
    || !Number.isSafeInteger(quota.diskGiB) || quota.diskGiB < 1 || quota.diskGiB > 1_073_741_824) {
    throw new TypeError('invalid_environment_quota');
  }
  return Object.freeze({ maxComputers: quota.maxComputers, vcpu: quota.vcpu, memoryMiB: quota.memoryMiB, diskGiB: quota.diskGiB });
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
  // `vmId` (start only): the Hyper-V VM id the approval named (the `vmId` arg of the approved action). The Broker refuses to start any VM whose own id differs, so an approval
  // given for VM A (or a network attestation made for it) can never start VM B that took its computer id, project, lease and generation. Optional: a start approved without one is as before.
  if (Object.hasOwn(operation, 'vmId') && (operation.action !== 'start' || !isVmId(operation.vmId))) throw new TypeError('invalid_environment_operation');
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
function isIdList(value, { minimum }) { return Array.isArray(value) && value.length >= minimum && value.every(isId); }
function isResources(value) {
  return isRecord(value) && Object.keys(value).length === 3
    && Number.isSafeInteger(value.vcpu) && value.vcpu >= 1 && value.vcpu <= 128
    && Number.isSafeInteger(value.memoryMiB) && value.memoryMiB >= 256 && value.memoryMiB <= 1_048_576
    && Number.isSafeInteger(value.diskGiB) && value.diskGiB >= 1 && value.diskGiB <= 1_048_576;
}
function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value'));
}
