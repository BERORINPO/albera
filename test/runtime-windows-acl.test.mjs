import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';
import { backupRuntimeJournal, recoverRuntimeJournalTail, restoreRuntimeJournal } from '../src/runtime/journal-backup.mjs';
import { loadOrCreateRuntimeSessionId } from '../src/runtime/session-identity.mjs';
import { openSqliteEnvironmentStore, restoreSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';
import { assertPrivateWindowsAcl, inspectWindowsAcl, inspectWindowsAcls, RuntimeStorageAclError } from '../src/runtime/windows-acl.mjs';

const USER = 'S-1-5-21-1-2-3-1001';
const fileStat = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
const directoryStat = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };
const descriptor = (rules = [], overrides = {}) => ({
  owner: USER,
  currentUser: USER,
  daclPresent: true,
  rules: [{ sid: USER, allow: true, rights: 0x001f01ff }, ...rules],
  ...overrides,
});

function recordAclChecks(checks) {
  return async (target, { kind }) => { checks.push({ target, kind }); };
}

async function verifyRecordedAclChecks(checks) {
  const kinds = new Map();
  for (const { target, kind } of checks) {
    assert.ok(!kinds.has(target) || kinds.get(target) === kind, `inconsistent ACL target kind: ${target}`);
    kinds.set(target, kind);
  }
  assert.ok(kinds.size > 0, 'the Runtime operation must request ACL validation');
  const targets = [];
  for (const target of kinds.keys()) {
    try { await lstat(target); targets.push(target); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  assert.ok(targets.length > 0, 'at least one checked object must still exist');
  const descriptors = await inspectWindowsAcls(targets);
  for (let index = 0; index < targets.length; index++) {
    await assertPrivateWindowsAcl(targets[index], {
      kind: kinds.get(targets[index]),
      inspect: async () => descriptors[index],
    });
  }
}

test('Windows Runtime storage ACL accepts current user with trusted system principals', async () => {
  await assert.doesNotReject(assertPrivateWindowsAcl('C:\\runtime\\audit.jsonl', {
    platform: 'win32',
    statTarget: async () => fileStat,
    inspect: async () => descriptor([
      { sid: 'S-1-5-18', allow: true, rights: 0x001f01ff },
      { sid: 'S-1-5-32-544', allow: true, rights: 0x001f01ff },
    ]),
  }));
});

test('Windows Runtime storage ACL rejects foreign data access, broad ACL edits, deny ACEs, null DACL and missing user control', async () => {
  const cases = [
    descriptor([{ sid: 'S-1-1-0', allow: true, rights: 1 }]),
    descriptor([{ sid: 'S-1-1-0', allow: true, rights: 0x40000 }]),
    descriptor([{ sid: USER, allow: false, rights: 1 }]),
    descriptor([], { daclPresent: false }),
    descriptor([], { rules: [{ sid: 'S-1-5-18', allow: true, rights: 0x001f01ff }] }),
  ];
  for (const acl of cases) await assert.rejects(
    assertPrivateWindowsAcl('C:\\runtime\\audit.jsonl', { platform: 'win32', statTarget: async () => fileStat, inspect: async () => acl }),
    (error) => error instanceof RuntimeStorageAclError && error.code === 'runtime_storage_acl_not_private',
  );
});

test('Windows Runtime storage ACL accepts only non-sensitive traverse and synchronize rights for other principals', async () => {
  await assert.doesNotReject(assertPrivateWindowsAcl('C:\\runtime', {
    kind: 'directory', platform: 'win32', statTarget: async () => directoryStat,
    inspect: async () => descriptor([{ sid: 'S-1-15-3-123', allow: true, rights: 0x00100020 }]),
  }));
  await assert.rejects(assertPrivateWindowsAcl('C:\\runtime', {
    kind: 'directory', platform: 'win32', statTarget: async () => directoryStat,
    inspect: async () => descriptor([{ sid: 'S-1-15-3-123', allow: true, rights: 0x00100021 }]),
  }), (error) => error.code === 'runtime_storage_acl_not_private');
});

test('ACL inspection is a no-op off Windows', async () => {
  await assert.doesNotReject(assertPrivateWindowsAcl('/tmp/audit.jsonl', { platform: 'linux' }));
});

test('Windows ACL query reads a real system DACL', {
  skip: process.platform !== 'win32' || process.env.ALBERA_RUN_WINDOWS_ACL_INTEGRATION !== '1',
}, async () => {
  const acl = await inspectWindowsAcl(os.homedir());
  assert.match(acl.owner, /^S-\d-/);
  assert.match(acl.currentUser, /^S-\d-/);
  assert.equal(acl.daclPresent, true);
  assert.ok(Array.isArray(acl.rules));
  await assertPrivateWindowsAcl(os.homedir(), { kind: 'directory', inspect: async () => acl });

  const root = await mkdtemp(path.join(os.homedir(), 'albera-acl-batch-'));
  try {
    const file = path.join(root, 'created.txt');
    await writeFile(file, 'temporary ACL fixture', { flag: 'wx' });
    const [directoryAcl, fileAcl] = await inspectWindowsAcls([root, file]);
    await assertPrivateWindowsAcl(root, { kind: 'directory', inspect: async () => directoryAcl });
    await assertPrivateWindowsAcl(file, { kind: 'file', inspect: async () => fileAcl });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite operation store and recovery-owner marker pass their private Windows DACL checks', {
  skip: process.platform !== 'win32' || process.env.ALBERA_RUN_WINDOWS_ACL_INTEGRATION !== '1',
}, async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), 'albera-sqlite-acl-'));
  let store;
  t.after(async () => { store?.close(); await rm(root, { recursive: true, force: true }); });
  const databasePath = path.join(root, 'operations.sqlite');
  store = await openSqliteEnvironmentStore(databasePath, { recoverInterruptedRequests: true });
  const computer = store.registerComputer({ computerId: 'acl-computer', projectId: 'acl-project', providerId: 'mock' });
  assert.equal(computer.computerId, 'acl-computer');
  await assertPrivateWindowsAcl(`${databasePath}.recovery-owner`, { kind: 'file' });
});

