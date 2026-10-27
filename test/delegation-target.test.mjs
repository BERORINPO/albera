import test from 'node:test';
import assert from 'node:assert/strict';
import { codexDelegationBlockReason } from '../src/core/session.mjs';

const target = { source: 'codex', cliSessionId: 'opaque', cwd: 'local-only', lifecycle: { status: 'complete' } };

test('only a completed local Codex session is eligible for confirmed delegation', () => {
  assert.equal(codexDelegationBlockReason(target), null);
  assert.equal(codexDelegationBlockReason({ ...target, lifecycle: { status: 'active' } }), 'session_active');
  assert.equal(codexDelegationBlockReason({ ...target, lifecycle: { status: 'interrupted' } }), 'session_interrupted');
  assert.equal(codexDelegationBlockReason({ ...target, lifecycle: { status: 'unknown' } }), 'session_unknown');
  assert.equal(codexDelegationBlockReason({ ...target, executionLocation: 'wsl' }), 'unsupported_location');
  assert.equal(codexDelegationBlockReason({ ...target, source: 'copilot' }), 'invalid_target');
  assert.equal(codexDelegationBlockReason({ ...target, cwd: '' }), 'invalid_target');
});
