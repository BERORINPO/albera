import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALBERA_VERSION } from '../src/runtime/albera-version.mjs';
import { isVersion } from '../src/runtime/feedback-contract.mjs';

test('the runtime version is the package version and a version the feedback contract accepts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(ALBERA_VERSION, pkg.version);
  assert.ok(isVersion(ALBERA_VERSION));
});
