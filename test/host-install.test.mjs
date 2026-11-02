import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseApprovalSettings } from '../src/runtime/room-approval-wiring.mjs';

// scripts/host/albera-host.ps1 installs the Host Broker and the Approval Authority on THIS PC and needs an elevated console, a real account, real services and a machine key.
// None of that runs here. What runs here, on any Windows PC without admin rights:
//   - plan / status / refusal modes of the real script (they change nothing; a before/after snapshot proves it),
//   - the PURE helpers of albera-host-lib.ps1 (validators that mirror the C# config rules, ACL plan, service checks), fed with keys made by Node,
//   - the system-touching helpers (copy with hashing, removal with its allow-list) against a TEMP folder, taken out of the real script by AST,
//   - the signing-key function in USER scope (a throw-away per-user key), verified with Node's crypto.
// The install / uninstall paths themselves (sc.exe, icacls, New-LocalUser, machine key, the Authority start-up guard) are lab-only: test/windows-service-lab/lab-host-install-check.ps1 (written, never run).
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostDir = path.join(root, 'scripts', 'host');
const driverDir = path.join(root, 'test', 'host-install');
const labRunner = path.join(root, 'test', 'windows-service-lab', 'lab-host-install-check.ps1');
const windows = process.platform === 'win32';
const POWERSHELL = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
const ps = (args, { env = {}, allowFail = false } = {}) => {
  try {
    const stdout = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      encoding: 'utf8', timeout: 180_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (error) {
    if (!allowFail) throw error;
    return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
};
const host = (args, options) => ps(['-File', path.join(hostDir, 'albera-host.ps1'), ...args], options);
const lastJson = (stdout) => JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
const scratch = (t) => { const dir = mkdtempSync(path.join(os.tmpdir(), 'albera-host-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const b64url = (value) => Buffer.from(value, 'base64url').toString('base64url');

// ---- files ----

test('the host scripts and test drivers are ASCII only (Windows PowerShell 5.1 reads a file without a BOM as the ANSI code page)', () => {
  const files = [
    path.join(hostDir, 'albera-host.ps1'), path.join(hostDir, 'albera-host-lib.ps1'), labRunner,
    ...readdirSync(driverDir).filter((name) => name.endsWith('.ps1')).map((name) => path.join(driverDir, name)),
  ];
  assert.ok(files.length >= 5);
  for (const file of files) assert.equal(/[^\t\r\n -~]/u.test(readFileSync(file, 'utf8')), false, `${path.relative(root, file)} has a non-ASCII character`);
});

test('source guards: install and uninstall check elevation first and never elevate; no secret is stored; the password is a SecureString', () => {
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  const lib = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  assert.match(script, /\$Mode -in @\('install', 'uninstall'\) -and -not \(Test-Elevated\)\) \{ Stop-Refused/u);
  assert.ok(script.indexOf('Stop-Refused "$Mode needs an elevated console') < script.indexOf('Get-HostLayout'), 'the elevation refusal comes before anything else is computed');
  for (const forbidden of [/-Verb\s+RunAs/iu, /\bRunAs\b(?!\s*=)/u, /Start-Process/u, /\bsudo\b/iu, /ConvertFrom-SecureString/u, /AsPlainText/u, /\bNetworkCredential\b/u, /PtrToStringAuto|PtrToStringBSTR|SecureStringToGlobalAllocUnicode/u]) {
    assert.equal(forbidden.test(script) || forbidden.test(lib), false, `must not contain ${forbidden}`);
  }
  assert.match(script, /\[securestring\]\$ControlPlanePassword/u);
  assert.match(script, /-AsSecureString/u);
  assert.match(script, /ALBERA_LAB_VM/u);
  assert.doesNotMatch(script, /-Password\s+['"]/u, 'no literal password');
  for (const tool of ['sc.exe', 'icacls.exe']) assert.match(script, new RegExp(`System32\\\\${tool}`, 'u'), `${tool} is started by its full path`);
});

// ---- the real script: plan, status, refusals ----

/** What a change would touch: local accounts, services, the two folders (names only), and the Albera keys. */
function snapshot() {
  const script = [
    '$users = @(Get-LocalUser | ForEach-Object { $_.Name } | Sort-Object)',
    '$services = @(Get-Service | ForEach-Object { $_.Name } | Sort-Object)',
    '$pd = Test-Path -LiteralPath (Join-Path $env:ProgramData "Albera"); $pf = Test-Path -LiteralPath (Join-Path $env:ProgramFiles "Albera")',
    '[ordered]@{ users = $users; services = $services; programData = $pd; programFiles = $pf } | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  return lastJson(ps(['-Command', script]).stdout);
}

test('plan is the default: numbered steps, every object named, nothing changed', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  const output = host([]).stdout;
  assert.deepEqual(snapshot(), before, 'plan changed nothing');
  assert.match(output, /PLAN ONLY/u);
  assert.match(output, /nothing was changed/iu);
  const numbered = [...output.matchAll(/^\s*(\d+)\. \[(todo|done|blocked|unknown)\] /gmu)].map((m) => Number(m[1]));
  assert.deepEqual(numbered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'ten numbered steps, in order');
  for (const needle of [
    'AlberaHostBroker', 'AlberaApprovalAuthority', 'albera-cp', 'restricted SID', 'SeChangeNotifyPrivilege', 'start=demand', 'SERVICE_QUERY_STATUS',
    'AlberaApprovalAuthority-host-1', 'Export Policy none', 'install-manifest.json', 'albera.approval.json', 'enroll --show', 'SHA-256', 'inheritance removed', 'no policy.json',
    'C:\\Program Files\\Albera', 'C:\\ProgramData\\Albera',
  ]) assert.ok(output.includes(needle), `the plan names ${needle}`);
  assert.match(output, /you start them/u, 'the plan says the owner starts the services');
  assert.doesNotMatch(output, /password\s*[:=]\s*\S/iu);
});

test('plan against a repo without builds is blocked with the build command, and without -ApproverKeyId the approver step is blocked', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const empty = scratch(t);
  const output = host(['-Mode', 'plan', '-RepoRoot', empty, '-ApproverKeyId', 'hello-0123456789abcdef']).stdout;
  assert.match(output, /\[blocked\] Verify the published builds/u);
  assert.match(output, /npm run build:windows-broker/u);
  assert.match(output, /npm run build:approval-authority/u);
  assert.match(output, /\[blocked\] Read the approver key/u);
  assert.match(output, /npm run build:approver/u);
  const noKeyId = host(['-Mode', 'plan', '-RepoRoot', empty]).stdout;
  assert.match(noKeyId, /-ApproverKeyId <hello-\.\.\.> is required for install/u);
});

test('plan for uninstall lists the six removal steps and says what it refuses to delete', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  const output = host(['-Mode', 'plan', '-PlanFor', 'uninstall']).stdout;
  assert.deepEqual(snapshot(), before);
  assert.deepEqual([...output.matchAll(/^\s*(\d+)\. \[/gmu)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6]);
  assert.match(output, /only if (?:this script|it) created it|only if this script created it/u);
  assert.match(output, /refused for any folder that holds a file this script does not know/u);
});

test('status with nothing installed says so and exits 0 without touching anything', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  if (existsSync(path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Albera', 'install-manifest.json'))) return; // a real install is present on this PC: its status is not a unit-test matter
  const before = snapshot();
  const result = host(['-Mode', 'status']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not installed/u);
  assert.deepEqual(snapshot(), before);
});

test('install and uninstall refuse unless elevated (the seam can only make the script refuse more, so a test can never install for real)', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  for (const mode of ['install', 'uninstall']) {
    const result = host(['-Mode', mode, '-ApproverKeyId', 'hello-0123456789abcdef'], { env: { ALBERA_HOST_ASSUME_NOT_ELEVATED: '1' }, allowFail: true });
    assert.equal(result.code, 3, `${mode} exits 3`);
    assert.match(result.stdout, /REFUSED: .* needs an elevated console/u);
    assert.match(result.stdout, /never elevates itself/u);
    assert.doesNotMatch(result.stdout, /^\s*\d+\. /mu, 'no step ran');
  }
  assert.deepEqual(snapshot(), before);
});

test('lab-only parameters are refused outside the lab VM (exit 2), in every mode, and bad ids are refused', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const labValues = JSON.stringify({ approverPublicKey: 'x', approverKeyId: 'hello-x', approverSid: 'S-1-5-21-1-2-3-4' });
  const outside = host(['-Mode', 'plan', '-LabApproverValues', labValues], { allowFail: true });
  assert.equal(outside.code, 2);
  assert.match(outside.stdout, /lab-only/u);
  const inLabButPlan = host(['-Mode', 'plan', '-LabApproverValues', labValues], { env: { ALBERA_LAB_VM: '1' }, allowFail: true });
  assert.equal(inLabButPlan.code, 2, 'even in the lab the parameter only applies to install');
  const wrongValue = host(['-Mode', 'plan', '-LabApproverValues', labValues], { env: { ALBERA_LAB_VM: 'true' }, allowFail: true });
  assert.equal(wrongValue.code, 2);
  assert.equal(host(['-Mode', 'plan', '-ApproverKeyId', 'not valid!'], { allowFail: true }).code, 2);
  assert.equal(host(['-Mode', 'plan', '-ProjectId', '../x'], { allowFail: true }).code, 2);
});

// ---- the pure helpers ----

const lib = (() => {
  let cached;
  return () => {
    if (cached) return cached;
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = ec.publicKey.export({ format: 'jwk' });
    const spki = (key) => key.export({ type: 'spki', format: 'der' }).toString('base64');
    const rsa2048 = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const rsa3072 = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey;
    const inputs = { ecSpki: spki(ec.publicKey), rsa2048: spki(rsa2048), rsa3072: spki(rsa3072) };
    const stdout = ps(['-File', path.join(driverDir, 'lib-checks.ps1'), '-EcX', jwk.x, '-EcY', jwk.y, '-EcSpki', inputs.ecSpki, '-Rsa2048Spki', inputs.rsa2048, '-Rsa3072Spki', inputs.rsa3072]).stdout;
    cached = { r: lastJson(stdout), inputs };
    return cached;
  };
})();
const needsWindows = { skip: !windows && 'Windows PowerShell only', timeout: 240_000 };

test('layout: every path is a plain absolute path under the two roots, the data root holds only what the install creates', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.layout.BrokerExe, 'C:\\Program Files\\Albera\\bin\\broker\\albera-windows-broker.exe');
  assert.equal(r.layout.AuthorityExe, 'C:\\Program Files\\Albera\\bin\\authority\\albera-approval-authority.exe');
  assert.equal(r.layout.PipeClientExe, 'C:\\Program Files\\Albera\\bin\\pipe-client\\albera-windows-broker-pipe-client.exe');
  assert.equal(r.layout.ManifestPath, 'C:\\ProgramData\\Albera\\install-manifest.json');
  assert.equal(r.layout.ApprovalSettings, 'C:\\ProgramData\\Albera\\control-plane\\albera.approval.json');
  assert.equal(r.layout.ControlPlaneJournal, 'C:\\ProgramData\\Albera\\control-plane\\operations.sqlite');
  for (const key of ['BrokerConfig', 'BrokerDb', 'AuthorityConfig', 'ApprovalSettings', 'ControlPlaneJournal']) assert.ok(r.layout[key].startsWith(r.layout.DataRoot + '\\'));
  // the broker database folder and config folder are different folders: the config is read-only for the service, the database folder is its own
  assert.notEqual(path.win32.dirname(r.layout.BrokerConfig), path.win32.dirname(r.layout.BrokerDb));
  assert.equal(r.constants.ControlPlaneUser, 'albera-cp');
});

test('derived service SIDs equal the C# derivation (the TrustedInstaller vector pinned by the C# harness)', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.sidTrustedInstaller, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
  assert.equal(r.sidCaseInsensitive, true);
  assert.match(r.sidBroker, /^S-1-5-80(-\d+){5}$/u);
  assert.match(r.sidAuthority, /^S-1-5-80(-\d+){5}$/u);
  assert.notEqual(r.sidBroker, r.sidAuthority);
});

test('SPKI: built from a P-256 public blob it equals Node\'s own export; wrong shapes are refused; RSA-2048 is told from other sizes', needsWindows, () => {
  const { r, inputs } = lib();
  assert.equal(r.spkiBuilt, inputs.ecSpki);
  assert.equal(r.spkiMatchesNode, true);
  assert.equal(r.spkiRoundTripBlob, true);
  assert.deepEqual(r.p256Accepts, [true, true]);
  assert.deepEqual(r.p256Rejects, [false, false, false, false]);
  assert.equal(r.badBlobRefused, true);
  assert.equal(r.rsaAccepts, true);
  assert.deepEqual(r.rsaRejects, [false, false, false]);
  assert.doesNotThrow(() => createPublicKey({ key: Buffer.from(r.spkiBuilt, 'base64'), format: 'der', type: 'spki' }));
});

test('approver values: parsed from the three public lines; a different key id, a non-user or equal SID, and a non-RSA-2048 key are each refused with a reason', needsWindows, () => {
  const { r, inputs } = lib();
  assert.deepEqual({ ...r.shown }, { approverPublicKey: inputs.rsa2048, approverKeyId: 'hello-0123456789abcdef', approverSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001' });
  assert.match(r.shownMissing, /approver_output_missing_approverSid/u);
  assert.match(r.shownRepeated, /approver_output_repeated_value/u);
  assert.equal(r.approverOk, 0);
  assert.deepEqual(r.approverWrongId, ['approver_key_id_differs_from_expected']);
  assert.deepEqual(r.approverSameSid, ['approver_sid_equals_control_plane_sid']);
  assert.deepEqual(r.approverVirtualSid, ['approver_sid_not_a_user_sid']);
  assert.deepEqual(r.approverGroupSid, ['approver_sid_not_a_user_sid']);
  assert.deepEqual(r.approverBadKey, ['approver_public_key_not_rsa2048_spki']);
});

test('the generated configs have exactly the key sets the C# parsers accept, and they pass the script\'s mirror of the C# checks', needsWindows, () => {
  const { r } = lib();
  const csKeys = (file, name) => {
    const text = readFileSync(path.join(root, 'src', 'runtime', file), 'utf8');
    const match = text.match(new RegExp(`${name} = \\[([^\\]]+)\\]`, 'u'));
    assert.ok(match, `${file} declares ${name}`);
    return [...match[1].matchAll(/"([A-Za-z]+)"/gu)].map((m) => m[1]).sort();
  };
  const broker = JSON.parse(r.brokerJson);
  const authority = JSON.parse(r.authorityJson);
  assert.deepEqual(Object.keys(broker).sort(), csKeys('windows-broker/ServiceConfig.cs', 'string\\[\\] Keys'));
  assert.deepEqual(Object.keys(authority).sort(), csKeys('windows-approval-authority/AuthorityConfig.cs', 'string\\[\\] Keys'));
  assert.deepEqual(Object.keys(broker.authorityKeys[0]).sort(), csKeys('windows-broker/ServiceConfig.cs', 'string\\[\\] AuthorityKeyFields'));
  assert.deepEqual([r.brokerReasons, r.authorityReasons], [[], []]);
  assert.equal(r.policyVersionsEqual, true, 'the Broker and the Authority name the same policyVersion (the Broker compares it with what the Authority signs)');
  assert.equal(broker.controlPlaneSid, authority.controlPlaneSid);
  assert.notEqual(authority.controlPlaneSid, authority.approverSid);
  assert.equal(authority.signingKeyProvider, 'software');
  assert.equal(authority.audience, 'albera-host-broker', 'the Broker config audience is fixed in the Broker (BrokerAudience); the Authority must sign the same');
  assert.match(readFileSync(path.join(root, 'src', 'runtime', 'windows-broker', 'BrokerRequests.cs'), 'utf8'), /BrokerAudience = "albera-host-broker"/u);
  assert.equal(broker.authorityKeys.length, 1);
  assert.equal(broker.authorityKeys[0].kid, authority.kid, 'the receipt names its key by kid: the Broker pins the key under the kid the Authority signs');
  assert.equal(broker.database, r.layout.BrokerDb);
  assert.ok(!('attestationKeyId' in authority), 'no attestation key is pinned: tier careful, a person for every action');
  assert.ok(JSON.stringify(broker).length < 4096 && JSON.stringify(authority).length < 4096);
});

test('config checks refuse what the C# parsers refuse (extra or missing key, relative / slash path, group or ALL SERVICES SID, generation 0, non-P-256 key, one SID for both pipes ...)', needsWindows, () => {
  const { r } = lib();
  const expectations = {
    extraKey: 'config_keys', missingKey: 'config_keys', relativeDb: 'database', slashDb: 'database', groupSid: 'control_plane_sid', allServicesSid: 'control_plane_sid',
    generationZero: 'generation', rsaKey: 'authority_keys', badPipe: 'pipe_name', notJson: 'config_syntax', tooBig: 'config_too_large',
  };
  for (const [name, reason] of Object.entries(expectations)) assert.ok(r.brokerBad[name].includes(reason), `broker ${name} -> ${reason}, got ${JSON.stringify(r.brokerBad[name])}`);
  const authorityExpect = {
    sameSid: 'sids_not_distinct', approverVirtual: 'approver_sid', pipeRootLower: 'pipe_root', providerOther: 'signing_provider', audienceUpper: 'audience',
    numberValue: 'config_keys', ecApproverKey: 'approver_public_key', extraKey: 'config_keys',
  };
  for (const [name, reason] of Object.entries(authorityExpect)) assert.ok(r.authorityBad[name].includes(reason), `authority ${name} -> ${reason}, got ${JSON.stringify(r.authorityBad[name])}`);
});

test('the Control Plane settings the script writes are accepted by the Control Plane\'s own parser (no secret, attestation null, one computer)', needsWindows, () => {
  const { r } = lib();
  const settings = parseApprovalSettings(r.settingsJson);
  assert.equal(settings.projectId, 'albera-host');
  assert.equal(settings.attestation, null);
  assert.deepEqual([...settings.computers], [['albera-clone-01', { computerId: 'clone-01' }]]);
  assert.deepEqual(settings.broker, { pipeName: r.constants.BrokerPipeName, expect: { serviceName: 'AlberaHostBroker' } });
  assert.deepEqual(settings.authority, { pipeRoot: r.constants.AuthorityPipeRoot, expect: { serviceName: 'AlberaApprovalAuthority' } });
  assert.equal(settings.journal, r.layout.ControlPlaneJournal);
  assert.equal(path.win32.dirname(settings.journal), path.win32.dirname(r.layout.ApprovalSettings), 'the journal sits in the folder the Control Plane account may write');
  assert.equal(/secret|password|token|key/iu.test(r.settingsJson.replace(/"keyFile"/gu, '')), false);
});

test('ACL plan: inheritance is removed everywhere, each service SID can write only its own folder, the Control Plane account only its own, nobody else gets write', needsWindows, () => {
  const { r } = lib();
  const sids = { broker: r.sidBroker, authority: r.sidAuthority };
  const byPath = new Map(r.aclPlan.map((entry) => [entry.path, entry.grants]));
  assert.deepEqual([...byPath.keys()], [r.layout.InstallRoot, r.layout.DataRoot, r.layout.BrokerConfigDir, r.layout.BrokerDbDir, r.layout.AuthorityDir, r.layout.ControlPlaneDir]);
  const rights = (dir) => Object.fromEntries(byPath.get(dir).map((grant) => { const m = grant.match(/^\*(S-[0-9-]+):(.+)$/u); return [m[1], m[2]]; }));
  const cp = 'S-1-5-21-1111111111-2222222222-3333333333-1500';
  for (const grants of byPath.values()) {
    const g = Object.fromEntries(grants.map((grant) => { const m = grant.match(/^\*(S-[0-9-]+):(.+)$/u); return [m[1], m[2]]; }));
    assert.equal(g['S-1-5-18'], '(OI)(CI)F');
    assert.equal(g['S-1-5-32-544'], '(OI)(CI)F');
    assert.equal(Object.keys(g).every((sid) => sid === 'S-1-5-18' || sid === 'S-1-5-32-544' || [sids.broker, sids.authority, cp].includes(sid)), true, 'only the three accounts are named');
  }
  const writers = (dir) => Object.entries(rights(dir)).filter(([sid, right]) => ![ 'S-1-5-18', 'S-1-5-32-544'].includes(sid) && /M$|F$/u.test(right)).map(([sid]) => sid);
  assert.deepEqual(writers(r.layout.InstallRoot), [], 'the binaries are read/execute only');
  assert.deepEqual(writers(r.layout.DataRoot), []);
  assert.deepEqual(writers(r.layout.BrokerConfigDir), [], 'the Broker cannot write its own config');
  assert.deepEqual(writers(r.layout.BrokerDbDir), [sids.broker]);
  assert.deepEqual(writers(r.layout.AuthorityDir), [sids.authority], 'the Authority writes policy.json next to its config');
  assert.deepEqual(writers(r.layout.ControlPlaneDir), [cp]);
  assert.equal(rights(r.layout.DataRoot)[cp], 'RX', 'this-folder-only read: the control plane account can reach its folder and nothing else');
  assert.equal(r.aclGood, 0);
  assert.deepEqual(r.aclInherited, ['inheritance_not_removed']);
  assert.deepEqual(r.aclEveryone, ['unexpected_principal:S-1-1-0']);
  assert.ok(r.aclMissing.some((d) => d.startsWith('missing_principal:')));
  assert.ok(r.aclOwnerUser.includes('owner_untrusted'));
});

test('services: the sc.exe arguments quote the path with a space, the Broker SDDL grants the Control Plane account only LC, and the fact checks catch each deviation', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.brokerCommandLine, '"C:\\Program Files\\Albera\\bin\\broker\\albera-windows-broker.exe" service "C:\\ProgramData\\Albera\\broker-config\\AlberaHostBroker.service.json"');
  assert.equal(r.scCreate, `create AlberaHostBroker binPath= "${r.brokerCommandLine.replace(/"/gu, '\\"')}" obj= "NT SERVICE\\AlberaHostBroker" start= demand type= own`);
  assert.equal(r.sddl, 'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;S-1-5-21-1111111111-2222222222-3333333333-1500)');
  assert.equal(r.sddlOk, 0);
  assert.deepEqual(r.sddlExtraUsers, ['unexpected_principal:S-1-5-32-545']);
  assert.deepEqual(r.sddlCpMore, ['control_plane_access_not_lc']);
  assert.deepEqual(r.sddlNoCp, ['control_plane_ace_missing']);
  assert.deepEqual(r.sddlJunk, ['sddl_unreadable']);
  // the lab's SDDL, character for character, with the Control Plane's SID in place of the lab service SID
  const lab = readFileSync(path.join(root, 'test', 'windows-service-lab', 'lab-guest.ps1'), 'utf8').match(/sc\.exe sdset \$B "(D:\(A;;[^"]*)\(A;;LC;;;\$\{SidC\}\)"/u);
  assert.ok(lab, 'the lab SDDL is still where this test expects it');
  assert.equal(r.sddl, `${lab[1]}(A;;LC;;;S-1-5-21-1111111111-2222222222-3333333333-1500)`);
  assert.equal(r.factsOk, 0);
  assert.deepEqual(r.factsBad.missing, ['service_missing']);
  assert.deepEqual(r.factsBad.localSystem, ['start_name_differs']);
  assert.deepEqual(r.factsBad.otherPath, ['path_differs']);
  assert.deepEqual(r.factsBad.auto, ['start_mode_not_demand']);
  assert.deepEqual(r.factsBad.shared, ['not_own_process']);
  assert.deepEqual(r.factsBad.unrestricted, ['sid_type_not_restricted']);
  assert.deepEqual(r.factsBad.impersonate, ['privileges_not_minimal']);
  assert.deepEqual(r.factsBad.noPrivs, ['privileges_not_minimal']);
});

test('the lab hardening is copied, not reinvented: the script uses the same sc.exe sequence as lab-guest.ps1', () => {
  const lab = readFileSync(path.join(root, 'test', 'windows-service-lab', 'lab-guest.ps1'), 'utf8');
  const lib = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.match(lab, /obj= "NT SERVICE\\\$n" start= demand type= own/u);
  assert.match(lib, /obj= "NT SERVICE\\' \+ \$Name \+ '" start= demand type= own/u);
  assert.match(lab, /sc\.exe sidtype \$n restricted/u);
  assert.match(script, /sidtype \$\(\$spec\.Name\) restricted/u);
  assert.match(lab, /sc\.exe privs \$n SeChangeNotifyPrivilege/u);
  assert.match(script, /privs \$\(\$spec\.Name\) SeChangeNotifyPrivilege/u);
  assert.match(lab, /\/inheritance:r', '\/grant:r', '\*S-1-5-18:\(OI\)\(CI\)F', '\/grant:r', '\*S-1-5-32-544:\(OI\)\(CI\)F'/u);
  assert.match(script, /\/inheritance:r/u);
  const keyTool = readFileSync(path.join(root, 'test', 'windows-service-lab', 'new-authority-key.ps1'), 'utf8');
  assert.match(keyTool, /ExportPolicy = if \(\$Variant -eq 'exportable'\) \{[^}]*\} else \{ \[System\.Security\.Cryptography\.CngExportPolicies\]::None \}/u);
  assert.match(keyTool, /\$sddl = "D:P\(A;;GA;;;SY\)\(A;;GA;;;BA\)\(A;;GA;;;\$ServiceSid\)"/u);
  assert.match(lib, /ExportPolicy = \[System\.Security\.Cryptography\.CngExportPolicies\]::None/u);
  assert.match(lib, /"D:P\(A;;GA;;;SY\)\(A;;GA;;;BA\)\(A;;GA;;;\$ServiceSid\)"/u);
});

test('signing key checks: exportable, broad ACE, another service SID and a user owner are each refused; the SDDL names only SYSTEM, Administrators and the service', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.keyGood, 0);
  assert.deepEqual(r.keyExportable, ['key_exportable']);
  assert.deepEqual(r.keyEveryone, ['ace_untrusted']);
  assert.deepEqual(r.keyBrokerSid, ['ace_untrusted']);
  assert.deepEqual(r.keyOwnerUser, ['owner_untrusted']);
  assert.equal(r.keySddl, `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;${r.sidAuthority})`);
  assert.deepEqual(r.keyNameOk, [true, false, false]);
});

