// PROTOTYPE. This runs as the same OS user as the caller; it is NOT the privileged Host Broker
// that ADR-002 requires. It is not imported from any entry point, API route or host composition.
// Reaching Hyper-V needs membership in the local "Hyper-V Administrators" group.
// It implements the fixed Broker methods HyperVEnvironmentProvider calls (createVm / inspectVm /
// startVm / stopVm / removeVm, plus retireVm / purgeVm for #115 step 1, attestNetwork for step 2 and attestTaskStart for step 4): a VM is a differencing-disk clone of a golden image (ADR-004,
// provisioning sequence 3). The golden image is named only by the host-registered ledger below;
// no operation can supply a path. Transport: a fixed `pwsh -File <fixed path>` process; the request
// travels as JSON on stdin. No command line is ever assembled from data.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnvironmentOperation } from './environment-provider.mjs';
import { isVmId, purgeExpired } from './environment-retirement-journal.mjs';
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, classifyNetworkAdapters, createNetworkAttestation, signNetworkAttestation } from './broker-contract/network-attestation.mjs';
import { createTaskStartAttestation, signTaskStartAttestation } from './broker-contract/task-start-attestation.mjs';
import { ID_PATTERN } from './broker-contract/action-digest.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./hyperv-env/env-io.ps1', import.meta.url));
const PWSH_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH]);
const PROVIDER_ID = 'hyperv';
const VM_PREFIX = 'albera-';
const COMPUTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,56}$/; // "albera-" + id stays within the 64-char VM name the desktop driver accepts
const DIGEST_KEY_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = new RegExp(ID_PATTERN);
const CHECKPOINT_NAME_PREFIX = 'albera-task-'; // + 24 hex characters of SHA-256(operationId): env-io.ps1 accepts exactly this shape and nothing else
const TASK_START_FIELDS = Object.freeze(['computerId', 'generation', 'leaseGeneration', 'leaseId', 'operationId', 'projectId', 'vmId']);
const ISOLATED_NETWORK = 'isolated-none';
const PS_CODES = new Set(['invalid_provider_state', 'operation_conflict', 'provider_timeout', 'provider_unavailable', 'provider_state_unknown']);
const HYPERV_STATES = Object.freeze({ Running: 'running', Off: 'off', Paused: 'paused', Saved: 'paused' });
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const STOP_WAIT_FRACTION = 0.8;

