import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveDemoSources } from '../src/entry/demo.mjs';

test('demo provider records visibly cover active, complete, interrupted, failed, and unknown lifecycle states', async () => {
  const { sessions } = await liveDemoSources('en', () => 1_800_000_000_000).sessionsSource.load();
  const codex = sessions.filter((session) => session.source === 'codex');
  assert.deepEqual(codex.map((session) => session.lifecycle.status).sort(), ['active', 'complete', 'failed', 'interrupted', 'unsupported']);
  assert.deepEqual(codex.map((session) => session.events.map((event) => event.type)), [
    ['turn_started'],
    ['turn_started', 'turn_completed'],
    ['turn_started', 'turn_aborted'],
    ['turn_started', 'turn_failed'],
    [],
  ]);
  assert.ok(codex.every((session) => session.title.includes('demo')));
});
