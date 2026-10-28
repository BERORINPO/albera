import { EnvironmentProviderError, isEnvironmentId } from './environment-provider.mjs';

/**
 * Local contract adapter for the future Host Broker boundary.
 * This class has no OS-authenticated IPC or elevated privileges; do not expose it as a service.
 */
export class LocalEnvironmentHostBroker {
  #store;
  #provider;
  #claims = new WeakMap();

  constructor({ store, provider } = {}) {
    if (!store || typeof store.resolveBrokerDispatch !== 'function'
      || typeof store.resolveBrokerInspection !== 'function'
      || typeof store.recordOperationAuthorization !== 'function') {
      throw new TypeError('invalid_environment_broker_store');
    }
    if (!provider || typeof provider.providerId !== 'string'
      || !['create', 'inspect', 'start', 'stop', 'destroy'].every((method) => typeof provider[method] === 'function')) {
      throw new TypeError('invalid_environment_provider');
    }
    this.#store = store;
    this.#provider = provider;
    Object.defineProperty(this, 'providerId', { value: provider.providerId, enumerable: true });
  }

  /** Reload and atomically claim one journaled dispatch; returns an unforgeable in-process capability. */
  claimOperation(request) {
    const operation = this.#store.resolveBrokerDispatch(request);
    const claim = Object.freeze(Object.create(null));
    this.#claims.set(claim, operation);
    return claim;
  }

  /** Consume the claim exactly once and invoke only the fixed Provider method named by the journal. */
  executeClaim(claim) {
    const operation = claim && typeof claim === 'object' ? this.#claims.get(claim) : undefined;
    if (!operation) throw new EnvironmentProviderError('broker_claim_invalid', { outcome: 'not_applied' });
    this.#claims.delete(claim);
    return this.#provider[operation.action](operation);
  }

  /** Resolve inspect input from the journal and its separately persisted reconciliation authorization. */
  inspectOperation({ operationId, approvalId } = {}) {
    if (!isEnvironmentId(operationId) || !isEnvironmentId(approvalId)) {
      throw new EnvironmentProviderError('broker_inspection_invalid', { outcome: 'not_applied' });
    }
    const operation = this.#store.resolveBrokerInspection({ operationId, approvalId });
    return this.#provider.inspect(operation);
  }
}
