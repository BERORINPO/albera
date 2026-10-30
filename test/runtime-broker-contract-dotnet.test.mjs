import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// The C# twin (src/runtime/broker-contract/*.cs) is compiled by source include into a throwaway console in a temp dir and must reproduce
// every shared vector: digest, preimage bytes, verdict code and field. Skipped without a .NET 10 SDK. No Broker or Authority code is involved.
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contractDir = path.join(repositoryRoot, 'src', 'runtime', 'broker-contract');
const harnessProject = path.join(repositoryRoot, 'test', 'receipt-v2-dotnet-harness', 'ReceiptV2Harness.csproj');
const vectorsPath = path.join(contractDir, 'test-vectors.json');
const schemaPath = path.join(contractDir, 'receipt-v2.schema.json');

function unavailableReason() {
  try {
    const sdks = execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return sdks.split(/\r?\n/u).some((line) => /^10\./u.test(line)) ? false : '.NET 10 SDK unavailable';
  } catch { return 'dotnet unavailable'; }
}

test('C# ActionDigest and ReceiptV2 give the same digests and verdicts as the Node contract for every vector', { skip: unavailableReason(), timeout: 240_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'albera-receipt-v2-'));
  try {
    const output = path.join(root, 'out');
    const intermediate = `${path.join(root, 'obj')}${path.sep}`;
    const run = (args) => execFileSync('dotnet', args, { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    run(['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:ContractDir=${contractDir}${path.sep}`,
      `--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo']);
    const result = JSON.parse(run([path.join(output, 'ReceiptV2Harness.dll'), vectorsPath, schemaPath]));
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
