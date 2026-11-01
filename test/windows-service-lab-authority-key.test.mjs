import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { currentUserSid } from './helpers/windows-broker-harness.mjs';

// test/windows-service-lab/new-authority-key.ps1 provisions the Authority's signing key inside the lab VM (machine scope, Administrator). Here it runs
// unprivileged with -Scope user: a persisted CURRENT-USER software-KSP key with a random name, removed at the end. That proves the script's key
// parameters and DACL are what its header says; the machine scope, the Authority's start-up guard against it and the exit codes are lab-only (run-lab.ps1).
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, 'test', 'windows-service-lab', 'new-authority-key.ps1');
const run = (...args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000, windowsHide: true });
const json = (output) => JSON.parse(output.trim().split(/\r?\n/u).at(-1));
const SERVICE_SID = 'S-1-5-80-1111111111-2222222222-3333333333-1444444444-2555555555';
// User scope adds the signed-in user to the DACL so the test can read the key back and delete it. Looked up lazily (whoami.exe exists only on Windows).
// The script reports allow-ACE SIDs, not SDDL text: an elevated built-in Administrator shows up as the alias LA there, SY / BA / WD for the others.
const me = () => currentUserSid();
const SYSTEM_SID = 'S-1-5-18', ADMINISTRATORS_SID = 'S-1-5-32-544', EVERYONE_SID = 'S-1-1-0';
const principals = (report) => [...report.allowSids].sort();

test('new-authority-key.ps1 is ASCII only (Windows PowerShell 5.1 reads it without a BOM) and never creates a key unless asked', () => {
  const text = readFileSync(script, 'utf8');
  assert.equal(/[^\t\r\n -~]/u.test(text), false);
  assert.match(text, /\[ValidateSet\('good', 'exportable', 'broad_ace'\)\]/u);
  assert.match(text, /refusing to touch it/u, 'an existing key is never overwritten');
});

test('new-authority-key.ps1 variants create the key the lab needs (per-user scope, read back from a fresh open)', { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 180_000 }, async (t) => {
  const names = [];
  const create = (variant) => {
    const keyName = `AlberaTestLabKey-${randomBytes(6).toString('hex')}`;
    const report = json(run('-KeyName', keyName, '-ServiceSid', SERVICE_SID, '-Variant', variant, '-Scope', 'user'));
    names.push(keyName);
    return report;
  };
  try {
    const good = create('good');
    await t.test('good: ECDSA P-256, Export Policy none, DACL = SYSTEM + Administrators + the service SID (+ the signed-in user in user scope)', () => {
      assert.equal(good.exportPolicy, 0);
      assert.equal(good.keySize, 256);
      assert.match(good.algorithm, /^ECDSA_P256$/u);
      assert.deepEqual(principals(good), [ADMINISTRATORS_SID, SYSTEM_SID, SERVICE_SID, me()].sort(), good.sddl);
      assert.match(good.sddl, /D:P/u, 'protected DACL');
    });
    await t.test('exportable: Export Policy allows export, same DACL', () => {
      const exportable = create('exportable');
      assert.equal(exportable.exportPolicy, 1);
      assert.deepEqual(principals(exportable), [ADMINISTRATORS_SID, SYSTEM_SID, SERVICE_SID, me()].sort());
    });
    await t.test('broad_ace: non-exportable, same DACL plus Everyone', () => {
      const broad = create('broad_ace');
      assert.equal(broad.exportPolicy, 0);
      assert.deepEqual(principals(broad), [ADMINISTRATORS_SID, SYSTEM_SID, EVERYONE_SID, SERVICE_SID, me()].sort());
    });
    await t.test('an existing key is refused, a bad name and a machine key without a service SID throw before anything is created', () => {
      assert.throws(() => run('-KeyName', names[0], '-ServiceSid', SERVICE_SID, '-Scope', 'user'), /already exists/u);
      assert.throws(() => run('-KeyName', 'bad name!', '-ServiceSid', SERVICE_SID, '-Scope', 'user'), /KeyName must match/u);
      assert.throws(() => run('-KeyName', `AlberaTestLabKey-${randomBytes(6).toString('hex')}`, '-Scope', 'machine'), /ServiceSid is required/u);
      assert.throws(() => run('-KeyName', `AlberaTestLabKey-${randomBytes(6).toString('hex')}`, '-ServiceSid', 'S-1-1-0', '-Scope', 'user'), /ServiceSid must be/u);
      // A machine key is only ever granted to a per-service SID: LocalService, NetworkService, SYSTEM, a user and a short service SID all throw before anything is created.
      for (const sid of ['S-1-5-19', 'S-1-5-20', 'S-1-5-18', me(), 'S-1-5-80-1-2-3']) {
        assert.throws(() => run('-KeyName', `AlberaTestLabKey-${randomBytes(6).toString('hex')}`, '-ServiceSid', sid, '-Scope', 'machine'), /per-service SID/u, sid);
      }
    });
  } finally {
    for (const keyName of names) {
      const removed = json(run('-KeyName', keyName, '-Scope', 'user', '-Remove'));
      assert.equal(removed.removed, true, `${keyName} removed`);
      assert.equal(json(run('-KeyName', keyName, '-Scope', 'user', '-Remove')).removed, false, 'a second remove finds nothing');
    }
  }
});

