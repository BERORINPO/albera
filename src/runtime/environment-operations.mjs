import { createHash, randomUUID } from 'node:crypto';
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

/** Durable coordinator: journal intent first, never replay an existing request, reconcile UNKNOWN by inspection. */
export class DurableEnvironmentOperationCoordinator {
  #store;
  #broker;
  #timeoutMs;
  #authorizeOperation;
  #nowMs;

  constructor({ store, broker, authorizeOperation, nowMs = Date.now, providerTimeoutMs = 30_000 } = {}) {
    if (!store || !['beginOperation', 'recordOperationAuthorization', 'recordProviderOutcome', 'recordReconciliation', 'getOperation'].every((method) => typeof store[method] === 'function')) {
      throw new TypeError('invalid_environment_store');
    }
    if (!broker || !['claimOperation', 'executeClaim', 'inspectOperation'].every((method) => typeof broker[method] === 'function')
      || typeof broker.providerId !== 'string') throw new TypeError('invalid_environment_broker');
    if (typeof authorizeOperation !== 'function') throw new TypeError('authorization_required');
    if (typeof nowMs !== 'function') throw new TypeError('invalid_authorization_clock');
    if (!Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 1 || providerTimeoutMs > 300_000) throw new TypeError('invalid_provider_timeout');
    this.#store = store;
    this.#broker = broker;
    this.#authorizeOperation = authorizeOperation;
    this.#nowMs = nowMs;
    this.#timeoutMs = providerTimeoutMs;
  }

  async execute(input) {
    const operation = validateEnvironmentOperation(input);
    if (operation.providerId !== this.#broker.providerId) throw new EnvironmentProviderError('provider_mismatch', { outcome: 'not_applied' });
    const actionDigest = `sha256:${digest(operation)}`;
    const grant = await this.#authorize(operation, actionDigest, 'execute');
    const begun = this.#store.beginOperation(operation);
    // The durable idempotency record is authoritative: retries return its state without another side effect.
    if (!begun.created) return publicSnapshot(begun.operation);
    let observed;
    let providerInvoked = false;
    try {
      this.#store.recordOperationAuthorization(operation.operationId, grant.authorization, { purpose: 'execute' });
      const dispatchClaim = this.#broker.claimOperation({
        protocolVersion: 1,
        type: 'broker.operation.request',
        requestId: randomUUID(),
        operationId: operation.operationId,
        expectedGeneration: operation.expectedGeneration,
        actionDigest: `sha256:${begun.operation.actionDigest}`,
      });
      if (grant.expiresAtMs <= this.#authorizationTime()) {
        this.#store.recordProviderOutcome(operation.operationId, {
          errorCode: 'authorization_expired', outcome: 'not_applied',
        });
        return publicSnapshot(this.#store.getOperation(operation.operationId));
      }
      providerInvoked = true;
      observed = await withTimeout(this.#broker.executeClaim(dispatchClaim), this.#timeoutMs);
    } catch (error) {
      this.#store.recordProviderOutcome(operation.operationId, {
        errorCode: safeCode(error),
        outcome: !providerInvoked || error?.outcome === 'not_applied' ? 'not_applied' : 'unknown',
      });
      return publicSnapshot(this.#store.getOperation(operation.operationId));
    }
    this.#store.recordProviderOutcome(operation.operationId, { observed });
    return publicSnapshot(this.#store.getOperation(operation.operationId));
  }

  async reconcile(operationId) {
    const record = this.#store.getOperation(operationId);
    if (!record) throw new EnvironmentProviderError('unknown_operation', { outcome: 'not_applied' });
    if (record.status !== 'UNKNOWN') return publicSnapshot(record);
    const { spec: _spec, ...request } = record.request;
    const inspectRequest = { ...request, action: 'inspect' };
    const grant = await this.#authorize(inspectRequest, `sha256:${digest(inspectRequest)}`, 'reconcile');
    if (grant.expiresAtMs <= this.#authorizationTime()) {
      throw new EnvironmentProviderError('authorization_expired', { outcome: 'not_applied' });
    }
    const persistedAuthorization = this.#store.recordOperationAuthorization(operationId, grant.authorization, { purpose: 'reconcile' });
    let observed;
    try {
      observed = await withTimeout(this.#broker.inspectOperation({ operationId, approvalId: persistedAuthorization.approvalId }), this.#timeoutMs);
    } catch (error) {
      this.#store.recordReconciliation(operationId, undefined, { errorCode: safeCode(error) });
      return publicSnapshot(this.#store.getOperation(operationId));
    }
    this.#store.recordReconciliation(operationId, observed);
    return publicSnapshot(this.#store.getOperation(operationId));
  }

  async #authorize(operation, actionDigest, purpose) {
    let grant;
    try {
      grant = await this.#authorizeOperation(Object.freeze({
        operation,
        actionDigest,
        purpose,
      }));
    } catch {
      throw new EnvironmentProviderError('authorization_denied', { outcome: 'not_applied' });
    }
    return validateAuthorizationGrant(grant, operation, actionDigest, purpose, this.#authorizationTime());
  }

  #authorizationTime() {
    let nowMs;
    try { nowMs = this.#nowMs(); }
    catch { throw new EnvironmentProviderError('authorization_clock_invalid', { outcome: 'not_applied' }); }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new EnvironmentProviderError('authorization_clock_invalid', { outcome: 'not_applied' });
    }
    return nowMs;
  }
}

