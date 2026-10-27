import assert from 'node:assert/strict';
import test from 'node:test';
import { delegationAvailability } from '../public/delegation-availability.mjs';
import { EN_CANVAS } from '../public/dict-en-canvas.mjs';
import { JA_CANVAS } from '../public/dict-ja-canvas.mjs';
import { delegationUnavailableNote } from '../public/delegation-note.mjs';
import fs from 'node:fs';

const base = {
  kind: 'delegates', direction: 'out', endpoint: 'session',
  sessionId: 'codex_00000000-0000-4000-8000-000000000002',
  status: 'planned', purpose: 'Review this synthetic change',
};
const target = { executionLocation: 'local', completedLocalCodex: true };
const decide = (overrides = {}, env = {}) => delegationAvailability({
  entry: { ...base, ...overrides }, demo: false, target, hasOperationId: false, ...env,
});

test('planned Codex delegation runs only when purpose and completed local target are present', () => {
  assert.deepEqual(decide(), { action: 'run', reason: null });
  assert.deepEqual(decide({ purpose: '' }), { action: null, reason: 'graph.delegationUnavailablePurpose' });
  assert.deepEqual(decide({}, { target: { executionLocation: 'local', completedLocalCodex: false } }), {
    action: null, reason: 'graph.delegationUnavailable',
  });
  assert.deepEqual(decide({}, { target: { executionLocation: 'wsl', completedLocalCodex: false } }), {
    action: null, reason: 'graph.delegationUnavailableWsl',
  });
});

test('unsupported targets and demo mode explain why a recorded delegation cannot run', () => {
  assert.deepEqual(decide({ sessionId: 'local_00000000-0000-4000-8000-000000000003' }), {
    action: null, reason: 'graph.delegationUnavailableProvider',
  });
  assert.deepEqual(decide({ endpoint: 'graph' }), { action: null, reason: 'graph.delegationUnavailableTargetType' });
  assert.deepEqual(decide({}, { demo: true }), { action: null, reason: 'graph.delegationUnavailableDemo' });
});

test('active operation can be checked without requiring a completed target; malformed active state is explained', () => {
  assert.deepEqual(decide({ status: 'active' }, { target: undefined, hasOperationId: true }), { action: 'check', reason: null });
  assert.deepEqual(decide({ status: 'active' }), { action: null, reason: 'graph.delegationUnavailableOperation' });
});

test('inbound and terminal delegation records do not expose execution actions', () => {
  assert.deepEqual(decide({ direction: 'in' }), { action: null, reason: null });
  assert.deepEqual(decide({ status: 'completed' }), { action: null, reason: null });
  assert.deepEqual(decide({ status: 'unknown' }), { action: null, reason: 'graph.delegationUnavailableUnknown' });
});

test('availability output contains no target IDs or session metadata', () => {
  const result = decide({ sessionId: 'codex_sensitive-synthetic-id' }, { target: { executionLocation: 'local', completedLocalCodex: false } });
  assert.deepEqual(result, { action: null, reason: 'graph.delegationUnavailable' });
  assert.doesNotMatch(JSON.stringify(result), /codex_|sensitive-synthetic-id/);
});

test('every unavailable delegation reason is localized and rendered as an explanatory detail note', () => {
  const reasons = [
    'graph.delegationUnavailableUnknown', 'graph.delegationUnavailableDemo',
    'graph.delegationUnavailableTargetType', 'graph.delegationUnavailableProvider',
    'graph.delegationUnavailableOperation', 'graph.delegationUnavailablePurpose',
    'graph.delegationUnavailableWsl', 'graph.delegationUnavailable',
  ];
  for (const dictionary of [JA_CANVAS, EN_CANVAS]) {
    for (const key of reasons) {
      assert.equal(typeof dictionary[key], 'string', `${key} is localized`);
      assert.ok(dictionary[key].length > 12, `${key} has an explanatory message`);
    }
  }
  const detail = fs.readFileSync(new URL('../public/canvas-bar.mjs', import.meta.url), 'utf8');
  assert.match(detail, /delegationUnavailableNote\(t, delegation\.reason\)/);
  const previousDocument = globalThis.document;
  class ElementFixture {
    tagName; className = ''; textContent = '';
    setAttribute() {}
    constructor(tagName) { this.tagName = tagName; }
    append() {}
  }
  globalThis.document = {
    createElement: (tag) => new ElementFixture(tag),
    createTextNode: (text) => ({ textContent: text }),
  };
  try {
    for (const [dictionary, language] of [[JA_CANVAS, 'Japanese'], [EN_CANVAS, 'English']]) {
      for (const key of reasons) {
        const note = delegationUnavailableNote((value) => dictionary[value] ?? value, key);
        assert.equal(note?.tagName, 'small', `${language} ${key} renders an explanatory note`);
        assert.equal(note?.className, 'graph-dialog__hint');
        assert.equal(note?.textContent, dictionary[key]);
      }
    }
    assert.equal(delegationUnavailableNote((key) => key, null), null);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
