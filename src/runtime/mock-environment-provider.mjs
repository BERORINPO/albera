import { EnvironmentProvider, EnvironmentProviderError, ENVIRONMENT_ACTIONS, validateEnvironmentOperation } from './environment-provider.mjs';
import { RetirementJournalError, createRetirementJournal, purgeExpired } from './environment-retirement-journal.mjs';

/** Deterministic, in-memory provider for contract and fault-injection tests only. It plays the Broker side: `retirements` is the Broker-owned journal (host configuration, never operation input). */
export class MockEnvironmentProvider extends EnvironmentProvider {
  #computers = new Map();
  #failures = [];
  #now;
  #retirements;

  constructor({ now = () => new Date().toISOString(), retirements } = {}) {
    super('mock');
    if (typeof now !== 'function') throw new TypeError('invalid_clock');
    this.#now = now;
    this.#retirements = retirements ?? createRetirementJournal({ nowMs: () => Date.parse(now()) });
    if (typeof this.#retirements.retire !== 'function' || typeof this.#retirements.get !== 'function') throw new TypeError('invalid_retirement_journal');
  }

  failNext(action, { timing = 'before', code = 'mock_provider_failure' } = {}) {
    if (!ENVIRONMENT_ACTIONS.includes(action)
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
    this.#retirements.remove(operation.computerId); // a destroyed environment leaves no retirement record behind
    const observed = this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    this.#maybeFail('destroy', 'after');
    return observed;
  }

  /** Stop, detach from the project and keep the disks; the Broker records the retirement time itself. Idempotent: a retired environment keeps its deadline. */
  async retire(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'retire' });
    this.#maybeFail('retire', 'before');
    const computer = this.#computers.get(operation.computerId);
    if (!computer) throw new EnvironmentProviderError('computer_missing', { outcome: 'not_applied' });
    this.#assertOwnership(operation, computer);
    computer.state = 'off';
    try { this.#retirements.retire({ computerId: operation.computerId, projectId: computer.projectId, generation: computer.generation }); }
    catch (error) { throw journalFailure(error); }
    const observed = this.#observation(operation.computerId, computer);
    this.#maybeFail('retire', 'after');
    return observed;
  }

  /** Delete a RETIRED environment. A requested purge needs approval like any action; it does not wait for the deadline. */
  async purge(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'purge' });
    this.#maybeFail('purge', 'before');
    const computer = this.#computers.get(operation.computerId);
    if (!computer) {
      this.#retirements.remove(operation.computerId);
      return this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    }
    this.#assertOwnership(operation, computer);
    if (!this.#retirements.get(operation.computerId)) throw new EnvironmentProviderError('environment_not_retired', { outcome: 'not_applied' });
    this.#computers.delete(operation.computerId);
    this.#retirements.remove(operation.computerId);
    const observed = this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    this.#maybeFail('purge', 'after');
    return observed;
  }

  /**
   * The scheduled purge: removes only environments whose own retirement record has passed its deadline. `now` is the Broker's clock (a timer or a test), never operation input;
   * omitted, the journal's own clock is used.
   */
  purgeExpiredRetirements({ now } = {}) {
    return purgeExpired({
      journal: this.#retirements,
      atMs: now,
      purgeRecord: (record) => {
        const computer = this.#computers.get(record.computerId);
        if (!computer) return 'already_missing';
        if (computer.generation !== record.generation || computer.projectId !== record.projectId) return 'skipped';
        this.#computers.delete(record.computerId);
        return 'purged';
      },
    });
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
    if (action === 'start' && this.#retirements.get(operation.computerId)) throw new EnvironmentProviderError('environment_retired', { outcome: 'not_applied' });
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
    const retired = computer.state !== 'missing' && this.#retirements.get(computerId) !== null;
    return Object.freeze({ computerId, providerId: 'mock', state: retired ? 'retired' : computer.state, generation: computer.generation, observedAt: this.#now() });
  }

  #maybeFail(action, timing) {
    const index = this.#failures.findIndex((failure) => failure.action === action && failure.timing === timing);
    if (index < 0) return;
    const [failure] = this.#failures.splice(index, 1);
    throw new EnvironmentProviderError(failure.code, { outcome: timing === 'before' ? 'not_applied' : 'unknown' });
  }
}

function journalFailure(error) {
  const conflict = error instanceof RetirementJournalError && error.code === 'retirement_conflict';
  return new EnvironmentProviderError(conflict ? 'operation_conflict' : 'provider_state_unknown', { outcome: conflict ? 'not_applied' : 'unknown' });
}
