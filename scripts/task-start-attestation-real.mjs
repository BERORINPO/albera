// Issue #115 step 4, real-host check of the task-start attestation (the lead runs it; CI never does). Usage, as a member of Hyper-V Administrators:
//   node scripts/task-start-attestation-real.mjs
// Creates ONE disposable VM (albera-tsa<time>, 2 GiB, no network adapter) from the read-only golden image through the Hyper-V Broker prototype, starts it,
// asks the prototype for a task-start attestation (network, ProductionOnly checkpoint, network again, sign), verifies it with the contract, lists the VM's
// checkpoints, then destroys the VM. Signs with a key generated in memory for this run only. Prints no password and no host path beyond the VM name.
// Issue #133 (prune): a SECOND attestation must leave exactly ONE albera-task checkpoint, the newer one (the older is removed by the checkpoint op once the new one is verified); the script
// polls up to PRUNE_WAIT_MS for the merge-behind removal to show and prints the prune reports the prototype gave (pruned / pruneFailed, counts only).
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { freemem } from 'node:os';
import { createEcdsaAttestationSigner, createEcdsaAttestationVerifier } from '../src/runtime/ecdsa-attestation-signer.mjs';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { firstExisting, pwshCandidates } from '../src/runtime/hyperv-guest-check-prototype.mjs';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { provesCheckpointedNoNetwork, verifyTaskStartAttestation } from '../src/runtime/broker-contract/task-start-attestation.mjs';

const GOLDEN = 'U:\\dev\\hyperv\\golden\\ws2025-desktop-golden.vhdx';
const CLONE_ROOT = 'U:\\dev\\hyperv\\clones';
const VM_MEMORY_GIB = 2;
const HOST_HEADROOM_GIB = 4; // a 4 GB VM on a full host froze the PC (2026-10-31)
const BOOT_WAIT_MS = 90_000;
const ATTEMPTS = 6;
const RETRY_MS = 30_000;
const PRUNE_WAIT_MS = 120_000;
const PRUNE_POLL_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const log = (line) => console.log(`[tsa] ${line}`);

if (freemem() / 2 ** 30 < VM_MEMORY_GIB + HOST_HEADROOM_GIB) {
  console.error(`[tsa] host has ${(freemem() / 2 ** 30).toFixed(1)} GiB free; need ${VM_MEMORY_GIB + HOST_HEADROOM_GIB}. Stop other VMs and retry.`);
  process.exit(2);
}
const pwsh = await firstExisting(pwshCandidates());
if (!pwsh) { console.error('[tsa] PowerShell 7 not found'); process.exit(2); }
const ps = (command) => execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();

