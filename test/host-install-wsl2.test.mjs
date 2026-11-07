import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseApprovalSettings } from '../src/runtime/room-approval-wiring.mjs';

// The WSL2 computer of scripts/host/albera-host.ps1 (-AddWsl2Computer, ADR-012 phase 5) and the two lab scripts. NOTHING here creates a key, an account, a service, a task or an ACL on this PC:
//   - the PURE helpers of albera-host-lib.ps1 (config builders, validators, the agreement of the key and its copies) are called with keys Node makes,
//   - the install and uninstall steps run against a TEMP folder with FAKES for the machine (the key store, the registry, the ACL writes, the bridge program),
//   - measure-attestation-key.ps1 and lab-sec2.ps1 are dot-sourced (their functions only) and run with fakes for the key, the tasks and the account, with every way out forced.
// What is NOT run: the real key, the real ACLs, a real task or account, the real bridge. docs/architecture/host-install.md ("WSL2 computer") lists it.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostDir = path.join(root, 'scripts', 'host');
const driverDir = path.join(root, 'test', 'host-install');
const windows = process.platform === 'win32';
const POWERSHELL = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
const ps = (args, { allowFail = false, env = {} } = {}) => {
  try {
    return { code: 0, stdout: execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', timeout: 240_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv(), ...env } }) };
  } catch (error) {
    if (!allowFail) throw error;
    return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
};
const lastJson = (stdout) => JSON.parse(stdout.trim().split(/\r?\n/u).at(-1).replace(/^\uFEFF/u, ''));
const scratch = (t) => { const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'albera-wsl2-test-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const ecSpki = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const rsaSpki = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const reasons = (value) => [value].flat().filter((entry) => entry !== undefined && entry !== null);
const OWNER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const H = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const newScripts = ['measure-attestation-key.ps1', 'lab-sec2.ps1'].map((name) => path.join(hostDir, name));

test('the new scripts and drivers are ASCII only (Windows PowerShell 5.1 reads a file without a BOM as the ANSI code page)', () => {
  for (const file of [...newScripts, path.join(hostDir, 'albera-host.ps1'), path.join(hostDir, 'albera-host-lib.ps1'), ...['wsl2-lib-check.ps1', 'wsl2-harness.ps1', 'wsl2-lab-harness.ps1'].map((name) => path.join(driverDir, name))]) {
    assert.equal(/[^\t\r\n -~]/u.test(readFileSync(file, 'utf8')), false, `${path.relative(root, file)} has a non-ASCII character`);
  }
});

test('source guards of the new scripts: never elevate, no RunAs, no password on a command line or in plain-text cmdlets, no service made, no wsl.exe, no download', () => {
  for (const file of newScripts) {
    const text = readFileSync(file, 'utf8').replace(/^\s*#.*$/gmu, '');
    for (const forbidden of [/-Verb\s+RunAs/iu, /\bRunAs\b/u, /AsPlainText/u, /ConvertFrom-SecureString/u, /\bsc\.exe\b/iu, /New-Service/u, /\bwsl(\.exe)?\s/iu, /Invoke-WebRequest|Invoke-RestMethod|DownloadFile|Start-BitsTransfer|\bcurl\b|\bwget\b/iu, /Set-ExecutionPolicy/u, /\/RP\b|\/RU\b|net\s+user/iu]) {
      assert.equal(forbidden.test(text), false, `${path.basename(file)} must not contain ${forbidden}`);
    }
    assert.match(text, /\$PSModuleAutoLoadingPreference = 'None'/u, 'user modules cannot load into the elevated session');
  }
  const host = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.match(host, /Get-AuthorityConfig \$script:Sids\.ControlPlane \$approver \$current\.State\.Attestation/u, 'set-approver rewrites the Authority config and must keep the Broker attestation pin');
  const measure = readFileSync(newScripts[0], 'utf8');
  assert.deepEqual([...measure.matchAll(/Invoke-NativeShort \$(\w+)/gu)].map((m) => m[1]).filter((value, index, all) => all.indexOf(value) === index && value !== 'Exe'), ['SchtasksExe'], 'the only program the measurement starts itself is schtasks.exe (the tasks start powershell.exe)');
  const lab = readFileSync(newScripts[1], 'utf8');
  const labCode = lab.slice(0, lab.indexOf("@'")) + lab.slice(lab.indexOf("'@", lab.indexOf("@'")) + 2);   // the probe text is what the temporary account runs, not something this script starts
  assert.equal([...labCode.matchAll(/Process\]::Start/gu)].length, 1, 'one place starts a process as the temporary account');
  assert.match(lab, /\$psi\.UserName = \$Account\.Name; \$psi\.Domain = '\.'; \$psi\.Password = \$Account\.Password; \$psi\.LoadUserProfile = \$false/u, 'it carries the credentials in the start info, never on a command line');
});

// ---------------------------------------------------------------------------------------------- the pure helpers of the lib
const lib = (t) => {
  const keys = { a: ecSpki(), b: ecSpki(), rsa: rsaSpki() };
  const out = lastJson(ps(['-File', path.join(driverDir, 'wsl2-lib-check.ps1'), '-Spki', keys.a, '-OtherSpki', keys.b, '-Rsa', keys.rsa]).stdout);
  return { keys, r: out };
};

test('Test-ComputersList accepts kind wsl2 the way ServiceConfig.cs reads it, and nothing else', (t) => {
  const { r } = lib(t);
  const c = r.computers;
  for (const accepted of ['vmOnly', 'wsl2Only', 'mixed', 'empty', 'eight']) assert.equal(c[accepted], true, accepted);
  for (const refused of ['wsl2WithVm', 'otherKind', 'kindUppercase', 'sameIdTwoKinds', 'sameIdTwice', 'badId', 'extraKey', 'nine', 'notArray', 'stringValue']) assert.equal(c[refused], false, refused);
});

test('the Broker config: the wsl2 computer and the attestation key are added, the plain config is unchanged, and the one-VM check ignores the wsl2 entry', (t) => {
  const { r } = lib(t);
  const b = r.broker;
  assert.deepEqual(b.plainKeys, ['pipeName', 'database', 'authorityKeys', 'controlPlaneSid', 'generation', 'leaseId', 'policyVersion']);
  assert.deepEqual(b.wsl2Keys, [...b.plainKeys, 'computers', 'attestation']);
  assert.deepEqual(b.wsl2.computers, [{ computerId: 'wsl-01', kind: 'wsl2' }]);
  assert.deepEqual(b.wsl2.attestation, { keyName: 'AlberaHostBroker-attest-1', keyId: 'albera-broker-attest-1' });
  assert.deepEqual(b.bothComputers.map((entry) => Object.keys(entry).sort()), [['computerId', 'vmId'], ['computerId', 'kind']]);
  for (const key of ['plainReasons', 'wsl2Reasons', 'bothReasons']) assert.deepEqual(reasons(b[key]), [], key);
  assert.equal(b.bothHyperVRecordOk, true);
  assert.equal(b.wsl2OnlyHyperVRecord, false);
  assert.deepEqual(reasons(b.badAttestationName), ['attestation']);
  assert.deepEqual(reasons(b.badAttestationId), ['attestation']);
  assert.deepEqual(reasons(b.extraAttestationKey), ['attestation']);
  assert.deepEqual(reasons(b.badKind), ['computers']);
});

test('the Authority config pins the key (both fields or neither), and a rebuild of the config for set-approver keeps the pin', (t) => {
  const { keys, r } = lib(t);
  const a = r.authority;
  assert.equal(a.attKeys.filter((key) => key.startsWith('attestation')).length, 2);
  assert.equal(a.plainKeys.some((key) => key.startsWith('attestation')), false);
  assert.deepEqual(reasons(a.plainReasons), []);
  assert.deepEqual(reasons(a.attReasons), []);
  assert.deepEqual(reasons(a.onlyKeyId), ['config_keys']);
  assert.deepEqual(reasons(a.onlyPublicKey), ['config_keys']);
  assert.deepEqual(reasons(a.badSpki), ['attestation_public_key']);
  assert.deepEqual(reasons(a.badKeyId), ['attestation_key_id']);
  assert.equal(a.stateAttestationKeyId, 'albera-broker-attest-1');
  assert.equal(a.stateAttestationSpki, keys.a);
  assert.equal(a.plainStateAttestation, null);
  assert.equal(a.rebuiltEqualsOriginal, true, 'the config set-approver writes is the one it read, pin included');
});

test('the approval settings with the wsl2 block are accepted by the room\'s own parser, and refused by it where the installer says they are wrong', (t) => {
  const { r } = lib(t);
  const s = r.settings;
  assert.deepEqual(s.plainKeys, ['version', 'projectId', 'broker', 'authority', 'journal', 'computers']);
  assert.match(s.withoutHelperThrows, /wsl2_needs_desktop_block/u);
  assert.deepEqual(reasons(s.reasons), []);
  const parsed = parseApprovalSettings(s.json.replace('C:\\Program Files', 'C:\\Program Files'));
  assert.equal(parsed.wsl2.pipeName, 'ALBERA_WslBridge');
  assert.equal(parsed.wsl2.serverSid, OWNER);
  assert.equal(parsed.wsl2.git, String.raw`C:\Program Files\Git\mingw64\bin\git.exe`);
  assert.equal(parsed.computers.get('wsl-01').isolation, 'wsl2');
  assert.equal(parsed.computers.get('wsl-01').repositoryId, 'repo-main');
  assert.equal(parsed.computers.get('albera-clone-01').computerId, 'clone-01');
  const object = JSON.parse(s.json);
  assert.throws(() => parseApprovalSettings(JSON.stringify({ ...object, desktop: undefined })), /runtime_room_approval_wsl2/u, 'the parser needs the desktop block for a wsl2 block');
  assert.throws(() => parseApprovalSettings(JSON.stringify({ ...object, wsl2: { ...object.wsl2, git: 'C:\\Tools\\git.exe' } })), /runtime_room_approval_wsl2/u);
  assert.deepEqual(reasons(s.noWsl2Block), ['settings_wsl2_block']);
  assert.deepEqual(reasons(s.noComputer), ['settings_wsl2_computer']);
  assert.deepEqual(reasons(s.otherSid), ['settings_wsl2_block_differs']);
  assert.deepEqual(reasons(s.otherRepo), ['settings_wsl2_computer']);
  assert.deepEqual(reasons(s.noDesktop), ['settings_desktop']);
});

test('the bridge config has exactly the fifteen keys of BridgeConfig.cs and every wrong value gets its own fixed word', (t) => {
  const { r } = lib(t);
  const b = r.bridge;
  assert.deepEqual(b.keys, ['pipeName', 'controlPlaneSid', 'computerId', 'brokerKeyId', 'brokerSpki', 'leaseFloorPath', 'imagePath', 'imageSha256', 'distributionsFolder', 'stateFolder', 'gitPath', 'minWslVersion', 'minKernelVersion', 'floorExpiresAt', 'repositories']);
  const source = readFileSync(path.join(root, 'src', 'runtime', 'windows-wsl-bridge', 'BridgeConfig.cs'), 'utf8');
  const csKeys = [...source.match(/private static readonly string\[\] Keys = \[([^\]]+)\]/u)[1].matchAll(/"(\w+)"/gu)].map((m) => m[1]);
  assert.deepEqual([...b.keys].sort(), [...csKeys].sort(), 'the installer writes the keys the bridge reads');
  assert.deepEqual(reasons(b.reasons), []);
  const config = JSON.parse(b.json);
  assert.equal(config.leaseFloorPath, 'C:\\ProgramData\\Albera\\wsl-bridge\\lease-floor');
  assert.equal(config.imagePath, 'C:\\ProgramData\\Albera\\wsl-bridge\\albera-wsl2.tar');
  assert.deepEqual(config.repositories, [{ repositoryId: 'repo-main', path: 'C:\\Work\\repo' }]);
  assert.equal(config.floorExpiresAt, 1900000000);
  const expected = { missingKey: 'config_keys', extraKey: 'config_keys', badSid: 'control_plane_sid', badSpki: 'broker_key', relativePath: 'image', badHash: 'image_hash_format', floorZero: 'floor', badVersion: 'floor', noRepositories: 'repositories', dupRepositories: 'repositories', repositoryExtra: 'repositories', pipeBadStart: 'pipe_name', tooLarge: 'config_too_large', notJson: 'config_syntax' };
  for (const [name, word] of Object.entries(expected)) assert.deepEqual(reasons(b[name]), [word], name);
});

test('the inputs: each wrong value is named, and the floor must be in the future', (t) => {
  const { r } = lib(t);
  const i = r.inputs;
  assert.deepEqual(reasons(i.good), []);
  const expected = { sameAsVm: 'wsl2_computer_id_same_as_vm_computer', badComputer: 'wsl2_computer_id', noRepository: 'wsl2_repository_id', relativeRepositoryPath: 'wsl2_repository_path', imageHashShort: 'wsl2_image_sha256', treeHashUpper: 'wsl2_bridge_tree_hash', floorPast: 'wsl2_floor_expires_at', floorNow: 'wsl2_floor_expires_at', gitElsewhere: 'wsl2_git_path', gitNotExe: 'wsl2_git_path', gitTraversal: 'wsl2_git_path', gitPrefixTrick: 'wsl2_git_path' };
  for (const [name, word] of Object.entries(expected)) assert.deepEqual(reasons(i[name]), [word], name);
  assert.deepEqual(reasons(i.gitLowercase), [], 'Windows paths compare without case');
});

test('the bridge tree hash, the floor file, the Run entry and the ACL plan', (t) => {
  const { r } = lib(t);
  const files = { 'albera-wsl-bridge.exe': H, 'sub/data.json': 'f'.repeat(64), 'a.dll': '1'.repeat(64) };
  const text = Object.keys(files).sort().map((rel) => `${rel}\t${files[rel]}\n`).join('');
  assert.equal(r.treeHash, sha256(text), 'the same canonical lines as the other tree hashes, sorted ordinal');
  assert.match(r.treeHashErrors.empty, /wsl2_tree_hash_empty/u);
  assert.match(r.treeHashErrors.traversal, /wsl2_tree_hash_path/u);
  assert.equal(r.floor.text, '7\r\n');
  assert.deepEqual(r.floor.read, { ok: 7, noEol: 12, empty: null, text: null, zero: null, negative: null, twoLines: null, long: null });
  assert.match(r.floor.zeroThrows, /wsl2_generation_invalid/u);
  assert.deepEqual(r.run, { name: 'AlberaWslBridge', command: '"C:\\Program Files\\Albera\\bin\\wsl-bridge\\albera-wsl-bridge.exe" serve "C:\\ProgramData\\Albera\\wsl-bridge\\bridge.json"', keyPath: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' });
  assert.deepEqual(r.acl.paths, ['C:\\ProgramData\\Albera\\wsl-bridge', 'C:\\ProgramData\\Albera\\wsl-bridge\\state', 'C:\\ProgramData\\Albera\\wsl-bridge\\distributions']);
  assert.deepEqual(r.acl.grants[0], ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${OWNER}:(OI)(CI)RX`], 'the owner reads the config, the floor and the image and writes nothing there');
  assert.deepEqual(r.acl.grants[1], ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${OWNER}:(OI)(CI)M`]);
  assert.equal(r.acl.writers[0].includes(OWNER), false);
  assert.equal(r.acl.writers[1].includes(OWNER), true);
  assert.equal(r.acl.writers[2].includes(OWNER), true);
  assert.match(r.acl.noOwnerThrows, /wsl2_owner_sid_missing/u);
  const sids = r.acl.grants.flat().join(' ');
  assert.equal(/S-1-5-80/u.test(sids), false, 'no service SID (Broker, Authority, Control Plane) has a rule on the bridge folders');
});

test('the install record and the manifest shape know the WSL2 part and refuse a forged one', (t) => {
  const { r } = lib(t);
  const rec = r.record;
  assert.equal(rec.minimal, true);
  assert.equal(rec.full, true);
  for (const bad of ['extraKey', 'otherKeyName', 'otherRunName', 'badHash', 'badGit', 'notDictionary']) assert.equal(rec[bad], false, bad);
  assert.deepEqual(reasons(r.manifest.withRecord), []);
  assert.deepEqual(reasons(r.manifest.badRecord), ['wsl2_record']);
  assert.deepEqual(reasons(r.manifest.badSpki), ['attestation_spki']);
});

test('the agreement check reads the key and its three copies back and names every disagreement', (t) => {
  const { r } = lib(t);
  const a = r.agreement;
  assert.deepEqual(reasons(a.allAgree), []);
  const expected = {
    liveKeyDiffers: ['authority_spki', 'bridge_spki'], authorityPinsOther: ['authority_spki'], authorityKeyId: ['authority_key_id'], authorityNoPin: ['authority_key_id', 'authority_spki'],
    bridgeSpki: ['bridge_spki'], bridgeKeyId: ['bridge_key_id'], brokerKeyId: ['broker_attestation_differs'], brokerKeyName: ['broker_attestation_differs'], brokerNoAttestation: ['broker_attestation', 'broker_wsl2_computer'],
    brokerNoWsl2: ['broker_wsl2_computer'], brokerOtherComputer: ['broker_wsl2_computer'], bridgeComputer: ['bridge_computer_id'], bridgeRepository: ['bridge_repository'],
    floorAbove: ['floor_above_generation'], floorBelow: [], floorMissing: ['floor_unreadable'], floorGarbage: ['floor_unreadable'],
    brokerUnreadable: ['broker_config_unreadable'], authorityUnreadable: ['authority_config_unreadable'], bridgeUnreadable: ['bridge_config_unreadable'], badLiveSpki: ['live_key_spki', 'authority_spki', 'bridge_spki'],
  };
  for (const [name, words] of Object.entries(expected)) assert.deepEqual(reasons(a[name]).sort(), [...words].sort(), name);
});

// ---------------------------------------------------------------------------------------------- the script, with fakes for the machine
const harness = (t, kind, extra = []) => {
  const keys = { a: ecSpki(), b: ecSpki(), rsa: rsaSpki() };
  const work = scratch(t);
  return { keys, work, r: lastJson(ps(['-File', path.join(driverDir, 'wsl2-harness.ps1'), '-Case', kind, '-Work', work, '-Spki', keys.a, '-OtherSpki', keys.b, '-Rsa', keys.rsa, ...extra]).stdout) };
};

test('the WSL2 steps sit after the steps they depend on, and appear only with the option (install) or the record (uninstall); the Run entry is NOT an install step', (t) => {
  const { r } = harness(t, 'steps');
  const plain = ['sources', 'approver', 'dataroot', 'services', 'folders', 'binaries', 'key', 'node', 'claude', 'configs', 'cpservice', 'shortcuts', 'finish'];
  assert.deepEqual(r.installPlain, plain, 'without the option the install is the install it was');
  assert.deepEqual(r.installWsl2, ['sources', 'approver', 'wsl2inputs', 'dataroot', 'services', 'folders', 'binaries', 'key', 'wsl2key', 'node', 'claude', 'configs', 'wsl2folders', 'wsl2files', 'wsl2verify', 'cpservice', 'shortcuts', 'finish']);
  assert.deepEqual(r.installBoth, ['sources', 'approver', r.hyperVVmId, 'wsl2inputs', 'dataroot', 'services', 'hyperv', 'folders', 'binaries', 'key', 'wsl2key', 'node', 'claude', 'configs', 'wsl2folders', 'wsl2files', 'wsl2verify', 'cpservice', 'shortcuts', 'finish']);
  assert.deepEqual(r.uninstallPlain, ['runentry', 'shortcuts', 'services', 'key', 'installroot', 'data', 'user', 'manifest']);
  assert.deepEqual(r.uninstallWsl2, ['wsl2run', 'runentry', 'shortcuts', 'services', 'key', 'wsl2key', 'installroot', 'data', 'user', 'manifest']);
  assert.ok(r.dataFolders.includes(r.wslDataDir), 'the bridge data folder is one of the data folders uninstall removes');
  assert.ok(r.wslDataDir.endsWith('\\wsl-bridge'));
});

test('the inputs of a step come from the options, and status and uninstall (no options) fall back to the install record', (t) => {
  const { r } = harness(t, 'inputs');
  assert.equal(r.fromOptions.ComputerId, 'wsl-07');
  assert.equal(r.fromOptions.RepositoryId, 'repo-x');
  assert.equal(r.fromOptions.FloorExpiresAt, 1900000000);
  assert.equal(r.defaults.ComputerId, 'wsl-01');
  assert.equal(r.defaults.GitPath, String.raw`C:\Program Files\Git\mingw64\bin\git.exe`, 'the default is the real git.exe, not the cmd\\git.exe launcher');
  assert.equal(r.fromRecord.ComputerId, 'wsl-09');
  assert.equal(r.fromRecord.RepositoryId, 'repo-rec');
  assert.equal(r.fromRecord.GitPath, String.raw`C:\Program Files\Git\mingw64\bin\git.exe`);
  assert.equal(r.fromRecord.ImageSha256, H);
  assert.equal(r.floorNotNumber, 0, 'a floor that is not a number is zero, which the input check refuses');
});

test('install, with fakes: the key is refused when it exists, the configs carry its public half, the files are made, NO program is started, the copies must agree (floor equal to the generation, readable by three accounts only), and the Run entry is a later, separate step', (t) => {
  const { keys, r } = harness(t, 'install');
  // the key step
  assert.equal(r.keyStepBlockedWhenForeignKeyExists.startsWith('blocked:'), true);
  assert.match(r.keyStepBlockedWhenForeignKeyExists, /never adopted/u);
  assert.equal(r.keyStepTodo, 'todo');
  assert.equal(r.keyStepDone, 'done');
  assert.equal(r.createdKeyArgs.name, 'AlberaHostBroker-attest-1');
  assert.equal(r.createdKeyArgs.sid, r.brokerSid, 'the Broker service SID, not the Authority and not the Control Plane');
  assert.equal(r.createdKeyArgs.scope, 'machine');
  assert.equal(r.record.keyId, 'albera-broker-attest-1');
  assert.equal(r.valuesSpki, keys.a);
  // the three files and the settings
  assert.equal(r.brokerConfig.attestation.keyName, 'AlberaHostBroker-attest-1');
  assert.deepEqual(r.brokerConfig.computers, [{ computerId: 'wsl-01', kind: 'wsl2' }]);
  assert.equal(r.authorityConfig.attestationPublicKey, keys.a);
  assert.equal(r.authorityConfig.attestationKeyId, 'albera-broker-attest-1');
  const settings = JSON.parse(r.settingsText);
  settings.desktop.helperPath = String.raw`C:\Program Files\Albera\bin\pipe-client\albera-windows-broker-pipe-client.exe`;   // the room's parser pins the real install folder; the harness layout is a temp folder
  assert.equal(parseApprovalSettings(JSON.stringify(settings)).wsl2.serverSid, OWNER);
  assert.deepEqual(r.configsStepBefore, 'todo');
  assert.deepEqual(r.configsStepAfter, 'done');
  assert.equal(r.configsStepAfterTamper, 'todo', 'a config that lost the pin is written again');
  // folders, copies, floor, config
  assert.deepEqual(r.foldersStepBefore, 'todo');
  assert.deepEqual(r.filesStepBefore, 'todo');
  assert.equal(r.bridgeTree, r.expectedBridgeTree, 'the copy was hashed with the same canonical lines Node uses');
  assert.equal(r.bridgeRecord.bridgeTreeSha256, r.expectedBridgeTree);
  assert.equal(r.imageRecord, r.expectedImageSha);
  assert.equal(r.floorFileText, '1\r\n');
  assert.deepEqual(r.bridgeConfig.repositories, [{ repositoryId: 'repo-main', path: r.repositoryPath }]);
  assert.equal(r.bridgeConfig.brokerSpki, keys.a);
  assert.equal(r.bridgeConfig.controlPlaneSid, r.controlPlaneSid);
  assert.equal(r.ownerAclOnBin, `*${OWNER}:(OI)(CI)RX`, 'the bridge folder is given to the owner read-only');
  assert.equal(r.filesStepAfter, 'done');
  assert.equal(r.filesStepAfterFloorChanged, 'todo');
  // refusals of the copies
  assert.match(r.wrongTreeHashError, /not to -Wsl2BridgeTreeHash.*deleted/u);
  assert.equal(r.partialLeftAfterWrongTree, false);
  assert.match(r.wrongImageError, /not to -Wsl2ImageSha256/u);
  assert.equal(r.imageLeftAfterWrong, false);
  assert.match(r.installedCopyChangedError, /update means uninstall/u);
  // H1: the install starts nothing. The first-start config is written and KEPT for the normal-console command
  assert.equal(r.verifyOk, null);
  assert.equal(r.firstStartConfig.controlPlaneSid, OWNER, 'the first-start config names the owner as the Control Plane');
  assert.deepEqual(r.firstStartConfig.repositories, [{ repositoryId: 'repo-main', path: r.repositoryPath }], 'and is otherwise the real bridge config');
  assert.equal(r.firstStartConfig.pipeName, r.bridgeConfig.pipeName);
  assert.equal(r.firstStartConfigKept, true);
  assert.match(r.verifyDisagree, /do not agree: .*authority_spki/u);
  assert.match(r.verifyKeyExportable, /key_key_exportable/u);
  assert.match(r.verifyKeyAclExtra, /key_ace_untrusted/u);
  // L1 and L2
  assert.match(r.verifyFloorAbove, /floor_above_generation/u);
  assert.match(r.verifyFloorReadableByUsers, /floor_acl:S-1-5-32-545/u);
  assert.match(r.copyFloorReadableByUsers, /lease floor file can be read by more than Administrators, SYSTEM and you/u);
  // L3: the bridge config on disk against the record
  assert.equal(r.status_pipeName, 'bridge_pipe_name');
  assert.equal(r.status_gitPath, 'bridge_git_path');
  assert.equal(r.status_imageSha256, 'bridge_image_sha256');
  assert.equal(r.status_controlPlaneSid, 'bridge_control_plane_sid');
  // M2 and the order: the owner's word, compared; the Run entry only after it
  assert.ok(r.statusBeforeConfirm.some((line) => line.State === 'FAIL' && /first start of the bridge in a normal console: NOT recorded/u.test(line.Text)));
  assert.equal(r.confirmElevated, 3, '"elevated" is refused: the bridge was run in an elevated console');
  assert.equal(r.confirmOther, 3);
  assert.equal(r.firstStartRecordedAfterRefusals, false);
  assert.equal(r.runEntryBeforeFirstStart, 3, 'no Run entry before the first start is recorded');
  assert.equal(r.runValueBeforeFirstStart, null);
  assert.equal(r.confirmRight, 0);
  assert.equal(r.firstStartRecord.word, 'control_plane_is_self');
  assert.equal(r.manifestShapeAfterConfirm, true);
  assert.equal(r.runEntryWhenKeyDiffers, 3, 'and not when the key and its copies do not read back as installed');
  assert.equal(r.runEntryOk, 0);
  assert.equal(r.runValue, r.expectedRunCommand);
  assert.equal(r.runRecord.command, r.expectedRunCommand);
  assert.equal(r.stepIdsHaveNoRun, true, 'the Run entry is not one of the install steps');
  // status
  assert.ok(r.statusLines.every((line) => line.State === 'ok'), JSON.stringify(r.statusLines.filter((line) => line.State !== 'ok')));
  assert.ok(r.statusLines.length >= 8);
  assert.equal(r.statusFloorWarning, 1, 'a floor that differs from the generation is said in words');
  assert.ok(r.statusTamperedLines.some((line) => line.State === 'FAIL' && /bridge/u.test(line.Text)));
  assert.equal(r.statusWithoutRecord, 0);
});

test('uninstall, with fakes: the Run value goes first and only if it is the command install wrote, the key is deleted, the owner\'s rules leave state and distributions BEFORE the recursive delete, and a locked lab folder next to the data folder does not stop it', (t) => {
  const { r } = harness(t, 'uninstall');
  assert.equal(r.runStepBefore, 'todo');
  assert.equal(r.runValueAfter, null);
  assert.equal(r.foreignRunValueKept, true, 'a Run value that is not the recorded command is left alone');
  assert.equal(r.keyStepBefore, 'todo');
  assert.deepEqual(r.deletedKeys, ['AlberaHostBroker-attest-1']);
  assert.equal(r.keyStepAfter, 'done');
  assert.equal(r.dataFolderExistsBefore, true);
  assert.equal(r.dataFolderExistsAfter, false);
  assert.match(r.dataFolderWithForeignFile, /holds files this script did not create/u);
  assert.equal(r.dataFolderForeignFileStillThere, true);
  // M1
  const adminOnly = ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'];
  const names = r.daclLog.map((entry) => entry.path.split('\\').slice(-1)[0]);
  assert.deepEqual(names.sort(), ['distributions', 'state']);
  for (const entry of r.daclLog) {
    assert.deepEqual(entry.grants, adminOnly, 'administrators and SYSTEM only');
    assert.equal(entry.existed && entry.hadFiles, true, 'the rule is taken off while the files are still there, before the delete');
  }
  // H2: the lab folder is outside the data folder, so a leftover (even a locked one) never blocks uninstall
  assert.equal(r.labSiblingStillThere, true);
  assert.equal(r.dataStepWithLockedLab, null);
});

test('-Mode wsl2-hashes prints the tree hash of the bridge publish folder, the same one the install checks the copy against', (t) => {
  const work = scratch(t);
  const publish = path.join(work, 'src', 'runtime', 'windows-wsl-bridge', 'bin', 'Release', 'net10.0-windows', 'win-x64', 'publish');
  mkdirSync(path.join(publish, 'sub'), { recursive: true });
  writeFileSync(path.join(publish, 'albera-wsl-bridge.exe'), 'exe');
  writeFileSync(path.join(publish, 'a.dll'), 'dll');
  writeFileSync(path.join(publish, 'sub', 'x.json'), '{}');
  const out = ps(['-File', path.join(hostDir, 'albera-host.ps1'), '-Mode', 'wsl2-hashes', '-RepoRoot', work]).stdout;
  const expected = sha256(['a.dll', 'albera-wsl-bridge.exe', 'sub/x.json'].map((rel) => `${rel}\t${sha256(readFileSync(path.join(publish, ...rel.split('/'))))}\n`).join(''));
  assert.match(out, new RegExp(`ALBERA_WSL_BRIDGE_TREE_HASH=${expected}`, 'u'));
  const missing = ps(['-File', path.join(hostDir, 'albera-host.ps1'), '-Mode', 'wsl2-hashes', '-RepoRoot', path.join(work, 'nowhere')], { allowFail: true });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stdout, /bridge publish folder is missing/u);
});

test('the real script: the WSL2 options are refused without -AddWsl2Computer and outside install, and the plan lists the steps, blocked with the reasons, changing nothing', () => {
  const host = (args) => ps(['-File', path.join(hostDir, 'albera-host.ps1'), ...args], { allowFail: true });
  const alone = host(['-Mode', 'plan', '-Wsl2Image', 'C:\\x.tar']);
  assert.equal(alone.code, 2);
  assert.match(alone.stdout, /only apply together with -AddWsl2Computer/u);
  for (const mode of ['status', 'uninstall']) {
    const refused = host(['-Mode', mode, '-AddWsl2Computer']);
    assert.notEqual(refused.code, 0, mode);
    assert.match(refused.stdout, /-AddWsl2Computer only applies to -Mode install|needs an elevated console/u, mode);
  }
  const migrate = host(['-Mode', 'plan', '-PlanFor', 'migrate', '-AddWsl2Computer']);
  assert.equal(migrate.code, 2);
  const plan = host(['-Mode', 'plan', '-AddWsl2Computer']);
  assert.equal(plan.code, 0);
  const lines = plan.stdout.split(/\r?\n/u);
  const at = (needle) => lines.findIndex((line) => line.includes(needle));
  assert.ok(at('Check the WSL2 options') > at('Check the approver values') && at('Check the WSL2 options') < at('Create C:\\ProgramData\\Albera'), 'the inputs are checked before anything is created');
  assert.ok(at('Create the Broker attestation key') > at('Create the Authority machine signing key'));
  assert.ok(at('Write the first-start config') > at('Write the Broker config'));
  assert.equal(/HKLM Run value AlberaWslBridge/u.test(plan.stdout), false, 'the Run entry is not an install step');
  assert.equal(/Start the installed bridge/u.test(plan.stdout), false, 'and nothing starts the bridge');
  assert.match(plan.stdout, /wsl2_repository_id.*wsl2_floor_expires_at/u, 'the blocked reasons are named');
  assert.match(plan.stdout, /PLAN ONLY: nothing was changed/u);
  const withoutOption = host(['-Mode', 'plan']);
  assert.equal(/WSL2|wsl2/u.test(withoutOption.stdout), false, 'without the option the plan does not mention it');
});

// ---------------------------------------------------------------------------------------------- the two lab scripts, with fakes
const lab = (t, kind) => lastJson(ps(['-File', path.join(driverDir, 'wsl2-lab-harness.ps1'), '-Case', kind, '-Work', scratch(t)]).stdout);

test('measure-attestation-key.ps1: names, identities, error names, the task XML and the answers; a task that did not run is never an answer; the report holds no key material', (t) => {
  const r = lab(t, 'measure-pure');
  assert.match(r.keyName, /^AlberaMeasure-[0-9a-f]{12}$/u);
  assert.equal(r.shortRandomThrows, 'random_too_short');
  assert.deepEqual(r.identities.map((i) => [i.Id, i.Account, i.MustSign]), [['broker', 'NT SERVICE\\AlberaMeasureBroker', true], ['other', 'NT SERVICE\\AlberaMeasureOther', false], ['controlplane', 'NT SERVICE\\AlberaControlPlane', false]]);
  for (const identity of r.identities) assert.match(identity.Sid, /^S-1-5-80(-\d+){5}$/u);
  assert.equal(new Set(r.identities.map((i) => i.Sid)).size, 3);
  assert.deepEqual(r.errorNames, { badKeyset: 'NTE_BAD_KEYSET', perm: 'NTE_PERM', exists: 'NTE_EXISTS', denied: 'E_ACCESSDENIED', unknown: 'unknown_0x12345678', none: null });
  assert.equal(r.taskService.valid, true);
  assert.equal(r.taskService.logonType, 'ServiceAccount');
  assert.equal(r.taskService.userId, 'NT SERVICE\\AlberaMeasureOther');
  assert.equal(r.taskService.runLevel, 'LeastPrivilege');
  assert.equal(r.taskService.triggers, 0, 'a task with no trigger runs only when it is asked to');
  assert.equal(r.taskInteractive.logonType, 'InteractiveToken');
  assert.equal(r.taskInteractive.runLevel, 'LeastPrivilege');
  assert.equal(r.taskEscaped.argumentsRoundTrip, true);
  assert.equal(r.verdicts.nonAdministratorCanTakeTheName, 'no');
  assert.equal(r.verdicts.keyCannotBeExported, 'yes');
  assert.equal(r.verdicts.signs_broker, 'yes');
  assert.equal(r.verdicts.signs_other, 'no');
  assert.equal(r.verdicts.asExpected_other, 'yes');
  assert.equal(r.verdicts.aclAllows_controlplane, 'no');
  assert.equal(r.verdicts.fileAclAllows_broker, 'yes');
  assert.equal(r.verdictsUnrun.signs_controlplane, 'not_measured', 'a task Windows would not run is not a pass');
  assert.equal(r.verdictsUnrun.asExpected_controlplane, 'not_measured');
  assert.equal(r.verdictsUnrun.nonAdministratorCanTakeTheName, 'not_measured');
  assert.equal(r.verdictsWrong.asExpected_other, 'NO', 'another account that CAN sign is flagged');
  assert.deepEqual(reasons(r.reportGood), []);
  assert.deepEqual(reasons(r.reportBlob), ['long_blob']);
  assert.deepEqual(reasons(r.reportPrivate), ['key_material']);
  assert.deepEqual(reasons(r.reportMissing), ['missing_cleanup']);
  assert.ok(r.planLines.length >= 6);
});

test('measure-attestation-key.ps1, with fakes: N7 runs every step in order and cleans up; C6 reads the installed key and creates and deletes NOTHING; a failure still writes the report; a leftover is removed by name and the real key never', (t) => {
  const r = lab(t, 'measure-flow');
  assert.deepEqual(r.normal.order, ['dir', 'dir', 'dir', 'create-name-nonadmin', 'create-key', 'export-sign', 'task:broker', 'task:other', 'task:controlplane', 'delete-key']);
  assert.equal(r.normal.reportWritten, true);
  assert.equal(r.normal.keyDeleted, true);
  assert.equal(r.normal.workRemoved, true);
  assert.deepEqual(r.normalCleanup.tasksLeft, []);
  assert.equal(r.markerAfterNormal, false, 'the pending marker is removed when everything is clean');
  assert.equal(r.normal.verdicts.nonAdministratorCanTakeTheName, 'no');
  assert.equal(r.normal.verdicts.asExpected_broker, 'yes');
  assert.equal(r.normal.createdKeyDacl[0], r.normal.brokerSid, 'the key is made for the stand-in Broker SID');
  assert.equal(/BEGIN|PRIVATE|Pkcs8/iu.test(r.normal.reportText), false, 'no key material in the report file');
  assert.equal(r.nonAdminMadeIt.deletedBeforeCreate, true, 'a key a non-administrator made first is deleted before the administrator creates the name');
  assert.equal(r.nonAdminMadeIt.verdict, 'yes');
  // C6 (after the install): the real key, the real services, nothing created, nothing deleted
  assert.deepEqual(r.c6.order, ['dir', 'dir', 'dir', 'read-installed-key', 'export-sign', 'task:broker', 'task:other', 'task:controlplane']);
  assert.equal(r.c6.threw, false);
  assert.equal(r.c6.keyStillThere, true, 'the installed key is never deleted');
  assert.equal(r.c6.keyName, 'AlberaHostBroker-attest-1');
  assert.equal(r.c6.phase, 'C6');
  assert.equal(r.c6.markerWritten, false);
  assert.equal(r.c6.verdicts.aclAllows_broker, 'yes');
  assert.equal(r.c6.verdicts.asExpected_controlplane, 'yes');
  // L4: a failure at any step still writes the report, with the failure in it
  for (const stage of ['create-key', 'export-sign', 'task:other']) {
    const f = r.failures[stage];
    assert.equal(f.threw, true, stage);
    assert.equal(f.reportWritten, true, `${stage}: the report is written`);
    assert.equal(f.reportFailed, true);
    assert.equal(f.reportHasFailedNote, true);
    assert.equal(f.keyDeleted, true, `${stage}: the key is deleted`);
    assert.equal(f.workRemoved, true, `${stage}: the work folder is removed`);
  }
  assert.equal(r.leftovers.code, 0);
  assert.equal(r.leftovers.throwawayGone, true);
  assert.equal(r.leftovers.realKeyKept, true);
  assert.equal(r.leftovers.markerGone, true);
  assert.equal(r.leftovers.runFolderGone, true);
  assert.equal(r.leftoversRefuseRealKey.code, 3, 'a marker that names the real key is refused');
  assert.equal(r.leftoversRefuseRealKey.realKeyKept, true);
  assert.equal(r.taskThatCannotStart.verdict, 'not_measured');
  assert.equal(r.taskThatCannotStart.ranAsAnother, 'not_measured', 'a task that ran as another account is not a measurement');
});

test('both lab scripts print their plan with -DryRun and change nothing (no admin needed)', (t) => {
  const work = scratch(t);
  const report = path.join(work, 'report', 'r.json');
  const measure = ps(['-File', newScripts[0], '-DryRun', '-ReportPath', report]);
  assert.match(measure.stdout, /DRY RUN. Nothing is created or changed/u);
  const stepLines = (text) => text.split(/\r?\n/u).filter((line) => /^\d\. /u.test(line));
  assert.ok(stepLines(measure.stdout).length >= 5);
  assert.equal(existsSync(path.join(work, 'report')), false, 'not even the report folder is made');
  const sec2 = ps(['-File', newScripts[1], '-DryRun']);
  assert.match(sec2.stdout, /DRY RUN. Nothing is created or changed/u);
  assert.ok(stepLines(sec2.stdout).length >= 6);
});

test('lab-sec2.ps1: names, ownership of an account, the three cases, the answers in words, and a probe that is only a start frame', (t) => {
  const r = lab(t, 'sec2-pure');
  assert.match(r.accountName, /^albera-sec2-[0-9a-f]{8}$/u);
  assert.ok(r.accountName.length <= 20, 'a local account name is at most 20 characters');
  assert.ok(r.description.length <= 48);
  assert.equal(r.owned.ours, true);
  for (const refused of ['wrongName', 'wrongDescription', 'uppercase', 'tooLong', 'prefixOnly', 'otherUser']) assert.equal(r.owned[refused], false, refused);
  assert.deepEqual(r.cases.map((c) => [c.Id, c.Owner === OWNER, c.Image === null ? null : c.Image.length]), [['owner', true, null], ['wrongOwner', false, null], ['ownerAndImage', true, 64]]);
  assert.match(r.cases[1].Owner, /^S-1-5-21-/u);
  assert.equal(r.verdicts.works.ownerCheck, 'works');
  assert.equal(r.verdicts.works.imagePin, 'works');
  assert.match(r.verdicts.works.advice, /may be set/u);
  assert.equal(r.verdicts.pinFails.ownerCheck, 'works');
  assert.equal(r.verdicts.pinFails.imagePin, 'fails_from_this_account:server_identity_unavailable');
  assert.match(r.verdicts.pinFails.advice, /leave serverImageSha256 out/u);
  assert.equal(r.verdicts.acceptsAny.ownerCheck, 'accepts_any_owner');
  assert.equal(r.verdicts.ownerFails.ownerCheck, 'fails_for_the_owner:broker_unavailable');
  assert.equal(r.verdicts.notRun.ownerCheck, 'not_measured');
  assert.equal(r.verdicts.notRun.imagePin, 'not_measured');
  assert.equal(r.verdicts.noResults.ownerCheck, 'not_measured');
  assert.equal(r.probe.parses, true);
  assert.deepEqual(r.probe.params, ['Helper', 'PipeName', 'OwnerSid', 'ImageSha256', 'CaseId']);
  assert.equal(r.probe.sendsOnlyTheStartFrame, true, 'the probe writes one start frame and no wire request');
  assert.equal(r.probe.usesHelperArgument, 'wsl-bridge');
});

test('lab-sec2.ps1, with fakes: the account AND the lab folder are removed on EVERY way out, a lock is reported and finished by -RemoveStale, a real run or a bad path stops it before anything is made', (t) => {
  const r = lab(t, 'sec2-flow');
  assert.deepEqual(r.normal.order, ['sweep', 'remove-lab', 'create-account', 'lab-folder', 'wait-pipe', 'probe:owner', 'probe:wrongOwner', 'probe:ownerAndImage', 'wait-pipe-gone', 'remove-account', 'remove-lab']);
  assert.equal(r.normal.removeCalls, 1);
  assert.equal(r.normal.verdict, 'works');
  assert.equal(r.normal.labFolderExists, false);
  assert.ok(r.normal.said.some((line) => /END THE LAB BRIDGE NOW/u.test(line)), 'it stops and asks the owner to end the lab bridge');
  for (const stage of ['create-account', 'lab-folder', 'wait-pipe-timeout', 'probe-throws', 'probe-throws-late']) {
    const run = r.failures[stage];
    assert.equal(run.accountsLeft, 0, `${stage}: no account is left`);
    assert.equal(run.labFolderExists, false, `${stage}: no lab folder is left`);
    assert.equal(run.removeCalls >= 1, true, `${stage}: removal was called`);
  }
  assert.equal(r.labFolderFailedHalfway, false, 'a lab folder step that failed after making the folder still gets the folder deleted');
  assert.equal(r.failures['wait-pipe-timeout'].verdict, 'not_measured');
  // H2: the lock
  assert.equal(r.locked.accountsLeft, 0, 'the account is removed even when the folder is locked');
  assert.equal(r.locked.warned, true, 'and the lock is said, with -RemoveStale as the way to finish');
  assert.equal(r.locked.verdict, 'works', 'the answer is not lost');
  assert.equal(r.lockedThenGone, true);
  assert.equal(r.realLock.threw, true, 'a real open file makes the real removal fail');
  assert.equal(r.realLock.folderStillThere, true);
  assert.equal(r.realLock.afterClose, true);
  assert.equal(r.realLock.goneAfterClose, true);
  assert.equal(r.absentFolder, false);
  // L5
  assert.deepEqual(r.realRunNames, ['albera-run-abc123']);
  assert.deepEqual(r.noRunNames, []);
  assert.equal(r.realRun.threw, true);
  assert.match(r.realRun.message, /a real WSL2 run exists \(albera-run-abc123\)/u);
  assert.equal(r.realRun.order.includes('create-account'), false, 'refused before an account exists');
  // the path is judged before anything is made
  assert.equal(r.labUnderDataDir.threw, true);
  assert.match(r.labUnderDataDir.message, /not acceptable/u);
  assert.equal(r.labUnderDataDir.order.includes('create-account'), false);
  assert.deepEqual(r.labDirChecks, { good: true, underData: false, same: false });
  assert.equal(r.removalThatFails.warned, true, 'a removal that fails says so and tells how to finish; it does not hide the original result');
  assert.equal(r.stale.removed, 1, 'a stale account of ours is swept first');
  assert.equal(r.stale.foreignKept, true, 'an account with our prefix but another description is never removed');
  assert.equal(r.notOurs.threw, true);
});

test('round 2 (lib): the floor must equal the generation at install, the bridge fields are compared, the floor file has three readers, the first start is a record, git is the real git.exe', (t) => {
  const { r } = lib(t);
  const a = r.agreement2;
  assert.deepEqual(reasons(a.fullAgree), []);
  assert.deepEqual(reasons(a.pipe), ['bridge_pipe_name']);
  assert.deepEqual(reasons(a.cp), ['bridge_control_plane_sid']);
  assert.deepEqual(reasons(a.git), ['bridge_git_path']);
  assert.deepEqual(reasons(a.image), ['bridge_image_sha256']);
  assert.deepEqual(reasons(a.strictEqual), []);
  assert.deepEqual(reasons(a.strictBelow), ['floor_below_generation']);
  assert.deepEqual(reasons(a.strictAbove), ['floor_above_generation']);
  assert.deepEqual(reasons(a.lenientBelow), [], 'status does not fail a floor below the generation; it says so in words');
  assert.deepEqual(reasons(r.floorAcl.good), []);
  assert.deepEqual(reasons(r.floorAcl.adminsOnly), []);
  assert.deepEqual(reasons(r.floorAcl.users), ['floor_acl:S-1-5-32-545']);
  assert.match(reasons(r.floorAcl.service)[0], /^floor_acl:S-1-5-80-/u);
  assert.deepEqual(reasons(r.floorAcl.everyone), ['floor_acl:S-1-1-0']);
  assert.equal(r.firstStartRecord.good, true);
  for (const bad of ['otherWord', 'badTime', 'notDict']) assert.equal(r.firstStartRecord[bad], false, bad);
  assert.equal(r.git.default, String.raw`C:\Program Files\Git\mingw64\bin\git.exe`);
  assert.equal(r.git.defaultOk, true);
  assert.equal(r.git.firstStartWord, 'control_plane_is_self');
});

test('H1: no unreviewed local build starts elevated, the first start and the Run entry are separate modes that need an elevated record write, and the CI log carries the bridge hash and the lab script hashes', () => {
  const host = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.equal(/Invoke-Native\s+\$W\./u.test(host), false, 'the elevated script never starts anything under the bridge folder');
  assert.equal(/Invoke-Wsl2FirstStart\b/u.test(host), false);
  assert.match(host, /function Invoke-Wsl2FirstStartConfirm/u);
  assert.match(host, /function Invoke-Wsl2RunEntryMode/u);
  assert.equal([...host.matchAll(/Set-Wsl2RunValue/gu)].length, 2, 'defined once and called once: only -Mode wsl2-run-entry sets the Run value');
  const yml = readFileSync(path.join(root, '.github', 'workflows', 'host-build-hashes.yml'), 'utf8');
  assert.match(yml, /- name: Build the WSL bridge \(build only; never installed or started\)\n        run: npm run build:wsl-bridge\n/u);
  assert.ok(yml.indexOf('npm run build:wsl-bridge') < yml.indexOf('-Mode wsl2-hashes'), 'the bridge is built before it is hashed');
  assert.match(yml, /-Mode wsl2-hashes/u);
  assert.match(yml, /ALBERA_WSL_BRIDGE_TREE_HASH=\*/u);
  assert.match(yml, /'measure-attestation-key\.ps1', 'lab-sec2\.ps1'/u);
  assert.match(yml, /ALBERA_HOST_SCRIPT_SHA256=\$h \$f/u);
  for (const file of newScripts) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /compare with the ALBERA_HOST_SCRIPT_SHA256 line of the CI run on main/u, `${path.basename(file)} prints its own hash`);
  }
  const doc = readFileSync(path.join(root, 'docs', 'architecture', 'host-install.md'), 'utf8');
  assert.match(doc, /the image cannot be built in CI/u, 'the doc says what is trusted about the image');
});

test('the new modes: -Mode wsl2-first-start and wsl2-run-entry refuse without an elevated console, and the first-start word is required', () => {
  const refuse = (mode, extra) => ps(['-File', path.join(hostDir, 'albera-host.ps1'), '-Mode', mode, ...extra], { allowFail: true, env: { ALBERA_HOST_ASSUME_NOT_ELEVATED: '1' } });
  const noWord = refuse('wsl2-first-start', []);
  assert.notEqual(noWord.code, 0);
  assert.match(noWord.stdout, /needs an elevated console|needs -Wsl2FirstStartWord/u);
  const wordElsewhere = refuse('plan', ['-Wsl2FirstStartWord', 'x']);
  assert.equal(wordElsewhere.code, 2);
  assert.match(wordElsewhere.stdout, /only applies to -Mode wsl2-first-start/u);
  for (const [mode, extra] of [['wsl2-first-start', ['-Wsl2FirstStartWord', 'control_plane_is_self']], ['wsl2-run-entry', []]]) {
    const refused = refuse(mode, extra);
    assert.notEqual(refused.code, 0, mode);
    assert.match(refused.stdout, /needs an elevated console/u, mode);
  }
});
