import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphSessionLabel } from '../public/graph-session-label.mjs';

const t = (key) => ({
  'graph.session': 'Session',
  'graph.unknownSession': 'Session unavailable',
  'source.claude': 'Claude Code',
  'source.codex': 'Codex CLI',
  'source.copilot': 'GitHub Copilot',
  'source.opencode': 'OpenCode',
}[key] ?? key);

test('graph session labels show only allowlisted provider and opaque ID suffix', () => {
  const cases = [
    ['local_00000000-0000-4000-8000-123456789abc', 'Claude Code'],
    ['codex_00000000-0000-4000-8000-123456789abc', 'Codex CLI'],
    ['copilot_00000000-0000-4000-8000-123456789abc', 'GitHub Copilot'],
    ['opencode_00000000-0000-4000-8000-123456789abc', 'OpenCode'],
  ];
  for (const [id, provider] of cases) {
    const label = graphSessionLabel({ id, title: 'private prompt-derived title' }, t);
    assert.equal(label, `Session: ${provider} (123456789abc)`);
    assert.equal(label.includes(id), false);
    assert.equal(label.includes('private prompt-derived title'), false);
  }
});

test('graph session labels fail closed for unknown or malformed identifiers', () => {
  assert.equal(graphSessionLabel({ id: 'private_123456789abc', title: 'private title' }, t), 'Session unavailable');
  assert.equal(graphSessionLabel({ id: 'codex_not-an-opaque-id', title: 'private title' }, t), 'Session unavailable');
});
