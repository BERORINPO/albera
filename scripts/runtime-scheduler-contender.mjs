// Test helper for cross-process SQLite quota and Guest receipt races. It is not a product command.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFileSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';
import { reserveComputerForRun } from '../src/runtime/computer-scheduler.mjs';

const [databasePath, workerId, mode = 'scheduler', operationId, expectedGeneration, actionDigest, providerStatePath] = process.argv.slice(2);
const projectId = 'race-project';
const requirements = {
  projectId, kind: 'ephemeral', os: 'linux', architecture: 'x64',
  imageDigest: `sha256:${'c'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 16 },
};
const quota = { maxComputers: 1, vcpu: 4, memoryMiB: 4096, diskGiB: 32 };
class ExitBeforeCommitDatabase {
  #database;

  constructor(databasePath) { this.#database = new DatabaseSync(databasePath); }
  prepare(sql) { return this.#database.prepare(sql); }
  exec(sql) {
    if (sql.trim().toUpperCase() === 'COMMIT') {
      writeSync(1, 'RESULT {"status":"EXIT_BEFORE_COMMIT"}\n');
      process.exit(26);
    }
    return this.#database.exec(sql);
  }
  close() { this.#database.close(); }
}

const store = await openSqliteEnvironmentStore(databasePath, {
  verifyWindowsAcl: async () => {},
  recoverInterruptedRequests: false,
  ...(mode === 'crash-before-dispatch-commit' ? { DatabaseImpl: ExitBeforeCommitDatabase } : {}),
  ...(['guest-event', 'begin-operation', 'idempotency-same', 'idempotency-conflict', 'release-lease', 'crash-after-begin'].includes(mode)
    ? { now: () => '2026-10-28T00:30:00.000Z' }
    : ['broker-dispatch', 'crash-after-dispatch', 'crash-after-provider-effect', 'crash-before-dispatch-commit'].includes(mode)
      ? { now: () => '2026-10-28T00:00:30.000Z' } : {}),
});
const startOperation = (workerId) => ({
  operationId: `race-operation-${workerId}`, idempotencyKey: `race-idempotency-${workerId}`,
  subjectId: 'human-a', projectId: 'project-a', taskId: 'task-a', runId: 'run-a',
  computerId: 'computer-a', providerId: 'mock', leaseId: 'lease-a', expectedGeneration: 1,
  policyVersion: 1, action: 'start',
});
const sharedIdempotencyOperation = (action = 'start') => ({
  ...startOperation(1), operationId: 'race-operation-shared-idempotency',
  idempotencyKey: 'race-idempotency-shared', action,
});
const input = createInterface({ input: process.stdin });
const go = new Promise((resolve) => input.once('line', resolve));
process.stdout.write('READY\n');
await go;
try {
  if (mode === 'guest-event') {
    const result = store.recordGuestEvent({
      protocolVersion: 1, type: 'guest.event', messageId: '99999999-9999-4999-8999-999999999999',
      computerId: 'computer-a', runId: 'run-a', generation: 1, sequence: 1,
      occurredAt: '2026-10-28T00:00:00.000Z', eventType: 'heartbeat', agentVersion: '0.1.0',
    });
    process.stdout.write(`RESULT ${JSON.stringify({ status: result.status, sequence: result.sequence })}\n`);
  } else if (mode === 'broker-dispatch') {
    const operation = store.resolveBrokerDispatch({
      protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
      operationId, expectedGeneration: Number(expectedGeneration), actionDigest: `sha256:${actionDigest}`,
    });
    process.stdout.write(`RESULT ${JSON.stringify({ status: 'CLAIMED', operationId: operation.operationId })}\n`);
  } else if (mode === 'crash-after-begin') {
    const result = store.beginOperation(startOperation(workerId));
    writeSync(1, `RESULT ${JSON.stringify({ status: result.operation.status, operationId: result.operation.operationId })}\n`);
    process.exit(23);
  } else if (mode === 'crash-after-dispatch') {
    const operation = store.resolveBrokerDispatch({
      protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
      operationId, expectedGeneration: Number(expectedGeneration), actionDigest: `sha256:${actionDigest}`,
    });
    writeSync(1, `RESULT ${JSON.stringify({ status: 'CLAIMED', operationId: operation.operationId })}\n`);
    process.exit(24);
  } else if (mode === 'crash-before-dispatch-commit') {
    store.resolveBrokerDispatch({
      protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
      operationId, expectedGeneration: Number(expectedGeneration), actionDigest: `sha256:${actionDigest}`,
    });
    throw new Error('fault_injection_commit_not_intercepted');
  } else if (mode === 'crash-after-provider-effect') {
    if (typeof providerStatePath !== 'string' || !providerStatePath) throw new Error('provider_state_path_invalid');
    const operation = store.resolveBrokerDispatch({
      protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
      operationId, expectedGeneration: Number(expectedGeneration), actionDigest: `sha256:${actionDigest}`,
    });
    // Simulate an irreversible external Provider effect, persist its observation,
    // then terminate before any outcome can be written back to the operation journal.
    writeFileSync(providerStatePath, JSON.stringify({ state: 'off', generation: operation.expectedGeneration }), { flag: 'wx', mode: 0o600 });
    writeSync(1, `RESULT ${JSON.stringify({ status: 'SIDE_EFFECT', operationId: operation.operationId })}\n`);
    process.exit(25);
  } else if (mode === 'flow-advance') {
    // Every contender holds the revision-0 record of the same operation (`operationId` argument); the journal's compare-and-set lets exactly one of them move it.
    const record = store.flowJournal().advance(operationId, 0, ['INTENT'], { phase: 'FENCED', winner: Number(workerId) });
    process.stdout.write(`RESULT ${JSON.stringify({ status: 'WON', winner: record.winner, revision: record.revision })}
`);
  } else if (mode === 'begin-operation') {
    const result = store.beginOperation(startOperation(workerId));
    process.stdout.write(`RESULT ${JSON.stringify({ status: result.created ? 'CREATED' : 'REPLAYED', operationId: result.operation.operationId })}\n`);
  } else if (mode === 'idempotency-same' || mode === 'idempotency-conflict') {
    const action = mode === 'idempotency-conflict' && workerId % 2 === 0 ? 'stop' : 'start';
    const result = store.beginOperation(sharedIdempotencyOperation(action));
    process.stdout.write(`RESULT ${JSON.stringify({ status: result.created ? 'CREATED' : 'REPLAYED', operationId: result.operation.operationId, action: result.operation.action })}\n`);
  } else if (mode === 'release-lease') {
    const lease = store.releaseLease('lease-a', {
      computerId: 'computer-a', providerId: 'mock', state: 'off', generation: 1,
      observedAt: '2026-10-28T00:30:00.000Z',
    });
    process.stdout.write(`RESULT ${JSON.stringify({ status: lease.state })}\n`);
  } else if (mode === 'scheduler') {
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
  } else {
    throw new Error('worker_mode_invalid');
  }
} catch (error) {
  process.stdout.write(`RESULT ${JSON.stringify({ errorCode: error?.code ?? 'unknown' })}\n`);
} finally {
  input.close();
  store.close();
}