test('SQLite snapshot backup and restore verify private Windows DACLs on every created file', {
  skip: process.platform !== 'win32' || process.env.ALBERA_RUN_WINDOWS_ACL_INTEGRATION !== '1',
}, async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), 'albera-sqlite-backup-acl-'));
  let store;
  let restored;
  t.after(async () => { restored?.close(); store?.close(); await rm(root, { recursive: true, force: true }); });
  const checks = [];
  const verifyWindowsAcl = recordAclChecks(checks);
  const databasePath = path.join(root, 'operations.sqlite');
  const backupPath = path.join(root, 'operations.backup.sqlite');
  const restoredPath = path.join(root, 'operations.restored.sqlite');
  store = await openSqliteEnvironmentStore(databasePath, { verifyWindowsAcl });
  await store.backupTo(backupPath);
  restored = await restoreSqliteEnvironmentStore(backupPath, restoredPath, { verifyWindowsAcl });
  await verifyRecordedAclChecks(checks);
  assert.ok(checks.some(({ target, kind }) => target === backupPath && kind === 'file'));
  assert.ok(checks.some(({ target, kind }) => target === restoredPath && kind === 'file'));
});

test('journal ACL refusal happens before existing journal content is read or changed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-acl-journal-'));
  const file = path.join(root, 'audit.jsonl');
  const noAcl = async () => {};
  const journal = await openRuntimeAuditJournal(file, { verifyWindowsAcl: noAcl });
  await journal.append({
    sessionId: 'a'.repeat(32), requestId: '12345678-1234-4234-8234-123456789abc',
    action: 'run.start', phase: 'accepted', at: 1,
  });
  await journal.close();
  const before = await readFile(file);
  const verifier = async (target, { kind }) => {
    if (target === file && kind === 'file') throw new RuntimeStorageAclError('runtime_storage_acl_not_private');
  };
  await assert.rejects(openRuntimeAuditJournal(file, { verifyWindowsAcl: verifier }), (error) => error.code === 'runtime_storage_acl_not_private');
  assert.deepEqual(await readFile(file), before);
  await rm(root, { recursive: true, force: true });
});

