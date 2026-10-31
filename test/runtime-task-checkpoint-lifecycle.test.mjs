// Issue #133, last open item: older ALBERA task checkpoints are pruned (the host disk stops growing) and a person-approved restore (undo) exists.
// Three layers, none of which starts a VM:
//   1. source guards on env-io.ps1 (the exact cmdlets, the order of the checks, the fixed codes),
//   2. the REAL env-io.ps1 run under PowerShell 7 against SYNTHETIC stand-ins for the Hyper-V cmdlets (test/helpers/fake-hyperv-cmdlets.ps1): this proves the script's own logic (which
//      checkpoints it removes, which one it restores, what it refuses), not how Hyper-V behaves; skipped when PowerShell 7 is missing,
//   3. the Hyper-V Broker prototype over a stand-in for env-io.ps1 (restoreTaskCheckpoint, generation, onCheckpointPrune).
// The real-host checks are the lead's: scripts/task-start-attestation-real.mjs and scripts/checkpoint-restore-real.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { verifyTaskStartAttestation } from '../src/runtime/broker-contract/task-start-attestation.mjs';
import { createEcdsaAttestationSigner, createEcdsaAttestationVerifier } from '../src/runtime/ecdsa-attestation-signer.mjs';
import { createRetirementJournal } from '../src/runtime/environment-retirement-journal.mjs';
import { createHyperVEnvironmentBrokerPrototype } from '../src/runtime/hyperv-environment-broker-prototype.mjs';
import { firstExisting, pwshCandidates } from '../src/runtime/hyperv-guest-check-prototype.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(path.dirname(here), 'src', 'runtime', 'hyperv-env', 'env-io.ps1');
const FAKES = path.join(here, 'helpers', 'fake-hyperv-cmdlets.ps1');
const RUNNER = path.join(here, 'helpers', 'run-env-io-with-fakes.ps1');
const scriptText = fs.readFileSync(SCRIPT, 'utf8');
const pwsh = await firstExisting(pwshCandidates());

const VM = '11111111-2222-4333-8444-555555555555';
const OTHER_VM = '99999999-8888-4777-8666-555555555555';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const notes = (extra = {}) => JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 3, imageDigest: DIGEST, projectId: 'proj-alpha', ...extra });
const taskName = (n) => `albera-task-${n.toString(16).padStart(24, '0')}`;
const guid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const EXPECT = Object.freeze({ computerId: 'pc-01', generation: 3, vmId: VM, identity: 'vm' });

// ---- 1. source guards ----

const functionBody = (name) => {
  const start = scriptText.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = scriptText.indexOf('\nfunction ', start + 1);
  return scriptText.slice(start, end < 0 ? scriptText.indexOf('\ntry {', start) : end);
};
const codeLines = (body) => body.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
const code = codeLines(scriptText).join('\n');

test('env-io.ps1: exactly one Remove-VMSnapshot (the prune in Invoke-Checkpoint), one Restore-VMSnapshot (Invoke-Restore) and two Get-VMSnapshot (one in each); no other checkpoint verb', () => {
  const uses = (verb) => [...code.matchAll(new RegExp(`\\b${verb}\\b`, 'gu'))].length;
  assert.equal(uses('Remove-VMSnapshot'), 1);
  assert.equal(uses('Restore-VMSnapshot'), 1);
  assert.equal(uses('Get-VMSnapshot'), 2);
  assert.equal(uses('Checkpoint-VM'), 1);
  assert.ok(functionBody('Invoke-Checkpoint').includes('Remove-VMSnapshot') && functionBody('Invoke-Checkpoint').includes('Get-VMSnapshot'));
  assert.ok(!functionBody('Invoke-Checkpoint').includes('Restore-VMSnapshot'));
  assert.ok(functionBody('Invoke-Restore').includes('Restore-VMSnapshot') && functionBody('Invoke-Restore').includes('Get-VMSnapshot'));
  assert.ok(!functionBody('Invoke-Restore').includes('Remove-VMSnapshot'));
  const anywhere = [...code.matchAll(/\b([A-Z][a-z]+-VM[A-Za-z]*)\b/gu)].map((m) => m[1]);
  for (const forbidden of ['Remove-VMCheckpoint', 'Get-VMCheckpoint', 'Restore-VMCheckpoint', 'Export-VMSnapshot', 'Rename-VMSnapshot', 'Set-VMSnapshot', 'Merge-VHD', 'Convert-VHD', 'Import-VM', 'Move-VM', 'Suspend-VM', 'Save-VM']) {
    assert.ok(!anywhere.includes(forbidden), forbidden);
  }
  assert.equal(/-IncludeAllChildSnapshots|-Recurse[^\n]*Snapshot|Remove-VMSnapshot[^\n]*(?:\*|-Name)|Get-VMSnapshot[^\n]*-Name/u.test(code), false, 'no recursive or name-based removal: the new checkpoint is a child of the old one');
});

