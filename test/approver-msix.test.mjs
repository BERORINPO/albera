import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  LOGOS, belongsInPackage, buildManifest, loadIdentity, packageFamilyName, parseIdentity, publisherId, solidPng,
} from '../scripts/approver-msix.mjs';
import { copyLayout, parseArguments } from '../scripts/package-windows-approver-msix.mjs';
import {
  BUILD_TOOLS, POWERSHELL_EXE, TAR_EXE, downloadPinned, extractTools, minimalEnvironment, prepareBuildTools, requireMicrosoftSignature, sha512Base64,
} from '../scripts/windows-sdk-buildtools.mjs';

// Issue #101: the MSIX packaging of the approver. Pure logic and fakes only: no download, no certificate, no package, no Hello. The installer script is read as text, and run
// ONLY as a dry run (no -Apply anywhere in this file), which by design changes nothing.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const identity = loadIdentity();
const installScript = read('scripts', 'approver-msix-install.ps1');

const tempFolders = [];
const makeTemp = (prefix = 'albera-msix-test-') => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempFolders.push(folder); return folder; };
process.on('exit', () => { for (const folder of tempFolders) fs.rmSync(folder, { recursive: true, force: true }); });

describe('identity registry and package family name', () => {
  it('is one valid registry; unknown, missing and malformed values are refused', () => {
    assert.equal(identity.packageName, 'Albera.LocalApprover');
    assert.equal(identity.publisher, 'CN=ALBERA Local Approver');
    const text = read('scripts', 'approver-msix-identity.json');
    for (const [field, value] of [['publisher', 'CN=A"B'], ['publisher', 'O=Someone'], ['packageName', 'x'], ['packageName', 'bad name'], ['version', '1.0.0'], ['version', '1.0.0.1'], ['executable', '..\\x.exe'],
      ['alias', 'a/b.exe'], ['certificateYears', 0], ['certificateYears', 99], ['displayName', '<b>'], ['minWindowsVersion', '10.0.1.0']]) {
      assert.throws(() => parseIdentity(JSON.stringify({ ...JSON.parse(text), [field]: value })), /^Error: invalid_identity: /u, `${field}=${value}`);
    }
    assert.throws(() => parseIdentity(JSON.stringify({ ...JSON.parse(text), extra: 1 })), /unknown field extra/u);
    const { publisher: _removed, ...missing } = JSON.parse(text);
    assert.throws(() => parseIdentity(JSON.stringify(missing)), /invalid_identity: publisher/u);
    assert.throws(() => parseIdentity('nope'), /not JSON/u);
    assert.throws(() => parseIdentity('[]'), /not an object/u);
  });

  it('derives the publisher id the way Windows does (checked against 169 installed packages on the author\'s PC) and the family name of this package', () => {
    assert.equal(publisherId('CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'), '8wekyb3d8bbwe', 'the well-known Microsoft id');
    assert.equal(publisherId('CN=ALBERA Local Approver'), 'rfb9xr8x8ned2');
    assert.equal(packageFamilyName(identity), 'Albera.LocalApprover_rfb9xr8x8ned2');
    assert.notEqual(publisherId('CN=ALBERA Local Approver'), publisherId('CN=ALBERA Local Approver '), 'any difference in the publisher string is another family');
  });

  it('is mirrored exactly by the C# constants (the entry point refuses to touch Hello from any other package)', () => {
    const source = read('src', 'runtime', 'windows-approver', 'PackageIdentity.cs');
    assert.equal(/public const string PackageName = "([^"]+)";/u.exec(source)[1], identity.packageName);
    assert.equal(/public const string Publisher = "([^"]+)";/u.exec(source)[1], identity.publisher);
  });
});