const MAX_APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Validate a trusted authorizer's short-lived, exact-operation human approval assertion. */
function validateAuthorizationGrant(grant, operation, actionDigest, purpose, nowMs) {
  try {
    const keys = ['decision', 'approvalId', 'approverId', 'operationId', 'idempotencyKey', 'subjectId', 'projectId', 'policyVersion', 'actionDigest', 'purpose', 'expiresAt'];
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)
      || Object.getPrototypeOf(grant) !== Object.prototype
      || Object.getOwnPropertySymbols(grant).length > 0
      || Object.keys(grant).length !== keys.length
      || keys.some((key) => !Object.hasOwn(grant, key))
      || Object.values(Object.getOwnPropertyDescriptors(grant)).some((descriptor) => !Object.hasOwn(descriptor, 'value'))
      || grant.decision !== 'approved'
      || !isAuthorizationId(grant.approvalId)
      || !isAuthorizationId(grant.approverId)
      || grant.operationId !== operation.operationId
      || grant.idempotencyKey !== operation.idempotencyKey
      || grant.subjectId !== operation.subjectId
      || grant.projectId !== operation.projectId
      || grant.policyVersion !== operation.policyVersion
      || grant.actionDigest !== actionDigest
      || grant.purpose !== purpose
      || typeof grant.expiresAt !== 'string') {
      throw new EnvironmentProviderError('authorization_invalid', { outcome: 'not_applied' });
    }
    const expiresAtMs = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + MAX_APPROVAL_TTL_MS) {
      throw new EnvironmentProviderError(expiresAtMs <= nowMs ? 'authorization_expired' : 'authorization_invalid', { outcome: 'not_applied' });
    }
    const authorization = Object.freeze(Object.fromEntries(keys.map((key) => [key, grant[key]])));
    return Object.freeze({ expiresAtMs, authorization });
  } catch (error) {
    if (error instanceof EnvironmentProviderError) throw error;
    throw new EnvironmentProviderError('authorization_invalid', { outcome: 'not_applied' });
  }
}

function isAuthorizationId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }

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

function publicSnapshot(record) {
  if (!record) throw new EnvironmentProviderError('operation_unknown', { outcome: 'not_applied' });
  const { request: _request, actionDigest: _actionDigest, ...snapshot } = record;
  return Object.freeze(snapshot);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new EnvironmentProviderError('provider_timeout')), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