test('prune (#133): after the new checkpoint is verified, only other fixed-shape checkpoints of this VM, never the new one, one at a time from snapshot objects, and a failure never aborts', () => {
  const body = functionBody('Invoke-Checkpoint');
  const lines = codeLines(body);
  const at = (needle) => { const n = body.indexOf(needle); assert.ok(n >= 0, needle); return n; };
  assert.ok(lines.includes("$old = @(Get-VMSnapshot -VM $after -ErrorAction Stop | Where-Object { $_.Name -cmatch $CheckpointNameRe -and ([string]$_.Id).ToLowerInvariant() -ne $checkpointId })"), 'the list: this very VM object, the fixed name shape (case sensitive), not the new id');
  assert.ok(lines.includes('try { Remove-VMSnapshot -VMSnapshot $s -ErrorAction Stop; $pruned++ } catch { $pruneFailed++ }'), 'one removal per snapshot object, a failure is counted');
  assert.ok(lines.includes('} catch { $pruneFailed++ }'), 'a list that fails is counted');
  assert.match(body, /\$checkpointId = \(\[string\]\$snapshots\[0\]\.Id\)\.ToLowerInvariant\(\)/u);
  // after every check that decides the attestation: one snapshot, State Off, a GUID id, the VM re-read
  const prune = at('$pruned = 0');
  for (const earlier of ["$snapshots.Count -ne 1", "[string]$snapshots[0].State -ne 'Off'", '$checkpointId -cnotmatch $GuidRe', '$after = Get-VM -Name $Req.vmName', "if ($restoreFailed) { Abort 'provider_state_unknown' }", "if ($typeNotSet) { Abort 'provider_unavailable' }"]) {
    assert.ok(at(earlier) < prune, `${earlier} comes before the prune`);
  }
  // the prune can only report: no Abort / Reject after it (a failed prune must not hide the new checkpoint)
  assert.equal(/\b(?:Abort|Reject)\b/u.test(body.slice(prune)), false, 'nothing after the prune can refuse');
  assert.ok(at('pruned = $pruned; pruneFailed = $pruneFailed') > prune);
  assert.equal([...body.matchAll(/\$pruned\+\+/gu)].length, 1);
  assert.equal([...body.matchAll(/\$pruneFailed\+\+/gu)].length, 2);
});

