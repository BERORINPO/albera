import { EnvironmentProviderError, isEnvironmentId } from './environment-provider.mjs';

/**
 * Local contract adapter for the future Host Broker boundary.
 * This class has no OS-authenticated IPC or elevated privileges; do not expose it as a service.
 */
export class LocalEnvironmentHostBroker {
  #resolveDispatch;
  #resolveInspection;
  #providerMethods;
  #claims = new WeakMap();

  constructor({ store, provider } = {}) {
    const resolveDispatch = captureMethod(store, 'resolveBrokerDispatch');
    const resolveInspection = captureMethod(store, 'resolveBrokerInspection');
    if (!resolveDispatch || !resolveInspection) {
      throw new TypeError('invalid_environment_broker_store');
    }
    const providerId = readDataProperty(provider, 'providerId');
    const providerMethods = Object.fromEntries(
      ['create', 'inspect', 'start', 'stop', 'destroy'].map((method) => [method, captureMethod(provider, method)]),
    );
    if (typeof providerId !== 'string' || Object.values(providerMethods).some((method) => !method)) {
      throw new TypeError('invalid_environment_provider');
    }
    // retire / purge are optional for a Provider: without them the journaled action ends as not_applied instead of reaching anything.
    for (const method of ['retire', 'purge']) {
      const captured = captureMethod(provider, method);
      if (captured) providerMethods[method] = captured;
    }
    this.#resolveDispatch = resolveDispatch;
    this.#resolveInspection = resolveInspection;
    this.#providerMethods = Object.freeze(providerMethods);
    Object.defineProperty(this, 'providerId', { value: providerId, enumerable: true });
  }

  /** Reload and atomically claim one journaled dispatch; returns an unforgeable in-process capability. */
  claimOperation(request) {
    const operation = this.#resolveDispatch(request);
    const claim = Object.freeze(Object.create(null));
    this.#claims.set(claim, operation);
    return claim;
  }

  /** Consume the claim exactly once and invoke only the fixed Provider method named by the journal. */
  executeClaim(claim) {
    const operation = claim && typeof claim === 'object' ? this.#claims.get(claim) : undefined;
    if (!operation) throw new EnvironmentProviderError('broker_claim_invalid', { outcome: 'not_applied' });
    this.#claims.delete(claim);
    if (!this.#providerMethods[operation.action]) throw new EnvironmentProviderError('provider_not_implemented', { outcome: 'not_applied' });
    return this.#providerMethods[operation.action](operation);
  }

  /** Resolve inspect input from the journal and its separately persisted reconciliation authorization. */
  inspectOperation({ operationId, approvalId } = {}) {
    if (!isEnvironmentId(operationId) || !isEnvironmentId(approvalId)) {
      throw new EnvironmentProviderError('broker_inspection_invalid', { outcome: 'not_applied' });
    }
    const operation = this.#resolveInspection({ operationId, approvalId });
    return this.#providerMethods.inspect(operation);
  }
}

function captureMethod(target, name) {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return null;
  try {
    let current = target;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          ? descriptor.value.bind(target)
          : null;
      }
      current = Object.getPrototypeOf(current);
    }
  }
  catch {
    return null;
  }
  return null;
}

function readDataProperty(target, name) {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  catch {
    return undefined;
  }
}
