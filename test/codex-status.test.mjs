import assert from 'node:assert/strict';
import test from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { codexStatusMessages, copilotStatusMessages } from '../public/codex-status.mjs';

const base = {
  files: 0, detected: 0, working: 0, trouble: 0, recent: 0,
  active: 0, completed: 0, interrupted: 0, unknown: 0, rejected: 0,
};

test('Codex status explains each zero-count cause and uses only safe numeric values', () => {
  const t = makeT('ja');
  assert.match(codexStatusMessages(t, base)[1], /rolloutファイルが見つかりません/);
  assert.match(codexStatusMessages(t, { ...base, files: 4, rejected: 4 })[1], /形式条件に合うセッションはありません/);
  assert.match(codexStatusMessages(t, { ...base, files: 4, detected: 2, recent: 2, completed: 1, interrupted: 1 })[1], /作業中0件/);

  const messages = codexStatusMessages(t, {
    ...base, files: 'C:\\secret\\prompt', detected: -1, working: NaN, rejected: Infinity,
    privatePath: 'C:\\secret\\prompt', toolOutput: 'SECRET_VALUE',
  });
  assert.equal(messages.length, 2);
  assert.ok(messages.join(' ').includes('候補 0 件'));
  assert.ok(!messages.join(' ').includes('secret'));
  assert.ok(!messages.join(' ').includes('SECRET_VALUE'));
});

test('Copilot diagnostics distinguish no candidates, rejected formats, and no working session', () => {
  const t = makeT('ja');
  assert.match(copilotStatusMessages(t, base)[1], /events.jsonlが見つかりません/);
  assert.match(copilotStatusMessages(t, { ...base, files: 2, rejected: 2 })[1], /識別情報が形式条件に合いません/);
  assert.match(copilotStatusMessages(t, { ...base, files: 2, detected: 1, completed: 1 })[1], /作業中0件/);
});
