import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Issue #115 step 3a: the VM lab checks p1 to p6 (the Approval Authority and its tier policy file, policy.json). The VM run is the lead's; these guards pin what the
// script must assert, and run the one pure helper that has to agree with the contract (the policy hash) on the host.
const labDir = path.dirname(fileURLToPath(import.meta.url));
const guestPath = path.join(labDir, 'lab-guest.ps1');
const guest = readFileSync(guestPath, 'utf8');
const stepBody = (id) => {
  const start = guest.indexOf(`Step '${id}'`);
  assert.notEqual(start, -1, `${id} exists`);
  const next = guest.indexOf('\nStep ', start + 1);
  const end = guest.indexOf('\nRemove-PolicyFiles\nRemove-AuthorityLabKey', start + 1);
  return guest.slice(start, Math.min(...[next, end].filter((i) => i !== -1)));
};

test('lab-guest.ps1 stays ASCII only and has the six policy checks, after the key checks and before the results are written', () => {
  assert.equal(/[^\t\r\n -~]/u.test(guest), false);
  const ids = [...guest.matchAll(/^Step '([^']+)'|^Test-AuthorityRefused '[^']+' '([^']+)'/gmu)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(ids.filter((id) => id.startsWith('p')), ['p1_no_policy_starts_careful', 'p2_untrusted_config_folder_73', 'p3_unsigned_standard_79', 'p4_service_writes_policy', 'p5_restart_with_written_policy', 'p6_unsigned_loosening_refused']);
  assert.ok(ids.indexOf('k_missing_key_77') < ids.indexOf('p1_no_policy_starts_careful'));
  assert.ok(guest.indexOf("Step 'p6_unsigned_loosening_refused'") < guest.indexOf('$result = [ordered]@{'));
});

test('the Authority has a config folder of its own whose only extra writer is its service SID, and the policy key is removed again', () => {
  assert.match(guest, /\$AuthConfig = "\$AuthDir\\\$AuthSvc\.service\.json"/u);
  assert.match(guest, /\$AuthPolicyFile = "\$AuthDir\\policy\.json"/u, 'policy.json sits next to the config');
  assert.match(guest, /Set-LabAcl \$AuthDir @\("\*\$\{SidAuth\}:\(OI\)\(CI\)M"\)/u, 'SYSTEM and Administrators full (Set-LabAcl), the service SID Modify, nobody else');
  assert.match(guest, /pipeRoot = \$AuthPipeRoot;/u, 'the config and the pipe client use the same pipe root');
  assert.match(guest, /\$AuthKeyNames = @\([^)]*'AlberaLabAuthPolicy'\)/u, 'the rollback removes the policy key too');
  assert.match(guest, /Remove-PolicyFiles\nRemove-AuthorityLabKey \$PolicyKeyName/u);
});

test('p1 and p5 reach RUNNING and read the policy back from the pipe; p1 writes no file; no committed evidence carries an account SID', () => {
  const p1 = stepBody('p1_no_policy_starts_careful');
  assert.match(p1, /Remove-PolicyFiles/u);
  assert.match(p1, /Test-PolicyShape \$reply 0 'careful' @\(\)/u, 'revision 0, careful, no overrides, hash computed here');
  assert.match(p1, /\(-not \$created\)/u, 'start-up writes no policy.json');
  const p5 = stepBody('p5_restart_with_written_policy');
  assert.match(p5, /Test-PolicyShape \$read 1 'careful' @\(\$PolicyOverrideAction\)/u);
  assert.match(p5, /\$unchanged/u, 'a start does not rewrite the file');
  assert.match(p5, /\$svc\.ProcessId -ne \$script:PolicyPid\)/u, 'a new process, not the p4 one');
  assert.match(guest, /function Hide-Sids\(\[string\]\$text\) \{ \$text -replace 'S-1-5-21\(-\[0-9\]\+\)\+', 'S-1-5-21-<redacted>' \}/u);
  assert.match(guest, /default \{ Hide-Sids \$sid \}/u, 'an unknown principal prints redacted');
});

test('p2 grants Users write on the config FOLDER only, expects 1066 / 73, and shows the same config starts once the ACE is gone', () => {
  const p2 = stepBody('p2_untrusted_config_folder_73');
  assert.match(p2, /icacls\.exe \$AuthDir \/grant '\*S-1-5-32-545:W'/u, 'no (OI)(CI): the config file is not touched, so the folder check is what refuses');
  assert.match(p2, /\$bad\.ExitCode -eq 1066\) -and \(\$bad\.ServiceSpecificExitCode -eq 73\)/u);
  assert.match(p2, /\/remove:g '\*S-1-5-32-545'/u);
  assert.match(p2, /\$fileReport\.Trusted/u, 'control: the config file stayed trusted');
  assert.match(p2, /\$good\.State -eq 'Running'/u, 'control: without the ACE the same config starts');
});

