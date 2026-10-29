import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const project = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-pipe-prototype', 'Albera.WindowsPipeProbe.csproj');
const unavailableReason = getUnavailableReason();

test('Windows ephemeral Named Pipe uses an inspected protected DACL and OS peer token', { skip: unavailableReason }, () => {
  const artifacts = mkdtempSync(path.join(os.tmpdir(), 'albera-issue21-'));
  try {
    const output = path.join(artifacts, 'output');
    const intermediate = path.join(artifacts, 'obj');
    execFileSync('dotnet', [
      'build', project,
      '--configuration', 'Release',
      '--output', output,
      `--property:BaseIntermediateOutputPath=${intermediate}${path.sep}`,
      `--property:MSBuildProjectExtensionsPath=${intermediate}${path.sep}`
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true });

    const probe = path.join(output, 'Albera.WindowsPipeProbe.dll');
    const result = execFileSync('dotnet', [probe, 'run'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 45_000,
      windowsHide: true
    });
    assert.match(result, /DACL_PROTECTED=true/);
    assert.match(result, /AUTHENTICATED_SID_MATCH=true/);
    assert.match(result, /DACL_ACE_COUNT=1/);
    assert.match(result, /DACL_ALLOW_SID_MATCH=true;MASK=0x00100083/);
    assert.match(result, /SPOOF_RESPONSE=\{"ok":false,"code":"invalid_request"\}/);
    assert.match(result, /PIPE_SQUAT_FAIL_CLOSED=true/);
    assert.match(result, /PIPE_CLEANUP=true/);
    assert.match(result, /CROSS_ACCOUNT_TEST=BLOCKED/);
    assert.match(result, /SERVICE_SID_TEST=BLOCKED/);
    assert.match(result, /RESULT=PASS same-user ephemeral DACL\/token\/spoof\/pipe-squat checks/);
    assert.doesNotMatch(result, /SYNTHETIC_SECRET_MARKER/);
    process.stdout.write(result);
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
  }
});

function getUnavailableReason() {
  if (process.platform !== 'win32') return 'Windows-only OS Named Pipe experiment';
  try {
    const sdks = execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true });
    if (!sdks.split(/\r?\n/).some((line) => /^10\./.test(line))) {
      return 'existing .NET 10 SDK not available; test skipped without installing SDKs';
    }
    const runtimes = execFileSync('dotnet', ['--list-runtimes'], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true });
    if (!runtimes.split(/\r?\n/).some((line) => /^Microsoft\.NETCore\.App 10\./.test(line))) {
      return 'existing .NET 10 runtime not available; test skipped without installing runtimes';
    }
  } catch {
    return 'dotnet SDK is unavailable; test skipped without installing SDKs';
  }
  return false;
}
