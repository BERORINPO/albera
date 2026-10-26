import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { delegationConfirmationText } from '../public/delegation-act.mjs';

const sessionId = 'codex_12345678-1234-1234-1234-1234567890ab';

test('delegation confirmation identifies the selected project and opaque session suffix in both languages', () => {
  for (const lang of ['ja', 'en']) {
    const text = delegationConfirmationText(makeT(lang), 'demo-app', sessionId, 'Review this synthetic task');
    assert.match(text, /demo-app/);
    assert.match(text, /Codex CLI/);
    assert.match(text, /1234567890ab/);
    assert.match(text, /Review this synthetic task/);
    assert.match(text, /localhost/);
    assert.match(text, /network|ネットワーク/i);
    assert.match(text, /usage|利用量/i);
    assert.match(text, /discarded|破棄/);
    assert.doesNotMatch(text, /12345678-1234-1234-1234-1234567890ab|\{\w+\}/);
  }
});
