import { EnvironmentProvider, EnvironmentProviderError, validateEnvironmentOperation } from './environment-provider.mjs';

/** Deterministic, in-memory provider for contract and fault-injection tests only. */
export class MockEnvironmentProvider extends EnvironmentProvider {
  #computers = new Map();
  #failures = [];
  #now;

  constructor({ now = () => new Date().toISOString() } = {}) {
    super();
    if (typeof now !== 'function') throw new TypeError('invalid_clock');
    this.#now = now;
  }

  failNext(action, { timing = 'before', code = 'mock_provider_failure' } = {}) {
    if (!['create', 'inspect', 'start', 'stop', 'destroy'].includes(action)
      || !['before', 'after'].includes(timing)
      || typeof code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(code)) throw new TypeError('invalid_mock_failure');
    this.#failures.push({ action, timing, code });
  }

  async create(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'create' });
    this.#maybeFail('create', 'before');
    if (this.#computers.has(operation.computerId)) {
      throw new EnvironmentProviderError('computer_already_exists', { outcome: 'not_applied' });
    }
    const computer = { projectId: operation.projectId, generation: operation.expectedGeneration, state: 'off' };
    this.#computers.set(operation.computerId, computer);
    const observed = this.#observation(operation.computerId, computer);
    this.#maybeFail('create', 'after');
    return observed;
  }

  async inspect(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'inspect' });
    this.#maybeFail('inspect', 'before');
    const computer = this.#computers.get(operation.computerId);
    if (!computer) return this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    this.#assertOwnership(operation, computer, { allowOldGenerationForInspection: true });
    const observed = this.#observation(operation.computerId, computer);
    this.#maybeFail('inspect', 'after');
    return observed;
  }

  async start(input) { return this.#transition(input, 'start', 'running'); }
  async stop(input) { return this.#transition(input, 'stop', 'off'); }

  async destroy(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'destroy' });
    this.#maybeFail('destroy', 'before');
    const computer = this.#computers.get(operation.computerId);
    if (!computer) return this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    this.#assertOwnership(operation, computer);
    this.#computers.delete(operation.computerId);
    const observed = this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    this.#maybeFail('destroy', 'after');
    return observed;
  }

  /** Simulate restore fencing in tests; this is not a production restore implementation. */
  restoreGeneration(computerId, generation) {
    const computer = this.#computers.get(computerId);
    if (!computer || !Number.isSafeInteger(generation) || generation <= computer.generation) {
      throw new EnvironmentProviderError('invalid_generation_advance', { outcome: 'not_applied' });
    }
    computer.generation = generation;
  }

  async #transition(input, action, state) {
    const operation = validateEnvironmentOperation({ ...input, action });
    this.#maybeFail(action, 'before');
    const computer = this.#computers.get(operation.computerId);
    if (!computer) throw new EnvironmentProviderError('computer_missing', { outcome: 'not_applied' });
    this.#assertOwnership(operation, computer);
    computer.state = state;
    const observed = this.#observation(operation.computerId, computer);
    this.#maybeFail(action, 'after');
    return observed;
  }

  #assertOwnership(operation, computer, { allowOldGenerationForInspection = false } = {}) {
    if (operation.projectId !== computer.projectId) throw new EnvironmentProviderError('project_mismatch', { outcome: 'not_applied' });
    if (operation.expectedGeneration !== computer.generation
      && !(allowOldGenerationForInspection && operation.expectedGeneration < computer.generation)) {
      throw new EnvironmentProviderError('stale_generation', { outcome: 'not_applied' });
    }
  }

  #observation(computerId, computer) {
    return Object.freeze({ computerId, providerId: 'mock', state: computer.state, generation: computer.generation, observedAt: this.#now() });
  }

  #maybeFail(action, timing) {
    const index = this.#failures.findIndex((failure) => failure.action === action && failure.timing === timing);
    if (index < 0) return;
    const [failure] = this.#failures.splice(index, 1);
    throw new EnvironmentProviderError(failure.code, { outcome: timing === 'before' ? 'not_applied' : 'unknown' });
  }
}