test('removal safety, path rules, the lab gate and id grammar', needsWindows, () => {
  const { r } = lib();
  assert.deepEqual(r.unknownEntries, ['broker\\notes.txt', 'control-plane\\sub\\x']);
  assert.deepEqual(r.pathsOk, [true, true]);
  assert.deepEqual(r.pathsBad, [false, false, false, false, false, false, false, false]);
  assert.deepEqual(r.gate, { labSupplied: true, notLab: 'control_plane_password_parameter_is_lab_only', labWrongValue: 'control_plane_password_parameter_is_lab_only', noPassword: true });
  assert.deepEqual(r.ids, [true, true, false, false, false]);
});

// ---- the signing key function, in user scope ----

test('New-AuthoritySigningKey (user scope, no admin): non-exportable ECDSA P-256, read back, and the SPKI it returns verifies a signature made with the key (checked by Node)', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const name = `AlberaHostTestKey-${randomBytes(6).toString('hex')}`;
  const message = randomBytes(48);
  const out = lastJson(ps(['-File', path.join(driverDir, 'key-check.ps1'), '-KeyName', name, '-MessageBase64', message.toString('base64')]).stdout);
  assert.equal(out.report.exportPolicy, 0, 'Export Policy none');
  assert.equal(out.report.keySize, 256);
  assert.match(out.report.algorithm, /ECDSA/u);
  assert.ok(out.report.allowSids.includes('S-1-5-18') && out.report.allowSids.includes('S-1-5-32-544') && out.report.allowSids.includes(out.serviceSid));
  assert.equal(out.readSpkiEqual, true);
  assert.equal(out.exists, true);
  const key = createPublicKey({ key: Buffer.from(out.spki, 'base64'), format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(out.signature, 'base64')), true, 'the SPKI is the public half of the stored key');
  assert.equal(verify('sha256', randomBytes(48), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(out.signature, 'base64')), false);
  assert.match(out.secondCreateRefused, /key_already_exists/u, 'an existing key is never touched');
  assert.match(out.machineNeedsServiceSid, /service_sid_invalid/u, 'a machine key can only be granted to a per-service SID');
  assert.equal(out.removed, true);
  assert.equal(out.existsAfter, false);
});