export function createHyperVEnvironmentBrokerPrototype({
  goldenImages, cloneRoot, pwsh = 'pwsh', timeoutMs = DEFAULT_TIMEOUT_MS,
  hashFile = sha256OfFile, runPowerShell, now = () => new Date(), retirements, attestationSigner, attestationTtlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  // `retirements` is the Broker-owned retirement journal (environment-retirement-journal.mjs): host configuration, never operation input. Without it retire / purge are refused.
  if (retirements !== undefined && (retirements === null || typeof retirements.retire !== 'function' || typeof retirements.get !== 'function'
    || typeof retirements.remove !== 'function' || typeof retirements.expired !== 'function')) {
    throw new TypeError('invalid_hyperv_environment_prototype_options');
  }
  // `attestationSigner` is the signer PORT ({ keyId, sign(bytes) }) for network attestations (#115 step 2): host configuration, never operation input. Without it attestNetwork is refused.
  if ((attestationSigner !== undefined && (attestationSigner === null || typeof attestationSigner.sign !== 'function' || typeof attestationSigner.keyId !== 'string'))
    || !Number.isSafeInteger(attestationTtlSeconds) || attestationTtlSeconds < 1 || attestationTtlSeconds > MAX_TTL_SECONDS) {
    throw new TypeError('invalid_hyperv_environment_prototype_options');
  }
  if (typeof pwsh !== 'string' || pwsh.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000
    || typeof hashFile !== 'function' || typeof now !== 'function'
    || (runPowerShell !== undefined && typeof runPowerShell !== 'function')) {
    throw new TypeError('invalid_hyperv_environment_prototype_options');
  }
  const root = checkedAbsolute(cloneRoot);
  const ledger = checkedLedger(goldenImages, root);
  const run = runPowerShell ?? ((request) => spawnScript(pwsh, timeoutMs, request));
  const hashCache = new Map(); // path|size|mtimeMs -> hex; valid for this broker instance only
  const waitSeconds = Math.max(1, Math.floor((timeoutMs * STOP_WAIT_FRACTION) / 1000));

  const observed = (computerId, state, generation) => ({
    computerId, providerId: PROVIDER_ID, state, generation, observedAt: now().toISOString(),
  });

  async function call(request) {
    let result;
    try {
      result = await run(request);
    }
    catch (error) {
      throw brokerError(safeCode(error?.code), error?.outcome === 'not_applied' ? 'not_applied' : 'unknown');
    }
    if (result?.ok === true) return result;
    throw brokerError(safeCode(result?.code), result?.notApplied === true ? 'not_applied' : 'unknown');
  }

  // `method` is 'inspect', or 'network' for the same fields plus the adapter facts, read in one call so the VM id and the adapters are one observation.
  async function lookup(vmName, method = 'inspect') {
    const result = await call({ method, vmName });
    if (result.exists !== true) return null;
    // vmId is the VM's own Hyper-V id (not editable, not copied by a restore); null when the script did not report a well-formed one.
    const vmId = typeof result.vmId === 'string' && isVmId(result.vmId.toLowerCase()) ? result.vmId.toLowerCase() : null;
    return { state: mapState(result.state), meta: parseNotes(result.notes), vmId, adapters: result.adapters };
  }

  // A VM we may act on: ours (Notes identity) and at the generation the caller expects.
  async function managed(operation, vmName, method = 'inspect') {
    const vm = await lookup(vmName, method);
    if (!vm) return null;
    if (!vm.meta || vm.meta.computerId !== operation.computerId) throw brokerError('invalid_provider_state', 'not_applied');
    if (vm.meta.generation !== operation.expectedGeneration) throw brokerError('stale_generation', 'not_applied');
    return vm;
  }

  async function verifyGolden(imagePath, digest) {
    let info;
    try {
      info = await stat(imagePath);
    }
    catch {
      throw brokerError('invalid_provider_state', 'not_applied');
    }
    // The only write protection is the read-only attribute (R-24); a writable parent is refused.
    if (!info.isFile() || (info.mode & 0o222) !== 0) throw brokerError('invalid_provider_state', 'not_applied');
    const key = `${imagePath}|${info.size}|${info.mtimeMs}`;
    let hex = hashCache.get(key);
    if (hex === undefined) {
      try {
        hex = String(await hashFile(imagePath)).toLowerCase();
      }
      catch {
        throw brokerError('invalid_provider_state', 'not_applied');
      }
      hashCache.set(key, hex);
    }
    if (`sha256:${hex}` !== digest) throw brokerError('invalid_provider_state', 'not_applied');
  }

  return {
    async createVm(input) {
      const { operation, vmName } = checkedOperation(input, 'create');
      // A retirement record means this computer id still has a retired incarnation: never create a new one over it.
      if (readRecord(operation.computerId)) throw brokerError('operation_conflict', 'not_applied');
      const { spec } = operation;
      const golden = Object.hasOwn(ledger, spec.imageDigest) ? ledger[spec.imageDigest] : null;
      if (!golden || golden.os !== spec.os || golden.architecture !== spec.architecture
        || spec.networkProfileId !== ISOLATED_NETWORK) {
        throw brokerError('invalid_provider_state', 'not_applied');
      }
      const notes = notesFor(operation, spec.imageDigest);
      const existing = await lookup(vmName);
      if (existing) {
        // Idempotent re-create: identical identity returns the current state, anything else conflicts.
        const m = existing.meta;
        if (!m || m.computerId !== operation.computerId || m.imageDigest !== spec.imageDigest
          || m.generation !== operation.expectedGeneration || (m.projectId !== null && m.projectId !== operation.projectId)) throw brokerError('operation_conflict', 'not_applied');
        return observed(operation.computerId, existing.state, operation.expectedGeneration);
      }
      await verifyGolden(golden.path, spec.imageDigest);
      const vmDir = path.join(root, vmName);
      // spec.resources.diskGiB is intentionally ignored: a differencing disk grows on demand and
      // its size is bounded by the parent's virtual size, not by a per-VM allocation.
      const result = await call({
        method: 'create', vmName, cloneRoot: root, vmDir, parentPath: golden.path,
        childPath: path.join(vmDir, `${vmName}.vhdx`),
        vcpu: spec.resources.vcpu, memoryMiB: spec.resources.memoryMiB, notes,
      });
      return observed(operation.computerId, mapState(result.state), operation.expectedGeneration);
    },

    async inspectVm(input) {
      const { operation, vmName } = checkedOperation(input, 'inspect');
      const vm = await lookup(vmName);
      // Nothing exists to carry a generation, so echo the caller's expected one (the observation
      // validator requires an integer >= 1). For an existing VM the Notes generation is the truth.
      const record = readRecord(operation.computerId);
      // A record with no VM behind it is an unfinished clean-up (a destroy that died before dropping it): never report that as plain "missing".
      if (!vm) return observed(operation.computerId, record ? 'unknown' : 'missing', operation.expectedGeneration);
      if (!vm.meta || vm.meta.computerId !== operation.computerId) throw brokerError('invalid_provider_state', 'not_applied');
      return observed(operation.computerId, vm.state === 'off' && matchesRecord(record, vm) ? 'retired' : vm.state, vm.meta.generation);
    },

    /**
     * Network attestation (#115 step 2, contract: broker-contract/network-attestation.mjs). Read-only: it reads the VM's adapters, classifies them itself (the operation takes no part),
     * and signs the result through the signer port, bound to computerId, the VM's own id, generation, projectId, `leaseGeneration` and the operation's leaseId (both claims of the caller,
     * checked by the verifier) and this Broker's clock. `input` is an inspect operation. The Approval Authority consumes it (#115 step 3b); it is evidence at observedAt only: an executor must re-check at execution time.
     * The project comes from the VM's own Notes, which create wrote from the authorized create operation; the request's projectId is only compared with it. A VM whose Notes carry no
     * projectId (created before this change) or another one is refused (`project_unknown` / `project_mismatch`, not applied): such a VM cannot be attested until it is re-created.
     * A VM that does not exist, is not ours or is at another generation is refused (not applied); adapters that cannot be read are "unknown", not an error.
     */
    async attestNetwork(input, { leaseGeneration } = {}) {
      const { operation, vmName } = checkedOperation(input, 'inspect');
      if (!attestationSigner || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw brokerError('invalid_provider_state', 'not_applied');
      const vm = await managed(operation, vmName, 'network');
      if (!vm || !vm.vmId) throw brokerError('invalid_provider_state', 'not_applied');
      if (vm.meta.projectId === null) throw brokerError('project_unknown', 'not_applied');
      if (vm.meta.projectId !== operation.projectId) throw brokerError('project_mismatch', 'not_applied');
      try {
        const body = createNetworkAttestation({
          network: classifyNetworkAdapters(vm.adapters), computerId: operation.computerId, vmId: vm.vmId, generation: vm.meta.generation, projectId: vm.meta.projectId,
          leaseId: operation.leaseId, leaseGeneration, observedAt: Math.floor(now().getTime() / 1000), ttlSeconds: attestationTtlSeconds,
        });
        return await signNetworkAttestation(body, attestationSigner);
      }
      catch {
        throw brokerError('provider_unavailable', 'not_applied'); // a signer failure or an unusable clock: nothing was changed
      }
    },

    /**
     * Task-start attestation (#115 step 4, contract: broker-contract/task-start-attestation.mjs). Before a task.start is submitted for approval the Broker takes a Production checkpoint of
     * the VM itself and signs one statement that says "no network" and "this checkpoint was taken", bound to the computer, the VM's own id, generation, project, lease, lease generation and
     * operation. The fields come from the caller's own state (the Control Plane's inspect and the fenced lease) and are checked here against the VM's own Notes and id; nothing else from a
     * request reaches PowerShell: the checkpoint name is derived from the validated operationId alone. Order: read the network (must be "none") -> checkpoint through the fixed
     * `checkpoint` op (the VM id is mandatory there) -> read the network again (still "none", same VM id) -> sign at this Broker's clock.
     * ANY failure (bad input, no signer, a retired or unknown VM, network present or unreadable, the checkpoint failing or reporting another VM, a signer failure) is `null`: no attestation, never
     * an error to the caller, and a person is asked. A checkpoint taken before a later failure is left where it is (cleaning up older checkpoints is not done here).
     * @returns {Promise<object|null>} the signed envelope, or null
     */
    async attestTaskStart(input) {
      try { return await takeTaskStartCheckpoint(input); }
      catch { return null; }
    },

    async startVm(input) { return changeState(input, 'start'); },

    async stopVm(input) { return changeState(input, 'stop'); },

    async removeVm(input) {
      const { operation, vmName } = checkedOperation(input, 'destroy');
      const vm = await managed(operation, vmName);
      // Read the record before anything is deleted: an unreadable journal means nothing was done.
      const record = readRecord(operation.computerId, vm ? 'not_applied' : 'unknown');
      if (!record) {
        // No retirement record for this id: destroy is exactly what it always was.
        if (vm) await deleteVm(expectOf(operation), vmName);
      }
      else if (vm) {
        // A retirement record exists: delete only the VM it describes (same VM id, project, generation, and the incarnation once the Notes carry it).
        // Anything else is not this VM: nothing is deleted and the record stays.
        if (record.projectId !== operation.projectId || !belongsToRecord(record, vm)) throw brokerError('operation_conflict', 'not_applied');
        await deleteVm(recordExpect(record, vm), vmName);
        dropRecord(record);
      }
      else if (record.generation === operation.expectedGeneration && record.projectId === operation.projectId) {
        // An earlier attempt already removed the VM and died before dropping the record: finish that clean-up.
        dropRecord(record);
      }
      return observed(operation.computerId, 'missing', operation.expectedGeneration);
    },

    // Retire: stop, detach (a retired computer id is refused by start and by create), keep every disk, write the retirement record at this Broker's own time with a new
    // incarnation id bound to the VM's own Hyper-V id, then write the incarnation id and the project into the VM's Notes. Each step is safe to repeat: a crash after the stop
    // or after the record is finished by a retry, and until the Notes carry the id nothing (purge, scheduled purge) will match the VM.
    // If a record already exists, only the very VM it was made for (same VM id; Notes blank or carrying the same identity) may be retired again; any other VM with that id and
    // generation (a restored backup, a copy) is refused before it is stopped or relabelled. A retired VM keeps its original record and deadline.
    async retireVm(input) {
      const { operation, vmName } = checkedOperation(input, 'retire');
      if (!retirements) throw brokerError('invalid_provider_state', 'not_applied');
      const vm = await managed(operation, vmName);
      if (!vm || !vm.vmId) throw brokerError('invalid_provider_state', 'not_applied');
      const existing = readRecord(operation.computerId);
      if (existing && (existing.projectId !== operation.projectId || existing.generation !== operation.expectedGeneration || !belongsToRecord(existing, vm))) {
        throw brokerError('operation_conflict', 'not_applied');
      }
      if (vm.meta.projectId !== null && vm.meta.projectId !== operation.projectId) throw brokerError('operation_conflict', 'not_applied'); // the Notes' project is the VM's own
      const vmExpect = { ...expectOf(operation), vmId: vm.vmId, identity: 'vm' };
      if (vm.state !== 'off') await call({ method: 'stop', vmName, expect: vmExpect, waitSeconds });
      let record;
      try {
        record = retirements.retire({ computerId: operation.computerId, projectId: operation.projectId, generation: operation.expectedGeneration, vmId: vm.vmId });
      }
      catch (error) {
        throw error?.code === 'retirement_conflict' ? brokerError('operation_conflict', 'not_applied') : brokerError('provider_state_unknown');
      }
      if (!matchesRecord(record, vm)) {
        const notes = JSON.stringify({
          albera: 1, computerId: operation.computerId, generation: operation.expectedGeneration, imageDigest: vm.meta.imageDigest,
          projectId: record.projectId, incarnationId: record.incarnationId,
        });
        await call({ method: 'annotate', vmName, expect: vmExpect, notes, incarnationId: record.incarnationId });
      }
      return observed(operation.computerId, 'retired', operation.expectedGeneration);
    },

    // Purge: delete the disks of a RETIRED environment only. This is the requested (approved) purge; it does not wait for the deadline.
    // The record must be this request's own (project, generation) and, when the VM exists, this VM's own (incarnation in its Notes). Otherwise: not applied, record kept.
    async purgeVm(input) {
      const { operation, vmName } = checkedOperation(input, 'purge');
      if (!retirements) throw brokerError('invalid_provider_state', 'not_applied');
      const vm = await managed(operation, vmName);
      const record = readRecord(operation.computerId);
      if (!vm) {
        if (!record) return observed(operation.computerId, 'missing', operation.expectedGeneration);
        if (record.generation !== operation.expectedGeneration || record.projectId !== operation.projectId) throw brokerError('environment_not_retired', 'not_applied');
        dropRecord(record);
        return observed(operation.computerId, 'missing', operation.expectedGeneration);
      }
      if (!record || record.generation !== operation.expectedGeneration || record.projectId !== operation.projectId || !matchesRecord(record, vm)) {
        throw brokerError('environment_not_retired', 'not_applied');
      }
      await deleteVm(identityOf(record), vmName);
      dropRecord(record);
      return observed(operation.computerId, 'missing', operation.expectedGeneration);
    },

    /**
     * The scheduled purge: removes only environments whose own retirement record has passed its deadline. It reads this Broker's journal and a clock and nothing the Control Plane sends;
     * `now` (epoch ms or Date) is for the Broker's timer and tests, omitted it is the journal's own clock. Not wired to a timer yet. Returns one result per expired record.
     * A VM that is not exactly the recorded one (VM id, computer id, generation, and project and incarnation id in its Notes) is 'skipped': nothing is deleted and the record is kept.
     */
    async purgeExpiredRetirements({ now: at } = {}) {
      if (!retirements) throw brokerError('invalid_provider_state', 'not_applied');
      return purgeExpired({
        journal: retirements,
        atMs: at,
        purgeRecord: async (record) => {
          if (!COMPUTER_ID_RE.test(record.computerId)) return 'skipped';
          const vmName = `${VM_PREFIX}${record.computerId}`;
          const vm = await lookup(vmName);
          if (!vm) return 'already_missing';
          if (!matchesRecord(record, vm)) return 'skipped';
          await deleteVm(identityOf(record), vmName);
          return 'purged';
        },
      });
    },
  };

  // The VM folder is always cloneRoot/<vmName>; the script deletes only disks inside it, and only for a VM whose Notes carry every field of `expect`.
  function deleteVm(expect, vmName) {
    return call({ method: 'remove', vmName, cloneRoot: root, vmDir: path.join(root, vmName), expect });
  }

  // Journal access. A read that fails before any change is not applied by default; the destroy clean-up asks for 'unknown' because the VM may already be gone.
  function readRecord(computerId, outcome = 'not_applied') {
    if (!retirements) return null;
    try { return retirements.get(computerId); }
    catch { throw brokerError('provider_state_unknown', outcome); }
  }

  function dropRecord(record) {
    try { retirements.remove(record.computerId, record.incarnationId); }
    catch { throw brokerError('provider_state_unknown'); }
  }

  // The VM exactly as the Broker sees it now, or null: ours, at the generation and project the caller named, the VM id it named, not retired, and with no network adapter at all.
  async function taskStartObservation(f, vmName) {
    const vm = await lookup(vmName, 'network');
    if (!vm || !vm.vmId || vm.vmId !== f.vmId || !vm.meta || vm.meta.computerId !== f.computerId || vm.meta.generation !== f.generation) return null;
    if (vm.meta.projectId === null || vm.meta.projectId !== f.projectId) return null;
    return classifyNetworkAdapters(vm.adapters) === 'none' ? vm : null;
  }

  async function takeTaskStartCheckpoint(input) {
    const f = checkedTaskStart(input);
    if (!attestationSigner || readRecord(f.computerId)) return null; // no signer, or a retired computer id
    const vmName = `${VM_PREFIX}${f.computerId}`;
    if (!await taskStartObservation(f, vmName)) return null;
    const name = `${CHECKPOINT_NAME_PREFIX}${createHash('sha256').update(f.operationId, 'utf8').digest('hex').slice(0, 24)}`;
    const result = await call({ method: 'checkpoint', vmName, expect: { computerId: f.computerId, generation: f.generation, vmId: f.vmId, identity: 'vm' }, checkpointName: name });
    const checkpointId = typeof result.checkpointId === 'string' ? result.checkpointId.toLowerCase() : null;
    if (!isVmId(checkpointId) || typeof result.vmId !== 'string' || result.vmId.toLowerCase() !== f.vmId) return null;
    if (!await taskStartObservation(f, vmName)) return null; // the network and the VM are checked again AFTER the checkpoint: the statement is made about what is true now
    const body = createTaskStartAttestation({
      network: 'none', computerId: f.computerId, vmId: f.vmId, generation: f.generation, projectId: f.projectId, leaseId: f.leaseId, leaseGeneration: f.leaseGeneration, operationId: f.operationId,
      checkpointId, checkpointType: 'production', observedAt: Math.floor(now().getTime() / 1000), ttlSeconds: attestationTtlSeconds,
    });
    return await signTaskStartAttestation(body, attestationSigner);
  }

  async function changeState(input, method) {
    const { operation, vmName } = checkedOperation(input, method);
    // An attested-policy start (checkedOperation has already refused one without a vmId) reads the adapters with the VM in the same call, right now: the attestation it rests on is older.
    const attested = method === 'start' && operation.attestedPolicy === true;
    const vm = await managed(operation, vmName, attested ? 'network' : 'inspect');
    if (!vm) throw brokerError('invalid_provider_state', 'not_applied');
    if (method === 'start' && readRecord(operation.computerId)) throw brokerError('environment_retired', 'not_applied');
    // The approval named a VM (start only): the VM's own Hyper-V id must be it. Checked here and again by the script (identity "vm" makes the id mandatory there).
    let expect = expectOf(operation);
    if (operation.vmId !== undefined) {
      if (vm.vmId !== operation.vmId) throw brokerError('operation_conflict', 'not_applied');
      expect = { ...expect, vmId: operation.vmId, identity: 'vm' };
    }
    // Same observation as the VM id above. "present" and "unknown" (unreadable) both refuse. What remains is the gap between this read and the script's start; the script checks the VM id only.
    if (attested && classifyNetworkAdapters(vm.adapters) !== 'none') throw brokerError('network_not_isolated', 'not_applied');
    const result = await call({ method, vmName, expect, waitSeconds });
    return observed(operation.computerId, mapState(result.state), operation.expectedGeneration);
  }
}

// The seven fields of attestTaskStart and nothing else. Throws (the caller turns that into "no attestation") for anything that is not exactly that.
function checkedTaskStart(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_task_start_attestation_input');
  const keys = Object.keys(input).sort();
  if (keys.length !== TASK_START_FIELDS.length || keys.some((key, n) => key !== TASK_START_FIELDS[n])) throw new TypeError('invalid_task_start_attestation_input');
  const f = Object.fromEntries(TASK_START_FIELDS.map((key) => [key, input[key]]));
  const ok = COMPUTER_ID_RE.test(String(f.computerId)) && typeof f.computerId === 'string' && ['projectId', 'leaseId', 'operationId'].every((key) => typeof f[key] === 'string' && ID_RE.test(f[key]))
    && [f.generation, f.leaseGeneration].every((n) => Number.isSafeInteger(n) && n >= 1) && isVmId(f.vmId);
  if (!ok) throw new TypeError('invalid_task_start_attestation_input');
  return Object.freeze(f);
}

function checkedOperation(input, action) {
  let operation;
  try {
    operation = validateEnvironmentOperation(input);
  }
  catch {
    throw brokerError('invalid_provider_state', 'not_applied');
  }
  // The VM name has a stricter alphabet than the generic ID (no . _ :), so reject here.
  if (operation.action !== action || operation.providerId !== PROVIDER_ID || !COMPUTER_ID_RE.test(operation.computerId)) {
    throw brokerError('invalid_provider_state', 'not_applied');
  }
  return { operation, vmName: `${VM_PREFIX}${operation.computerId}` };
}

const expectOf = (operation) => ({ computerId: operation.computerId, generation: operation.expectedGeneration });
// The full retirement identity; the script refuses (identity: 'full') a request that leaves any part out and a VM that differs in any part.
const identityOf = (record) => ({
  computerId: record.computerId, generation: record.generation, vmId: record.vmId, projectId: record.projectId, incarnationId: record.incarnationId, identity: 'full',
});
// For destroy of a recorded VM: always the VM id; project and incarnation only once the Notes carry them (a half-finished retire has blank Notes).
const recordExpect = (record, vm) => (vm.meta.incarnationId !== null && vm.meta.projectId !== null ? identityOf(record)
  : { computerId: record.computerId, generation: record.generation, vmId: record.vmId, identity: 'vm' });
// Fully retired: the VM is the recorded one and its Notes carry the recorded project and incarnation.
const matchesRecord = (record, vm) => Boolean(record && vm && vm.meta && vm.vmId && vm.vmId === record.vmId && vm.meta.computerId === record.computerId
  && vm.meta.generation === record.generation && vm.meta.projectId === record.projectId && vm.meta.incarnationId === record.incarnationId);
// The recorded VM, possibly mid-retire: same VM id and generation; Notes identity blank or the recorded one.
const belongsToRecord = (record, vm) => Boolean(record && vm && vm.meta && vm.vmId && vm.vmId === record.vmId && vm.meta.computerId === record.computerId
  && vm.meta.generation === record.generation && (vm.meta.projectId === null || vm.meta.projectId === record.projectId)
  && (vm.meta.incarnationId === null || vm.meta.incarnationId === record.incarnationId));

// projectId is the Broker's own record of the project (written from the create operation that was authorized); network attestations read it from here, never from a request.
const notesFor = (operation, imageDigest) => JSON.stringify({
  albera: 1, computerId: operation.computerId, generation: operation.expectedGeneration, imageDigest, projectId: operation.projectId,
});

function parseNotes(text) {
  if (typeof text !== 'string') return null;
  let value;
  try {
    value = JSON.parse(text);
  }
  catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || value.albera !== 1 || typeof value.computerId !== 'string'
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || typeof value.imageDigest !== 'string') return null;
  // projectId is written by create (VMs made before #115 step 2 have none); incarnationId only by a retire, together with the project. A malformed value makes the whole Notes untrusted.
  const hasProject = Object.hasOwn(value, 'projectId');
  const hasIncarnation = Object.hasOwn(value, 'incarnationId');
  if ((hasProject && typeof value.projectId !== 'string') || (hasIncarnation && (!hasProject || !/^[a-f0-9]{32}$/.test(String(value.incarnationId))))) return null;
  return {
    computerId: value.computerId, generation: value.generation, imageDigest: value.imageDigest,
    projectId: hasProject ? value.projectId : null, incarnationId: hasIncarnation ? value.incarnationId : null,
  };
}

const mapState = (state) => (Object.hasOwn(HYPERV_STATES, state) ? HYPERV_STATES[state] : state === 'Missing' ? 'missing' : 'unknown');
const safeCode = (code) => (typeof code === 'string' && (PS_CODES.has(code) || code === 'stale_generation') ? code : 'provider_unavailable');
const brokerError = (code, outcome = 'unknown') => Object.assign(new Error(code), { code, outcome });

function checkedAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('invalid_hyperv_environment_prototype_options');
  return path.resolve(value);
}

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function isUnder(child, root) {
  const rel = path.relative(fold(root), fold(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The ledger is trusted host configuration. A golden image inside cloneRoot could be deleted by removeVm.
function checkedLedger(goldenImages, root) {
  if (goldenImages === null || typeof goldenImages !== 'object' || Array.isArray(goldenImages)) {
    throw new TypeError('invalid_hyperv_environment_prototype_options');
  }
  const ledger = Object.create(null);
  for (const [digest, entry] of Object.entries(goldenImages)) {
    if (!DIGEST_KEY_RE.test(digest) || entry === null || typeof entry !== 'object'
      || !['linux', 'windows'].includes(entry.os) || !['x64', 'arm64'].includes(entry.architecture)) {
      throw new TypeError('invalid_hyperv_environment_prototype_options');
    }
    const imagePath = checkedAbsolute(entry.path);
    if (fold(imagePath) === fold(root) || isUnder(imagePath, root)) throw new TypeError('invalid_hyperv_environment_prototype_options');
    ledger[digest] = Object.freeze({ path: imagePath, os: entry.os, architecture: entry.architecture });
  }
  return Object.freeze(ledger);
}

async function sha256OfFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function spawnScript(pwsh, timeoutMs, request) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(pwsh, PWSH_ARGS, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    catch {
      reject(brokerError('provider_unavailable', 'not_applied'));
      return;
    }
    const out = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, brokerError('provider_timeout'));
    }, timeoutMs);
    child.on('error', () => finish(reject, brokerError('provider_unavailable', 'not_applied')));
    child.stdout.on('data', (data) => {
      outBytes += data.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish(reject, brokerError('provider_state_unknown'));
        return;
      }
      out.push(data);
    });
    child.stderr.on('data', (data) => { // drained, never surfaced: it may contain host paths
      errBytes += data.length;
      if (errBytes > MAX_STDERR_BYTES) child.stderr.destroy();
    });
    child.on('close', () => {
      try {
        finish(resolve, JSON.parse(Buffer.concat(out).toString('utf8')));
      }
      catch {
        finish(reject, brokerError('provider_state_unknown'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
