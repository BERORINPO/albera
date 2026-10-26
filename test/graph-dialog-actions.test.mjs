import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmBlockedOperationRelease } from '../public/graph-dialog-actions.mjs';

const blocked = { id: 'edge-1', operationId: 'op-1', kind: 'delegates', status: 'blocked' };

test('blocked operation release requires a matching eligible record', () => {
  let confirmations = 0;
  let resolutions = 0;
  const run = (edge) => confirmBlockedOperationRelease({
    edge,
    confirm: () => { confirmations += 1; return true; },
    resolve: () => { resolutions += 1; return true; },
  });

  assert.equal(run(undefined), false);
  assert.equal(run({ ...blocked, kind: 'related' }), false);
  assert.equal(run({ ...blocked, status: 'active' }), false);
  assert.equal(run({ ...blocked, operationId: '' }), false);
  assert.equal(confirmations, 0);
  assert.equal(resolutions, 0);
});

test('cancelled review leaves the blocked operation untouched', () => {
  let resolutions = 0;
  const result = confirmBlockedOperationRelease({
    edge: blocked,
    confirm: () => false,
    resolve: () => { resolutions += 1; return true; },
  });

  assert.equal(result, false);
  assert.equal(resolutions, 0);
});

test('failed graph save keeps the dialog open', () => {
  const result = confirmBlockedOperationRelease({ edge: blocked, confirm: () => true, resolve: () => false });
  assert.equal(result, false);
});

test('successful graph save permits the dialog to close', () => {
  let resolved;
  const result = confirmBlockedOperationRelease({
    edge: blocked,
    confirm: () => true,
    resolve: (id, operationId) => { resolved = [id, operationId]; return true; },
  });

  assert.equal(result, true);
  assert.deepEqual(resolved, ['edge-1', 'op-1']);
});
