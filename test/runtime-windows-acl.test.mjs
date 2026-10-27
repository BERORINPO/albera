import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { openRuntimeAuditJournal } from '../src/runtime/audit-journal.mjs';
import { loadOrCreateRuntimeSessionId } from '../src/runtime/session-identity.mjs';
import { assertPrivateWindowsAcl, inspectWindowsAcl, RuntimeStorageAclError } from '../src/runtime/windows-acl.mjs';

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

test('Windows ACL query reads a real system DACL', { skip: process.platform !== 'win32' }, async () => {
  const acl = await inspectWindowsAcl(os.homedir());
  assert.match(acl.owner, /^S-\d-/);
  assert.match(acl.currentUser, /^S-\d-/);
  assert.equal(acl.daclPresent, true);
  assert.ok(Array.isArray(acl.rules));
  await assertPrivateWindowsAcl(os.homedir(), { kind: 'directory', inspect: async () => acl });
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
