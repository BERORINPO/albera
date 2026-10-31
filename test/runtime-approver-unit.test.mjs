import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getUnavailableReason, runApproverUnitHarness } from './helpers/approver-harness.mjs';

// Unit checks of the approver app, run in-process by test/approver-harness (the real source files plus the test fake, by source include): safe rendering (control,
// bidi, non-ASCII, look-alike characters), every digest input shown, the digest recomputed with the contract and a mismatch refused before anything is signed or
// sent, the exact presence message bytes, the approve / deny / presence_unavailable flows against a canned channel, exit codes, and the fixed command grammar.
// Windows-only; skipped without the .NET 10 SDK.
const EXPECTED_AT_LEAST = 58;

test('Approver unit checks (rendering, digest recompute and refusal, presence message bytes, command flows)', { skip: getUnavailableReason(), timeout: 420_000 }, async (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'albera-approver-unit-'));
  try {
    const result = runApproverUnitHarness(work);
    assert.ok(result.checks.length >= EXPECTED_AT_LEAST, `the harness ran ${result.checks.length} checks, expected at least ${EXPECTED_AT_LEAST}`);
    assert.equal(new Set(result.checks.map((c) => c.name)).size, result.checks.length, 'check names are unique');
    for (const check of result.checks) {
      await t.test(check.name, () => assert.equal(check.ok, true, check.detail));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
