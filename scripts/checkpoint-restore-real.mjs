// Issue #133, real-host check of the person-approved restore (undo) of a task checkpoint (the lead runs it; CI never does). Usage, as a member of Hyper-V Administrators:
//   node scripts/checkpoint-restore-real.mjs
// Creates ONE disposable VM (albera-rst<time>, 2 GiB, no network adapter) from the read-only golden image through the Hyper-V Broker prototype, starts it, takes an ALBERA task checkpoint
// (attestTaskStart), then:
//   1. stops the VM, changes its startup memory (an informational marker that lives in the checkpointed VM configuration) and restores from Off;
//   2. starts it again at the NEW generation and restores from RUNNING;
//   3. checks after each restore: the VM is Off, its own VM id is unchanged, the generation moved by exactly one (the Notes generation is the Broker's generation), the one checkpoint is still
//      there with the same id (a restore removes nothing), and the old generation is refused everywhere (start, a second restore, a task-start statement);
//   4. removes the checkpoint by hand and checks that a restore with no ALBERA checkpoint is refused and changes nothing (VM state and generation as they were);
//   5. destroys the VM.
// No guest channel in the prototype can WRITE into the guest (guest checks are read-only), so a marker file is not used; the guest-disk undo was shown by test/windows-service-lab/checkpoint-cost.ps1
// (2026-10-31). What this script proves is the Broker's side: the right checkpoint is applied, the VM ends Off, the generation is reissued. The memory marker is printed as informational
// (does Hyper-V bring the checkpointed hardware configuration back?) and is not part of the verdict.
// A 4 GB VM on a full host froze the PC (2026-10-31): the host memory guard refuses to start. Signs with a key generated in memory for this run only. Prints no password and no host path.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import path from 'node:path';
import { createEcdsaAttestationSigner } from '../src/runtime/ecdsa-attestation-signer.mjs';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { createGenerationFloor } from '../src/runtime/environment-generation-floor.mjs';
import { firstExisting, pwshCandidates } from '../src/runtime/hyperv-guest-check-prototype.mjs';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';

const GOLDEN = 'U:\\dev\\hyperv\\golden\\ws2025-desktop-golden.vhdx';
const CLONE_ROOT = 'U:\\dev\\hyperv\\clones';
const VM_MEMORY_GIB = 2;
const MARKER_MEMORY_GIB = 1;
const HOST_HEADROOM_GIB = 4;
const BOOT_WAIT_MS = 90_000;
const ATTEMPTS = 6;
const RETRY_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const log = (line) => console.log(`[rst] ${line}`);

if (freemem() / 2 ** 30 < VM_MEMORY_GIB + HOST_HEADROOM_GIB) {
  console.error(`[rst] host has ${(freemem() / 2 ** 30).toFixed(1)} GiB free; need ${VM_MEMORY_GIB + HOST_HEADROOM_GIB}. Stop other VMs and retry.`);
  process.exit(2);
}
const pwsh = await firstExisting(pwshCandidates());
if (!pwsh) { console.error('[rst] PowerShell 7 not found'); process.exit(2); }
const ps = (command) => execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();

