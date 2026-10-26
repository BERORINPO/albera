import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEventRows } from '../public/events.mjs';

test('event detail projection keeps only supported event codes and safe integer timestamps', () => {
  const rows = safeEventRows({
    source: 'opencode',
    events: [
      { type: 'turn_started', at: 1000, prompt: 'PRIVATE-PROMPT', env: { TOKEN: 'PRIVATE-ENV' } },
      { type: 'future_secret_event', at: 2000, input: 'PRIVATE-TOOL-INPUT', output: 'PRIVATE-TOOL-OUTPUT' },
      { type: 'turn_completed', at: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'turn_failed', at: 3000 },
    ],
  });
  assert.deepEqual(rows, [
    { type: 'turn_started', at: 1000 },
    { type: 'turn_failed', at: 3000 },
  ]);
  assert.equal(JSON.stringify(rows).includes('PRIVATE-'), false);
});

test('event detail projection is absent for unsupported sources and empty for supported sources with no safe events', () => {
  assert.equal(safeEventRows({ source: 'claude', events: [] }), null);
  assert.deepEqual(safeEventRows({ source: 'opencode', events: [{ type: 'unknown', at: 1000 }] }), []);
  assert.deepEqual(safeEventRows({ source: 'codex' }), null);
});
