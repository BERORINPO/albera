import assert from 'node:assert/strict';
import test from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { productLimitMessages } from '../public/product-limits.mjs';

test('unavailable product actions explain the unresolved policy in Japanese and English', () => {
  const ja = productLimitMessages(makeT('ja')).join(' ');
  assert.match(ja, /Claude Codeへの実行委譲は利用できません/);
  assert.match(ja, /音声 Main AI は利用できません/);
  assert.match(ja, /企業向け権限制御は利用できません/);
  assert.match(ja, /ロールと操作ごとの許可規則が未定義/);

  const en = productLimitMessages(makeT('en')).join(' ');
  assert.match(en, /Claude Code execution delegation is unavailable/);
  assert.match(en, /Voice Main AI is unavailable/);
  assert.match(en, /Enterprise authorization is unavailable/);
  assert.match(en, /roles and per-operation allow\/deny rules are undefined/);
});
