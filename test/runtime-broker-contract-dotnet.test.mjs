import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// The C# twin (src/runtime/broker-contract/*.cs) is compiled by source include into a throwaway console in a temp dir and must reproduce
// every shared vector: digest, preimage bytes, verdict code and field; the receipt v3 / tier policy vectors (test-vectors-v3.json); and the network attestation vectors
// (network-attestation-vectors.json: canonical digest, and the signature / expiry / binding verdicts of NetworkAttestation.Verify). Skipped without a .NET 10 SDK.
// No Broker or Authority code is involved.
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contractDir = path.join(repositoryRoot, 'src', 'runtime', 'broker-contract');
const harnessProject = path.join(repositoryRoot, 'test', 'receipt-v2-dotnet-harness', 'ReceiptV2Harness.csproj');
const vectorsPath = path.join(contractDir, 'test-vectors.json');
const schemaPath = path.join(contractDir, 'receipt-v2.schema.json');
const vectorsV3Path = path.join(contractDir, 'test-vectors-v3.json');
const schemaV3Path = path.join(contractDir, 'receipt-v3.schema.json');
const attestationVectorsPath = path.join(contractDir, 'network-attestation-vectors.json');
const taskStartVectorsPath = path.join(contractDir, 'task-start-attestation-vectors.json');

function unavailableReason() {
  try {
    const sdks = execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return sdks.split(/\r?\n/u).some((line) => /^10\./u.test(line)) ? false : '.NET 10 SDK unavailable';
  } catch { return 'dotnet unavailable'; }
}

test('C# ActionDigest, ReceiptV2, ReceiptV3, TierPolicy, NetworkAttestation and TaskStartAttestation give the same digests, verdicts and policy hashes as the Node contract for every vector', { skip: unavailableReason(), timeout: 240_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'albera-receipt-v2-'));
  try {
    const output = path.join(root, 'out');
    const intermediate = `${path.join(root, 'obj')}${path.sep}`;
    const run = (args) => execFileSync('dotnet', args, { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    run(['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:ContractDir=${contractDir}${path.sep}`,
      `--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo']);
    const result = JSON.parse(run([path.join(output, 'ReceiptV2Harness.dll'), vectorsPath, schemaPath, vectorsV3Path, schemaV3Path, attestationVectorsPath, taskStartVectorsPath]));
    const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

    assert.deepEqual(result.schemaMismatches, [], 'ReceiptV2.Fields equals receipt-v2.schema.json');
    assert.equal(result.digest.length, vectors.digestVectors.length);
    assert.equal(result.receipt.length, vectors.receiptVectors.length);
    vectors.digestVectors.forEach((vector, i) => {
      const { name, ...actual } = result.digest[i];
      assert.equal(name, vector.name);
      assert.deepEqual(actual, vector.expected, `digest vector ${vector.name}`);
    });
    vectors.receiptVectors.forEach((vector, i) => {
      const { name, ...actual } = result.receipt[i];
      assert.equal(name, vector.name);
      assert.deepEqual(actual, vector.expected, `receipt vector ${vector.name}`);
    });

    // Receipt v3 and the tier policy.
    const v3 = JSON.parse(fs.readFileSync(vectorsV3Path, 'utf8'));
    assert.deepEqual(result.v3SchemaMismatches, [], 'ReceiptV3.Fields equals receipt-v3.schema.json');
    assert.deepEqual(result.policyBasisActions, ['environment.inspect', 'environment.stop', 'workspace.inspect', 'task.cancel']);
    assert.deepEqual(result.attestedPolicyBasisActions, ['environment.start', 'task.start']);
    const check = (actual, expectedVectors, label) => {
      assert.equal(actual.length, expectedVectors.length, label);
      expectedVectors.forEach((vector, i) => {
        const { name, ...verdict } = actual[i];
        assert.equal(name, vector.name);
        assert.deepEqual(verdict, vector.expected, `${label} ${vector.name}`);
      });
    };
    check(result.v3, v3.receiptVectors, 'v3 receipt vector');
    check(result.v3Direct, v3.receiptVectors, 'v3 receipt vector (direct)');
    check(result.v2ViaDispatcher.filter((r) => r.name !== 'version-3'), vectors.receiptVectors.filter((v) => v.name !== 'version-3'), 'v2 vector through the dispatcher');
    assert.deepEqual(result.v2ViaDispatcher.find((r) => r.name === 'version-3'), { name: 'version-3', ok: false, code: 'schema', field: 'policyVersion' });
    assert.equal(result.policy.length, v3.policyVectors.length);
    v3.policyVectors.forEach((vector, i) => {
      const { name, canonicalRoundTrips, ...actual } = result.policy[i];
      assert.equal(name, vector.name);
      assert.deepEqual(actual, vector.expected.ok ? vector.expected : { ok: false }, `policy vector ${vector.name}`);
      if (vector.expected.ok) assert.equal(canonicalRoundTrips, true, `${vector.name}: the compact form parses back to the same hash`);
    });
    assert.deepEqual(result.loosen, v3.loosenVectors.map(({ name, loosens }) => ({ name, loosens })));
    assert.deepEqual(result.policyMessageHex, v3.policyMessage.cases.map((c) => c.messageHex));

    // Network attestation: the digest vectors (the exact preimage bytes) and the signed verify vectors, with the vector file's ephemeral public key.
    const attestation = JSON.parse(fs.readFileSync(attestationVectorsPath, 'utf8'));
    check(result.attestationDigest, attestation.digestVectors.map(({ name, expected }) => ({ name, expected })), 'attestation digest vector');
    assert.ok(attestation.verifyVectors.cases.length >= 40 && result.attestationVerify.length === attestation.verifyVectors.cases.length);
    check(result.attestationVerify, attestation.verifyVectors.cases.map(({ name, result: expected }) => ({ name, expected })), 'attestation verify vector');

    // Task-start attestation (step 4): the same two kinds of vector, with its own ephemeral public key.
    const taskStart = JSON.parse(fs.readFileSync(taskStartVectorsPath, 'utf8'));
    check(result.taskStartDigest, taskStart.digestVectors.map(({ name, expected }) => ({ name, expected })), 'task-start digest vector');
    assert.ok(taskStart.verifyVectors.cases.length >= 50 && result.taskStartVerify.length === taskStart.verifyVectors.cases.length);
    check(result.taskStartVerify, taskStart.verifyVectors.cases.map(({ name, result: expected }) => ({ name, expected })), 'task-start verify vector');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
