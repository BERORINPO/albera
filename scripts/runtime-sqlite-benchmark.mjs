#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { proposeComputerPlacement } from '../src/runtime/computer-scheduler.mjs';
import { openSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';

const samples = Number.parseInt(process.env.ALB_RUNTIME_BENCH_SAMPLES ?? '40', 10);
if (!Number.isSafeInteger(samples) || samples < 10 || samples > 500) throw new Error('bench_samples_out_of_range');
const root = await mkdtemp(path.join(os.homedir(), '.albera-sqlite-benchmark-'));
let store;

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3));
}

function summarize(values) {
  return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Number(Math.max(...values).toFixed(3)) };
}

try {
  store = await openSqliteEnvironmentStore(path.join(root, 'benchmark.sqlite'), { maxRecords: Math.min(20_000, samples * 8) });
  const computerWrites = [];
  const leaseWrites = [];
  const operationWrites = [];
  const placementTimes = [];
  const placementRequirements = {
    projectId: 'bench-placement-project', kind: 'ephemeral', os: 'linux', architecture: 'x64',
    imageDigest: `sha256:${'c'.repeat(64)}`, capabilities: ['terminal'],
    networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1',
    resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
  };
  const placementQuota = { maxComputers: 10_000, vcpu: 1_000_000, memoryMiB: 1_073_741_824, diskGiB: 1_073_741_824 };
  const placementCandidates = Array.from({ length: 100 }, (_, index) => ({
    computerId: `bench-placement-${String(index).padStart(3, '0')}`,
    projectId: placementRequirements.projectId,
    leaseAvailable: true,
    capacity: { os: 'linux', architecture: 'x64', capabilities: ['terminal'],
      networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
      resources: { vcpu: 8 + index, memoryMiB: 8192 + index * 256, diskGiB: 128 + index * 8 } },
  }));
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  for (let index = 0; index < samples; index++) {
    const suffix = String(index).padStart(4, '0');
    const projectId = `bench-project-${suffix}`;
    const computerId = `bench-computer-${suffix}`;
    const startComputer = performance.now();
    store.registerComputer({ computerId, projectId, providerId: 'mock' });
    computerWrites.push(performance.now() - startComputer);

    const startLease = performance.now();
    const lease = store.reserveLease({ leaseId: `bench-lease-${suffix}`, subjectId: 'bench-subject', projectId,
      taskId: `bench-task-${suffix}`, runId: `bench-run-${suffix}`, computerId, expiresAt });
    leaseWrites.push(performance.now() - startLease);

    const startOperation = performance.now();
    store.beginOperation({ operationId: `bench-operation-${suffix}`, idempotencyKey: `bench-idempotency-${suffix}`,
      subjectId: lease.subjectId, projectId, taskId: lease.taskId, runId: lease.runId, computerId, providerId: 'mock',
      leaseId: lease.leaseId, expectedGeneration: lease.generation, policyVersion: 1, action: 'inspect' });
    operationWrites.push(performance.now() - startOperation);
  }
  for (let index = 0; index < 25; index++) proposeComputerPlacement({ computers: placementCandidates, requirements: placementRequirements, quota: placementQuota });
  for (let index = 0; index < samples; index++) {
    const startPlacement = performance.now();
    const decision = proposeComputerPlacement({ computers: placementCandidates, requirements: placementRequirements, quota: placementQuota });
    if (decision.status !== 'PROPOSED') throw new Error('benchmark_placement_failed');
    placementTimes.push(performance.now() - startPlacement);
  }

  console.log(JSON.stringify({
    driver: 'node:sqlite', node: process.version, platform: `${process.platform}-${process.arch}`,
    samples, journalMode: store.diagnostics().journalMode, synchronous: store.diagnostics().synchronous,
    records: { computers: samples, leases: samples, operations: samples, events: samples * 3 },
    transactionLatency: { registerComputer: summarize(computerWrites), reserveLease: summarize(leaseWrites), beginOperation: summarize(operationWrites) },
    scheduler: { candidates: placementCandidates.length, proposalLatency: summarize(placementTimes) },
    scope: 'synthetic local store transactions and in-memory placement proposals only; excludes startup ACL checks, provider work, OS scheduling, and remote I/O',
  }));
} finally {
  store?.close();
  await rm(root, { recursive: true, force: true });
}
