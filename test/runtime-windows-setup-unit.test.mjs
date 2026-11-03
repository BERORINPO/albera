import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSetupHarness, getUnavailableReason, ghArgumentsFromSetup, policyOf, runSetupUnitHarness } from './helpers/windows-setup-harness.mjs';

// Unit checks of the setup program (src/runtime/windows-setup), run in-process by test/windows-setup-harness: the real source files compiled as ordinary .NET (the NativeAOT
// bytes can only be made in CI, where the MSVC linker is), with gh.exe and the installer script replaced by a fake process runner. They cover the environment allowlist, the
// attestation policy (repository, workflow, ref, runner, commit, run id), the refusal paths, the tree hash check and the installer's arguments. The one real gh in the last test is
// whatever `gh` is on PATH (not downloaded, not the pinned one); it is only asked whether it accepts the argument list. Windows-only; skipped without the .NET 10 SDK.
const EXPECTED_AT_LEAST = 80;
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'attestations', 'synthetic');
const SAMPLE_SHA256 = '77b9fdd0b54053f8a98058a132567d44b9f73faeeaac2e6bafd62a11992ebb0c';

test('Setup program unit checks (environment allowlist, attestation policy, refusals, tree hash, installer arguments)', { skip: getUnavailableReason(), timeout: 600_000 }, async (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'albera-setup-unit-'));
  try {
    const dll = buildSetupHarness(work);
    const result = runSetupUnitHarness(dll);
    assert.ok(result.checks.length >= EXPECTED_AT_LEAST, `the harness ran ${result.checks.length} checks, expected at least ${EXPECTED_AT_LEAST}`);
    assert.equal(new Set(result.checks.map((c) => c.name)).size, result.checks.length, 'check names are unique');
    for (const check of result.checks) {
      await t.test(check.name, () => assert.equal(check.ok, true, check.detail));
    }

    await t.test('synthetic fixture: the hand-written gh output is accepted and gives its commit and run id', () => {
      const answer = policyOf(dll, path.join(fixtures, 'gh-verify-output.json'), SAMPLE_SHA256);
      assert.deepEqual(answer, { ok: true, facts: [{ Commit: '0123456789abcdef0123456789abcdef01234567', RunId: 1234567 }] });
    });

    await t.test('synthetic fixture: the same output for another file is refused, naming the digest', () => {
      const answer = policyOf(dll, path.join(fixtures, 'gh-verify-output.json'), 'f'.repeat(64));
      assert.equal(answer.ok, false);
      assert.equal(answer.code, 'attestation_policy');
      assert.match(answer.message, /SHA-256/u);
    });

    await t.test('real gh on PATH (any version, offline): setup\'s arguments are accepted and a placeholder bundle is refused', (subtest) => {
      const probe = spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true });
      if (probe.error || probe.status !== 0) return subtest.skip('no gh on PATH');
      const args = ghArgumentsFromSetup(dll, path.join(fixtures, 'sample.bin'), path.join(fixtures, 'bundle.jsonl'), path.join(fixtures, 'trusted_root.jsonl'));
      const config = path.join(work, 'gh-config');
      const run = spawnSync('gh', args, {
        encoding: 'utf8', windowsHide: true, timeout: 60_000,
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GH_CONFIG_DIR: config, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', DO_NOT_TRACK: '1' },
      });
      assert.notEqual(run.status, 0, 'gh accepted a placeholder bundle');
      assert.doesNotMatch(run.stderr, /unknown (?:flag|shorthand flag|command)|invalid argument|accepts \d+ arg/iu, `gh did not understand the arguments: ${run.stderr}`);
      assert.doesNotMatch(run.stdout, /Verification succeeded/u);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
