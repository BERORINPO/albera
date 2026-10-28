import {
  EnvironmentProvider,
  EnvironmentProviderError,
  validateEnvironmentOperation,
  validateObservedEnvironment,
} from './environment-provider.mjs';

// Keep the privileged boundary narrow: no operation can name a command, script,
// host path, PowerShell expression, or arbitrary Broker method.
const BROKER_METHODS = Object.freeze({
  create: 'createVm',
  inspect: 'inspectVm',
  start: 'startVm',
  stop: 'stopVm',
  destroy: 'removeVm',
});

/**
 * Typed adapter seam for a future authenticated Host Broker client.
 * This class has no IPC, process, PowerShell, Hyper-V, or network implementation.
 * The injected client must itself be a trusted Broker boundary; this is not one.
 */
export class HyperVEnvironmentProvider extends EnvironmentProvider {
  #brokerMethods;

  constructor({ broker }) {
    super('hyperv');
    const descriptors = readBrokerDescriptors(broker);
    if (!descriptors) throw new TypeError('invalid_hyperv_broker_client');
    const methods = {};
    for (const [action, name] of Object.entries(BROKER_METHODS)) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError('invalid_hyperv_broker_client');
      }
      methods[action] = descriptor.value.bind(broker);
    }
    this.#brokerMethods = Object.freeze(methods);
  }

  create(input) { return this.#invoke('create', input); }
  inspect(input) { return this.#invoke('inspect', input); }
  start(input) { return this.#invoke('start', input); }
  stop(input) { return this.#invoke('stop', input); }
  destroy(input) { return this.#invoke('destroy', input); }

  async #invoke(action, input) {
    let operation;
    try {
      operation = validateEnvironmentOperation(input);
    }
    catch {
      throw new EnvironmentProviderError('invalid_environment_operation', { outcome: 'not_applied' });
    }
    if (operation.providerId !== this.providerId || operation.action !== action) {
      throw new EnvironmentProviderError('provider_operation_mismatch', { outcome: 'not_applied' });
    }

    // Invoke only a fixed typed lifecycle method. Keep only a bounded error
    // code and the definitive/not-applied bit; Broker messages may contain paths
    // or credentials and must not escape through this adapter.
    let observed;
    try {
      observed = await this.#brokerMethods[action](operation);
    }
    catch (error) {
      const codeCandidate = dataProperty(error, 'code');
      const outcomeCandidate = dataProperty(error, 'outcome');
      const code = typeof codeCandidate === 'string' && /^[a-z0-9_]{1,64}$/.test(codeCandidate)
        ? codeCandidate
        : 'provider_outcome_unknown';
      throw new EnvironmentProviderError(code, {
        outcome: outcomeCandidate === 'not_applied' ? 'not_applied' : 'unknown',
      });
    }
    let normalized;
    try {
      normalized = validateObservedEnvironment(observed, operation);
    }
    catch {
      // Broker results are untrusted boundary data. A malformed object or a
      // hostile Proxy can throw during reflection; never expose its message.
      throw new EnvironmentProviderError('invalid_provider_observation', { outcome: 'unknown' });
    }
    if (action !== 'inspect' && normalized.generation !== operation.expectedGeneration) {
      throw new EnvironmentProviderError('stale_provider_observation');
    }
    return normalized;
  }
}

function readBrokerDescriptors(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!Object.values(descriptors).every((descriptor) => Object.hasOwn(descriptor, 'value'))) return null;
    return descriptors;
  } catch {
    return null;
  }
}

function dataProperty(value, key) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  catch {
    return undefined;
  }
}
