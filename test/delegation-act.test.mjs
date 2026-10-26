import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { delegationConfirmationDetails } from '../public/delegation-act.mjs';

const sessionId = 'codex_12345678-1234-1234-1234-1234567890ab';

test('delegation confirmation identifies the selected project and opaque session suffix in both languages', () => {
  for (const lang of ['ja', 'en']) {
    const details = delegationConfirmationDetails(makeT(lang), 'demo-app', sessionId, 'Review this synthetic task');
    const text = Object.values(details).join('\n');
    assert.match(details.target, /demo-app/);
    assert.match(details.target, /Codex CLI/);
    assert.match(details.target, /1234567890ab/);
    assert.equal(details.purpose, 'Review this synthetic task');
    assert.match(details.transfer, /localhost/);
    assert.match(details.network, /network|ネットワーク/i);
    assert.match(details.network, /usage|利用量/i);
    assert.match(details.output, /discarded|破棄/);
    assert.match(details.session, /session|セッション/i);
    assert.doesNotMatch(text, /12345678-1234-1234-1234-1234567890ab|\{\w+\}/);
  }
});

test('delegation execution uses an explicit in-app form and has no native confirmation call', () => {
  const act = fs.readFileSync(new URL('../public/delegation-act.mjs', import.meta.url), 'utf8');
  const dialog = fs.readFileSync(new URL('../public/delegation-confirm-dialog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(act, /window\.confirm/);
  assert.match(act, /executeConfirmedDelegation\(edgeId, sourceId, targetId, purpose/);
  assert.match(dialog, /type: 'button'.*data-delegation-cancel/);
  assert.match(dialog, /type: 'submit'.*graph\.delegationConfirmRun/);
  assert.match(dialog, /cancel\.addEventListener\('click', \(\) => dialog\.close\(\)\)/);
  assert.match(dialog, /dialog\.close\(\);\s*onConfirm\(\)/);
});