const computerId = `rst${Date.now().toString(36)}`;
const vmName = `albera-${computerId}`;
const projectId = 'proj-rst';
const signer = createEcdsaAttestationSigner({ keyId: 'albera-lab-broker-rst', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
const pruneReports = [];

log('hashing the golden image (read only) ...');
const digest = `sha256:${ps(`(Get-FileHash -Algorithm SHA256 -LiteralPath '${GOLDEN}').Hash`).toLowerCase()}`;
// The restore op needs the Broker-owned generation floor (#140): a throwaway one for this run, removed at exit.
const floorDir = mkdtempSync(path.join(tmpdir(), 'albera-rst-floor-'));
process.once('exit', () => { try { rmSync(floorDir, { recursive: true, force: true }); } catch { /* a leftover temp folder is harmless */ } });
const generationFloor = createGenerationFloor({ filePath: path.join(floorDir, 'generation-floor.sqlite') });
const broker = createHyperVEnvironmentBrokerPrototype({
  generationFloor,
  goldenImages: { [digest]: { path: GOLDEN, os: 'windows', architecture: 'x64' } },
  cloneRoot: CLONE_ROOT, pwsh, timeoutMs: 300_000, attestationSigner: signer, onCheckpointPrune: (report) => pruneReports.push({ pruned: report.pruned, pruneFailed: report.pruneFailed }),
});
const op = (action, generation, extra = {}) => ({
  operationId: `rst-${action}-${generation}`, idempotencyKey: `rst-key-${action}-${generation}`, subjectId: 'velo-lab', projectId, taskId: 'task-rst', runId: 'run-rst',
  computerId, providerId: 'hyperv', leaseId: 'lease-rst', expectedGeneration: generation, policyVersion: 1, action, ...extra,
});
const refused = async (promise) => { try { await promise; return 'NOT REFUSED'; } catch (error) { return `${error.code}/${error.outcome}`; } };
const snapshotsOf = () => JSON.parse(ps(`@(Get-VMSnapshot -VMName '${vmName}' | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.Id.Guid } }) | ConvertTo-Json -Compress -AsArray`) || '[]'); // no item prints nothing, not []
const vmFacts = () => JSON.parse(ps(`$v = Get-VM -Name '${vmName}'; [pscustomobject]@{ state = [string]$v.State; id = $v.Id.Guid; generation = ($v.Notes | ConvertFrom-Json).generation; startupMemoryGiB = [math]::Round((Get-VMMemory -VMName '${vmName}').Startup / 1GB, 2) } | ConvertTo-Json -Compress`));

const results = { checks: {} };
const check = (name, value) => { results.checks[name] = value === true; if (value !== true) results.failed = [...(results.failed ?? []), name]; };
let created = false;
try {
  await broker.createVm(op('create', 1, { spec: {
    projectId, kind: 'ephemeral', os: 'windows', architecture: 'x64', imageDigest: digest, capabilities: ['desktop'],
    networkProfileId: 'isolated-none', securityProfileId: 'sec-1', resources: { vcpu: 2, memoryMiB: VM_MEMORY_GIB * 1024, diskGiB: 40 },
  } }));
  created = true;
  const vmId = ps(`(Get-VM -Name '${vmName}').Id.Guid`).toLowerCase();
  await broker.startVm(op('start', 1));
  log(`started ${vmName}; waiting ${BOOT_WAIT_MS / 1000} s for the guest`);
  await sleep(BOOT_WAIT_MS);

  const dtoOf = (generation, task) => ({ action: 'task.start', projectId, computerId, args: { expectedGeneration: generation, task, vmId } });
  const attest = async (generation, operationId, task) => broker.attestTaskStart({
    computerId, projectId, leaseId: 'lease-rst', leaseGeneration: 1, generation, vmId, operationId, actionDigest: computeActionDigest('guest.command', dtoOf(generation, task)),
  });
  let envelope = null;
  for (let attempt = 1; attempt <= ATTEMPTS && !envelope; attempt++) {
    envelope = await attest(1, 'rst-task-0001', 'rst task one');
    log(`attempt ${attempt}: ${envelope ? 'checkpoint taken' : 'none'}`);
    if (!envelope && attempt < ATTEMPTS) await sleep(RETRY_MS);
  }
  check('checkpointTaken', Boolean(envelope));
  const checkpoint = snapshotsOf();
  check('exactlyOneCheckpointBefore', checkpoint.length === 1 && /^albera-task-[0-9a-f]{24}$/.test(checkpoint[0].name));
  const memoryAtCheckpoint = vmFacts().startupMemoryGiB;

  // 1. restore from Off, after a host-visible change to the VM configuration
  await broker.stopVm(op('stop', 1));
  ps(`Set-VMMemory -VMName '${vmName}' -StartupBytes ${MARKER_MEMORY_GIB}GB`);
  const marked = vmFacts();
  const first = await broker.restoreTaskCheckpoint({ computerId, projectId, expectedGeneration: 1, vmId });
  const afterFirst = vmFacts();
  check('firstRestoreOff', first.state === 'off' && afterFirst.state === 'Off');
  check('firstRestoreGeneration2', first.generation === 2 && afterFirst.generation === 2);
  check('firstRestoreSameVmId', afterFirst.id.toLowerCase() === vmId);
  check('firstRestoreKeptTheCheckpoint', JSON.stringify(snapshotsOf()) === JSON.stringify(checkpoint));
  results.memoryMarker = { atCheckpointGiB: memoryAtCheckpoint, changedToGiB: marked.startupMemoryGiB, afterRestoreGiB: afterFirst.startupMemoryGiB, revertedByRestore: afterFirst.startupMemoryGiB === memoryAtCheckpoint };

  // the old generation is refused everywhere
  results.staleStart = await refused(broker.startVm(op('start', 1)));
  results.staleRestore = await refused(broker.restoreTaskCheckpoint({ computerId, projectId, expectedGeneration: 1, vmId }));
  check('staleStartRefused', results.staleStart === 'stale_generation/not_applied');
  check('staleRestoreRefused', results.staleRestore === 'stale_generation/not_applied');
  check('staleStatementNotMade', (await attest(1, 'rst-task-stale', 'rst stale')) === null);

  // 2. restore from RUNNING, at the new generation
  await broker.startVm(op('start', 2));
  check('runningAtGeneration2', vmFacts().state === 'Running');
  const second = await broker.restoreTaskCheckpoint({ computerId, projectId, expectedGeneration: 2, vmId });
  const afterSecond = vmFacts();
  check('secondRestoreOff', second.state === 'off' && afterSecond.state === 'Off');
  check('secondRestoreGeneration3', second.generation === 3 && afterSecond.generation === 3);
  check('secondRestoreKeptTheCheckpoint', JSON.stringify(snapshotsOf()) === JSON.stringify(checkpoint));
  check('generationNeverReused', afterSecond.generation > afterFirst.generation);

  // 4. no ALBERA checkpoint: refused, nothing changes
  for (let tries = 1; ; tries++) { // right after a restore Hyper-V can still be busy with the VM; the removal then fails for a while
    try { ps(`Get-VMSnapshot -VMName '${vmName}' | Remove-VMSnapshot -ErrorAction Stop`); break; }
    catch (error) { if (tries >= 12) throw error; await sleep(10_000); }
  }
  const removeDeadline = Date.now() + 120_000;
  while (snapshotsOf().length !== 0 && Date.now() < removeDeadline) await sleep(3_000);
  const beforeNone = vmFacts();
  results.noCheckpoint = await refused(broker.restoreTaskCheckpoint({ computerId, projectId, expectedGeneration: 3, vmId }));
  check('noCheckpointRefused', results.noCheckpoint === 'invalid_provider_state/not_applied');
  check('noCheckpointChangedNothing', JSON.stringify(vmFacts()) === JSON.stringify(beforeNone));
  // A restore the op refused definitely must not fence the VM (real host 2026-11-01: the raise stayed and even destroy was refused). stop at generation 3 works; destroy at 3 is the clean-up below,
  // whose success is the vmDeleted verdict.
  const afterRefusal = await refused(broker.stopVm(op('stop', 3)));
  check('refusedRestoreDidNotFence', afterRefusal === 'NOT REFUSED' && (await broker.inspectVm(op('inspect', 3))).generation === 3 && (await broker.inspectVm(op('inspect', 3))).state === 'off');
  results.pruneReports = pruneReports;
}
catch (error) {
  results.error = typeof error?.code === 'string' ? error.code : 'unexpected';
}
finally {
  if (created) {
    try {
      const generation = (() => { try { return vmFacts().generation; } catch { return 1; } })(); // wherever the run stopped, the VM's own Notes say which generation it is at
      await broker.stopVm(op('stop', generation)).catch(() => {});
      for (let tries = 1; ; tries++) { // a background merge can make the removal fail for a while
        try { ps(`Get-VMSnapshot -VMName '${vmName}' -ErrorAction SilentlyContinue | Remove-VMSnapshot -ErrorAction Stop`); break; }
        catch (error) { if (tries >= 12) throw error; await sleep(10_000); }
      }
      await broker.removeVm(op('destroy', generation));
      results.vmDeleted = ps(`[bool](Get-VM -Name '${vmName}' -ErrorAction SilentlyContinue)`) === 'False';
    }
    catch (error) { results.cleanup = typeof error?.code === 'string' ? error.code : 'unexpected'; }
  }
  results.goldenReadOnly = ps(`(Get-Item -LiteralPath '${GOLDEN}').IsReadOnly`) === 'True';
  console.log(JSON.stringify(results));
}
const ok = !results.error && !results.failed && Object.keys(results.checks).length >= 16 && results.vmDeleted && results.goldenReadOnly;
console.log(ok ? 'RST: PASS' : 'RST: FAIL');
process.exit(ok ? 0 : 1);