test('restore op (#133): the VM id is mandatory, ownership before anything else, only a fixed-shape State-Off checkpoint, the NEW generation written from the request and read back, every code fixed', () => {
  const body = functionBody('Invoke-Restore');
  const lines = codeLines(body);
  const at = (needle) => { const n = body.indexOf(needle); assert.ok(n >= 0, needle); return n; };
  const apply = at('Restore-VMSnapshot');
  assert.ok(lines.includes('Restore-VMSnapshot -VMSnapshot $newest -Confirm:$false -ErrorAction Stop'), 'the one snapshot object chosen above, no name');
  assert.ok(lines.includes('Set-VM -VM (Get-VM -Id $vm.Id -ErrorAction Stop) -Notes $Req.notes -ErrorAction Stop'), 'the only Set-VM writes Notes of the VM re-read by id');
  assert.equal([...body.matchAll(/\bSet-VM\b/gu)].length, 1);
  assert.ok(at("[string]$Req.expect.identity -ne 'vm' -or $null -eq $Req.expect.vmId") < at('Require-Vm'), 'the VM id is mandatory, checked before the VM is looked up');
  assert.ok(at('Require-Vm') < at('Get-VMSnapshot') && at('Get-VMSnapshot') < apply, 'ownership (Notes + VM id), then the list, then the restore');
  assert.ok(lines.includes('try { $found = @(Get-VMSnapshot -VM $vm -ErrorAction Stop | Where-Object { $_.Name -cmatch $CheckpointNameRe } | Sort-Object -Property CreationTime -Descending) } catch { Reject \'provider_unavailable\' }'), 'this VM only, fixed name shape, newest first');
  for (const refusal of ['if ($found.Count -eq 0) { Reject', "$found.Count -gt 1 -and $found[0].CreationTime -eq $found[1].CreationTime", "[string]$newest.State -ne 'Off'", '$checkpointId -cnotmatch $GuidRe', '$want.generation -ne ([int]$Req.expect.generation + 1)',
    '$want.computerId -cne [string]$Req.expect.computerId', '[string]$want.imageDigest -cne [string]$have.imageDigest', '[string]$want.projectId -cne [string]$have.projectId', '$null -ne $have.incarnationId -or $null -ne $want.incarnationId',
    '$Req.notes -isnot [string]', '@($want.PSObject.Properties).Count -ne 5']) {
    assert.ok(at(refusal) < apply, `${refusal} is judged before anything is restored`);
  }
  // nothing before the restore can change the VM; after it every failure is an unknown outcome, never "not applied"
  assert.equal(/\bAbort\b/u.test(body.slice(0, apply)), false);
  assert.match(body.slice(apply), /catch \{ Abort 'provider_state_unknown' \}/u);
  assert.ok(at("[string]$after.State -ne 'Off' -or $now.generation -ne $want.generation -or $now.computerId -cne $want.computerId") > apply, 'the new generation and the Off state are read back');
  for (const codeName of [...body.matchAll(/(?:Reject|Abort) '([a-z_]+)'/gu)].map((m) => m[1])) assert.ok(['invalid_provider_state', 'provider_unavailable', 'provider_state_unknown'].includes(codeName), codeName);
  // it never starts, stops, removes or reconfigures anything else
  const cmdlets = new Set([...lines.slice(1).join('\n').matchAll(/\b([A-Z][a-z]+-[A-Za-z]+)\b/gu)].map((m) => m[1]));
  assert.deepEqual([...cmdlets].sort(), ['Get-VM', 'Get-VMSnapshot', 'Require-Vm', 'Restore-VMSnapshot', 'Set-VM', 'Sort-Object', 'Where-Object']);
  assert.equal(/Invoke-Expression|\biex\b|Start-Process|-Command|\$Req\.(?:cloneRoot|vmDir|parentPath|childPath|checkpointName)/iu.test(body), false, 'no string-built command and no path input');
  assert.match(scriptText, /'restore' \{ Invoke-Restore \$req \}/u);
  assert.match(scriptText, /derived from the\s*#?\s*restored ones/u, 'the comment says the generation is never taken from the restored Notes');
  assert.equal([...Buffer.from(scriptText, 'utf8')].every((b) => b < 128), true, 'ASCII only');
});

// ---- 2. the real env-io.ps1 against synthetic Hyper-V cmdlets ----

const synthetic = { skip: pwsh ? false : 'PowerShell 7 not found' };

function world({ vm = {}, extraVms = [], snapshots = [], flags = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-fake-hv-'));
  const file = path.join(dir, 'state.json');
  const state = {
    vms: [{ Id: VM, Name: 'albera-pc-01', Notes: notes(), State: 'Running', CheckpointType: 'Standard', ...vm }, ...extraVms],
    snapshots, flags: { failRemoveNames: [], ...flags }, log: [], nextTicks: 700_000_000_000_000_000,
  };
  fs.writeFileSync(file, JSON.stringify(state));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = (request) => {
    const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', RUNNER, '-Fakes', FAKES, '-Script', SCRIPT], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 90_000, windowsHide: true, env: { ...process.env, ALBERA_FAKE_HV_STATE: file },
    });
    assert.ok(result.stdout.trim().length > 0, `no output (exit ${result.status}): ${String(result.stderr).slice(0, 400)}`);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  return { run, read, names: () => read().snapshots.map((s) => s.Name), log: () => read().log, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const snap = (n, extra = {}) => ({ Id: guid(n), VMId: VM, Name: taskName(n), State: 'Off', Ticks: 600_000_000_000_000_000 + n * 10_000_000, SavedNotes: notes(), ...extra });
const checkpointRequest = (n = 0xabc, expect = EXPECT) => ({ method: 'checkpoint', vmName: 'albera-pc-01', expect, checkpointName: taskName(n) });
const restoreRequest = (extra = {}) => ({ method: 'restore', vmName: 'albera-pc-01', expect: EXPECT, notes: notes({ generation: 4 }), ...extra });
const withWorld = (options, body) => { const w = world(options); try { return body(w); } finally { w.cleanup(); } };

test('prune (synthetic cmdlets): the other ALBERA task checkpoints of this VM go; every other name, the other VM\'s checkpoints and the new one stay', synthetic, () => {
  const foreign = [
    snap(0x900, { Name: 'manual-before-upgrade' }), snap(0x901, { Name: 'ALBERA-TASK-000000000000000000000abc' }), snap(0x902, { Name: 'albera-task-00000000000000000000abc' }),
    snap(0x903, { Name: `${taskName(0xabc)}x` }), snap(0x904, { Name: 'albera-task-00000000000000000000000G' }), snap(0x905, { Name: 'xalbera-task-000000000000000000000abc' }),
  ];
  const otherVm = { Id: OTHER_VM, Name: 'albera-pc-02', Notes: notes({ computerId: 'pc-02' }), State: 'Off', CheckpointType: 'Standard' };
  withWorld({ vm: { CheckpointType: 'Standard' }, extraVms: [otherVm], snapshots: [snap(1), snap(2), ...foreign, snap(0x777, { VMId: OTHER_VM })] }, (w) => {
    const reply = w.run(checkpointRequest());
    assert.equal(reply.ok, true);
    assert.equal(reply.pruned, 2);
    assert.equal(reply.pruneFailed, 0);
    assert.deepEqual(w.log().sort(), [`Remove ${taskName(1)}`, `Remove ${taskName(2)}`]);
    const left = w.read().snapshots;
    assert.deepEqual(left.map((s) => s.Name).sort(), [...foreign.map((s) => s.Name), taskName(0x777), taskName(0xabc)].sort(), 'foreign names, the other VM\'s checkpoint and the new one are untouched');
    assert.equal(left.find((s) => s.Name === taskName(0xabc)).Id, reply.checkpointId, 'the reply names the new checkpoint');
    assert.equal(left.find((s) => s.Name === taskName(0x777)).VMId, OTHER_VM);
    assert.equal(w.read().vms[0].CheckpointType, 'Standard', 'the VM\'s own CheckpointType is as it was found');
  });
});

test('prune (synthetic cmdlets): the new checkpoint is never removed even when an old one has the same name; a VM with no old checkpoint prunes nothing', synthetic, () => {
  withWorld({ snapshots: [snap(0xabc, { Id: guid(0xfff) })] }, (w) => {
    const reply = w.run(checkpointRequest(0xabc));
    assert.equal(reply.ok, true);
    assert.equal(reply.pruned, 1, 'the old one with the same name is another checkpoint');
    assert.deepEqual(w.read().snapshots.map((s) => s.Id), [reply.checkpointId]);
  });
  withWorld({}, (w) => {
    const reply = w.run(checkpointRequest());
    assert.deepEqual([reply.ok, reply.pruned, reply.pruneFailed], [true, 0, 0]);
    assert.deepEqual(w.log(), []);
  });
});

test('prune (synthetic cmdlets): a removal that fails, or a list that fails, is REPORTED and does not block the new checkpoint or its attestation', synthetic, () => {
  withWorld({ snapshots: [snap(1), snap(2), snap(3)], flags: { failRemoveNames: [taskName(2)] } }, (w) => {
    const reply = w.run(checkpointRequest());
    assert.deepEqual([reply.ok, reply.pruned, reply.pruneFailed], [true, 2, 1]);
    assert.deepEqual(w.names().sort(), [taskName(2), taskName(0xabc)].sort(), 'the one that could not be removed stays, the new one exists');
  });
  withWorld({ snapshots: [snap(1)], flags: { failList: true } }, (w) => {
    const reply = w.run(checkpointRequest());
    assert.deepEqual([reply.ok, reply.pruned, reply.pruneFailed], [true, 0, 1]);
  });
});

test('prune (synthetic cmdlets): nothing is pruned unless the new checkpoint passed every check (State Saved, a failed checkpoint, a wrong VM id, a bad name)', synthetic, () => {
  withWorld({ snapshots: [snap(1)], flags: { snapshotState: 'Saved' } }, (w) => {
    const reply = w.run(checkpointRequest());
    assert.deepEqual([reply.ok, reply.code], [false, 'provider_state_unknown'], 'a checkpoint that holds guest memory is no attestation');
    assert.deepEqual(w.log(), [], 'and nothing older is removed because of it');
    assert.ok(w.names().includes(taskName(1)));
  });
  withWorld({ snapshots: [snap(1)], flags: { failCheckpoint: true } }, (w) => {
    assert.equal(w.run(checkpointRequest()).ok, false);
    assert.deepEqual([w.log(), w.names()], [[], [taskName(1)]]);
  });
  withWorld({ snapshots: [snap(1)] }, (w) => {
    for (const request of [
      checkpointRequest(0xabc, { ...EXPECT, vmId: OTHER_VM }), checkpointRequest(0xabc, { ...EXPECT, identity: undefined }), checkpointRequest(0xabc, { ...EXPECT, generation: 4 }),
      { ...checkpointRequest(), checkpointName: 'manual-before-upgrade' }, { ...checkpointRequest(), checkpointName: taskName(5).toUpperCase() },
    ]) assert.equal(w.run(request).ok, false);
    assert.deepEqual([w.log(), w.names()], [[], [taskName(1)]], 'refused before anything was touched');
  });
});

test('restore (synthetic cmdlets): the NEWEST fixed-shape checkpoint is applied, the VM ends Off, and the generation is the request\'s (current + 1), not the restored Notes\'', synthetic, () => {
  const older = snap(1, { SavedNotes: notes({ generation: 1 }) });
  const newest = snap(2, { SavedNotes: notes({ generation: 2 }) });
  const manualNewer = snap(0x999, { Name: 'manual-after-the-task', Ticks: 650_000_000_000_000_000, SavedNotes: notes({ generation: 3 }) });
  withWorld({ snapshots: [older, newest, manualNewer] }, (w) => {
    const reply = w.run(restoreRequest());
    assert.equal(reply.ok, true);
    assert.deepEqual([reply.vmId, reply.state, reply.generation, reply.checkpointId], [VM, 'Off', 4, guid(2)]);
    assert.deepEqual(w.log(), [`Restore ${taskName(2)}`], 'exactly one restore, of the newest ALBERA checkpoint (a newer manual checkpoint is not ours)');
    const vm = w.read().vms[0];
    assert.equal(vm.State, 'Off');
    assert.equal(JSON.parse(vm.Notes).generation, 4, 'the restored Notes said 2; the VM was at 3; the new generation is 4');
    assert.deepEqual(JSON.parse(vm.Notes), { albera: 1, computerId: 'pc-01', generation: 4, imageDigest: DIGEST, projectId: 'proj-alpha' });
    assert.deepEqual(w.names().sort(), [taskName(1), taskName(2), 'manual-after-the-task'].sort(), 'no checkpoint is removed by a restore');
  });
});

test('restore (synthetic cmdlets): refused with nothing changed when there is no ALBERA checkpoint, only foreign names, a Saved one, or a tie for newest', synthetic, () => {
  const cases = {
    'no checkpoint at all': [],
    'only foreign names': [snap(1, { Name: 'manual' }), snap(2, { Name: 'ALBERA-TASK-000000000000000000000002' }), snap(3, { Name: 'albera-task-0000000000000000000002' })],
    'the other VM\'s ALBERA checkpoint': [snap(4, { VMId: OTHER_VM })],
    'the newest ALBERA checkpoint holds guest memory (State Saved)': [snap(1), snap(2, { State: 'Saved' })],
    'a tie for newest': [snap(1, { Ticks: 600_000_000_000_000_000 }), snap(2, { Ticks: 600_000_000_000_000_000 })],
    'a checkpoint id that is not a GUID': [snap(1, { Id: 'not-a-guid' })],
  };
  for (const [label, snapshots] of Object.entries(cases)) {
    withWorld({ snapshots, extraVms: [{ Id: OTHER_VM, Name: 'albera-pc-02', Notes: notes({ computerId: 'pc-02' }), State: 'Off', CheckpointType: 'Standard' }] }, (w) => {
      const before = w.read();
      const reply = w.run(restoreRequest());
      assert.deepEqual([reply.ok, reply.code, reply.notApplied], [false, 'invalid_provider_state', true], label);
      assert.deepEqual(w.read(), before, `${label}: the VM and its checkpoints are exactly as they were`);
    });
  }
});

test('restore (synthetic cmdlets): refused before anything is touched for a wrong or missing VM id, a stale generation, and Notes that are not exactly "this VM at generation + 1"', synthetic, () => {
  const otherDigest = notes({ generation: 4, imageDigest: `sha256:${'b'.repeat(64)}` });
  const requests = {
    'another VM id': restoreRequest({ expect: { ...EXPECT, vmId: OTHER_VM } }),
    'no VM id': restoreRequest({ expect: { computerId: 'pc-01', generation: 3, identity: 'vm' } }),
    'no identity level': restoreRequest({ expect: { computerId: 'pc-01', generation: 3, vmId: VM } }),
    'identity full': restoreRequest({ expect: { ...EXPECT, identity: 'full' } }),
    'a stale generation (the VM is at 3)': restoreRequest({ expect: { ...EXPECT, generation: 2 }, notes: notes({ generation: 3 }) }),
    'another computer': restoreRequest({ expect: { ...EXPECT, computerId: 'pc-02' } }),
    'a VM name that is not ours': { ...restoreRequest(), vmName: 'albera-pc-09' },
    'Notes at the same generation': restoreRequest({ notes: notes({ generation: 3 }) }),
    'Notes two generations ahead': restoreRequest({ notes: notes({ generation: 5 }) }),
    'Notes at a lower generation': restoreRequest({ notes: notes({ generation: 2 }) }),
    'Notes of another computer': restoreRequest({ notes: notes({ generation: 4, computerId: 'pc-02' }) }),
    'Notes with another image': restoreRequest({ notes: otherDigest }),
    'Notes with an extra key': restoreRequest({ notes: JSON.stringify({ ...JSON.parse(notes({ generation: 4 })), extra: 'x'.repeat(2000) }) }),
    'Notes with another project': restoreRequest({ notes: notes({ generation: 4, projectId: 'proj-other' }) }),
    'Notes that start a retirement': restoreRequest({ notes: notes({ generation: 4, incarnationId: 'a'.repeat(32) }) }),
    'Notes that are not JSON': restoreRequest({ notes: 'not json' }),
    'Notes that are not a string': restoreRequest({ notes: { generation: 4 } }),
    'no Notes': (({ notes: _omit, ...rest }) => rest)(restoreRequest()),
    'a generation as text': restoreRequest({ notes: notes({ generation: '4' }) }),
  };
  withWorld({ snapshots: [snap(1)] }, (w) => {
    const before = w.read();
    for (const [label, request] of Object.entries(requests)) {
      const reply = w.run(request);
      assert.equal(reply.ok, false, label);
      assert.ok(['invalid_provider_state'].includes(reply.code) && reply.notApplied === true, `${label}: ${JSON.stringify(reply)}`);
      assert.deepEqual(w.read(), before, `${label}: nothing changed`);
    }
    assert.equal(w.run(restoreRequest()).ok, true, 'and the right request still works afterwards');
  });
});

test('restore (synthetic cmdlets): a restore or a Notes write that fails is an UNKNOWN outcome (never "not applied"), and a VM whose Notes carry an incarnation id is refused', synthetic, () => {
  withWorld({ snapshots: [snap(1)], flags: { failRestore: true } }, (w) => {
    const reply = w.run(restoreRequest());
    assert.deepEqual([reply.ok, reply.code, reply.notApplied], [false, 'provider_state_unknown', false]);
  });
  withWorld({ snapshots: [snap(1)], flags: { failSetNotes: true } }, (w) => {
    const reply = w.run(restoreRequest());
    assert.deepEqual([reply.ok, reply.code, reply.notApplied], [false, 'provider_state_unknown', false]);
    assert.deepEqual(w.log(), [`Restore ${taskName(1)}`], 'the restore happened; the caller must inspect before retrying');
  });
  withWorld({ vm: { Notes: notes({ incarnationId: 'a'.repeat(32) }) }, snapshots: [snap(1)] }, (w) => {
    const before = w.read();
    assert.deepEqual([w.run(restoreRequest()).ok, w.read()], [false, before]);
  });
  withWorld({ snapshots: [snap(1)], flags: { failList: true } }, (w) => {
    const reply = w.run(restoreRequest());
    assert.deepEqual([reply.ok, reply.code, reply.notApplied], [false, 'provider_unavailable', true]);
  });
});

test('env-io.ps1 parses (PowerShell 7) with the new ops', synthetic, () => {
  const probe = '$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:ALBERA_PS_FILE, [ref]$t, [ref]$e); if (@($e).Count -ne 0) { $e | ForEach-Object { $_.Message }; exit 1 }';
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ALBERA_PS_FILE: SCRIPT } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// ---- 3. the Hyper-V Broker prototype over a stand-in for env-io.ps1 ----

const T0 = 1793404800;
const CKPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const tmpRoot = path.join(os.tmpdir(), 'albera-checkpoint-lifecycle-never-created');
const RESTORE_INPUT = Object.freeze({ computerId: 'pc-01', projectId: 'proj-alpha', expectedGeneration: 3, vmId: VM });

/** Stateful stand-in for env-io.ps1 'inspect' / 'network' / 'checkpoint' / 'restore' / 'start': one VM whose Notes (and so generation) a restore rewrites. */
function stateful({ restore, checkpoint, vm = {} } = {}) {
  const state = { notes: notes(), state: 'Running', vmId: VM, ...vm };
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    const describe = () => ({ ok: true, exists: true, state: state.state, notes: state.notes, vmId: state.vmId.toUpperCase(), adapters: [] });
    if (request.method === 'inspect' || request.method === 'network') return describe();
    if (request.method === 'checkpoint') return typeof checkpoint === 'function' ? checkpoint(request) : (checkpoint ?? { ok: true, checkpointId: CKPT, vmId: VM, state: 'Running', pruned: 1, pruneFailed: 0 });
    if (request.method === 'restore') {
      if (typeof restore === 'function') return restore(request, state);
      if (restore) return restore;
      state.notes = request.notes;
      state.state = 'Off';
      return { ok: true, checkpointId: CKPT, vmId: VM, state: 'Off', generation: JSON.parse(request.notes).generation };
    }
    if (request.method === 'start') { state.state = 'Running'; return { ok: true, state: 'Running' }; }
    return { ok: false, code: 'invalid_provider_state', notApplied: true };
  };
  return { run, calls, state, methods: () => calls.map((c) => c.method) };
}

const ecdsa = () => createEcdsaAttestationSigner({ keyId: 'albera-test-broker-1', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
function hv(scriptOptions = {}, options = {}) {
  const script = stateful(scriptOptions);
  const signer = ecdsa();
  const broker = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [DIGEST]: { path: path.join(os.tmpdir(), 'albera-checkpoint-lifecycle-golden', 'base.vhdx'), os: 'windows', architecture: 'x64' } },
    cloneRoot: tmpRoot, runPowerShell: script.run, now: () => new Date((T0 + 5) * 1000), attestationSigner: signer, ...options,
  });
  return { broker, script, signer };
}
const op = (action, extra = {}) => ({
  operationId: `op-${action}`, idempotencyKey: `idem-${action}`, subjectId: 'sub-1', projectId: 'proj-alpha', taskId: 'task-1', runId: 'run-1', computerId: 'pc-01',
  providerId: 'hyperv', leaseId: 'lease-1', expectedGeneration: 3, policyVersion: 1, action, ...extra,
});
const refusal = async (promise, code, outcome) => {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code); assert.equal(error.outcome, outcome); return true; });
};