test('session identity ACL refusal preserves the existing identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-acl-session-'));
  const journalPath = path.join(root, 'audit.jsonl');
  const noAcl = async () => {};
  const first = await loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl: noAcl });
  const identityPath = `${journalPath}.session-id`;
  const before = await readFile(identityPath);
  const verifier = async (target, { kind }) => {
    if (target === identityPath && kind === 'file') throw new RuntimeStorageAclError('runtime_storage_acl_not_private');
  };
  await assert.rejects(loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl: verifier }), (error) => error.code === 'runtime_storage_acl_not_private');
  assert.deepEqual(await readFile(identityPath), before);
  assert.match(first, /^[0-9a-f]{32}$/);
  await rm(root, { recursive: true, force: true });
});

test('manual journal backup and restored files pass the real Windows DACL guard', {
  skip: process.platform !== 'win32' || process.env.ALBERA_RUN_WINDOWS_ACL_INTEGRATION !== '1',
}, async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), 'albera-backup-acl-'));
  const journalPath = path.join(root, 'runtime.audit.jsonl');
  const backupPath = path.join(root, 'runtime.backup.albera');
  const destinationDirectory = path.join(root, 'restored');
  t.after(() => rm(root, { recursive: true, force: true }));
  const checks = [];
  const verifyWindowsAcl = recordAclChecks(checks);
  const journal = await openRuntimeAuditJournal(journalPath, { verifyWindowsAcl });
  const sessionId = await loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl });
  await journal.append({
    sessionId, requestId: '12345678-1234-4234-8234-123456789abc',
    action: 'run.start', phase: 'requested', at: 1, provider: 'claude',
  });
  await journal.close();
  await backupRuntimeJournal({ journalPath, outputPath: backupPath, passphrase: 'synthetic Windows DACL test phrase', verifyWindowsAcl });
  const restored = await restoreRuntimeJournal({ backupPath, destinationDirectory, passphrase: 'synthetic Windows DACL test phrase', verifyWindowsAcl });
  await verifyRecordedAclChecks(checks);
  assert.ok(checks.some(({ target, kind }) => target === backupPath && kind === 'file'));
  assert.ok(checks.some(({ target, kind }) => target === restored.journalPath && kind === 'file'));
});

test('manual journal tail recovery output passes the real Windows DACL guard', {
  skip: process.platform !== 'win32' || process.env.ALBERA_RUN_WINDOWS_ACL_INTEGRATION !== '1',
}, async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), 'albera-tail-recovery-acl-'));
  const journalPath = path.join(root, 'runtime.audit.jsonl');
  const outputPath = path.join(root, 'runtime.recovered.jsonl');
  t.after(() => rm(root, { recursive: true, force: true }));
  const checks = [];
  const verifyWindowsAcl = recordAclChecks(checks);
  const journal = await openRuntimeAuditJournal(journalPath, { verifyWindowsAcl });
  const sessionId = await loadOrCreateRuntimeSessionId(journalPath, { verifyWindowsAcl });
  await journal.append({
    sessionId, requestId: '12345678-1234-4234-8234-123456789abc',
    action: 'run.start', phase: 'requested', at: 1, provider: 'claude',
  });
  await journal.close();
  await appendFile(journalPath, '{"incomplete":true');
  const recovered = await recoverRuntimeJournalTail({ journalPath, outputPath, verifyWindowsAcl });
  assert.equal(recovered.sessionId, sessionId);
  await verifyRecordedAclChecks(checks);
  assert.ok(checks.some(({ target, kind }) => target === outputPath && kind === 'file'));
  assert.ok(checks.some(({ target, kind }) => target === `${outputPath}.session-id` && kind === 'file'));
});