// ---- the system-touching helpers, against a temp folder ----

const harness = (t, kind) => lastJson(ps(['-File', path.join(driverDir, 'function-harness.ps1'), '-Case', kind, '-Work', scratch(t)]).stdout);

test('copy: three builds are copied with every file hashed, recorded in the manifest, re-run changes nothing, a tampered or stale copy is refused, a leftover .partial is replaced', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'copy');
  assert.equal(r.firstRunError, null);
  assert.deepEqual(r.recorded, ['authority', 'broker', 'pipe-client']);
  assert.equal(r.destFiles.length, 12);
  assert.ok(r.destFiles.includes('broker\\sub\\data.json'));
  assert.equal(r.noPartialLeft, true);
  assert.equal(r.treeEqual, true);
  assert.equal(r.exeShaRecorded, true);
  assert.equal(r.secondRunError, null);
  assert.equal(r.secondRunUntouched, true, 'a second run leaves the copied files alone');
  assert.match(r.tamperedError, /already exists and differs from the build/u);
  assert.equal(r.afterPartialError, null);
  assert.equal(r.staleGone, true);
  assert.equal(r.secondCopied, true);
  assert.deepEqual(r.manifestReread, ['authority', 'broker', 'pipe-client'], 'the manifest on disk round-trips');
  assert.equal(r.manifestState, 'partial');
});

