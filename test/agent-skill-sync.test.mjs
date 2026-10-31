import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The albera-goal skill is read by Codex from .agents/skills and by Claude Code from .claude/skills. Both copies must stay identical so the
// two agents follow the same stops and limits, and every repository path the skill names must exist, so a renamed ledger cannot leave the
// skill pointing at a stale file.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readSkill = (dir) => readFileSync(path.join(root, dir, 'albera-goal', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

test('albera-goal skill copies for Codex and Claude Code are identical', () => {
  assert.equal(readSkill('.claude/skills'), readSkill('.agents/skills'));
});

test('every repository path named in the albera-goal skill exists', () => {
  const named = [...readSkill('.agents/skills').matchAll(/`((?:docs|spec|test|scripts|src)\/[^`\s]+)`/g)].map((m) => m[1]);
  assert.ok(named.length >= 6, `expected the skill to name at least 6 repository paths, found ${named.length}`);
  for (const rel of named) assert.ok(existsSync(path.join(root, rel)), `${rel} is named in the skill but does not exist`);
});
