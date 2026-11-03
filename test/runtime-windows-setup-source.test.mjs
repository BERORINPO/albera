import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArguments, pinnedToolsSource } from '../scripts/publish-windows-setup.mjs';

// Source-level guards for the setup program (albera-setup.exe, PR6), its publish script, its fixtures and the workflow that builds, attests and self-verifies it. They run on every
// OS and need no .NET SDK. What they cannot show (the NativeAOT bytes, the real attestations) is listed in docs/architecture/control-plane-service.md and in the PR.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const directory = path.join(root, 'src', 'runtime', 'windows-setup');
const sources = Object.fromEntries(readdirSync(directory).filter((f) => f.endsWith('.cs')).map((f) => [f, readFileSync(path.join(directory, f), 'utf8')]));
const project = read('src', 'runtime', 'windows-setup', 'Albera.Setup.csproj');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const code = Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, stripComments(text)]));
const allCode = Object.values(code).join('\n');
const workflow = read('.github', 'workflows', 'host-build-hashes.yml');
const layout = sources['SetupLayout.cs'];
const csharpString = (name) => new RegExp(`const string ${name}\\s*=\\s*"([^"]*)"`, 'u').exec(layout)?.[1];

test('the setup project is NativeAOT, BCL only, asks for administrator and cannot compile without its generated pins', () => {
  assert.deepEqual([...project.matchAll(/<(?:PackageReference|ProjectReference|FrameworkReference|COMReference|Reference|Import)\b[^>]*>/gu)], [], 'no package, project or other reference');
  assert.match(project, /<PublishAot>true<\/PublishAot>/u);
  assert.match(project, /<AssemblyName>albera-setup<\/AssemblyName>/u);
  assert.match(project, /<TargetFramework>net10\.0-windows<\/TargetFramework>/u);
  assert.match(project, /<ApplicationManifest>app\.manifest<\/ApplicationManifest>/u);
  assert.match(project, /<TreatWarningsAsErrors>true<\/TreatWarningsAsErrors>/u);
  assert.deepEqual([...project.matchAll(/<LinkerArg Include="([^"]+)"/gu)].map((m) => m[1]), ['/DEPENDENTLOADFLAG:0x800'], 'DLLs loaded later by name come from System32 only');
  assert.deepEqual([...project.matchAll(/<Compile Include="([^"]+)"/gu)].map((m) => m[1]), ['$(AlberaPinnedToolsSource)'], 'the only extra source is the generated pin file');
  assert.equal(/IsAotCompatible|PublishTrimmed|SelfContained|EnableTrimAnalyzer/u.test(project), false, 'IsAotCompatible would need the ILLink pack download for a local build; the AOT analyzers run in CI with PublishAot');
  const manifest = read('src', 'runtime', 'windows-setup', 'app.manifest');
  assert.match(manifest, /requestedExecutionLevel level="requireAdministrator" uiAccess="false"/u);
  const lock = JSON.parse(read('src', 'runtime', 'windows-setup', 'packages.lock.json'));
  assert.deepEqual(Object.values(lock.dependencies).map((framework) => Object.keys(framework)), [[], []], 'the lock file pins no NuGet package');
  assert.equal(readdirSync(directory).some((f) => /^(?:Directory\.|global\.json|nuget\.config)/iu.test(f)), false, 'no ambient MSBuild or NuGet file');
});

test('the setup code reads no environment variable and no folder the owner can redirect', () => {
  const forbidden = [
    /GetEnvironmentVariable/u, /GetEnvironmentVariables/u, /ExpandEnvironmentVariables/u, /Path\.GetTempPath/u, /Path\.GetTempFileName/u, /Environment\.CurrentDirectory/u,
    /Directory\.GetCurrentDirectory/u, /Environment\.UserName/u, /Environment\.UserDomainName/u, /SpecialFolder\.(?!ProgramFiles\b|CommonApplicationData\b)/u, /\bargs\b.*ExpectedTreeHash/u,
  ];
  for (const pattern of forbidden) assert.equal(pattern.test(allCode), false, `forbidden: ${pattern}`);
  assert.match(code['Program.cs'], /Environment\.SystemDirectory/u);
  assert.equal(/ExpectedTreeHash|expected-tree-hash/iu.test(code['SetupOptions.cs']), false, 'nothing about the tree hash can be typed');
});

test('processes: one place starts them, never through a shell, never elevated, an empty environment is filled from the spec, a timeout ends only the process it started', () => {
  const owners = Object.entries(code).filter(([, text]) => /Process\.Start\(/u.test(text)).map(([name]) => name);
  assert.deepEqual(owners, ['ProcessRunner.cs']);
  const runner = code['ProcessRunner.cs'];
  assert.match(runner, /UseShellExecute = false/u);
  assert.equal(/UseShellExecute = true|Verb\s*=|runas/iu.test(allCode), false, 'no shell execute, no elevation');
  assert.match(runner, /info\.Environment\.Clear\(\)/u);
  assert.match(runner, /Path\.IsPathFullyQualified\(spec\.FileName\)/u, 'no PATH lookup');
  assert.match(runner, /process\.Kill\(\)/u);
  assert.equal(/Kill\(\s*(?:true|entireProcessTree)|GetProcessesByName|GetProcesses\(|taskkill|Stop-Process|ProcessName/iu.test(allCode), false, 'only the PID setup started is ever stopped');
  assert.equal(/cmd\.exe|"\/c"|powershell -Command|-EncodedCommand|Invoke-Expression/iu.test(allCode.replace(/PowerShellExecutable[^;]*;/u, '')), false, 'no shell is used to start anything');
});

test('the program has no network, reflection, native-import or extension surface', () => {
  assert.equal(/System\.Net|HttpClient|WebClient|Socket|Assembly\.Load|Activator\.|Type\.GetType|DllImport|LibraryImport|NativeLibrary|AppDomain|AssemblyLoadContext/u.test(allCode), false);
  assert.equal(/TEST_FAULTS|#if |ALBERA_(?!SETUP_VERIFIED)[A-Z_]+/u.test(allCode), false, 'no test seam in the shipped program');
});

test('gh is run offline with the exact identity: bundle, trusted root, repository, certificate identity, hosted runners only, JSON; never a token, host or network flag', () => {
  const gh = code['GhVerifier.cs'];
  for (const flag of ['--bundle', '--custom-trusted-root', '--repo', '--cert-identity', '--deny-self-hosted-runners', '--format']) assert.ok(gh.includes(`"${flag}"`), flag);
  assert.equal(/--hostname|--owner|--bundle-from-oci|--token|--no-public-good|--tuf/u.test(gh), false);
  assert.equal(csharpString('Repository'), 'BERORINPO/albera');
  assert.equal(csharpString('WorkflowFile'), 'host-build-hashes.yml');
  assert.equal(csharpString('SourceRef'), 'refs/heads/main');
  assert.match(layout, /CertificateIdentity = RepositoryUrl \+ "\/\.github\/workflows\/" \+ WorkflowFile \+ "@" \+ SourceRef/u);
  const env = code['SetupEnvironment.cs'];
  assert.equal(/GH_TOKEN|GITHUB_TOKEN|GH_HOST/u.test(env.replace(/"GH_[A-Z_]+"\]\s*=/gu, '')), false, 'no token or host is handed to gh');
  const engine = code['EngineLaunch.cs'];
  assert.match(engine, /SetupLayout\.PowerShellExecutable/u);
  // gh.exe and the trusted root that run are the checked copies in the work folder, never the files beside setup; the work folder is born with its protected DACL
  const flow = code['SetupFlow.cs'];
  assert.match(flow, /new GhVerifier\(deps\.Runner, tools\.Gh, tools\.TrustedRoot,/u);
  assert.equal(/Path\.Combine\(deps\.SetupDirectory, "gh\.exe"\)|Path\.Combine\(deps\.SetupDirectory, "trusted_root/u.test(flow), false, 'gh is never started from beside setup');
  assert.match(flow, /FileMode\.CreateNew[\s\S]*input\.CopyTo\(output\)[\s\S]*FileSystemChecks\.Sha256\(copy\)/u, 'stream copy first, then the hash of the COPY');
  assert.match(code['Program.cs'], /CreateWorkDirectory = path => FileSystemChecks\.CreateAdministratorOnlyDirectory\(path\)/u);
  assert.match(code['FileSystemChecks.cs'], /SetAccessRuleProtection\(isProtected: true, preserveInheritance: false\)/u);
  assert.match(code['FileSystemChecks.cs'], /new DirectoryInfo\(path\)\.Create\(security\)/u, 'the DACL is given at creation');
  assert.match(code['FileSystemChecks.cs'], /0x40000000[\s\S]*0x10000000/u, 'generic write and generic all count as write access');
  assert.equal(/InheritOnly\) != 0\)\) continue|rule\.InheritOnly\)? continue/u.test(code['FileSystemChecks.cs']), false, 'InheritOnly rules are not skipped');
  assert.match(code['SetupEnvironment.cs'], /\["PSModulePath"\] = PowerShellModulePath/u);
  assert.match(code['SetupEnvironment.cs'], /PowerShellModulePath = @"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\Modules"/u);
  assert.equal(csharpString('RepositoryId'), '1424608761');
  assert.equal(csharpString('OwnerId'), '215606621');
  assert.match(code['AttestationPolicy.cs'], /"sourceRepositoryIdentifier", SetupLayout\.RepositoryId[\s\S]*"sourceRepositoryOwnerIdentifier", SetupLayout\.OwnerId/u);
  assert.match(layout, /PowerShellExecutable = @"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/u);
  assert.match(engine, /"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"/u);
  assert.match(engine, /"-ExpectedTreeHash", treeHash, "-SetupRunId"/u, 'the tree hash and the run id come from the verified build, as arguments of the script');
});

test('the layout in setup is the one the installer script and the workflow use (no drift)', () => {
  // components: Get-BuildSources in scripts/host/albera-host.ps1 is the installer's own list
  const script = read('scripts', 'host', 'albera-host.ps1');
  const installer = [...script.matchAll(/Name = '([^']+)'; Dir = Join-Path \$r '([^']+)'; Exe = '([^']+)'/gu)].map((m) => [m[1], m[2].replaceAll('\\', '/'), m[3]]);
  assert.equal(installer.length, 3, 'the three build sources are found (false-safe)');
  const setup = [...layout.matchAll(/new\("([^"]+)", "([^"]+)", "([^"]+)"\)/gu)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(setup, installer);

  // attested files and the workflow's subject list, through the staging layout
  const components = setup.map(([, dir, exe]) => `repo/${dir}/${exe}`);
  const attested = [csharpString('BuildHashesFile'), csharpString('HostScript'), csharpString('HostLibrary'), ...components, csharpString('SetupExecutable'), csharpString('GhExecutable'), csharpString('TrustedRoot')];
  assert.ok(attested.every(Boolean), 'every layout constant is found (false-safe)');
  const subjects = subjectList();
  const staged = subjects.map((subject) => {
    if (subject.startsWith('src/runtime/windows-setup/')) return `setup/${path.posix.basename(subject)}`;
    if (subject.startsWith('setup-input/')) return `setup/${path.posix.basename(subject)}`;
    if (subject === 'build-hashes.json') return subject;
    return `repo/${subject}`;
  });
  assert.deepEqual([...staged].sort(), [...attested].sort(), 'the workflow attests and stages exactly the files setup verifies');
  for (const component of setup) assert.ok(workflow.includes(`'${component[1]}'`), `${component[0]} publish folder is staged by the workflow`);
});

/** The `subject-path` block of the attest step. */
function subjectList() {
  const block = /subject-path: \|\n((?: {12}\S.*\n)+)/u.exec(workflow);
  assert.ok(block, 'subject-path is a literal block of paths');
  return block[1].trim().split('\n').map((line) => line.trim());
}

/** The text of the step whose `- name:` line starts with `name`. */
function stepText(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start > 0, `step "${name}" exists`);
  const next = workflow.indexOf('\n      - ', start + 10);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test('the workflow pins gh by version and SHA-256, fetches nothing else, and runs the steps in the order that makes the pins mean something', () => {
  const version = /GH_PINNED_VERSION: (\d+\.\d+\.\d+)\s*$/mu.exec(workflow)?.[1];
  const zipSha = /GH_PINNED_ZIP_SHA256: ([0-9a-f]{64})\s*$/mu.exec(workflow)?.[1];
  assert.ok(version && zipSha, 'version and zip SHA-256 are pinned as literals');
  assert.ok(workflow.includes(`releases/download/v${version}/gh_${version}_checksums.txt`), 'the comment names the checksums file the value came from');
  const fetchStep = stepText('Fetch the pinned gh.exe');
  assert.ok(fetchStep.includes('releases/download/v${version}/gh_${version}_windows_amd64.zip'), 'official release URL for the pinned version');
  assert.equal([...workflow.matchAll(/Invoke-WebRequest|Invoke-RestMethod|curl |wget |Start-BitsTransfer/gu)].length, 1, 'one download in the whole workflow');
  assert.match(fetchStep, /\$actual -ne \$expected\) \{ throw/u, 'the zip hash is compared and a mismatch stops the job');
  assert.ok(fetchStep.indexOf('Get-FileHash') < fetchStep.indexOf('Expand-Archive'), 'the hash is checked before the zip is opened');
  assert.match(fetchStep, /gh version \$version \*/u, 'the version line of the extracted gh.exe is checked');
  // every flag setup passes to gh is checked against the pinned gh's own --help
  const verifyFlags = /'verify' = @\(([^)]*)\)/u.exec(fetchStep)?.[1].match(/--[a-z-]+/gu) ?? [];
  for (const flag of code['GhVerifier.cs'].match(/"--[a-z-]+"/gu).map((f) => f.slice(1, -1))) assert.ok(verifyFlags.includes(flag), `${flag} is checked against gh's help`);
  const order = ['Fetch the pinned gh.exe', 'Make the Sigstore trusted root', 'Build albera-setup.exe', 'Attest build provenance', 'Download the attestation bundles', 'Assemble the update folder', 'Verify the update folder', 'Upload the update folder\n']
    .map((name) => workflow.indexOf(`- name: ${name}`));
  order[3] = workflow.indexOf('uses: actions/attest-build-provenance@');
  assert.ok(order.every((index) => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `steps are in order: ${order}`);
  assert.ok(workflow.indexOf('-Mode hashes') < workflow.indexOf('- name: Fetch the pinned gh.exe'), 'the published trees are hashed before anything of setup exists');
});

test('the workflow: trusted root from the pinned gh with a closing line feed, setup built with both hashes, bundles by gh attestation download, the built setup verifies its own run', () => {
  const trusted = stepText('Make the Sigstore trusted root');
  assert.match(trusted, /'attestation', 'trusted-root'/u);
  assert.match(trusted, /\$bytes\[\$bytes\.Length - 1\] -ne 10/u, 'closing line feed is checked');
  assert.equal(/GH_TOKEN/u.test(trusted), false, 'the trusted root needs no token');
  const build = stepText('Build albera-setup.exe');
  assert.match(build, /publish-windows-setup\.mjs --gh "\$PWD\\setup-input\\gh\.exe" --trusted-root "\$PWD\\setup-input\\trusted_root\.jsonl"/u);
  const download = stepText('Download the attestation bundles');
  assert.match(download, /'attestation', 'download'/u);
  assert.match(download, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.equal([...workflow.matchAll(/GH_TOKEN/gu)].length, 1, 'the job token reaches exactly one step');
  assert.equal(/secrets\./u.test(workflow), false, 'no repository secret');
  const downloaded = [...download.matchAll(/^\s+'([^']+)',?$/gmu)].map((m) => m[1]);
  assert.deepEqual(downloaded, subjectList(), 'a bundle is downloaded for exactly the attested subjects');
  const verify = stepText('Verify the update folder');
  assert.match(verify, /--mode verify --update \$update --no-pause/u);
  assert.match(verify, /commit=\$env:GITHUB_SHA /u);
  assert.match(verify, /run=\$env:GITHUB_RUN_ID /u);
  assert.match(stepText('Upload the update folder\n'), /name: albera-update\n[\s\S]*path: albera-update[\s\S]*if-no-files-found: error/u);
});

test('the workflow keeps its existing guards: manual only, main only, one attest action, the narrow permissions', () => {
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:\s*$/mu);
  assert.match(workflow, /^\s+if: github\.ref == 'refs\/heads\/main'\s*$/mu);
  assert.equal([...workflow.matchAll(/uses:\s*actions\/attest\S*/gu)].length, 1, 'one attest step');
  assert.deepEqual([...workflow.matchAll(/dotnet-version:\s*(\S+)/gu)].map((m) => m[1]), ['10.0.403']);
  assert.equal(/packages: write|contents: write|write-all/u.test(workflow), false);
});

/** The text of one job: from its "  <name>:" line to the next job (or the end). */
function jobText(name) {
  const start = workflow.indexOf('\n  ' + name + ':\n');
  assert.ok(start > 0, 'job ' + name + ' exists');
  const next = workflow.slice(start + 1).search(/\n  [a-z]+:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test('the workflow is split so the code that builds never shares a job with the OIDC token: build (no token), attest (token, no npm / dotnet / node), verify (no token)', () => {
  const [build, attest, verify] = ['build', 'attest', 'verify'].map(jobText).map((text) => text.replace(/^\s*#.*$/gmu, ''));
  assert.deepEqual([...workflow.matchAll(/^  ([a-z]+):\n    name:/gmu)].map((m) => m[1]), ['build', 'attest', 'verify'], 'exactly these three jobs');
  assert.equal(/id-token|attestations: write|attest-build-provenance/u.test(build), false, 'the build job cannot ask for a signature');
  assert.equal(/id-token|attestations: write|attest-build-provenance/u.test(verify), false, 'the verify job has no token');
  assert.match(attest, /id-token: write/u);
  assert.match(attest, /attestations: write/u);
  assert.equal(/\bnpm\b|\bnode\b|\bdotnet\b|setup-node|setup-dotnet|actions\/checkout|publish-windows/u.test(attest.replace(/^\s*(?:- )?name:.*$/gmu, '')), false, 'the attest job runs no npm, node or dotnet and checks no code out');
  assert.match(build, /npm ci --ignore-scripts/u);
  assert.equal(/npm ci(?! --ignore-scripts)/u.test(workflow), false, 'no lifecycle script runs at npm ci');
  assert.match(attest, /needs: build/u);
  assert.match(verify, /needs: \[build, attest\]/u);
  assert.match(verify, /attestations: read/u);
  assert.match(build, /outputs:\n      subjects: \$\{\{ steps\.subjects\.outputs\.subjects \}\}/u);
  assert.match(attest, /SUBJECTS: \$\{\{ needs\.build\.outputs\.subjects \}\}/u, 'the hashes arrive through a job output, not the artifact');
  const check = stepText('Check the downloaded files against the hashes');
  assert.ok(workflow.indexOf('- name: Check the downloaded files') < workflow.indexOf('uses: actions/attest-build-provenance@'), 'files are compared before they are attested');
  assert.match(check, /\$actual -ne \$expected\[\$path\]\) \{ throw/u);
  assert.deepEqual([...check.matchAll(/^\s+'([^']+)',?$/gmu)].map((m) => m[1]), subjectList(), 'the compared files are the attested subjects');
  const recorded = [...stepText('Record the SHA-256').matchAll(/^\s+'([^']+)',?$/gmu)].map((m) => m[1]);
  assert.deepEqual(recorded, subjectList(), 'the build job reports exactly the attested subjects');
  // The job that holds the OIDC token runs nothing the build made: no gh, no setup, no node, no token for a downloaded program.
  assert.equal(/GH_TOKEN|Start-Process|attestation download|\.exe\s+(?:--|attestation)|&\s*\$|&\s*\(|\bInvoke-Expression\b|\biex\b|\bcmd\b/u.test(attest), false, 'the attest job starts no program');
  assert.deepEqual([...attest.matchAll(/^\s+- name: (.+)$/gmu)].map((m) => m[1]), ['Check the downloaded files against the hashes the build job reported', 'Attest build provenance'], 'the attest job has exactly these steps');
  assert.deepEqual([...attest.matchAll(/^\s+- uses: (\S+)/gmu)].map((m) => m[1].split('@')[0]), ['actions/download-artifact'], 'and only the download action besides the attest action');
  // the token-free job is the one that downloads the bundles with the job token and runs gh / setup
  assert.match(verify, /Download the attestation bundles[\s\S]*GH_TOKEN/u);
  assert.match(verify, /Verify the update folder[\s\S]*albera-setup\.exe/u);
  assert.equal(verify.includes('Check the downloaded files'), true, 'the verify job compares the files it will run with the build job\'s report too');
  assert.equal([...workflow.matchAll(/GH_TOKEN/gu)].length, 1, 'the job token reaches exactly one step');
});

test('every action is pinned to a commit SHA (the tag stays in the comment) and the bundle limit equals the policy limit of setup', () => {
  const uses = [...workflow.matchAll(/^\s+(?:- )?uses:\s*(\S+)(.*)$/gmu)].map((m) => [m[1], m[2]]);
  assert.ok(uses.length >= 8, 'the actions are found (false-safe)');
  for (const [action, comment] of uses) {
    assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40}$/u, action + ' is pinned to a commit');
    assert.match(comment, /# v\d+$/u, action + ' names its tag in a comment');
  }
  const policy = read('src', 'runtime', 'windows-setup', 'AttestationPolicy.cs');
  const maxEntries = /MaxEntries = (\d+)/u.exec(policy)?.[1];
  assert.ok(maxEntries);
  assert.match(stepText('Download the attestation bundles'), new RegExp("'--limit', '" + maxEntries + "'", 'u'));
  assert.ok(stepText('Fetch the pinned gh.exe').includes("'download' = @('--repo', '--limit')"), 'the pinned gh is asked whether it has --limit');
});

test('the publish script reads its two inputs as files, compiles their SHA-256 in as constants, and has a local compile-only mode', () => {
  assert.deepEqual(parseArguments(['--compile-check']), { compileCheck: true });
  assert.deepEqual(parseArguments(['--gh', 'C:\\x\\gh.exe', '--trusted-root', 'C:\\x\\root.jsonl']), { compileCheck: false, gh: 'C:\\x\\gh.exe', trustedRoot: 'C:\\x\\root.jsonl' });
  for (const bad of [[], ['--gh', 'a'], ['--trusted-root', 'b'], ['--compile-check', '--gh', 'a'], ['--gh', 'a', '--gh', 'b', '--trusted-root', 'c'], ['--bogus'], ['--gh']]) {
    assert.throws(() => parseArguments(bad), /usage:/u, bad.join(' '));
  }
  const source = pinnedToolsSource('a'.repeat(64), 'b'.repeat(64));
  assert.match(source, /public const string GhSha256 = "a{64}";/u);
  assert.match(source, /public const string TrustedRootSha256 = "b{64}";/u);
  assert.throws(() => pinnedToolsSource('A'.repeat(64), 'b'.repeat(64)), /not a SHA-256/u);
  assert.throws(() => pinnedToolsSource('a'.repeat(64), 'b"; evil'), /not a SHA-256/u);
  const script = read('scripts', 'publish-windows-setup.mjs');
  assert.match(script, /requireHostBuildSdk\(context\)/u);
  assert.ok(script.indexOf('requireHostBuildSdk(context)') < script.indexOf('restoreAndBuild(context'), 'the SDK is checked before restore');
  assert.match(script, /-p:RestoreLockedMode=true/u);
  assert.match(script, /-p:PublishAot=\$\{parsed\.compileCheck \? 'false' : 'true'\}/u);
  assert.equal(/fetch\(|https?\.get|download/iu.test(script.replace(/\/\/.*$/gmu, '')), false, 'the script downloads nothing');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:windows-setup'], 'node scripts/publish-windows-setup.mjs');
});

test('fixtures: synthetic files are labelled, parse as what they claim to be, and no real bundle is claimed', () => {
  const fixtures = path.join(root, 'test', 'fixtures', 'attestations');
  const readme = readFileSync(path.join(fixtures, 'README.md'), 'utf8');
  assert.match(readme, /`synthetic\/`.*written by hand/u);
  assert.match(readme, /`real\/`.*\*\*None yet\.\*\*/u);
  assert.equal(existsSync(path.join(fixtures, 'real')), false, 'a real/ folder needs its own README with the run id, commit and date');
  for (const file of ['bundle.jsonl', 'trusted_root.jsonl']) {
    const text = readFileSync(path.join(fixtures, 'synthetic', file), 'utf8');
    assert.ok(text.endsWith('\n') && text.trim().split('\n').every((line) => JSON.parse(line).synthetic === true), `${file}: lines of JSON marked synthetic, ending with a line feed`);
  }
  const output = JSON.parse(readFileSync(path.join(fixtures, 'synthetic', 'gh-verify-output.json'), 'utf8'));
  assert.match(output[0].attestation.note, /^SYNTHETIC/u);
  assert.equal(output[0].verificationResult.signature.certificate.subjectAlternativeName, `https://github.com/${csharpString('Repository')}/.github/workflows/${csharpString('WorkflowFile')}@${csharpString('SourceRef')}`);
});

test('tree hash: the C# rule and PowerShell\'s Get-CanonicalTreeHash give the same value for the vector the C# harness pins', { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 120_000 }, () => {
  const harness = readFileSync(path.join(root, 'test', 'windows-setup-harness', 'ChecksFiles.cs'), 'utf8');
  const expected = /VectorHash = "([0-9a-f]{64})"/u.exec(harness)?.[1];
  assert.ok(expected, 'the vector is found (false-safe)');
  const work = mkdtempSync(path.join(os.tmpdir(), 'albera-setup-vector-'));
  try {
    const lib = path.join(root, 'scripts', 'host', 'albera-host-lib.ps1');
    const script = path.join(work, 'vector.ps1');
    // the same input as VectorInput() in ChecksFiles.cs
    writeFileSync(script, [
      `. '${lib}'`,
      "$a = 'a' * 64; $b = 'b' * 64; $c = 'c' * 64; $d = 'd' * 64; $e = [string][char]0x00e9",
      "$comps = @{ 'broker' = @{ 'a.dll' = $a; 'B.dll' = $b; 'z/b.dll' = $c; ($e + '.dll') = $d }; 'authority' = @{ 'x.exe' = $c }; 'pipe-client' = @{ 'p.exe' = $d; 'sub\\q.dll' = $a } }",
      'Write-Output (Get-CanonicalTreeHash $comps)',
    ].join('\n'), 'utf8');
    const out = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.trim(), expected);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
