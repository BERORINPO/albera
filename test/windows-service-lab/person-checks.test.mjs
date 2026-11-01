import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Issue #23, "no privilege inherited by Observer, Guest or Main AI": lab-guest.ps1 checks u1 to u6 run probes as a local BUILTIN\Users account that
// stands in for the person (lab-person.ps1), and u6 opens the Broker pipe through SMB. The VM run is the lead's; here the scripts' text is checked and
// person-probe.ps1 runs on the host against a temporary folder (it only opens and closes; a create-new probe is deleted on close).
const labDir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(labDir, name), 'utf8');
const guest = read('lab-guest.ps1');
const person = read('lab-person.ps1');
const probe = read('person-probe.ps1');
const driver = read('run-lab.ps1');
const section = guest.slice(guest.indexOf('\n# ---- Issue #23 acceptance item'), guest.indexOf('\nRemove-PolicyFiles\nRemove-AuthorityLabKey'));

test('lab-person.ps1 and person-probe.ps1 are ASCII only (Windows PowerShell 5.1 reads them without a BOM)', () => {
  for (const [name, text] of [['lab-person.ps1', person], ['person-probe.ps1', probe]]) assert.equal(/[^\t\r\n -~]/u.test(text), false, name);
});

test('the person checks u1 to u6 sit after p6 and before the results are written, with the Broker and Authority stopped afterwards', () => {
  const ids = [...section.matchAll(/^\s*Step '([^']+)'/gmu)].map((m) => m[1]);
  assert.deepEqual(ids, ['u1_person_token', 'u2_person_pipes_denied', 'u3_person_scm_no_control', 'u4_person_files_denied', 'u5_no_broad_ace', 'u6_remote_client_refused']);
  assert.ok(guest.indexOf("Step 'p6_unsigned_loosening_refused'") < guest.indexOf('# ---- Issue #23 acceptance item'));
  assert.ok(guest.indexOf("Step 'u6_remote_client_refused'") < guest.indexOf('$result = [ordered]@{'));
  assert.match(section, /finally \{ Stop-LabService \$B; Stop-LabService \$AuthSvc \}/u);
  assert.match(section, /\$pidR = Start-LabBroker 'remote' \$Db11 7 \$SidP/u, 'u6 makes the person the configured Control Plane SID, so only the remote-client refusal can deny it');
  assert.match(section, /'\\\\127\.0\.0\.1\\pipe\\srvsvc'/u, 'u6 proves SMB itself works for the account before it reads a refusal as the pipe\'s');
  assert.match(section, /Status = 'BLOCKED'/u, 'without a working SMB loopback u6 is BLOCKED, never PASS');
});

test('the person stand-in is created only in the guest, removed by the rollback, and never reused', () => {
  assert.match(guest, /\$Everything = @\(\$B, \$C, \$O, \$AuthSvc, \$PersonSvc\)/u, 'the rollback deletes its service with the others');
  assert.match(guest, /& \$PersonTool -Remove -UserName \$PersonUser/u);
  assert.match(guest, /local user \$PersonUser already exists; refusing to touch it/u);
  assert.match(driver, /@\('new-authority-key\.ps1', 'lab-person\.ps1', 'person-probe\.ps1'\)/u, 'run-lab.ps1 copies both tools into the guest');
  assert.match(person, /Add-LocalGroupMember -Group \(Get-LocalGroup -SID 'S-1-5-32-545'\)/u, 'Users only');
  assert.doesNotMatch(person, /S-1-5-32-544|Administrators/u, 'never an administrator');
  assert.match(person, /New-Service -Name \$ServiceName -BinaryPathName \$BinPath -Credential \$credential/u, 'the password reaches the SCM without a command line');
  assert.doesNotMatch(person, /sc\.exe|password=/iu);
  assert.match(person, /ValidatePattern\('\^AlberaLab\[A-Za-z\]\{1,10\}\$'\)/u, 'only lab-named accounts');
  // New-LocalUser refuses a description over 48 characters (the first VM run, 2026-11-01, failed setup on exactly that).
  const description = /-Description '([^']*)'/u.exec(person)?.[1] ?? '';
  assert.ok(description.length > 0 && description.length <= 48, `account description is ${description.length} characters`);
});

test('person-probe.ps1 reports opened / missing / denied without leaving anything behind', { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 60_000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'albera-person-probe-'));
  try {
    writeFileSync(path.join(dir, 'f.txt'), 'x');
    const targets = [
      { id: 'list', kind: 'dir-list', path: dir }, { id: 'create', kind: 'dir-create', path: dir },
      { id: 'read', kind: 'file-read', path: path.join(dir, 'f.txt') }, { id: 'write', kind: 'file-write', path: path.join(dir, 'f.txt') },
      { id: 'gone', kind: 'file-read', path: path.join(dir, 'nope.txt') }, { id: 'key', kind: 'cng-key', path: `AlberaNoSuchKey${process.pid}` },
      { id: 'bogus', kind: 'nope', path: dir },
    ];
    const targetsFile = path.join(dir, 'targets.json');
    writeFileSync(targetsFile, JSON.stringify(targets));
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(labDir, 'person-probe.ps1'), targetsFile], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const report = JSON.parse(out.trim().split(/\r?\n/u).at(-1));
    assert.equal(report.probe, 'person-files');
    assert.deepEqual(Object.fromEntries(report.results.map((r) => [r.id, r.outcome])), {
      list: 'opened', create: 'opened', read: 'opened', write: 'opened', gone: 'missing', key: 'missing', bogus: 'error:unknown_kind',
    });
    assert.deepEqual(readdirSync(dir).sort(), ['f.txt', 'targets.json'], 'the create-new probe file is gone');
    assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'x', 'the write probe wrote nothing');
  }
  finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});
