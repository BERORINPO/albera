import { isEnvironmentId, validateEnvironmentCapacity, validateEnvironmentQuota, validateEnvironmentSpec } from './environment-provider.mjs';

/** Deterministic, side-effect-free placement proposal; never contacts an Environment Provider. */
export function proposeComputerPlacement({ computers, requirements, quota }) {
  const spec = validateEnvironmentSpec(requirements);
  const projectQuota = validateEnvironmentQuota(quota);
  if (!Array.isArray(computers)) throw new TypeError('invalid_computer_candidates');
  const rejected = new Set();
  const eligible = [];
  const candidateIdCounts = new Map();
  for (const computer of computers) {
    if (computer && isEnvironmentId(computer.computerId)) {
      candidateIdCounts.set(computer.computerId, (candidateIdCounts.get(computer.computerId) ?? 0) + 1);
    }
  }
  for (const computer of computers) {
    if (!computer || !isEnvironmentId(computer.computerId)) { rejected.add('candidate_invalid'); continue; }
    if (candidateIdCounts.get(computer.computerId) > 1) { rejected.add('candidate_duplicate'); continue; }
    if (computer.projectId !== spec.projectId) { rejected.add('project_mismatch'); continue; }
    if (computer.leaseAvailable !== true) { rejected.add('lease_unavailable'); continue; }
    if (!computer.capacity) { rejected.add('capacity_unknown'); continue; }
    let capacity;
    try { capacity = validateEnvironmentCapacity(computer.capacity); }
    catch { rejected.add('capacity_invalid'); continue; }
    if (capacity.os !== spec.os || capacity.architecture !== spec.architecture) { rejected.add('platform_mismatch'); continue; }
    if (!spec.capabilities.every((capability) => capacity.capabilities.includes(capability))) { rejected.add('capability_mismatch'); continue; }
    if (!capacity.networkProfileIds.includes(spec.networkProfileId)) { rejected.add('network_profile_mismatch'); continue; }
    if (!capacity.securityProfileIds.includes(spec.securityProfileId)) { rejected.add('security_profile_mismatch'); continue; }
    if (capacity.resources.vcpu < spec.resources.vcpu || capacity.resources.memoryMiB < spec.resources.memoryMiB
      || capacity.resources.diskGiB < spec.resources.diskGiB) { rejected.add('resource_capacity_insufficient'); continue; }
    eligible.push(computer);
  }
  eligible.sort((left, right) => {
    const a = left.capacity.resources;
    const b = right.capacity.resources;
    return (a.diskGiB - spec.resources.diskGiB) - (b.diskGiB - spec.resources.diskGiB)
      || (a.memoryMiB - spec.resources.memoryMiB) - (b.memoryMiB - spec.resources.memoryMiB)
      || (a.vcpu - spec.resources.vcpu) - (b.vcpu - spec.resources.vcpu)
      || (left.computerId < right.computerId ? -1 : left.computerId > right.computerId ? 1 : 0);
  });
  return Object.freeze({
    status: eligible.length ? 'PROPOSED' : 'NO_CAPACITY',
    computerId: eligible[0]?.computerId ?? null,
    requirements: spec,
    quota: projectQuota,
    reasonCodes: Object.freeze(eligible.length ? [] : [...rejected].sort()),
  });
}

/** Re-read candidates, propose, then let the SQLite store atomically revalidate and reserve. */
export function reserveComputerForRun({ store, lease, requirements, quota }) {
  if (!store || typeof store.listComputers !== 'function' || typeof store.reserveLease !== 'function') {
    throw new TypeError('invalid_scheduler_store');
  }
  const spec = validateEnvironmentSpec(requirements);
  const projectQuota = validateEnvironmentQuota(quota);
  const proposal = proposeComputerPlacement({
    computers: store.listComputers(spec.projectId), requirements: spec, quota: projectQuota,
  });
  if (proposal.status !== 'PROPOSED') return proposal;
  return Object.freeze({
    ...proposal,
    lease: store.reserveLease({ ...lease, projectId: spec.projectId, computerId: proposal.computerId,
      requirements: spec, quota: projectQuota }),
  });
}
