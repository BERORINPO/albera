import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { productLimitMessages } from '../public/product-limits.mjs';

test('unavailable product actions explain the unresolved policy in Japanese and English', () => {
  const ja = productLimitMessages(makeT('ja')).join(' ');
  assert.match(ja, /Claude Codeへの実行委譲は利用できません/);
  assert.doesNotMatch(ja, /音声 Main AI は利用できません/);
  assert.match(ja, /企業向け権限制御は利用できません/);
  assert.match(ja, /ロールと操作ごとの許可規則が未定義/);

  const en = productLimitMessages(makeT('en')).join(' ');
  assert.match(en, /Claude Code execution delegation is unavailable/);
  assert.doesNotMatch(en, /Voice Main AI is unavailable/);
  assert.match(en, /Enterprise authorization is unavailable/);
  assert.match(en, /roles and per-operation allow\/deny rules are undefined/);
  assert.match(makeT('ja')('voice.open'), /音声 AI/);
  assert.match(makeT('en')('voice.open'), /Voice AI/);
});

test('voice HTML first paint discloses browser-local recording and separate API billing', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Starting sends microphone audio to OpenAI GPT-Live/);
  assert.match(html, /API charges are separate from ChatGPT/);
  assert.match(html, /saves the transcript and separate microphone\/assistant audio tracks only in this browser/);
  assert.match(html, /standard abuse-monitoring logs for up to 30 days/);
  assert.match(html, /Start conversation/);
  assert.doesNotMatch(html, /Recordings are not stored/);
});