test('p3 refuses an unsigned standard file with 1066 / 79 and has a careful control written the same way (owner Administrators)', () => {
  const p3 = stepBody('p3_unsigned_standard_79');
  assert.match(p3, /Write-PolicyFileAsAdministrator '\{"v":1,"rev":1,"tier":"careful","overrides":\{\}\}'/u);
  assert.match(p3, /Write-PolicyFileAsAdministrator '\{"v":1,"rev":1,"tier":"standard","overrides":\{\}\}'/u, 'no authorized block, so no signature');
  assert.match(p3, /\$bad\.ExitCode -eq 1066\) -and \(\$bad\.ServiceSpecificExitCode -eq 79\)/u);
  assert.match(p3, /\$control\.State -eq 'Running'\) -and \$controlReport\.Trusted -and \$badReport\.Trusted/u, 'the 79 cannot be an owner or ACL refusal: both files pass the mirror, the careful one starts');
  assert.match(guest, /icacls\.exe \$AuthPolicyFile \/setowner '\*S-1-5-32-544'/u);
  assert.match(p3, /Remove-PolicyFiles \}/u, 'the file never outlives the step');
});

test('p4 has the service write policy.json through policy_set without a signature, then checks the file, its shape, its hash and its owner / ACL', () => {
  const p4 = stepBody('p4_service_writes_policy');
  assert.match(p4, /"verb":"policy_set","policy":\{"v":1,"rev":1,"tier":"careful","overrides":\{"' \+ \$PolicyOverrideAction \+ '":"prompt"\}\}\}/u);
  assert.equal(/presence/u.test(p4), false, 'no presence signature is sent');
  assert.match(p4, /\$set\.policyVersion -eq \$expectedHash/u, 'the reply hash equals the one computed here');
  assert.match(p4, /-eq 'v,rev,tier,overrides'/u, 'the file has exactly the policy keys: no authorized block');
  assert.match(p4, /\$report\.Trusted/u, 'owner and ACL of the written file');
  assert.match(p4, /\$leftovers -eq 0/u, 'no temp file left behind');
  assert.match(guest, /\$PolicyOverrideAction = 'task\.start'/u);
});

test('p6 sends an unsigned loosening policy_set and expects presence_mismatch with the file untouched', () => {
  const p6 = stepBody('p6_unsigned_loosening_refused');
  assert.match(p6, /"policy":\{"v":1,"rev":2,"tier":"standard","overrides":\{\}\}\}/u);
  assert.match(p6, /\$refused\.code -eq 'presence_mismatch'/u);
  assert.match(p6, /\$unchanged/u);
});

test('the pipe client opens with the approver ACE rights (not GENERIC_WRITE), identification impersonation, and the Authority framing', () => {
  assert.match(guest, /\[System\.IO\.Pipes\.PipeAccessRights\]::ReadData -bor \[System\.IO\.Pipes\.PipeAccessRights\]::WriteData -bor \[System\.IO\.Pipes\.PipeAccessRights\]::Synchronize/u);
  assert.match(guest, /\[System\.Security\.Principal\.TokenImpersonationLevel\]::Identification/u);
  assert.match(guest, /"\$AuthPipeRoot\\approver\\v1"/u);
  assert.match(guest, /\$length -lt 1 -or \$length -gt 2048/u);
});

// The domain is read from TierPolicy.cs, so a change of the contract's hash domain fails here instead of only in the VM.
const hashDomain = /HashDomain = "([^"]+)"/u.exec(readFileSync(path.join(labDir, '..', '..', 'src', 'runtime', 'broker-contract', 'TierPolicy.cs'), 'utf8'))[1];

test('Get-PolicyHash in the lab script agrees with the contract hash (TierPolicy.HashDomain)', { skip: process.platform !== 'win32' }, () => {
  const script = [
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:LAB_GUEST, [ref]$null, [ref]$null)",
    "$f = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-PolicyHash' }, $true)",
    ". ([scriptblock]::Create($f.Extent.Text))",
    "Get-PolicyHash 0 'careful' @()",
    "Get-PolicyHash 1 'careful' @('task.start')",
    "Get-PolicyHash 3 'careful' @('environment.destroy', 'task.start')",
  ].join('\n');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', env: { ...process.env, LAB_GUEST: guestPath }, timeout: 60_000, windowsHide: true });
  const hash = (rev, tier, prompts) => `sha256:${createHash('sha256').update([hashDomain, String(rev), tier, ...[...prompts].sort()].join('\0')).digest('hex')}`;
  assert.deepEqual(output.trim().split(/\r?\n/u), [hash(0, 'careful', []), hash(1, 'careful', ['task.start']), hash(3, 'careful', ['environment.destroy', 'task.start'])]);
});
