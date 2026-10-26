import assert from 'node:assert/strict';
import test from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { codexStatusMessages, copilotStatusMessages, openCodeStatusMessages } from '../public/codex-status.mjs';

const base = {
  files: 0, detected: 0, working: 0, trouble: 0, recent: 0,
  active: 0, completed: 0, interrupted: 0, unknown: 0, rejected: 0,
};

test('Codex status explains each zero-count cause and uses only safe numeric values', () => {
  const t = makeT('ja');
  assert.match(codexStatusMessages(t, base)[1], /rolloutファイルが見つかりません/);
  const unmatched = codexStatusMessages(t, { ...base, files: 4, rejected: 4 })[1];
  assert.match(unmatched, /形式条件に合うセッションはありません/);
  assert.match(unmatched, /保存先がCLI用か確認/);
  assert.match(unmatched, /形式が変わっていれば対応後に再読み込み/);
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

test('Codex WSL guidance uses only the explicit share configuration category', () => {
  const t = makeT('ja');
  const notConfigured = codexStatusMessages(t, { ...base, wslShareStatus: 'not_configured' });
  assert.match(notConfigured.join(' '), /WSLのCodex保存先は未接続です/);
  assert.match(notConfigured.join(' '), /WSLコマンドは実行しません/);
  const configured = codexStatusMessages(t, { ...base, wslShareStatus: 'configured' });
  assert.equal(configured.some((message) => /WSLのCodex保存先/.test(message)), false);
  const untrusted = codexStatusMessages(t, { ...base, wslShareStatus: 'C:\\private\\distro' });
  assert.equal(untrusted.some((message) => message.includes('private')), false);
});

test('Copilot diagnostics distinguish no candidates, rejected formats, and no working session', () => {
  const t = makeT('ja');
  assert.match(copilotStatusMessages(t, base)[1], /events.jsonlが見つかりません/);
  assert.match(copilotStatusMessages(t, { ...base, files: 2, rejected: 2 })[1], /識別情報が形式条件に合いません/);
  assert.match(copilotStatusMessages(t, { ...base, files: 2, detected: 1, completed: 1 })[1], /作業中0件/);
});

test('OpenCode diagnostics explain database, schema, runtime, and lifecycle zero states without rendering arbitrary values', () => {
  const t = makeT('ja');
  assert.match(openCodeStatusMessages(t, base)[1], /DBが見つかりません/);
  assert.match(openCodeStatusMessages(t, { ...base, files: 1, detected: 0 })[1], /session_v2形式がありません/);
  assert.match(openCodeStatusMessages(t, { ...base, files: 1, unsupportedRuntime: true })[1], /Node.js 22系は22.18以降、または24.4以降/);
  assert.match(openCodeStatusMessages(t, { ...base, files: 1, detected: 2, failed: 1 })[0], /失敗 1/);
  const safe = openCodeStatusMessages(t, { ...base, unsupportedRuntime: true, path: 'C:\\private\\auth.json', prompt: 'PRIVATE_PROMPT' }).join(' ');
  assert.ok(!safe.includes('private'));
  assert.ok(!safe.includes('PRIVATE_PROMPT'));
});
