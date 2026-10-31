import { randomUUID } from 'node:crypto';
import { EnvironmentProvider, EnvironmentProviderError, ENVIRONMENT_ACTIONS, validateEnvironmentOperation } from './environment-provider.mjs';
import { RetirementJournalError, createRetirementJournal, purgeExpired } from './environment-retirement-journal.mjs';
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, classifyNetworkAdapters, createNetworkAttestation, signNetworkAttestation } from './broker-contract/network-attestation.mjs';

// What env-io.ps1 create leaves behind: the default adapter, disconnected from any switch. By the attestation rule that is still "present".
const DEFAULT_ADAPTERS = Object.freeze([Object.freeze({ connected: false, switchType: null })]);

/** Deterministic, in-memory provider for contract and fault-injection tests only. It plays the Broker side: `retirements` is the Broker-owned journal (host configuration, never operation input). */
export class MockEnvironmentProvider extends EnvironmentProvider {
  #computers = new Map();
  #failures = [];
  #now;
  #retirements;
  #signer;
  #ttlSeconds;

  /** `attestationSigner` is the Broker-side signer port (host configuration, never operation input); without it attestNetwork is refused. */
  constructor({ now = () => new Date().toISOString(), retirements, attestationSigner, attestationTtlSeconds = DEFAULT_TTL_SECONDS } = {}) {
    super('mock');
    if (typeof now !== 'function') throw new TypeError('invalid_clock');
    if ((attestationSigner !== undefined && (attestationSigner === null || typeof attestationSigner.sign !== 'function'))
      || !Number.isSafeInteger(attestationTtlSeconds) || attestationTtlSeconds < 1 || attestationTtlSeconds > MAX_TTL_SECONDS) throw new TypeError('invalid_attestation_options');
    this.#signer = attestationSigner;
    this.#ttlSeconds = attestationTtlSeconds;
    this.#now = now;
    this.#retirements = retirements ?? createRetirementJournal({ nowMs: () => Date.parse(now()) });
    if (['retire', 'get', 'remove', 'expired'].some((method) => typeof this.#retirements[method] !== 'function')) throw new TypeError('invalid_retirement_journal');
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
    // A retirement record means this id still has a retired incarnation: never create a new one over it.
    if (this.#record(operation.computerId)) throw new EnvironmentProviderError('operation_conflict', { outcome: 'not_applied' });
    const computer = { projectId: operation.projectId, generation: operation.expectedGeneration, state: 'off', vmId: randomUUID(), adapters: DEFAULT_ADAPTERS }; // vmId: the stand-in for the hypervisor's own VM id
    this.#computers.set(operation.computerId, computer);
    const observed = this.#observation(operation.computerId, computer);
    this.#maybeFail('create', 'after');
    return observed;
  }

  async inspect(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'inspect' });
    this.#maybeFail('inspect', 'before');
    const computer = this.#computers.get(operation.computerId);
    // A record with no environment behind it is an unfinished clean-up: never report that as plain "missing".
    if (!computer) return this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: this.#record(operation.computerId) ? 'unknown' : 'missing' });
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
    if (computer) this.#assertOwnership(operation, computer);
    const record = this.#record(operation.computerId, computer ? 'not_applied' : 'unknown');
    // A retirement record exists: only the environment it describes may be destroyed (same VM id and project, generation, incarnation once present).
    // Anything else is not that environment: nothing is deleted and the record stays. With no record destroy is exactly what it always was.
    if (computer && record && !this.#belongs(record, computer)) throw new EnvironmentProviderError('operation_conflict', { outcome: 'not_applied' });
    if (computer) this.#computers.delete(operation.computerId);
    // Clean up the record of THIS environment, also when an earlier attempt already removed it and died before this point; a failed drop is an unknown-outcome error.
    if (record && (computer || (record.generation === operation.expectedGeneration && record.projectId === operation.projectId))) this.#drop(record);
    const observed = this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    this.#maybeFail('destroy', 'after');
    return observed;
  }

  /** Stop, detach from the project and keep the disks; the Broker records the retirement time and a new incarnation id itself. Idempotent for the very environment that was retired; any other one under that id is refused. */
  async retire(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'retire' });
    this.#maybeFail('retire', 'before');
    const computer = this.#computers.get(operation.computerId);
    if (!computer) throw new EnvironmentProviderError('computer_missing', { outcome: 'not_applied' });
    this.#assertOwnership(operation, computer);
    const existing = this.#record(operation.computerId);
    if (existing && !this.#belongs(existing, computer)) throw new EnvironmentProviderError('operation_conflict', { outcome: 'not_applied' });
    computer.state = 'off';
    let record;
    try { record = this.#retirements.retire({ computerId: operation.computerId, projectId: computer.projectId, generation: computer.generation, vmId: computer.vmId }); }
    catch (error) { throw journalFailure(error); }
    computer.incarnationId = record.incarnationId; // what the Hyper-V Broker writes into the VM Notes
    const observed = this.#observation(operation.computerId, computer);
    this.#maybeFail('retire', 'after');
    return observed;
  }

  /** Delete a RETIRED environment. A requested purge needs approval like any action; it does not wait for the deadline. The record must be this request's own. */
  async purge(input) {
    const operation = validateEnvironmentOperation({ ...input, action: 'purge' });
    this.#maybeFail('purge', 'before');
    const computer = this.#computers.get(operation.computerId);
    const record = this.#record(operation.computerId);
    if (!computer) {
      if (!record) return this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
      if (record.generation !== operation.expectedGeneration || record.projectId !== operation.projectId) throw new EnvironmentProviderError('environment_not_retired', { outcome: 'not_applied' });
      this.#drop(record);
      return this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    }
    this.#assertOwnership(operation, computer);
    if (!record || !this.#matches(record, computer)) throw new EnvironmentProviderError('environment_not_retired', { outcome: 'not_applied' });
    this.#computers.delete(operation.computerId);
    this.#drop(record);
    const observed = this.#observation(operation.computerId, { generation: operation.expectedGeneration, state: 'missing' });
    this.#maybeFail('purge', 'after');
    return observed;
  }

  /**
   * The scheduled purge: removes only environments whose own retirement record has passed its deadline. `now` is the Broker's clock (a timer or a test), never operation input;
   * omitted, the journal's own clock is used. An environment that is not exactly the recorded incarnation is 'skipped': nothing is deleted and the record is kept.
   */
  purgeExpiredRetirements({ now } = {}) {
    return purgeExpired({
      journal: this.#retirements,
      atMs: now,
      purgeRecord: (record) => {
        const computer = this.#computers.get(record.computerId);
        if (!computer) return 'already_missing';
        if (!this.#matches(record, computer)) return 'skipped';
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

  /** Simulate another incarnation under the same id (a restored backup, a re-created environment): same project and generation, but no retirement identity. */
  restoreComputer(computerId, { projectId, generation }) {
    if (!this.#computers.has(computerId) || typeof projectId !== 'string' || !Number.isSafeInteger(generation) || generation < 1) {
      throw new EnvironmentProviderError('invalid_restore', { outcome: 'not_applied' });
    }
    this.#computers.set(computerId, { projectId, generation, state: 'off', vmId: randomUUID(), adapters: DEFAULT_ADAPTERS });
  }

  /** Test setup: the adapter facts the "hypervisor" reports for an environment ([{ connected, switchType }]; anything else, for example null, reads as unreadable). */
  setNetworkAdapters(computerId, adapters) {
    const computer = this.#computers.get(computerId);
    if (!computer) throw new EnvironmentProviderError('computer_missing', { outcome: 'not_applied' });
    computer.adapters = adapters;
  }

  /** The Broker-side counterpart of HyperVEnvironmentBrokerPrototype.attestNetwork: classify what is attached (the operation takes no part) and sign it, bound to this environment and the caller's lease generation. */
  async attestNetwork(input, { leaseGeneration } = {}) {
    const operation = validateEnvironmentOperation({ ...input, action: 'inspect' });
    if (!this.#signer || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new EnvironmentProviderError('invalid_provider_state', { outcome: 'not_applied' });
    const computer = this.#computers.get(operation.computerId);
    if (!computer) throw new EnvironmentProviderError('computer_missing', { outcome: 'not_applied' });
    this.#assertOwnership(operation, computer);
    try {
      const body = createNetworkAttestation({
        network: classifyNetworkAdapters(computer.adapters), computerId: operation.computerId, vmId: computer.vmId, generation: computer.generation,
        projectId: computer.projectId, leaseGeneration, observedAt: Math.floor(Date.parse(this.#now()) / 1000), ttlSeconds: this.#ttlSeconds,
      });
      return await signNetworkAttestation(body, this.#signer);
    }
    catch { throw new EnvironmentProviderError('provider_unavailable', { outcome: 'not_applied' }); }
  }

  async #transition(input, action, state) {
    const operation = validateEnvironmentOperation({ ...input, action });
    this.#maybeFail(action, 'before');
    const computer = this.#computers.get(operation.computerId);
    if (!computer) throw new EnvironmentProviderError('computer_missing', { outcome: 'not_applied' });
    this.#assertOwnership(operation, computer);
    if (action === 'start' && this.#record(operation.computerId)) throw new EnvironmentProviderError('environment_retired', { outcome: 'not_applied' });
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

  // Fully retired: the very environment (same VM id) with the recorded project, generation and incarnation.
  #matches(record, computer) {
    return Boolean(record) && computer.vmId === record.vmId && computer.generation === record.generation && computer.projectId === record.projectId
      && computer.incarnationId === record.incarnationId;
  }

  // The recorded environment, possibly mid-retire: same VM id, project and generation; incarnation not yet written or the recorded one.
  #belongs(record, computer) {
    return Boolean(record) && computer.vmId === record.vmId && computer.generation === record.generation && computer.projectId === record.projectId
      && (computer.incarnationId === undefined || computer.incarnationId === record.incarnationId);
  }

  // Journal access. A read that fails is not applied by default; the destroy clean-up asks for 'unknown' because the environment may already be gone.
  #record(computerId, outcome = 'not_applied') {
    try { return this.#retirements.get(computerId); }
    catch { throw new EnvironmentProviderError('provider_state_unknown', { outcome }); }
  }

  #drop(record) {
    try { this.#retirements.remove(record.computerId, record.incarnationId); }
    catch { throw new EnvironmentProviderError('provider_state_unknown', { outcome: 'unknown' }); }
  }

  #observation(computerId, computer) {
    const retired = computer.state !== 'missing' && computer.state !== 'unknown' && this.#matches(this.#record(computerId), computer);
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