test('the VM lab driver provisions the key, starts the real Authority service and checks good / exportable / broad-ACE / missing (script not executed here)', () => {
  const read = (...parts) => readFileSync(path.join(root, 'test', 'windows-service-lab', ...parts), 'utf8');
  const guest = read('lab-guest.ps1');
  const driver = read('run-lab.ps1');
  for (const [name, text] of [['lab-guest.ps1', guest], ['run-lab.ps1', driver], ['lab-vm.ps1', read('lab-vm.ps1')]]) assert.equal(/[^\t\r\n -~]/u.test(text), false, `${name} stays ASCII only`);
  const ids = [...guest.matchAll(/^Step '([^']+)'|^Test-AuthorityRefused '[^']+' '([^']+)'/gmu)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(ids.filter((id) => id.startsWith('k_')).sort(), ['k_broad_ace_refused', 'k_exportable_key_refused', 'k_good_key_starts', 'k_missing_key_77'].sort());
  assert.match(guest, /Test-AuthorityRefused '[^']+' 'k_exportable_key_refused' 'exportable' \$AuthKeyNames\[1\] 78/u);
  assert.match(guest, /Test-AuthorityRefused '[^']+' 'k_broad_ace_refused' 'broad_ace' \$AuthKeyNames\[2\] 78/u);
  assert.match(guest, /Test-AuthorityRefused '[^']+' 'k_missing_key_77' '' 'AlberaLabAuthMissing' 77/u);
  assert.match(guest, /\(\$svc\.ExitCode -eq 1066\) -and \(\$svc\.ServiceSpecificExitCode -eq \$expectedExit\)/u, 'a refusal is STOPPED with 1066 and the fixed code');
  assert.match(guest, /\$running = \$svc\.State -eq 'Running'/u, 'the good key reaches RUNNING (both pipes exist)');
  assert.match(guest, /sc\.exe create \$AuthSvc binPath= "\$AuthExe service \$AuthConfig" obj= "NT SERVICE\\\$AuthSvc"/u, 'the real Authority is the service, under its virtual account');
  assert.match(guest, /signingKeyProvider = 'software'/u);
  assert.match(guest, /& \$AuthKeyTool -KeyName \$keyName -ServiceSid \$SidAuth -Variant \$variant/u, 'the key is created for the Authority service SID');
  assert.match(driver, /authority = Join-Path \$repo 'src\\runtime\\windows-approval-authority\\bin\\Release\\net10\.0-windows\\win-x64\\publish'/u);
  assert.match(driver, /foreach \(\$tool in @\('new-authority-key\.ps1'[^)]*\)\) \{ Copy-Item -ToSession \$session -Path \(Join-Path \$PSScriptRoot \$tool\) -Destination "\$LabRoot\\tools\\\$tool"/u);
  assert.match(read('lab-vm.ps1'), /npm run build:approval-authority/u);
});