describe('AppxManifest.xml', () => {
  const manifest = buildManifest(identity);

  it('declares exactly this identity, one full-trust console application with an execution alias, and no capability but runFullTrust', () => {
    assert.match(manifest, /<Identity Name="Albera\.LocalApprover" Publisher="CN=ALBERA Local Approver" Version="1\.0\.0\.0" ProcessorArchitecture="x64" \/>/u);
    assert.deepEqual([...manifest.matchAll(/<Application\b[^>]*>/gu)].length, 1, 'one application');
    assert.match(manifest, /Executable="AlberaApprover\.exe" EntryPoint="Windows\.FullTrustApplication" desktop4:Subsystem="console" desktop4:SupportsMultipleInstances="true"/u);
    assert.match(manifest, /<uap5:Extension Category="windows\.appExecutionAlias" Executable="AlberaApprover\.exe" EntryPoint="Windows\.FullTrustApplication">/u);
    assert.match(manifest, /<uap5:AppExecutionAlias desktop4:Subsystem="console">\s*<uap5:ExecutionAlias Alias="AlberaApprover\.exe" \/>/u);
    assert.deepEqual([...manifest.matchAll(/<(?:rescap:|uap:|)Capability Name="([^"]+)"/gu)].map((m) => m[1]), ['runFullTrust']);
    assert.match(manifest, /AppListEntry="none"/u, 'a console tool has no Start menu entry');
    assert.equal(/Extension Category="windows\.(?!appExecutionAlias)/u.test(manifest), false, 'no other extension (no service, no protocol, no startup task)');
    assert.equal(/AppContainer|uap:Capability|DeviceCapability|internetClient|windows\.service|startupTask/iu.test(manifest), false);
  });

  it('is well-formed, uses CRLF, names only logos the package contains, and escapes anything XML-special', () => {
    assert.match(manifest, /^<\?xml version="1\.0" encoding="utf-8"\?>\r\n<Package /u);
    assert.equal(manifest.includes('\n') && manifest.replace(/\r\n/gu, '').includes('\n'), false, 'only CRLF line ends');
    const opens = [...manifest.matchAll(/<([A-Za-z][\w:]*)(?:\s[^>]*?)?(\/?)>/gu)].filter((m) => m[2] !== '/').map((m) => m[1]);
    const closes = [...manifest.matchAll(/<\/([A-Za-z][\w:]*)>/gu)].map((m) => m[1]);
    assert.deepEqual([...opens].sort(), [...closes].sort(), 'every opened element is closed');
    for (const logo of manifest.matchAll(/Assets\\([A-Za-z0-9]+\.png)/gu)) assert.ok(LOGOS.some((l) => l.file === logo[1]), `${logo[1]} is generated`);
    assert.ok(buildManifest({ ...identity, displayName: 'A & B' }).includes('DisplayName>A &amp; B<'), 'escaping');
  });
});

describe('generated logos and the package layout', () => {
  it('writes valid solid-colour PNGs of the declared sizes', () => {
    for (const { size } of LOGOS) {
      const png = solidPng(size);
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      const idat = png.indexOf(Buffer.from('IDAT'));
      const length = png.readUInt32BE(idat - 4);
      assert.equal(inflateSync(png.subarray(idat + 4, idat + 4 + length)).length, size * (1 + 3 * size), 'one filter byte + RGB per row');
      assert.equal(png.subarray(-12, -8).toString('hex'), '00000000', 'IEND');
    }
  });

  it('copies the publish folder without symbols and the build hash file, and refuses a link', () => {
    const from = makeTemp(); const to = path.join(makeTemp(), 'layout');
    fs.mkdirSync(path.join(from, 'sub'));
    for (const file of ['AlberaApprover.exe', 'AlberaApprover.pdb', 'AlberaApprover.exe.manifest.json', path.join('sub', 'x.dll'), path.join('sub', 'x.PDB')]) fs.writeFileSync(path.join(from, file), 'x');
    copyLayout(from, to);
    assert.deepEqual(fs.readdirSync(to, { recursive: true }).map(String).sort(), ['AlberaApprover.exe', 'sub', path.join('sub', 'x.dll')]);
    assert.equal(belongsInPackage('a\\b.pdb'), false);
    assert.equal(belongsInPackage('AlberaApprover.dll'), true);
    const linked = makeTemp();
    try { fs.symlinkSync(from, path.join(linked, 'link'), 'junction'); } catch { return; } // a link cannot be made here: nothing more to show
    assert.throws(() => copyLayout(linked, path.join(makeTemp(), 'layout2')), /layout_link/u);
  });

  it('takes no argument or exactly --sign-thumbprint <40 hex>', () => {
    assert.deepEqual(parseArguments([]), { signThumbprint: null });
    assert.deepEqual(parseArguments(['--sign-thumbprint', 'ab'.repeat(20)]), { signThumbprint: 'AB'.repeat(20) });
    for (const bad of [['--sign-thumbprint'], ['--sign-thumbprint', 'xyz'], ['--sign-thumbprint', 'ab'.repeat(21)], ['--sign'], ['x'], ['--sign-thumbprint', 'ab'.repeat(20), 'extra']]) assert.throws(() => parseArguments(bad), /^Error: usage:/u, bad.join(' '));
  });
});

describe('the pinned Windows SDK build tools', () => {
  const body = Buffer.from('not really a nupkg');
  const pin = { ...BUILD_TOOLS, sha512Base64: sha512Base64(body), maxBytes: 1024 };
  const respond = (bytes, init = {}) => async () => new Response(bytes, { status: 200, ...init });

  it('pins one exact package version over https from nuget.org with the SHA-512 the owner approved, and two tools', () => {
    assert.equal(BUILD_TOOLS.id, 'Microsoft.Windows.SDK.BuildTools');
    assert.equal(BUILD_TOOLS.version, '10.0.28000.2705');
    assert.equal(BUILD_TOOLS.sha512Base64, '47kp42eMb8rF3bjDuZHVkzGRb9Fr7wyFZDIT2sWr3StwnTCoDHIisDe0SPWGwerwVUw/eQQO/OxDb0YYHbfNvA==');
    assert.equal(BUILD_TOOLS.url, 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.28000.2705/microsoft.windows.sdk.buildtools.10.0.28000.2705.nupkg');
    assert.equal(BUILD_TOOLS.binFolder, 'bin/10.0.28000.0/x64');
    assert.deepEqual(BUILD_TOOLS.tools, ['makeappx.exe', 'signtool.exe']);
    assert.equal(Buffer.from(BUILD_TOOLS.sha512Base64, 'base64').length, 64, 'a SHA-512 digest');
    assert.equal(Object.isFrozen(BUILD_TOOLS), true);
  });

  it('keeps a download whose SHA-512 matches', async () => {
    const file = path.join(makeTemp(), 'a.nupkg');
    assert.deepEqual(await downloadPinned({ file, fetchImpl: respond(body), pin }), { bytes: body.length, sha512Base64: pin.sha512Base64 });
    assert.deepEqual(fs.readFileSync(file), body);
  });

  it('deletes a download whose SHA-512 differs (a single changed byte), a bad status, and anything over the size limit; none is kept', async () => {
    const tampered = Buffer.from(body); tampered[3] ^= 1;
    for (const [label, fetchImpl, error] of [
      ['tampered bytes', respond(tampered), /buildtools_hash_mismatch/u],
      ['404', respond('no', { status: 404 }), /buildtools_download: HTTP 404/u],
      ['declared too large', respond(body, { headers: { 'content-length': '999999' } }), /over the 1024 byte limit/u],
      ['streamed too large', respond(Buffer.alloc(2048, 1)), /more than 1024 bytes/u],
    ]) {
      const file = path.join(makeTemp(), 'a.nupkg');
      await assert.rejects(downloadPinned({ file, fetchImpl, pin }), error, label);
      assert.equal(fs.existsSync(file), false, `${label}: nothing left on disk`);
    }
  });

  it('never extracts before the hash matched, and runs the fixed tar with a minimal environment on the one pinned folder', async () => {
    const calls = [];
    const run = (file, args, options) => { calls.push({ file, args, env: options.env }); return { status: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' }) }; };
    const makeFolder = (prefix) => makeTemp(prefix);
    await assert.rejects(prepareBuildTools({ fetchImpl: respond(Buffer.from('tampered')), run, makeFolder, pin, log: () => {} }), /buildtools_hash_mismatch/u);
    assert.deepEqual(calls, [], 'a mismatch runs no process at all (no tar, no PowerShell)');

    const tools = await prepareBuildTools({ fetchImpl: respond(body), run, makeFolder, pin, log: () => {} });
    assert.equal(calls[0].file, TAR_EXE);
    assert.deepEqual(calls[0].args.slice(0, 1), ['-xf']);
    assert.equal(calls[0].args.at(-1), pin.binFolder, 'only the pinned folder is extracted');
    assert.deepEqual(calls.slice(1).map((c) => c.file), [POWERSHELL_EXE, POWERSHELL_EXE], 'then one signature check per tool, with the fixed Windows PowerShell');
    for (const call of calls) assert.deepEqual(Object.keys(call.env).filter((k) => !['SystemRoot', 'windir', 'PATH', 'TEMP', 'TMP', 'ALBERA_TOOL_PATH'].includes(k)), [], 'nothing is inherited from the caller\'s environment');
    assert.ok(tools.makeappx.endsWith(path.join('bin', '10.0.28000.0', 'x64', 'makeappx.exe')) && tools.signtool.endsWith('signtool.exe'));
    assert.deepEqual(Object.keys(tools.env).sort(), ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'windir']);
  });

  it('refuses a tool that is not Valid or is signed by anyone but Microsoft Corporation (including a look-alike name)', () => {
    const answering = (status, subject) => () => ({ status: 0, stdout: JSON.stringify({ status, subject }) });
    const microsoft = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
    requireMicrosoftSignature(['x.exe'], { temp: os.tmpdir(), run: answering('Valid', microsoft) });
    for (const [status, subject, error] of [['NotSigned', '', /status NotSigned/u], ['HashMismatch', microsoft, /status HashMismatch/u], ['UnknownError', microsoft, /status UnknownError/u],
      ['Valid', 'CN=Evil Corporation', /not by Microsoft Corporation/u], ['Valid', 'CN=Microsoft Corporation Evil, O=x', /not by Microsoft Corporation/u], ['Valid', 'O=Microsoft Corporation', /not by Microsoft Corporation/u], ['Valid', '', /not by Microsoft Corporation/u]]) {
      assert.throws(() => requireMicrosoftSignature(['x.exe'], { temp: os.tmpdir(), run: answering(status, subject) }), error, `${status} ${subject}`);
    }
    assert.throws(() => requireMicrosoftSignature(['x.exe'], { temp: os.tmpdir(), run: () => ({ status: 1, stdout: '' }) }), /could not read the signature/u);
    assert.throws(() => requireMicrosoftSignature(['x.exe'], { temp: os.tmpdir(), run: () => ({ status: 0, stdout: 'garbage' }) }), /unreadable answer/u);
  });

  it('turns a tar failure into one clear error and exposes the environment helper', () => {
    assert.throws(() => extractTools({ nupkg: 'a', folder: 'b', temp: 'c', run: () => ({ status: 1 }), pin }), /^Error: buildtools_extract: tar failed \(exit 1\)/u);
    assert.deepEqual(minimalEnvironment('T', { X: '1' }), { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', PATH: 'C:\\Windows\\System32', TEMP: 'T', TMP: 'T', X: '1' });
    assert.equal(createHash('sha512').update(body).digest('base64'), sha512Base64(body));
  });
});

describe('the host-changing script is one separate file, dry by default, and never elevates itself', () => {
  const HOST_CHANGES = /New-SelfSignedCertificate|Import-Certificate|Export-Certificate|Add-AppxPackage|Remove-AppxPackage|certutil|Remove-Item\s+-LiteralPath\s+\$path\b/iu;

  it('is ASCII only (Windows PowerShell 5.1 reads it) and starts no elevated or detached process', () => {
    assert.equal(/[^\x00-\x7f]/u.test(installScript), false, 'ASCII only');
    assert.equal(/-Verb\s+RunAs|Start-Process|runas\b|\bsudo\b|Set-ExecutionPolicy|Invoke-Expression|\biex\b|DownloadString|Invoke-WebRequest|Invoke-RestMethod/iu.test(installScript), false);
    assert.match(installScript, /\[Parameter\(Mandatory = \$true\)\]\[ValidateSet\('Sign', 'Trust', 'Install', 'Uninstall', 'Untrust'\)\]\[string\]\$Step/u);
    assert.match(installScript, /\[switch\]\$Apply/u);
    assert.match(installScript, /This script never elevates itself/u);
  });

  it('changes nothing before the -Apply check of its step, and the two machine-wide steps check for administrator rights after it', () => {
    const functions = [...installScript.matchAll(/^function (Invoke-\w+) \{\r?\n([\s\S]*?)^\}/gmu)];
    assert.deepEqual(functions.map((m) => m[1]), ['Invoke-Sign', 'Invoke-Trust', 'Invoke-Install', 'Invoke-Uninstall', 'Invoke-Untrust']);
    for (const [, name, body] of functions) {
      const gate = body.search(/if \(-not \$Apply\) \{ return \}/u);
      assert.ok(gate > 0, `${name} returns early without -Apply`);
      const plan = body.indexOf('Write-Plan @(');
      assert.ok(plan > 0 && plan < gate, `${name}: the plan is printed before the dry-run return`);
      assert.equal(HOST_CHANGES.test(body.slice(0, plan)), false, `${name}: no host change before the plan`);
      const statements = body.slice(plan, gate).split(/\r?\n/u).filter((line) => /^ {2}\S/u.test(line));
      assert.equal(statements.length, 0, `${name}: nothing but the plan between its start and the dry-run return (its text may name the commands; it runs none)`);
      assert.ok(HOST_CHANGES.test(body.slice(gate)), `${name} changes something after it`);
      assert.match(body.slice(0, gate), /Write-Plan @\(/u, `${name} prints CHANGES / NEEDS / UNDO first`);
    }
    for (const name of ['Invoke-Trust', 'Invoke-Untrust']) {
      const body = functions.find((m) => m[1] === name)[2];
      assert.ok(body.indexOf('Assert-Administrator') > body.search(/if \(-not \$Apply\) \{ return \}/u), `${name} asks for administrator rights only when applying`);
      assert.ok(body.indexOf('Assert-Administrator') < body.search(HOST_CHANGES), `${name} checks before it changes`);
    }
    const sign = functions[0][2];
    assert.match(sign, /finally \{ Remove-SigningCertificate \$created\.Thumbprint \}/u, 'the signing key is deleted even when packing fails');
    assert.match(sign, /-KeyExportPolicy NonExportable/u);
    assert.match(installScript, /Remove-Item -LiteralPath \$path -DeleteKey -Force/u, 'removes the private key together with the certificate');
    assert.match(sign, /--sign-thumbprint \$created\.Thumbprint/u);
    assert.match(installScript, /Import-Certificate -FilePath \$cer -CertStoreLocation \$trustStore/u);
    assert.match(installScript, /\$trustStore = 'Cert:\\LocalMachine\\TrustedPeople'/u, 'the only machine-wide store touched');
    assert.equal(/Cert:\\LocalMachine\\(?!TrustedPeople)/u.test(installScript), false, 'never the machine Root or Publisher stores');
    assert.equal(/Cert:\\CurrentUser\\(?!My\b)/u.test(installScript), false);
  });

  it('is the ONLY place that names a certificate-creating, certificate-trusting or package-installing command', () => {
    const roots = ['scripts', 'src'];
    const offenders = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (!['node_modules', 'bin', 'obj'].includes(entry.name)) walk(full); continue; }
        if (!/\.(mjs|js|cs|ps1|json|csproj)$/u.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/New-SelfSignedCertificate|Import-Certificate|Add-AppxPackage|Remove-AppxPackage|certutil/iu.test(text)) offenders.push(path.relative(root, full).replaceAll('\\', '/'));
      }
    };
    for (const folder of roots) walk(path.join(root, folder));
    assert.deepEqual(offenders, ['scripts/approver-msix-install.ps1']);
  });

  it('prints CHANGES, NEEDS and UNDO for every step as a dry run, with the exit code 0, and creates nothing (Windows only)', { skip: process.platform !== 'win32' }, () => {
    const before = fs.existsSync(path.join(root, 'src', 'runtime', 'windows-approver', 'bin', 'msix'));
    for (const step of ['Sign', 'Trust', 'Install', 'Uninstall', 'Untrust']) {
      const result = spawnSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'approver-msix-install.ps1'), '-Step', step],
        { encoding: 'utf8', env: minimalEnvironment(os.tmpdir(), { LOCALAPPDATA: process.env.LOCALAPPDATA ?? '' }), windowsHide: true, timeout: 60_000 });
      assert.equal(result.status, 0, `${step}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`== step ${step} : DRY RUN \\(nothing is changed; add -Apply to do it\\)`, 'u'), step);
      for (const label of ['CHANGES:', 'NEEDS:', 'UNDO:']) assert.ok(result.stdout.includes(`   ${label}`), `${step}: ${label}`);
    }
    assert.equal(fs.existsSync(path.join(root, 'src', 'runtime', 'windows-approver', 'bin', 'msix')), before, 'a dry run creates no output folder');
  });

  it('refuses a step it does not know and a thumbprint that is not 40 hex characters (Windows only)', { skip: process.platform !== 'win32' }, () => {
    for (const args of [['-Step', 'Everything'], ['-Step', 'Untrust', '-Thumbprint', 'not-a-thumbprint'], []]) {
      const result = spawnSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'approver-msix-install.ps1'), ...args],
        { encoding: 'utf8', env: minimalEnvironment(os.tmpdir()), windowsHide: true, timeout: 60_000 });
      assert.notEqual(result.status, 0, args.join(' '));
      assert.equal(result.stdout.includes('DRY RUN'), false);
    }
  });
});
