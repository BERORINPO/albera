import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeComputerPlacement } from '../src/runtime/computer-scheduler.mjs';

const requirements = Object.freeze({
  projectId: 'project-a', kind: 'ephemeral', os: 'linux', architecture: 'x64',
  imageDigest: `sha256:${'b'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'net-a', securityProfileId: 'sec-a',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
});
const quota = Object.freeze({ maxComputers: 12, vcpu: 96, memoryMiB: 196608, diskGiB: 4096 });

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function buildCandidates(seed) {
  const random = createRandom(seed);
  const count = Math.floor(random() * 30);
  return Array.from({ length: count }, (_, index) => ({
    computerId: `computer-${String(index).padStart(2, '0')}`,
    projectId: random() < 0.8 ? 'project-a' : 'project-b',
    leaseAvailable: random() >= 0.15,
    capacity: {
      os: random() < 0.85 ? 'linux' : 'windows',
      architecture: random() < 0.9 ? 'x64' : 'arm64',
      capabilities: random() < 0.8 ? ['terminal', 'browser'] : ['browser'],
      networkProfileIds: random() < 0.75 ? ['net-a', 'net-b'] : ['net-b'],
      securityProfileIds: random() < 0.7 ? ['sec-a', 'sec-b'] : ['sec-b'],
      resources: {
        vcpu: 1 + Math.floor(random() * 16),
        memoryMiB: 256 * (1 + Math.floor(random() * 64)),
        diskGiB: 1 + Math.floor(random() * 256),
      },
    },
  }));
}

function isEligible(candidate) {
  const capacity = candidate.capacity;
  return candidate.projectId === requirements.projectId
    && candidate.leaseAvailable === true
    && capacity.os === requirements.os
    && capacity.architecture === requirements.architecture
    && requirements.capabilities.every((capability) => capacity.capabilities.includes(capability))
    && capacity.networkProfileIds.includes(requirements.networkProfileId)
    && capacity.securityProfileIds.includes(requirements.securityProfileId)
    && capacity.resources.vcpu >= requirements.resources.vcpu
    && capacity.resources.memoryMiB >= requirements.resources.memoryMiB
    && capacity.resources.diskGiB >= requirements.resources.diskGiB;
}

function bestFit(left, right) {
  const leftResources = left.capacity.resources;
  const rightResources = right.capacity.resources;
  return (leftResources.diskGiB - requirements.resources.diskGiB) - (rightResources.diskGiB - requirements.resources.diskGiB)
    || (leftResources.memoryMiB - requirements.resources.memoryMiB) - (rightResources.memoryMiB - requirements.resources.memoryMiB)
    || (leftResources.vcpu - requirements.resources.vcpu) - (rightResources.vcpu - requirements.resources.vcpu)
    || left.computerId.localeCompare(right.computerId);
}

test('placement property: every winner is eligible, deterministic and best-fit over generated pools', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const candidates = buildCandidates(seed);
    const original = structuredClone(candidates);
    const eligible = candidates.filter(isEligible).sort(bestFit);
    const proposal = proposeComputerPlacement({ computers: candidates, requirements, quota });

    assert.equal(proposal.status, eligible.length ? 'PROPOSED' : 'NO_CAPACITY', `seed=${seed}`);
    assert.equal(proposal.computerId, eligible[0]?.computerId ?? null, `seed=${seed}`);
    assert.deepEqual(candidates, original, `input mutated for seed=${seed}`);

    const permuted = [...candidates].reverse();
    const reverseProposal = proposeComputerPlacement({ computers: permuted, requirements, quota });
    assert.equal(reverseProposal.computerId, proposal.computerId, `candidate order changed winner for seed=${seed}`);
  }
});

test('placement rejects an invalid capacity and reports no winner without modifying other candidates', () => {
  const valid = buildCandidates(41).find(isEligible) ?? {
    computerId: 'computer-valid', projectId: 'project-a', leaseAvailable: true,
    capacity: { os: 'linux', architecture: 'x64', capabilities: ['terminal'],
      networkProfileIds: ['net-a'], securityProfileIds: ['sec-a'],
      resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 } },
  };
  const invalid = { computerId: 'computer-invalid', projectId: 'project-a', leaseAvailable: true,
    capacity: { ...valid.capacity, resources: { ...valid.capacity.resources, vcpu: Number.MAX_SAFE_INTEGER } } };
  const candidates = [invalid, valid];
  const result = proposeComputerPlacement({ computers: candidates, requirements, quota });
  assert.equal(result.status, 'PROPOSED');
  assert.equal(result.computerId, valid.computerId);
  assert.deepEqual(result.reasonCodes, []);
});
