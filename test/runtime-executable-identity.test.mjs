import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureExecutableIdentity, sameExecutableIdentity } from '../src/runtime/executable-identity.mjs';

test('executable identity includes a streaming SHA-256 digest of the opened file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-executable-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'provider.bin');
  const contents = Buffer.from('synthetic executable identity fixture\n');
  await writeFile(file, contents);

  const identity = await captureExecutableIdentity(file);
  assert.equal(identity.sha256, createHash('sha256').update(contents).digest('hex'));
  assert.equal(sameExecutableIdentity(identity, await captureExecutableIdentity(file)), true);
});

test('executable identity detects same-size in-place content replacement after mtime restoration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-executable-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'provider.bin');
  await writeFile(file, Buffer.from('approved-content'));
  const before = await captureExecutableIdentity(file);
  const handle = await open(file, 'r+');
  try {
    await handle.write(Buffer.from('changed--content'), 0, 16, 0);
    await handle.sync();
  } finally { await handle.close(); }
  const time = new Date('2026-01-01T00:00:00.000Z');
  await utimes(file, time, time);

  const after = await captureExecutableIdentity(file);
  assert.equal(before.size, after.size);
  assert.equal(before.sha256 === after.sha256, false);
  assert.equal(sameExecutableIdentity(before, after), false);
});
