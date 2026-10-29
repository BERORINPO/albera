// PROTOTYPE. This runs as the same OS user as the caller; it is NOT the privileged Host Broker
// that ADR-002 requires. It is not imported from any entry point, API route or host composition.
// Reaching Hyper-V needs membership in the local "Hyper-V Administrators" group.
// It implements the fixed Broker methods HyperVEnvironmentProvider calls (createVm / inspectVm /
// startVm / stopVm / removeVm): a VM is a differencing-disk clone of a golden image (ADR-004,
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

const SCRIPT_PATH = fileURLToPath(new URL('./hyperv-env/env-io.ps1', import.meta.url));
const PWSH_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH]);
const PROVIDER_ID = 'hyperv';
const VM_PREFIX = 'albera-';
const COMPUTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,56}$/; // "albera-" + id stays within the 64-char VM name the desktop driver accepts
const DIGEST_KEY_RE = /^sha256:[a-f0-9]{64}$/;
const ISOLATED_NETWORK = 'isolated-none';
const PS_CODES = new Set(['invalid_provider_state', 'operation_conflict', 'provider_timeout', 'provider_unavailable', 'provider_state_unknown']);
const HYPERV_STATES = Object.freeze({ Running: 'running', Off: 'off', Paused: 'paused', Saved: 'paused' });
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const STOP_WAIT_FRACTION = 0.8;

export function createHyperVEnvironmentBrokerPrototype({
  goldenImages, cloneRoot, pwsh = 'pwsh', timeoutMs = DEFAULT_TIMEOUT_MS,
  hashFile = sha256OfFile, runPowerShell, now = () => new Date(),
} = {}) {
  if (typeof pwsh !== 'string' || pwsh.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000
    || typeof hashFile !== 'function' || typeof now !== 'function'
    || (runPowerShell !== undefined && typeof runPowerShell !== 'function')) {
    throw new TypeError('invalid_hyperv_environment_prototype_options');
  }
  const root = checkedAbsolute(cloneRoot);
  const ledger = checkedLedger(goldenImages, root);
  const run = runPowerShell ?? ((request) => spawnScript(pwsh, timeoutMs, request));
  const hashCache = new Map(); // path|size|mtimeMs -> hex; valid for this broker instance only

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

  async function lookup(vmName) {
    const result = await call({ method: 'inspect', vmName });
    if (result.exists !== true) return null;
    return { state: mapState(result.state), meta: parseNotes(result.notes) };
  }

  // A VM we may act on: ours (Notes identity) and at the generation the caller expects.
  async function managed(operation, vmName) {
    const vm = await lookup(vmName);
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
          || m.generation !== operation.expectedGeneration) throw brokerError('operation_conflict', 'not_applied');
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
      if (!vm) return observed(operation.computerId, 'missing', operation.expectedGeneration);
      if (!vm.meta || vm.meta.computerId !== operation.computerId) throw brokerError('invalid_provider_state', 'not_applied');
      return observed(operation.computerId, vm.state, vm.meta.generation);
    },

    async startVm(input) { return changeState(input, 'start'); },

    async stopVm(input) { return changeState(input, 'stop'); },

    async removeVm(input) {
      const { operation, vmName } = checkedOperation(input, 'destroy');
      if (!await managed(operation, vmName)) return observed(operation.computerId, 'missing', operation.expectedGeneration);
      // The VM folder is always cloneRoot/<vmName>; the script deletes only disks inside it.
      await call({ method: 'remove', vmName, cloneRoot: root, vmDir: path.join(root, vmName), expect: expectOf(operation) });
      return observed(operation.computerId, 'missing', operation.expectedGeneration);
    },
  };

  async function changeState(input, method) {
    const { operation, vmName } = checkedOperation(input, method);
    if (!await managed(operation, vmName)) throw brokerError('invalid_provider_state', 'not_applied');
    const result = await call({
      method, vmName, expect: expectOf(operation), waitSeconds: Math.max(1, Math.floor((timeoutMs * STOP_WAIT_FRACTION) / 1000)),
    });
    return observed(operation.computerId, mapState(result.state), operation.expectedGeneration);
  }
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
const notesFor = (operation, imageDigest) => JSON.stringify({
  albera: 1, computerId: operation.computerId, generation: operation.expectedGeneration, imageDigest,
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
  return { computerId: value.computerId, generation: value.generation, imageDigest: value.imageDigest };
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