test('build manifest check: ok, missing, no manifest, changed exe, malformed manifest', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'exe');
  assert.deepEqual({ ...r, case: undefined }, { case: undefined, ok: 'ok', missing: 'missing', noManifest: 'manifest_missing', changed: 'sha256_differs_from_manifest', badManifest: 'manifest_invalid' });
});

test('removal: only known files are deleted; an unknown file, a sub-folder or a junction stops the removal and nothing is deleted there', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'remove');
  assert.match(r.unknownRefused, /holds files this script did not create \(control-plane\\my-notes\.txt\); nothing was deleted there/u);
  assert.equal(r.unknownKept, true);
  assert.equal(r.knownRemoved, null);
  assert.equal(r.knownGone, true);
  assert.match(r.subfolderRefused, /authority\\extra/u);
  assert.equal(r.authorityKept, true);
  assert.equal(r.installTreeRemoved, null);
  assert.equal(r.installGone, true);
  assert.match(r.installUnknownRefused, /readme\.txt/u);
  assert.equal(r.installUnknownKept, true);
  assert.match(r.junctionRefused, /contains a link or junction/u);
  assert.equal(r.outsideIntact, true, 'the junction target was not followed or deleted');
});

test('the password comparison is exact and the SecureStrings are only compared, never shown', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'secure');
  assert.deepEqual({ ...r, case: undefined }, { case: undefined, same: true, differentLastChar: false, differentLength: false, reflexive: true });
});

test('the lab runner refuses to run outside the lab VM', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const result = ps(['-File', labRunner, '-HostScriptDir', hostDir, '-RepoRoot', root],{ allowFail: true, env: { ALBERA_LAB_VM: '' } });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + (result.stderr ?? ''), /lab VM|ALBERA_LAB_VM/u);
});
