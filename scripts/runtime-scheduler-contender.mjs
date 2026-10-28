// Test helper for the cross-process SQLite quota race. It is not a product command.
import { createInterface } from 'node:readline';
import { openSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';
import { reserveComputerForRun } from '../src/runtime/computer-scheduler.mjs';

const [databasePath, workerId] = process.argv.slice(2);
const projectId = 'race-project';
const requirements = {
  projectId, kind: 'ephemeral', os: 'linux', architecture: 'x64',
  imageDigest: `sha256:${'c'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 16 },
};
const quota = { maxComputers: 1, vcpu: 4, memoryMiB: 4096, diskGiB: 32 };
const store = await openSqliteEnvironmentStore(databasePath, { verifyWindowsAcl: async () => {} });
const input = createInterface({ input: process.stdin });
const go = new Promise((resolve) => input.once('line', resolve));
process.stdout.write('READY\n');
await go;
try {
  const result = reserveComputerForRun({
    store,
    lease: {
      leaseId: `race-lease-${workerId}`, subjectId: `race-subject-${workerId}`,
      taskId: `race-task-${workerId}`, runId: `race-run-${workerId}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    requirements, quota,
  });
  process.stdout.write(`RESULT ${JSON.stringify({ status: result.status, computerId: result.computerId ?? null, leaseId: result.lease?.leaseId ?? null })}\n`);
} catch (error) {
  process.stdout.write(`RESULT ${JSON.stringify({ errorCode: error?.code ?? 'unknown' })}\n`);
} finally {
  input.close();
  store.close();
}
