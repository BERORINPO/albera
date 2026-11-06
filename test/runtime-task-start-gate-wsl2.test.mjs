// ADR-012, decision 4: the task.start of a wsl2 computer names its target, so that target is in the digest the owner approves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskStartGate } from '../src/runtime/task-start-gate.mjs';

const OID = 'a'.repeat(40);
const TARGET = Object.freeze({ repositoryId: 'repo-alpha', baseOid: OID });

function gateWith(overrides) {
  const runs = [];
  const flow = { run: async (request) => { runs.push(request); return { status: 'claimed', operationId: request.operationId, replayed: false }; } };
  return { runs, gate: createTaskStartGate({ flow, projectId: 'proj-alpha', computerIdFor: () => 'pc-wsl', newOperationId: () => 'op-1', ...overrides }) };
}

test('the action names the isolation, the repository and the commit', async () => {
  const { gate, runs } = gateWith({ wsl2TargetFor: () => TARGET });
  assert.deepEqual(await gate.startApproved({ vmId: 'albera-wsl', task: 'build' }), { ok: true, operationId: 'op-1' });
  assert.deepEqual({ ...runs[0].action, args: { ...runs[0].action.args } }, { action: 'task.start', projectId: 'proj-alpha', computerId: 'pc-wsl', args: { task: 'build', isolation: 'wsl2', repositoryId: 'repo-alpha', baseOid: OID } });
});

test('the target may come from an async lookup', async () => {
  const { gate, runs } = gateWith({ wsl2TargetFor: async () => TARGET });
  assert.equal((await gate.startApproved({ vmId: 'albera-wsl', task: 'build' })).ok, true);
  assert.equal(runs[0].action.args.baseOid, OID);
});

test('a computer the lookup does not know stays a plain start', async () => {
  const { gate, runs } = gateWith({ wsl2TargetFor: () => undefined });
  assert.equal((await gate.startApproved({ vmId: 'albera-vm', task: 'build' })).ok, true);
  assert.deepEqual({ ...runs[0].action.args }, { task: 'build' });
});

test('a bad target, a failing lookup, or a VM named beside it starts nothing', async () => {
  const cases = [
    ['a branch for a commit', { wsl2TargetFor: () => ({ ...TARGET, baseOid: 'main' }) }], ['no commit', { wsl2TargetFor: () => ({ repositoryId: 'repo-alpha' }) }], ['a path for a repository', { wsl2TargetFor: () => ({ ...TARGET, repositoryId: 'C:/repo' }) }],
    ['null', { wsl2TargetFor: () => null }], ['a lookup that throws', { wsl2TargetFor: () => { throw new Error('x'); } }], ['a lookup that rejects', { wsl2TargetFor: async () => { throw new Error('x'); } }],
    ['an attestation beside it', { wsl2TargetFor: () => TARGET, attestationFor: () => ({ vmId: '11111111-2222-4333-8444-555555555555', expectedGeneration: 1 }) }],
  ];
  for (const [label, overrides] of cases) {
    const { gate, runs } = gateWith(overrides);
    assert.deepEqual(await gate.startApproved({ vmId: 'albera-wsl', task: 'build' }), { ok: false, code: 'vm_unknown' }, label);
    assert.deepEqual(runs, [], label);
  }
});

test('a wsl2TargetFor that is not a function is a wiring error', () => {
  assert.throws(() => gateWith({ wsl2TargetFor: 'x' }), /invalid_task_start_gate_dependencies/u);
});
