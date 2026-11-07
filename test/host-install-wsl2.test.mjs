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
const ps = (args, { allowFail = false } = {}) => {
  try {
    return { code: 0, stdout: execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', timeout: 240_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }) };
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
  assert.deepEqual([...measure.matchAll(/Invoke-NativeShort \$(\w+)/gu)].map((m) => m[1]).filter((value, index, all) => all.indexOf(value) === index), ['SchtasksExe'], 'the only program the measurement starts itself is schtasks.exe (the tasks start powershell.exe)');
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
  assert.equal(parsed.wsl2.git, 'C:\\Program Files\\Git\\cmd\\git.exe');
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

test('the WSL2 steps sit after the steps they depend on, and appear only with the option (install) or the record (uninstall)', (t) => {
  const { r } = harness(t, 'steps');
  const plain = ['sources', 'approver', 'dataroot', 'services', 'folders', 'binaries', 'key', 'node', 'claude', 'configs', 'cpservice', 'shortcuts', 'finish'];
  assert.deepEqual(r.installPlain, plain, 'without the option the install is the install it was');
  assert.deepEqual(r.installWsl2, ['sources', 'approver', 'wsl2inputs', 'dataroot', 'services', 'folders', 'binaries', 'key', 'wsl2key', 'node', 'claude', 'configs', 'wsl2folders', 'wsl2files', 'wsl2verify', 'cpservice', 'shortcuts', 'wsl2run', 'finish']);
  assert.deepEqual(r.installBoth, ['sources', 'approver', r.hyperVVmId, 'wsl2inputs', 'dataroot', 'services', 'hyperv', 'folders', 'binaries', 'key', 'wsl2key', 'node', 'claude', 'configs', 'wsl2folders', 'wsl2files', 'wsl2verify', 'cpservice', 'shortcuts', 'wsl2run', 'finish']);
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
  assert.equal(r.defaults.GitPath, 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(r.fromRecord.ComputerId, 'wsl-09');
  assert.equal(r.fromRecord.RepositoryId, 'repo-rec');
  assert.equal(r.fromRecord.GitPath, 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe');
  assert.equal(r.fromRecord.ImageSha256, H);
  assert.equal(r.floorNotNumber, 0, 'a floor that is not a number is zero, which the input check refuses');
});

test('install, with fakes: the key is refused when it exists, the three configs and the settings carry its public half, the bridge folder, copies, floor file and config are made, the first start must exit 77, and a disagreement stops it', (t) => {
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
  // the first start and the agreement
  assert.equal(r.firstStartConfig.controlPlaneSid, OWNER, 'the first-start config names the owner as the Control Plane');
  assert.deepEqual(r.firstStartConfig.repositories, [{ repositoryId: 'repo-main', path: r.repositoryPath }], 'and is otherwise the real bridge config');
  assert.equal(r.firstStartConfig.pipeName, r.bridgeConfig.pipeName);
  assert.equal(r.firstStartConfigStillThere, false, 'the first-start config is deleted again');
  assert.equal(r.verifyOk, null);
  assert.match(r.verifyWrongExit, /expected exit 77 and got 0/u);
  assert.equal(r.firstStartConfigGoneAfterFailure, true);
  assert.match(r.verifyDisagree, /do not agree: .*authority_spki/u);
  assert.match(r.verifyKeyExportable, /key_key_exportable/u);
  assert.match(r.verifyKeyAclExtra, /key_ace_untrusted/u);
  // the run entry
  assert.equal(r.runStepBefore, 'todo');
  assert.equal(r.runValue, r.expectedRunCommand);
  assert.equal(r.runStepAfter, 'done');
  assert.equal(r.runRecord.command, r.expectedRunCommand);
  // status
  assert.ok(r.statusLines.every((line) => line.State === 'ok'), JSON.stringify(r.statusLines.filter((line) => line.State !== 'ok')));
  assert.ok(r.statusLines.length >= 7);
  assert.ok(r.statusTamperedLines.some((line) => line.State === 'FAIL' && /bridge/u.test(line.Text)));
  assert.equal(r.statusWithoutRecord, 0);
});

test('uninstall, with fakes: the Run value goes first and only if it is the command install wrote, the key is deleted, and the data folder goes with its state and distributions', (t) => {
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
  assert.ok(at('Start the installed bridge once') > at('Write the Broker config'));
  assert.ok(at('HKLM Run value AlberaWslBridge') > at('Make the launcher'));
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

test('measure-attestation-key.ps1, with fakes: every step runs in order, the key and the work folder are removed on every way out, the report is written without secrets, and the dry run changes nothing', (t) => {
  const r = lab(t, 'measure-flow');
  assert.deepEqual(r.normal.order, ['dir', 'dir', 'dir', 'create-name-nonadmin', 'create-key', 'export-sign', 'task:broker', 'task:other', 'task:controlplane', 'delete-key']);
  assert.equal(r.normal.reportWritten, true);
  assert.equal(r.normal.keyDeleted, true);
  assert.equal(r.normal.workRemoved, true);
  assert.equal(r.normal.verdicts.nonAdministratorCanTakeTheName, 'no');
  assert.equal(r.normal.verdicts.asExpected_broker, 'yes');
  assert.equal(r.normal.createdKeyDacl[0], r.normal.brokerSid, 'the key is made for the stand-in Broker SID');
  assert.equal(/BEGIN|PRIVATE|Pkcs8/iu.test(r.normal.reportText), false, 'no key material in the report file');
  assert.equal(r.nonAdminMadeIt.deletedBeforeCreate, true, 'a key a non-administrator made first is deleted before the administrator creates the name');
  assert.equal(r.nonAdminMadeIt.verdict, 'yes');
  for (const stage of ['create-key', 'export-sign', 'task:other']) {
    assert.equal(r.failures[stage].threw, true, stage);
    assert.equal(r.failures[stage].keyDeleted, true, `${stage}: the key is deleted`);
    assert.equal(r.failures[stage].workRemoved, true, `${stage}: the work folder is removed`);
  }
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

test('lab-sec2.ps1, with fakes: the account is removed on EVERY way out (a failure at any step, the pipe never appearing, a probe that dies), and the dry run changes nothing', (t) => {
  const r = lab(t, 'sec2-flow');
  assert.deepEqual(r.normal.order, ['sweep', 'create-account', 'lab-folder', 'wait-pipe', 'probe:owner', 'probe:wrongOwner', 'probe:ownerAndImage', 'remove-account', 'remove-lab']);
  assert.equal(r.normal.removed, 1);
  assert.equal(r.normal.verdict, 'works');
  for (const stage of ['create-account', 'lab-folder', 'wait-pipe-timeout', 'probe-throws', 'probe-throws-late']) {
    const run = r.failures[stage];
    assert.equal(run.accountsLeft, 0, `${stage}: no account is left`);
    if (stage !== 'create-account') assert.equal(run.removeCalls >= 1, true, `${stage}: removal was called`);
  }
  assert.equal(r.failures['wait-pipe-timeout'].verdict, 'not_measured');
  assert.equal(r.failures['lab-folder'].labRemoved, false, 'there is no lab folder to remove when it was never made');
  assert.equal(r.failures['probe-throws'].labRemoved, true);
  assert.equal(r.removalThatFails.warned, true, 'a removal that fails says so and tells how to finish; it does not hide the original result');
  assert.equal(r.stale.removed, 1, 'a stale account of ours is swept first');
  assert.equal(r.stale.foreignKept, true, 'an account with our prefix but another description is never removed');
  assert.equal(r.notOurs.threw, true);
});