const computerId = `tsa${Date.now().toString(36)}`;
const vmName = `albera-${computerId}`;
const projectId = 'proj-tsa';
const signer = createEcdsaAttestationSigner({ keyId: 'albera-lab-broker-tsa', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
const verifier = createEcdsaAttestationVerifier({ keyId: signer.keyId, publicKey: signer.publicKeySpki });

const pruneReports = [];
log('hashing the golden image (read only) ...');
const digest = `sha256:${ps(`(Get-FileHash -Algorithm SHA256 -LiteralPath '${GOLDEN}').Hash`).toLowerCase()}`;
const broker = createHyperVEnvironmentBrokerPrototype({
  goldenImages: { [digest]: { path: GOLDEN, os: 'windows', architecture: 'x64' } },
  cloneRoot: CLONE_ROOT, pwsh, timeoutMs: 300_000, attestationSigner: signer, onCheckpointPrune: (report) => pruneReports.push({ pruned: report.pruned, pruneFailed: report.pruneFailed }),
});
const op = (action, extra = {}) => ({
  operationId: `tsa-${action}`, idempotencyKey: `tsa-key-${action}`, subjectId: 'velo-lab', projectId, taskId: 'task-tsa', runId: 'run-tsa',
  computerId, providerId: 'hyperv', leaseId: 'lease-tsa', expectedGeneration: 1, policyVersion: 1, action, ...extra,
});

const results = {};
let created = false;
try {
  await broker.createVm(op('create', { spec: {
    projectId, kind: 'ephemeral', os: 'windows', architecture: 'x64', imageDigest: digest, capabilities: ['desktop'],
    networkProfileId: 'isolated-none', securityProfileId: 'sec-1', resources: { vcpu: 2, memoryMiB: VM_MEMORY_GIB * 1024, diskGiB: 40 },
  } }));
  created = true;
  const vmId = ps(`(Get-VM -Name '${vmName}').Id.Guid`).toLowerCase();
  log(`created ${vmName}; adapters: ${ps(`@(Get-VMNetworkAdapter -VMName '${vmName}').Count`)}`);
  await broker.startVm(op('start'));
  log(`started; waiting ${BOOT_WAIT_MS / 1000} s for the guest`);
  await sleep(BOOT_WAIT_MS);

  // The statement is bound to the action digest of the guest.command DTO the Authority would sign (issue #133); two different tasks give two digests.
  const dtoOf = (task) => ({ action: 'task.start', projectId, computerId, args: { expectedGeneration: 1, task, vmId } });
  const actionDigest = computeActionDigest('guest.command', dtoOf('tsa task one'));
  const input = { computerId, projectId, leaseId: 'lease-tsa', leaseGeneration: 1, generation: 1, vmId, operationId: 'tsa-task-0001', actionDigest };
  const typeBefore = ps(`(Get-VM -Name '${vmName}').CheckpointType`); // issue #133 (c): the checkpoint op must leave the VM's own setting as it found it
  let envelope = null;
  for (let attempt = 1; attempt <= ATTEMPTS && !envelope; attempt++) {
    const began = Date.now();
    envelope = await broker.attestTaskStart(input);
    log(`attempt ${attempt}: ${envelope ? 'attestation' : 'none'} in ${((Date.now() - began) / 1000).toFixed(1)} s`);
    if (!envelope && attempt < ATTEMPTS) await sleep(RETRY_MS);
  }
  results.attested = Boolean(envelope);
  if (envelope) {
    const verified = verifyTaskStartAttestation(JSON.parse(JSON.stringify(envelope)), {
      clock: () => Math.floor(Date.now() / 1000), verify: verifier.verify,
      expected: { computerId, vmId, generation: 1, projectId, leaseId: 'lease-tsa', leaseGeneration: 1, operationId: 'tsa-task-0001', actionDigest },
    });
    results.verified = true;
    results.boundToTheAction = verified.actionDigest === actionDigest;
    results.provesCheckpointedNoNetwork = provesCheckpointedNoNetwork(verified);
    results.network = verified.network;
    results.checkpointType = verified.checkpointType;
    const snapshots = JSON.parse(ps(`@(Get-VMSnapshot -VMName '${vmName}' | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.Id.Guid; type = [string]$_.SnapshotType; state = [string]$_.State } }) | ConvertTo-Json -Compress -AsArray`) || '[]'); // no item prints nothing, not []
    results.snapshots = snapshots.map((s) => ({ name: s.name, type: s.type, state: s.state, matchesAttestation: s.id.toLowerCase() === verified.checkpointId }));
    results.again = Boolean(await broker.attestTaskStart({ ...input, operationId: 'tsa-task-0002', actionDigest: computeActionDigest('guest.command', dtoOf('tsa task two')) })); // a second operation gets its own checkpoint
    // Issue #133: the second checkpoint op removed the first one. The removal starts a background merge, so poll until exactly one remains (or the wait is over).
    const listSnapshots = () => JSON.parse(ps(`@(Get-VMSnapshot -VMName '${vmName}' | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.Id.Guid } }) | ConvertTo-Json -Compress -AsArray`) || '[]'); // no item prints nothing, not []
    const pruneDeadline = Date.now() + PRUNE_WAIT_MS;
    let remaining = listSnapshots();
    while (remaining.length !== 1 && Date.now() < pruneDeadline) { await sleep(PRUNE_POLL_MS); remaining = listSnapshots(); }
    results.snapshotCount = remaining.length;
    const secondName = `albera-task-${createHash('sha256').update('tsa-task-0002', 'utf8').digest('hex').slice(0, 24)}`;
    results.onlyTheNewerRemains = remaining.length === 1 && remaining[0].name === secondName && remaining[0].name !== results.snapshots[0].name;
    results.pruneReports = pruneReports;
    results.checkpointTypeBefore = typeBefore;
    results.checkpointTypeRestored = ps(`(Get-VM -Name '${vmName}').CheckpointType`) === typeBefore;
    // Issue #133 (b), INFORMATIONAL ONLY (the verdict uses the snapshot State Off, see env-io.ps1): is there a read-only property that tells a production checkpoint from a standard one? SnapshotType is known not to (Standard for ProductionOnly).
    // Nothing below is trusted or part of the verdict; the lead reads it to decide whether env-io.ps1 can verify the snapshot itself. No host path is printed.
    try {
      results.snapshotProbe = JSON.parse(ps(`@(Get-VMSnapshot -VMName '${vmName}' | ForEach-Object { $s = $_; $c = @(Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_VirtualSystemSettingData | Where-Object { $_.InstanceID -like ('*' + $s.Id.Guid + '*') }) | Select-Object -First 1; [pscustomobject]@{ name = $s.Name; snapshotType = [string]$s.SnapshotType; vmStateAtSnapshot = [string]$s.State; consistencyLevel = $c.ConsistencyLevel; virtualSystemType = $c.VirtualSystemType } }) | ConvertTo-Json -Compress -AsArray`) || '[]'); // no item prints nothing, not []
    }
    catch { results.snapshotProbe = 'unavailable'; }
  }
}
catch (error) {
  results.error = typeof error?.code === 'string' ? error.code : 'unexpected';
}
finally {
  if (created) {
    try {
      await broker.stopVm(op('stop')).catch(() => {});
      // A prune just before may still be merging in the background; removing a checkpoint then fails, so retry for a while (real host 2026-11-01).
      for (let tries = 1; ; tries++) {
        try { ps(`Get-VMSnapshot -VMName '${vmName}' -ErrorAction SilentlyContinue | Remove-VMSnapshot -ErrorAction Stop`); break; }
        catch (error) { if (tries >= 12) throw error; await sleep(10_000); }
      }
      await broker.removeVm(op('destroy'));
      results.vmDeleted = ps(`[bool](Get-VM -Name '${vmName}' -ErrorAction SilentlyContinue)`) === 'False';
    }
    catch (error) { results.cleanup = typeof error?.code === 'string' ? error.code : 'unexpected'; }
  }
  results.goldenReadOnly = ps(`(Get-Item -LiteralPath '${GOLDEN}').IsReadOnly`) === 'True';
  console.log(JSON.stringify(results));
}
const ok = results.verified && results.boundToTheAction && results.provesCheckpointedNoNetwork && results.again && results.checkpointTypeRestored === true && results.snapshotCount === 1 && results.onlyTheNewerRemains
  && results.pruneReports.length >= 2 && results.pruneReports.at(-1).pruned === 1 && results.pruneReports.every((r) => r.pruneFailed === 0) && results.vmDeleted && results.goldenReadOnly
  && results.snapshots.length === 1 && results.snapshots[0].matchesAttestation && results.snapshots[0].state === 'Off' && /^albera-task-[0-9a-f]{24}$/.test(results.snapshots[0].name);
console.log(ok ? 'TSA: PASS' : 'TSA: FAIL');
process.exit(ok ? 0 : 1);
