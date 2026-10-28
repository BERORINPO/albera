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
    if (!isRecord(broker)) {
      throw new TypeError('invalid_hyperv_broker_client');
    }
    const descriptors = Object.getOwnPropertyDescriptors(broker);
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

    // Invoke only a fixed typed lifecycle method. Preserving thrown errors lets
    // the coordinator keep timeout/transport ambiguity as UNKNOWN.
    const observed = await this.#brokerMethods[action](operation);
    const normalized = validateObservedEnvironment(observed, operation);
    if (action !== 'inspect' && normalized.generation !== operation.expectedGeneration) {
      throw new EnvironmentProviderError('stale_provider_observation');
    }
    return normalized;
  }
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => Object.hasOwn(descriptor, 'value'));
}