test('restoreTaskCheckpoint: the fixed restore op gets the VM id, the current generation and the Notes at generation + 1 built from the VM\'s own Notes; the reply is at the new generation, Off', async () => {
  const { broker, script } = hv();
  const observed = await broker.restoreTaskCheckpoint({ ...RESTORE_INPUT });
  assert.deepEqual(script.methods(), ['inspect', 'restore', 'inspect']);
  assert.deepEqual(script.calls[1], {
    method: 'restore', vmName: 'albera-pc-01', expect: { computerId: 'pc-01', generation: 3, vmId: VM, identity: 'vm' },
    notes: JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 4, imageDigest: DIGEST, projectId: 'proj-alpha' }),
  });
  assert.deepEqual([observed.computerId, observed.providerId, observed.state, observed.generation], ['pc-01', 'hyperv', 'off', 4]);
  assert.equal(Object.hasOwn(script.calls[1], 'checkpointName'), false, 'no caller-supplied name or path reaches the script: it picks the newest ALBERA checkpoint itself');
});

test('restore reissues the generation (ADR-004 acceptance 5): old-generation start / stop / destroy / inspect operations, task-start statements and receipts are refused, new-generation ones work', async () => {
  const { broker, script, signer } = hv();
  const verifier = createEcdsaAttestationVerifier({ keyId: signer.keyId, publicKey: signer.publicKeySpki });
  const dtoOf = (generation) => ({ action: 'task.start', projectId: 'proj-alpha', computerId: 'pc-01', args: { expectedGeneration: generation, task: 'build', vmId: VM } });
  const taskInput = (generation, operationId) => ({
    computerId: 'pc-01', projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, generation, vmId: VM, operationId, actionDigest: computeActionDigest('guest.command', dtoOf(generation)),
  });
  const before = await broker.attestTaskStart(taskInput(3, 'op-before'));
  assert.ok(before, 'a statement at generation 3 exists');
  await broker.restoreTaskCheckpoint({ ...RESTORE_INPUT });
  // 1. the statement made BEFORE the restore no longer verifies for the new generation
  const expected = { computerId: 'pc-01', vmId: VM, generation: 4, projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, operationId: 'op-before', actionDigest: computeActionDigest('guest.command', dtoOf(3)) }; // only the generation moved
  assert.throws(() => verifyTaskStartAttestation(JSON.parse(JSON.stringify(before)), { clock: () => T0 + 10, verify: verifier.verify, expected }), (error) => error.code === 'binding' && error.field === 'generation');
  // 2. a new statement for the OLD generation is not made (null), for the new one it is
  assert.equal(await broker.attestTaskStart(taskInput(3, 'op-stale')), null);
  assert.ok(await broker.attestTaskStart(taskInput(4, 'op-fresh')));
  // 3. every lifecycle operation that still carries generation 3 is refused before the script is asked to do anything
  const startsBefore = script.calls.filter((c) => c.method === 'start').length;
  for (const action of ['start', 'stop']) await refusal(broker[`${action}Vm`](op(action)), 'stale_generation', 'not_applied');
  await refusal(broker.removeVm(op('destroy')), 'stale_generation', 'not_applied');
  await refusal(broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'stale_generation', 'not_applied'); // an old approval cannot restore twice
  assert.equal(script.calls.filter((c) => c.method === 'start' || c.method === 'stop' || c.method === 'remove').length, startsBefore, 'the script never saw an old-generation start, stop or remove');
  // 4. the new generation works
  assert.equal((await broker.startVm(op('start', { expectedGeneration: 4 }))).generation, 4);
  assert.equal((await broker.inspectVm(op('inspect', { expectedGeneration: 4 }))).generation, 4);
  // 5. a second restore needs its own approval at the new generation, and moves on again (monotonic, never reused)
  assert.equal((await broker.restoreTaskCheckpoint({ ...RESTORE_INPUT, expectedGeneration: 4 })).generation, 5);
  assert.equal(JSON.parse(script.state.notes).generation, 5);
});

