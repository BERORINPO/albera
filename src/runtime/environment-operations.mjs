import { createHash } from 'node:crypto';
import { EnvironmentProviderError, validateEnvironmentOperation, validateObservedEnvironment } from './environment-provider.mjs';

const TARGET_STATE = Object.freeze({ create: 'off', start: 'running', stop: 'off', destroy: 'missing' });

/**
 * In-memory operation coordinator for deterministic contract tests.
 * This is deliberately not wired to an HTTP route and is not a durable production journal.
 */
export class EnvironmentOperationCoordinator {
  #provider;
  #operations = new Map();
  #idempotency = new Map();
  #now;

  constructor({ provider, now = () => new Date().toISOString() } = {}) {
    if (!provider || !['create', 'inspect', 'start', 'stop', 'destroy'].every((method) => typeof provider[method] === 'function')) {
      throw new TypeError('invalid_environment_provider');
    }
    if (typeof now !== 'function') throw new TypeError('invalid_clock');
    this.#provider = provider;
    this.#now = now;
  }

  async execute(input) {
    const operation = validateEnvironmentOperation(input);
    const fingerprint = digest(operation);
    const idempotencyScope = `${operation.subjectId}\0${operation.projectId}\0${operation.idempotencyKey}`;
    const priorId = this.#idempotency.get(idempotencyScope);
    if (priorId) {
      const prior = this.#operations.get(priorId);
      if (prior.fingerprint !== fingerprint) throw new EnvironmentProviderError('idempotency_conflict', { outcome: 'not_applied' });
      return snapshot(prior);
    }
    if (this.#operations.has(operation.operationId)) throw new EnvironmentProviderError('operation_id_conflict', { outcome: 'not_applied' });

    const record = {
      operation,
      fingerprint,
      status: 'REQUESTED',
      desiredState: TARGET_STATE[operation.action] ?? null,
      observedState: 'unknown',
      observedAt: null,
      errorCode: null,
      createdAt: this.#now(),
      updatedAt: this.#now(),
    };
    // The in-memory harness records intent before invoking the provider. Production durability is not implied.
    this.#operations.set(operation.operationId, record);
    this.#idempotency.set(idempotencyScope, operation.operationId);
    try {
      const observed = await this.#invoke(operation);
      this.#applyObservation(record, observed);
      record.status = operation.action === 'inspect' || record.observedState === record.desiredState ? 'SUCCEEDED' : 'UNKNOWN';
    } catch (error) {
      record.errorCode = safeCode(error);
      record.status = error?.outcome === 'not_applied' ? 'FAILED' : 'UNKNOWN';
    }
    record.updatedAt = this.#now();
    return snapshot(record);
  }

  async reconcile(operationId) {
    const record = this.#operations.get(operationId);
    if (!record) throw new EnvironmentProviderError('unknown_operation', { outcome: 'not_applied' });
    if (record.status !== 'UNKNOWN') return snapshot(record);
    try {
      const { spec: _spec, ...inspectOperation } = record.operation;
      const observed = validateObservedEnvironment(await this.#provider.inspect({ ...inspectOperation, action: 'inspect' }), record.operation);
      this.#applyObservation(record, observed);
      if (record.operation.action === 'inspect' || record.observedState === record.desiredState) {
        record.status = 'SUCCEEDED';
        record.errorCode = null;
      }
    } catch (error) {
      record.errorCode = safeCode(error);
      // An inspection failure is not proof that the requested side effect failed.
      record.status = 'UNKNOWN';
    }
    record.updatedAt = this.#now();
    return snapshot(record);
  }

  get(operationId) {
    const record = this.#operations.get(operationId);
    return record ? snapshot(record) : null;
  }

  #invoke(operation) {
    return this.#provider[operation.action](operation);
  }

  #applyObservation(record, observed) {
    const valid = validateObservedEnvironment(observed, record.operation);
    if (valid.generation !== record.operation.expectedGeneration) throw new EnvironmentProviderError('stale_provider_observation');
    record.observedState = valid.state;
    record.observedAt = valid.observedAt;
  }
}

function snapshot(record) {
  return Object.freeze({
    operationId: record.operation.operationId,
    subjectId: record.operation.subjectId,
    projectId: record.operation.projectId,
    taskId: record.operation.taskId,
    runId: record.operation.runId,
    computerId: record.operation.computerId,
    leaseId: record.operation.leaseId,
    generation: record.operation.expectedGeneration,
    action: record.operation.action,
    status: record.status,
    desiredState: record.desiredState,
    observedState: record.observedState,
    observedAt: record.observedAt,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function digest(operation) {
  const { operationId: _operationId, idempotencyKey: _idempotencyKey, ...actionPayload } = operation;
  return createHash('sha256').update(JSON.stringify(sortObject(actionPayload))).digest('hex');
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'provider_outcome_unknown';
}
