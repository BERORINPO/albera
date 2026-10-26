import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWslPathInShare, wslCwdToUnc, wslShareRoot } from '../src/adapters/wsl-paths.mjs';

test('WSL share root accepts only a configured WSL distro share', () => {
  assert.equal(wslShareRoot('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex'), '\\\\wsl.localhost\\Ubuntu');
  assert.equal(wslShareRoot('\\\\wsl$\\Ubuntu'), '\\\\wsl$\\Ubuntu');
  assert.equal(wslShareRoot('\\\\server\\share\\.codex'), '');
  assert.equal(wslShareRoot('/home/dev/.codex'), '');
});

test('folder hints can opt into only the exact configured WSL distro share', () => {
  const root = '\\\\wsl.localhost\\Ubuntu';
  assert.equal(isWslPathInShare(`${root}\\home\\dev\\repo`, root), true);
  assert.equal(isWslPathInShare('\\\\wsl.localhost\\Other\\home\\repo', root), false);
  assert.equal(isWslPathInShare('\\\\server\\share\\repo', root), false);
  assert.equal(isWslPathInShare(root, root), false);
});

test('WSL cwd mapping rejects traversal, host paths, and control characters', () => {
  const root = '\\\\wsl.localhost\\Ubuntu';
  assert.equal(wslCwdToUnc('/home/dev/project', root), `${root}\\home\\dev\\project`);
  for (const cwd of ['/../../outside', '/home/../outside', 'C:\\private', '//server/share', '/home/secret\u0000']) {
    assert.equal(wslCwdToUnc(cwd, root), null, cwd);
  }
  assert.equal(wslCwdToUnc('/home/dev/project', '\\\\server\\share'), null);
});