test('restoreTaskCheckpoint refusals: not applied, and the script is never asked to restore (stale generation, other VM id, other project, no project, retired, an incarnation id, a VM that is not ours)', async () => {
  const cases = [
    ['a stale generation', { ...RESTORE_INPUT, expectedGeneration: 2 }, {}, 'stale_generation'],
    ['a generation ahead of the VM', { ...RESTORE_INPUT, expectedGeneration: 4 }, {}, 'stale_generation'],
    ['another VM id than the approval names', { ...RESTORE_INPUT }, { vm: { vmId: OTHER_VM } }, 'operation_conflict'],
    ['another project', { ...RESTORE_INPUT, projectId: 'proj-other' }, {}, 'project_mismatch'],
    ['a VM with no project in its Notes', { ...RESTORE_INPUT }, { vm: { notes: JSON.stringify({ albera: 1, computerId: 'pc-01', generation: 3, imageDigest: DIGEST }) } }, 'project_unknown'],
    ['Notes of another computer', { ...RESTORE_INPUT }, { vm: { notes: notes({ computerId: 'pc-02' }) } }, 'invalid_provider_state'],
    ['Notes that are not ours', { ...RESTORE_INPUT }, { vm: { notes: 'not json' } }, 'invalid_provider_state'],
    ['a retirement that has begun on the VM', { ...RESTORE_INPUT }, { vm: { notes: notes({ incarnationId: 'a'.repeat(32) }) } }, 'operation_conflict'],
  ];
  for (const [label, input, scriptOptions, code] of cases) {
    const { broker, script } = hv(scriptOptions);
    await refusal(broker.restoreTaskCheckpoint(input), code, 'not_applied');
    assert.equal(script.methods().includes('restore'), false, label);
  }
  const none = createHyperVEnvironmentBrokerPrototype({
    goldenImages: { [DIGEST]: { path: path.join(os.tmpdir(), 'g', 'base.vhdx'), os: 'windows', architecture: 'x64' } }, cloneRoot: tmpRoot,
    runPowerShell: async () => ({ ok: true, exists: false }),
  });
  await refusal(none.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'invalid_provider_state', 'not_applied');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-restore-retire-'));
  let journal;
  try {
    journal = createRetirementJournal({ path: path.join(dir, 'retire.sqlite') });
    journal.retire({ computerId: 'pc-01', projectId: 'proj-alpha', generation: 3, vmId: VM });
    const retired = hv({}, { retirements: journal });
    await refusal(retired.broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'environment_retired', 'not_applied');
    assert.equal(retired.script.calls.length, 0, 'a retired computer id is refused before the script is asked anything');
  } finally { journal?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restoreTaskCheckpoint input: exactly four fields; anything else never reaches the script', async () => {
  const bad = [
    null, 'x', [], { ...RESTORE_INPUT, extra: 1 }, { ...RESTORE_INPUT, checkpointName: taskName(1) }, { ...RESTORE_INPUT, notes: notes({ generation: 9 }) }, { ...RESTORE_INPUT, generation: 3 },
    (({ vmId, ...r }) => r)(RESTORE_INPUT), (({ projectId, ...r }) => r)(RESTORE_INPUT), (({ expectedGeneration, ...r }) => r)(RESTORE_INPUT),
    { ...RESTORE_INPUT, vmId: 'AAAAAAAA-2222-4333-8444-555555555555' }, { ...RESTORE_INPUT, vmId: 'vm-1' }, { ...RESTORE_INPUT, expectedGeneration: 0 }, { ...RESTORE_INPUT, expectedGeneration: '3' },
    { ...RESTORE_INPUT, expectedGeneration: 1.5 }, { ...RESTORE_INPUT, expectedGeneration: Number.MAX_SAFE_INTEGER }, { ...RESTORE_INPUT, computerId: 'pc_01' }, { ...RESTORE_INPUT, computerId: '..\\pc' },
    { ...RESTORE_INPUT, projectId: '' }, { ...RESTORE_INPUT, projectId: 'a b' },
  ];
  for (const input of bad) {
    const { broker, script } = hv();
    await refusal(broker.restoreTaskCheckpoint(input), 'invalid_provider_state', 'not_applied');
    assert.equal(script.calls.length, 0, JSON.stringify(input));
  }
});

test('restoreTaskCheckpoint: an op that fails, or reports anything but "this VM, Off, the new generation", is an error and no success; a failure of the op keeps its outcome', async () => {
  const wrongReplies = {
    'another VM id in the reply': { ok: true, checkpointId: CKPT, vmId: OTHER_VM, state: 'Off', generation: 4 },
    'no VM id in the reply': { ok: true, checkpointId: CKPT, state: 'Off', generation: 4 },
    'the VM left running': { ok: true, checkpointId: CKPT, vmId: VM, state: 'Running', generation: 4 },
    'the old generation in the reply': { ok: true, checkpointId: CKPT, vmId: VM, state: 'Off', generation: 3 },
    'a generation two ahead': { ok: true, checkpointId: CKPT, vmId: VM, state: 'Off', generation: 5 },
    'a generation as text': { ok: true, checkpointId: CKPT, vmId: VM, state: 'Off', generation: '4' },
  };
  for (const restore of Object.values(wrongReplies)) {
    const { broker } = hv({ restore });
    await refusal(broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'provider_state_unknown', 'unknown');
  }
  // the reply is fine but the VM itself does not show the new generation / Off: unknown, not success
  const lying = hv({ restore: (request, state) => { state.notes = request.notes; state.state = 'Running'; return { ok: true, checkpointId: CKPT, vmId: VM, state: 'Off', generation: 4 }; } });
  await refusal(lying.broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'provider_state_unknown', 'unknown');
  const unchanged = hv({ restore: () => ({ ok: true, checkpointId: CKPT, vmId: VM, state: 'Off', generation: 4 }) });
  await refusal(unchanged.broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'provider_state_unknown', 'unknown');
  // the op's own refusals keep their meaning (no checkpoint = not applied; a failed restore / Notes write = unknown)
  const none = hv({ restore: { ok: false, code: 'invalid_provider_state', notApplied: true } });
  await refusal(none.broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'invalid_provider_state', 'not_applied');
  assert.equal(none.script.methods().filter((m) => m === 'inspect').length, 1, 'no second read after a refusal');
  const failed = hv({ restore: { ok: false, code: 'provider_state_unknown', notApplied: false } });
  await refusal(failed.broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'provider_state_unknown', 'unknown');
  const thrown = hv({ restore: () => { throw Object.assign(new Error('provider_timeout'), { code: 'provider_timeout' }); } });
  await refusal(thrown.broker.restoreTaskCheckpoint({ ...RESTORE_INPUT }), 'provider_timeout', 'unknown');
});

test('onCheckpointPrune: the counts of the checkpoint op reach the hook; a prune that failed is reported and the attestation is still made; a throwing hook and a silent script change nothing', async () => {
  const input = {
    computerId: 'pc-01', projectId: 'proj-alpha', leaseId: 'lease-1', leaseGeneration: 7, generation: 3, vmId: VM, operationId: 'op-0001',
    actionDigest: `sha256:${createHash('sha256').update('x').digest('hex')}`,
  };
  const heard = [];
  const ok = hv({}, { onCheckpointPrune: (report) => heard.push(report) });
  assert.ok(await ok.broker.attestTaskStart({ ...input }));
  const failing = hv({ checkpoint: { ok: true, checkpointId: CKPT, vmId: VM, pruned: 0, pruneFailed: 2 } }, { onCheckpointPrune: (report) => heard.push(report) });
  assert.ok(await failing.broker.attestTaskStart({ ...input }), 'a prune failure only costs disk: the new checkpoint is real, so the statement is made');
  const silent = hv({ checkpoint: { ok: true, checkpointId: CKPT, vmId: VM } }, { onCheckpointPrune: (report) => heard.push(report) });
  assert.ok(await silent.broker.attestTaskStart({ ...input }));
  const malformed = hv({ checkpoint: { ok: true, checkpointId: CKPT, vmId: VM, pruned: -1, pruneFailed: '2' } }, { onCheckpointPrune: (report) => heard.push(report) });
  assert.ok(await malformed.broker.attestTaskStart({ ...input }));
  const throwing = hv({}, { onCheckpointPrune: () => { throw new Error('hook down'); } });
  assert.ok(await throwing.broker.attestTaskStart({ ...input }), 'a hook cannot change the outcome');
  assert.deepEqual(heard, [
    { computerId: 'pc-01', pruned: 1, pruneFailed: 0 }, { computerId: 'pc-01', pruned: 0, pruneFailed: 2 },
    { computerId: 'pc-01', pruned: null, pruneFailed: null }, { computerId: 'pc-01', pruned: null, pruneFailed: null },
  ]);
  assert.throws(() => createHyperVEnvironmentBrokerPrototype({ goldenImages: {}, cloneRoot: tmpRoot, onCheckpointPrune: 'not a function' }), TypeError);
  // the hook is told even when a later step ends in no statement (the checkpoint and the prune did happen)
  const late = hv({ checkpoint: { ok: true, checkpointId: CKPT, vmId: OTHER_VM, pruned: 1, pruneFailed: 0 } }, { onCheckpointPrune: (report) => heard.push(report) });
  assert.equal(await late.broker.attestTaskStart({ ...input }), null);
  assert.equal(heard.length, 5);
});
