import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getUnavailableReason, makeLeaseKit, runBridgeHarness } from './helpers/wsl-bridge-harness.mjs';

// The WSL bridge (ADR-012, "The WSL bridge"), checked in-process by test/wsl-bridge-harness: the real bridge sources with a fake wsl.exe, a fake agent and a fake repository.
// G1 for the bridge (a missing, expired, reused, wrong-target lease and a bundle whose head is not baseOid, one check each), the order of begin, the call count and the lease's end, the sizes, hostile
// agents, stop, the ledger across restarts, and only `albera-run-` names reaching wsl. Windows-only; skipped without the .NET 10 SDK. Nothing here starts wsl.exe: the real machine is scripts/wsl2-bridge-gates.mjs.
const EXPECTED_AT_LEAST = 84;
const REQUIRED = [
  'g1 no lease', 'g1 expired lease', 'g1 reused lease', 'g1 wrong computer', 'g1 wrong repository', 'g1 wrong operation', 'g1 old generation', 'g1 wrong signer', 'g1 head is not baseOid', 'g1 bundle head is not baseOid',
  'pipe: stop still arrives after 8 clients connected', 'pipe: stop still arrives after 8 clients read', 'revocation: the floor is read at every begin', 'revocation: a run below a raised floor',
];

test('WSL bridge checks (G1, begin order, calls, lease end, sizes, hostile agent, ledger, names, config, pipe)', { skip: getUnavailableReason(), timeout: 480_000 }, async (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'albera-wsl-bridge-unit-'));
  try {
    // A lease from the Node twin, signed with a Node key: the harness must accept it through begin (the two twins agree on the bytes, not only on the vectors).
    const kit = makeLeaseKit('broker-node');
    const now = Math.floor(Date.now() / 1000);
    const lease = await kit.lease({ operationId: 'op-node', computerId: 'pc-wsl', repositoryId: 'repo-alpha', baseOid: 'a'.repeat(40), issuedAt: now - 10 });
    const probe = path.join(work, 'probe.json');
    writeFileSync(probe, JSON.stringify({ spki: kit.spki, keyId: kit.keyId, now, lease }));
    const result = runBridgeHarness(work, probe);
    assert.ok(result.checks.length >= EXPECTED_AT_LEAST, `the harness ran ${result.checks.length} checks, expected at least ${EXPECTED_AT_LEAST}`);
    assert.equal(new Set(result.checks.map((c) => c.name)).size, result.checks.length, 'check names are unique');
    for (const prefix of REQUIRED) assert.ok(result.checks.some((c) => c.name.startsWith(prefix)), `the check "${prefix}" is missing`);
    assert.ok(result.checks.some((c) => c.name.startsWith('interop:')), 'the Node-signed lease check ran');
    for (const check of result.checks) await t.test(check.name, () => assert.equal(check.ok, true, check.detail));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
