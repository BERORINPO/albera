import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { computeActionDigest } from '../src/runtime/broker-contract/action-digest.mjs';
import { getUnavailableReason, runUnitHarness } from './helpers/approval-authority-harness.mjs';

// Unit checks of the Approval Authority core, run in-process by test/approval-authority-harness (the real source files plus the test fakes, by
// source include): pending store (max 32 / TTL 120 s / queue_full / dedupe), digest recomputation, expiry, receipts that validate with the contract
// and the signer key, presence verification (real RSA-2048 PKCS#1 v1.5 and the fake), protocol framing and verbs per pipe, config rejections, the CNG
// signer's refusal to invent a machine key, the signing key guard (synthetic descriptors + real per-user software keys), and the tier policy (careful default, the standard tier,
// overrides, the Hello-signed policy change by effect, the policy file). Windows-only; skipped without the .NET 10 SDK.
const EXPECTED_AT_LEAST = 80;

test('Approval Authority unit checks (pending store, digest, expiry, queue_full, presence, receipts, protocol, config)', { skip: getUnavailableReason(), timeout: 420_000 }, async (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'albera-authority-unit-'));
  try {
    const result = runUnitHarness(work);
    assert.ok(result.checks.length >= EXPECTED_AT_LEAST, `the harness ran ${result.checks.length} checks, expected at least ${EXPECTED_AT_LEAST}`);
    assert.equal(new Set(result.checks.map((c) => c.name)).size, result.checks.length, 'check names are unique');
    for (const check of result.checks) {
      await t.test(check.name, () => assert.equal(check.ok, true, check.detail));
    }
    await t.test('the digest the Authority computes equals the Node contract digest for the same DTO', () => {
      assert.ok(result.digestProbes.length >= 3);
      for (const probe of result.digestProbes) {
        assert.equal(probe.digest, computeActionDigest(probe.purpose, JSON.parse(probe.dtoJson)), probe.dtoJson);
      }
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
