import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The C# twin (src/runtime/windows-approver/MatchCode.cs) is compiled alone (it has no other dependency) into a throwaway console in a temp dir and must reproduce
// every vector of match-code-vectors.json: the code, the three candidates in order, the position of the correct one, the preimage bytes, the hash, and the refusal
// (code and field). Skipped without a .NET 10 SDK. No approver, Broker or Authority code is involved.
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const matchCodeSource = path.join(repositoryRoot, 'src', 'runtime', 'windows-approver', 'MatchCode.cs');
const harnessProject = path.join(repositoryRoot, 'test', 'match-code-dotnet-harness', 'MatchCodeHarness.csproj');
const vectorsPath = path.join(repositoryRoot, 'src', 'runtime', 'broker-contract', 'match-code-vectors.json');

function unavailableReason() {
  try {
    const sdks = execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return sdks.split(/\r?\n/u).some((line) => /^10\./u.test(line)) ? false : '.NET 10 SDK unavailable';
  } catch { return 'dotnet unavailable'; }
}

test('C# MatchCode gives the same codes, candidates, order, preimage bytes, hashes and refusals as the Node contract for every vector', { skip: unavailableReason(), timeout: 240_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'albera-match-code-'));
  try {
    const output = path.join(root, 'out');
    const intermediate = `${path.join(root, 'obj')}${path.sep}`;
    const run = (args) => execFileSync('dotnet', args, { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    run(['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:MatchCodeSource=${matchCodeSource}`,
      `--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo']);
    const results = JSON.parse(run([path.join(output, 'MatchCodeHarness.dll'), vectorsPath]));
    const { vectors } = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
    assert.equal(results.length, vectors.length);
    vectors.forEach((vector, i) => {
      const { name, ...actual } = results[i];
      assert.equal(name, vector.name);
      assert.deepEqual(actual, vector.expected, `match code vector ${vector.name}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
