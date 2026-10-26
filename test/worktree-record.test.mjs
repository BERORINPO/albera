import assert from 'node:assert/strict';
import test from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { worktreeRecordBody } from '../public/worktree-record.mjs';

test('canvas worktree records name the safe project label alongside branch and working state', () => {
  const body = worktreeRecordBody(makeT('ja'), 'pigeonholes', 'main', { status: 'changed', changed: 2, untracked: 1, conflicted: 0 });
  assert.match(body, /対象 pigeonholes/);
  assert.match(body, /基点 main/);
  assert.match(body, /変更 2 件、未追跡 1 件、競合 0 件/);
  assert.doesNotMatch(body, /[A-Z]:\\|\\\\|\//, 'record uses the project label and contains no repository path');
});

test('canvas worktree records use the local no-project label when unavailable', () => {
  const body = worktreeRecordBody(makeT('ja'), null, 'main', { status: 'clean', changed: 0, untracked: 0, conflicted: 0 });
  assert.match(body, /対象 フォルダなし/);
});

test('canvas worktree records reject path-like project values', () => {
  const body = worktreeRecordBody(makeT('ja'), 'C:\\private\\repo', 'main', { status: 'clean', changed: 0, untracked: 0, conflicted: 0 });
  assert.match(body, /対象 フォルダなし/);
  assert.doesNotMatch(body, /private|C:\\|\\repo/);
});
