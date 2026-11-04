import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for the approver app (AlberaApprover.exe; ADR-002 "Receipt v2" / Approval Authority, Proposed / NOT VERIFIED). They run on every OS and need no .NET SDK.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(root, 'src', 'runtime', 'windows-approver');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const sources = Object.fromEntries(readdirSync(directory).filter((f) => f.endsWith('.cs')).map((f) => [f, readFileSync(path.join(directory, f), 'utf8')]));
const project = read('src', 'runtime', 'windows-approver', 'Albera.Approver.csproj');
const lockFile = JSON.parse(read('src', 'runtime', 'windows-approver', 'packages.lock.json'));
const publish = read('scripts', 'publish-windows-approver.mjs');
const stripComments = (source) => source.replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const code = Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, stripComments(text)]));
const allCode = Object.values(code).join('\n');
const helloCode = code['WindowsHello.cs'];
const codeWithoutHello = Object.entries(code).filter(([name]) => name !== 'WindowsHello.cs').map(([, text]) => text).join('\n');
const recordFileCode = code['KeyRecordFile.cs']; // the one file that touches the file system (the key record files); see the WebAuthn guards below
const codeWithoutRecordFile = Object.entries(code).filter(([name]) => name !== 'KeyRecordFile.cs').map(([, text]) => text).join('\n');
const webAuthnCode = code['WebAuthn.cs']; // the one file that calls webauthn.dll (shipped build only)
const outsideSeam = (text) => text.replace(/#if ALBERA_APPROVER_TEST_FAULTS[\s\S]*?#endif/gu, '');
const shippedCode = Object.entries(code).filter(([name]) => name !== 'TestSeam.cs').map(([, text]) => outsideSeam(text)).join('\n');
const importsOf = (source) => [...source.matchAll(/\[DllImport\("([^"]+)"[^\]]*\)\]\s*(?:private|internal|public) static extern \w+ (\w+)\(/gu)].map((m) => `${m[1]}!${m[2]}`);
const sliceBetween = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test('the approver is a separate project: one external dependency (the pinned Windows SDK projection), no other project, the contract by source include only, no elevation', () => {
  assert.deepEqual([...project.matchAll(/<PackageReference /gu)], [], 'no package reference: the only download is the targeting pack the Windows TFM implies');
  assert.match(project, /<TargetFramework>net10\.0-windows10\.0\.19041\.0<\/TargetFramework>/u, 'the Windows TFM is what makes the SDK restore Microsoft.Windows.SDK.NET.Ref');
  assert.match(project, /<WindowsSdkPackageVersion>10\.0\.19041\.57<\/WindowsSdkPackageVersion>/u, 'the projection pack version is pinned, never floating');
  assert.deepEqual([...project.matchAll(/<(?:PackageVersion|FrameworkReference|COMReference|Reference|Import)\b[^>]*>/gu)], [], 'no other dependency');
  assert.equal(/ProjectReference|windows-broker|WindowsBroker|windows-approval-authority|ApprovalAuthority/iu.test(project), false, 'no other project is referenced');
  assert.deepEqual([...project.matchAll(/<Compile Include="([^"]+)"/gu)].map((m) => m[1]), ['../broker-contract/*.cs']);
  assert.match(project, /<AssemblyName>AlberaApprover<\/AssemblyName>/u);
  assert.match(project, /<RuntimeIdentifiers>win-x64<\/RuntimeIdentifiers>/u);
  assert.equal(/ApplicationManifest|requestedExecutionLevel|WindowsService|UseWindowsServices|UseWPF/iu.test(project), false, 'no elevation, no service wrapper, no WPF');
  assert.deepEqual(Object.keys(lockFile.dependencies), ['net10.0-windows10.0.19041', 'net10.0-windows10.0.19041/win-x64']);
  assert.deepEqual(Object.values(lockFile.dependencies).map((framework) => Object.keys(framework)), [[], []], 'the lock file pins no NuGet package (the projection pack is a targeting pack, pinned in the csproj)');
  for (const [name, text] of Object.entries(sources)) {
    assert.equal(/windows-broker|WindowsBroker|windows-approval-authority|Albera\.ApprovalAuthority|approval-authority\.exe/iu.test(text), false, `${name} must not name another project`);
  }
});

test('the approver never starts a process, registers a service, writes a file, uses the network, reads the environment, or creates / imports / exports / deletes a key', () => {
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /ServiceBase/u, /ServiceController/u, /\bsc\.exe\b/u, /powershell/iu, /Hyper-?V/iu, /SetAccessControl/u,
    /CreateService|ChangeServiceConfig|ControlService|DeleteService|StartService/u, /System\.ServiceProcess|Microsoft\.Extensions\.Hosting/u,
    /HttpClient|System\.Net\.Sockets|TcpClient|WebRequest/u,
    /Environment\.GetEnvironmentVariable|Environment\.ExpandEnvironmentVariables/u, /CngKey|NCrypt|ExportPkcs8PrivateKey|ExportRSAPrivateKey|ExportParameters\(true\)|RSA\.Create\(\d/u,
    /RenewAttestationAsync/u]) {
    assert.equal(forbidden.test(allCode), false, `no approver source may match ${forbidden}`);
  }
  // File writes: since WebAuthn the approver writes the public key record files (`enroll --webauthn`) and nothing else. That is ONE file, KeyRecordFile.cs; no other source touches the file system,
  // and that file may only create (never overwrite, delete, move or append) under the fixed folder. See the key record file guard below.
  assert.equal(/File\.(?:Write|Create|Delete|Move|Copy|Append|Open|Replace)|FileMode\.|FileAccess\.Write|new FileStream|(?<!\w)Directory\.|FileInfo|DirectoryInfo|StreamWriter/u.test(codeWithoutRecordFile), false, 'only KeyRecordFile.cs touches the file system');
  assert.equal(/KeyCredentialManager|Windows\.Security\.Credentials|Windows\.Security\.Cryptography/u.test(codeWithoutHello), false, 'the WinRT Hello API is used only in WindowsHello.cs');
  // Issue #101: the two calls that used to be forbidden are allowed in exactly one place each, in the Hello file: attest the key `enroll` just made, and remove that key when the attestation is refused.
  assert.equal(/DeleteAsync|GetAttestationAsync/u.test(codeWithoutHello), false, 'attest / delete live only in WindowsHello.cs');
  assert.equal([...helloCode.matchAll(/GetAttestationAsync/gu)].length, 1, 'one attestation call');
  assert.equal([...helloCode.matchAll(/DeleteAsync/gu)].length, 1, 'one delete call');
  assert.match(helloCode, /private static bool RemoveCreatedKey\(\)\s*\{\s*try \{ KeyCredentialManager\.DeleteAsync\(HelloCredential\.Name\)/u, 'the delete is the removal of the key enroll just made, by the fixed name');
  assert.equal([...helloCode.matchAll(/RemoveCreatedKey\(\)/gu)].length, 2, 'defined once and called once (the refused-attestation path)');
  // The one exception: PresenceSignature.Verify (Presence.cs) makes an RSA object only to import a PUBLIC key (SPKI) for the self-check's local verify; it never generates a key.
  // WebAuthn (ApproverKeyRecord.cs) does the same for the public keys of its records: the same two statements, importing a PUBLIC SPKI, to classify a key and to verify a signature. Nothing else makes an RSA object.
  const withoutVerifier = outsideSeam(codeWithoutHello).replace(/using RSA rsa = RSA\.Create\(\);\s*rsa\.ImportSubjectPublicKeyInfo\(spki, out (?:_|int \w+)\);/gu, '');
  assert.equal(/RSA\.Create\(\)/u.test(withoutVerifier), false, 'an RSA key object is created only in the test seam (and, public-key import only, in PresenceSignature.Verify and the key record code)');
  assert.equal([...code['Presence.cs'].matchAll(/RSA\.Create\(\)/gu)].length, 1, 'exactly one RSA object in Presence.cs');
  assert.equal([...code['ApproverKeyRecord.cs'].matchAll(/RSA\.Create\(\)/gu)].length, 1, 'one in the key record code: classifying a public key, an import');
});

test('Windows Hello: the shipped build signs with WindowsHelloPresenceSigner through the one IPresenceSigner seam; the WinRT calls are a short fixed list in one file; no private key is touched', () => {
  assert.match(code['Presence.cs'], /internal interface IPresenceSigner\s*\{\s*SignResult Sign\(byte\[\] message\);\s*\}/u);
  assert.deepEqual([...allCode.matchAll(/class (\w+) : IPresenceSigner/gu)].map((m) => m[1]).sort(), ['NotReadyPresenceSigner', 'WindowsHelloPresenceSigner']);
  assert.deepEqual([...allCode.matchAll(/class (\w+)\([^)]*\) : IPresenceSigner/gu)].map((m) => m[1]), ['FakePresenceSigner'], 'the only other implementation is the fake');
  assert.deepEqual([...allCode.matchAll(/class (\w+)(?:\([^)]*\))? : IHelloKeyStore/gu)].map((m) => m[1]).sort(), ['FakeKeyStore', 'WindowsHelloKeyStore']);
  // The shipped branch of the entry point wires Hello; the test-faults branch wires the never-ready signer (and the Hello file is not even compiled there).
  const wiring = sources['Program.cs'].match(/#if ALBERA_APPROVER_TEST_FAULTS\n([\s\S]*?)#else\n([\s\S]*?)#endif/u);
  assert.ok(wiring, 'Program.cs has one #if / #else / #endif for the wiring');
  assert.match(wiring[2], /new WindowsHelloPresenceSigner\(\), new WindowsHelloKeyStore\(\)/u, 'the shipped build uses Windows Hello');
  assert.equal(/Fake|NotReady|TestSeam/u.test(wiring[2]), false, 'the shipped branch has no fake');
  assert.match(wiring[1], /new NotReadyPresenceSigner\(\), new FakeKeyStore\(null, unavailable: true\)/u, 'a test build never reaches the real Hello');
  assert.match(project, /<Compile Remove="WindowsHello\.cs" Condition="'\$\(AlberaApproverTestFaults\)' == 'true'" \/>/u, 'the test-faults build does not contain the Hello file');
  // The WinRT surface: exactly these members, nothing that exports a private key or renews an attestation. (Issue #101 added GetAttestationAsync and DeleteAsync.)
  const used = [...new Set([...helloCode.matchAll(/\b(KeyCredentialManager\.\w+|RetrievePublicKey|RequestSignAsync|GetAttestationAsync|CryptographicBuffer\.\w+)\b/gu)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['CryptographicBuffer.CopyToByteArray', 'CryptographicBuffer.CreateFromByteArray', 'GetAttestationAsync', 'KeyCredentialManager.DeleteAsync', 'KeyCredentialManager.IsSupportedAsync',
    'KeyCredentialManager.OpenAsync', 'KeyCredentialManager.RequestCreateAsync', 'RequestSignAsync', 'RetrievePublicKey']);
  assert.deepEqual([...helloCode.matchAll(/^using ([\w.]+);/gmu)].map((m) => m[1]), ['System.Security.Cryptography', 'Windows.Security.Credentials', 'Windows.Security.Cryptography', 'Windows.Security.Cryptography.Core']);
  assert.match(helloCode, /CryptographicPublicKeyBlobType\.X509SubjectPublicKeyInfo/u, 'only the public half, as SPKI');
  assert.match(helloCode, /public const string Name = "AlberaApprover\.v1";/u, 'one fixed credential name');
  assert.match(helloCode, /KeyCredentialCreationOption\.ReplaceExisting : KeyCredentialCreationOption\.FailIfExists/u, 'create never replaces unless enroll --replace was typed-confirmed');
  assert.equal(/Console\.|File\.|Process|Environment|HttpClient|Socket/u.test(helloCode), false, 'the Hello file prints, writes and connects to nothing');
  assert.match(helloCode, /return signature\.Length == HelloCredential\.SignatureBytes \? SignResult\.Signed\(signature\) : SignResult\.Unavailable;/u, 'only a 256-byte (RSA-2048) signature is ever sent');
  assert.match(helloCode, /Status == KeyCredentialStatus\.NotFound\) return SignResult\.NotReady;/u, 'not enrolled sends nothing');
});

test('enroll --check (self-check): local only, the existing key only, domain-separated message, console first, verify before OK; nothing is sent, written or created', () => {
  const check = code['SelfCheckCommand.cs'];
  assert.ok(check, 'SelfCheckCommand.cs exists');
  // Local only: its constructor takes the key store, the signer and console writers; no channel, and nothing in the file names a pipe, a network type, a file, the environment or a process.
  assert.match(check, /internal sealed class SelfCheckCommand\(IHelloKeyStore store, IPresenceSigner signer, Func<string> currentUserSid, Func<byte\[\]> nonce, TextWriter output, TextWriter errors, bool interactive\)/u);
  for (const forbidden of [/IApproverChannel|PipeChannel|NamedPipe|ServerExpectation|CallAsync/u, /Socket|HttpClient|WebRequest|Dns\b|System\.Net/u, /File\b|Path\.|Directory|FileStream|StreamWriter/u, /Environment\./u, /Console\./u, /Process/u]) {
    assert.equal(forbidden.test(check), false, `the self-check must not match ${forbidden}`);
  }
  // It never creates, replaces or deletes a key: only Open() is called on the store.
  assert.deepEqual([...check.matchAll(/store\.(\w+)\(/gu)].map((m) => m[1]), ['Open']);
  assert.equal(/Create\(|ReplaceExisting|RequestCreateAsync|DeleteAsync/u.test(check), false);
  // Order: console check, open the existing key, (expect check), sign, verify, only then the OK line.
  const order = ['if (!interactive)', 'store.Open()', 'expectedKeyId is not null', 'signer.Sign(message)', 'PresenceSignature.Verify(', 'self-check: OK'].map((token) => check.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `console -> open -> expect -> sign -> verify -> OK (${order})`);
  assert.equal([...check.matchAll(/signer\.Sign\(/gu)].length, 1, 'one signing site');
  assert.equal([...check.matchAll(/self-check: OK/gu)].length, 1, 'one place prints OK, and it is the verified branch');
  assert.match(check, /case SignStatus\.Signed when PresenceSignature\.Verify\(lookup\.PublicKey!, message, signed\.Signature!\):\s*output\.Write\(\$"self-check: OK/u);
  // Domain separation: its own domain word, never the presence one.
  assert.match(check, /public const string Domain = "albera\.selfcheck\.v1";/u);
  assert.match(check, /\$"\{Domain\}\\0\{Convert\.ToHexStringLower\(nonce\)\}"/u);
  assert.equal(/albera\.presence|PresenceMessage/u.test(check), false, 'the self-check never builds or names a presence message');
  assert.notEqual('albera.selfcheck.v1', /Domain = "([^"]+)"/u.exec(code['Presence.cs'])[1]);
  assert.equal(code['Presence.cs'].includes('albera.selfcheck'), false, 'the presence file does not know the self-check domain');
  assert.equal(allCode.split('albera.selfcheck.v1').length - 1, 1, 'the self-check domain word is defined once');
  // The entry point routes it to the key store and signer only, before any pipe object exists, with a fresh 32-byte nonce.
  const program = code['Program.cs'];
  const branch = program.slice(program.indexOf('if (command.Option == "check")'), program.indexOf('if (command.Verb == "enroll")'));
  assert.match(branch, /new SelfCheckCommand\(wiring\.KeyStore, wiring\.Signer, CurrentUserSid, \(\) => RandomNumberGenerator\.GetBytes\(SelfCheckMessage\.NonceBytes\), Console\.Out, Console\.Error, wiring\.Interactive\)\.Run\(command\.Expect\)/u);
  assert.equal(/PipeChannel|wiring\.Expectation/u.test(branch), false, 'no pipe on the self-check path');
  assert.ok(program.indexOf('if (command.Option == "check")') < program.indexOf('new PipeChannel('), 'dispatched before the pipe is constructed');
  assert.match(check, /public const int NonceBytes = 32;/u);
  // Grammar and docs: --expect only after --check, the key id in the Authority's id grammar.
  assert.match(code['CommandLine.cs'], /args is \["enroll", "--check", "--expect", \{ \} expected\] && IsKeyId\(expected\)/u);
  assert.match(code['CommandLine.cs'], /Regex\.IsMatch\(value, ActionDigest\.IdPattern/u);
  assert.match(read('docs', 'architecture', 'approver-app.md'), /enroll --check/u);
});

test('there is no --yes: the typed yes cannot be skipped, approve needs a console before any pipe access, and enroll never prints or stores private material', () => {
  assert.equal(/--yes|AssumeYes|assumeYes/u.test(Object.values(sources).join('\n')), false, 'no --yes anywhere in the sources (comments included)');
 assert.match(code['CommandLine.cs'], /Usage = "usage: AlberaApprover list \| approve <approvalId> \| deny <approvalId> \| enroll \[--show \| --replace \| --check \[--expect <approverKeyId>\]\] \| enroll \[--replace\] --accept-unattested \| enroll --webauthn --accept-unattested \| keys list \| keys remove <keyId> \| policy \[show\] \| policy set <careful\|standard> \[--prompt <action>\]\.\.\. \| --tray"/u);
  assert.match(code['ApproverCommands.cs'], /if \(!interactive\) throw new Stop\(ExitCodes\.Refused, "not_interactive"/u);
  assert.equal([...code['Program.cs'].matchAll(/!Console\.IsInputRedirected/gu)].length, 2, 'interactive means stdin is not redirected, in both build branches and nowhere else');
  const enroll = code['EnrollCommand.cs'];
  assert.match(enroll, /if \(option == "show"\) return Show\(\);\s*if \(!interactive\) return Fail\(ExitCodes\.Refused, "not_interactive"\);/u, 'create / replace need a console; show does not');
  assert.match(enroll, /input\.ReadLine\(\) != ReplaceWord\) return Fail\(ExitCodes\.Refused, "not_confirmed"\)/u);
  assert.deepEqual([...enroll.matchAll(/\\"(approver\w+)\\"/gu)].map((m) => m[1]).sort(), ['approverKeyId', 'approverPublicKey', 'approverSid'], 'enroll prints exactly the three config values');
  assert.equal(/PrivateKey|Pkcs8|Export(?!SubjectPublicKeyInfo)/u.test(enroll + code['HelloKeyStore.cs'] + helloCode), false, 'no private material in enroll or the Hello code');
});

test('the fake signer, the test options and the TestSeam exist only inside #if ALBERA_APPROVER_TEST_FAULTS and never in the shipped build', () => {
  assert.equal(/FakePresenceSigner|TestSeam|--test-|ImportPkcs8PrivateKey|SignData|SoftwareAuthenticator/u.test(shippedCode), false, 'fake names only appear inside the test-only #if blocks');
  assert.match(sources['TestSeam.cs'].trimStart(), /^#if ALBERA_APPROVER_TEST_FAULTS/u, 'TestSeam.cs is one #if block');
  assert.match(sources['TestSeam.cs'].trimEnd(), /#endif$/u);
  assert.match(project, /Condition="'\$\(AlberaApproverTestFaults\)' == 'true'"/u);
  assert.match(project, /<DefineConstants>\$\(DefineConstants\);ALBERA_APPROVER_TEST_FAULTS<\/DefineConstants>/u);
  assert.equal([...outsideSeam(sources['Program.cs']).matchAll(/ALBERA_APPROVER_TEST_FAULTS/gu)].length, 0, 'the entry file has no stray reference to the switch outside its #if blocks');
  assert.match(sources['Program.cs'], /if \(!TestSeam\.TryApply\(ref args, ref wiring\)\) return Usage\(\);\n#else/u);
  assert.equal(/FakePresenceSigner|FakeKeyStore|NotReadyPresenceSigner/u.test(shippedCode), false, 'the fakes are named only in the test-only blocks');
  // MSBuild reads environment variables as properties, so the publish pins the switch off as a global property and never turns it on.
  assert.match(publish, /'-p:AlberaApproverTestFaults=false'/u);
  assert.equal(/AlberaApproverTestFaults=(?!false')|ALBERA_APPROVER_TEST_FAULTS/u.test(publish), false, 'the publish script must never enable the test fakes');
});

test('the server is verified on the connected handle BEFORE the only write: SQOS identification, owner SID, server PID, session 0 in service mode', () => {
  const pipe = code['PipeChannel.cs'];
  assert.deepEqual(importsOf(pipe), ['kernel32.dll!CreateFileW', 'kernel32.dll!GetNamedPipeServerProcessId', 'kernel32.dll!GetNamedPipeServerSessionId']);
  assert.deepEqual(importsOf(code['ServerExpectation.cs']), ['advapi32.dll!OpenSCManagerW', 'advapi32.dll!OpenServiceW', 'advapi32.dll!QueryServiceStatusEx', 'advapi32.dll!CloseServiceHandle']);
  assert.match(pipe, /SecuritySqosPresent = 0x00100000, SecurityIdentification = 0x00010000/u);
  assert.match(pipe, /FlagOverlapped \| SecuritySqosPresent \| SecurityIdentification/u);
  assert.match(code['PipeChannel.cs'].replace(/\/\*[^*]*\*\//gu, '').replace(/ +/gu, ' '), /ClientAccess = 0x1 \| 0x2 \| 0x80 \| 0x20000 \| 0x100000 ?;/u, 'specific rights, never GENERIC_WRITE');
  const call = sliceBetween(pipe, 'public async Task<string> CallAsync', 'private async Task<NamedPipeClientStream> ConnectAsync');
  const order = ['ConnectAsync(', 'VerifyServer(pipe)', 'ExchangeAsync('].map((token) => call.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `connect -> verify -> exchange (${order})`);
  assert.equal([...pipe.matchAll(/\.WriteAsync\(/gu)].length, 1, 'one write site');
  assert.ok(pipe.indexOf('VerifyServer(NamedPipeClientStream') < pipe.indexOf('.WriteAsync('), 'the write is after the verification code');
  const verify = sliceBetween(pipe, 'private void VerifyServer', 'private static ChannelException Mismatch');
  for (const token of ['expectation.Resolve()', 'GetOwner(typeof(SecurityIdentifier))', 'owner.Equals(expected.Owner)', 'GetNamedPipeServerProcessId(', 'serverPid != expected.Pid', 'expected.RequireSessionZero', 'session != 0']) {
    assert.ok(verify.includes(token), `VerifyServer checks ${token}`);
  }
  assert.match(verify, /catch \(Exception ex\) when \(ex is not ChannelException\)\s*\{\s*throw new ChannelException\(ChannelCodes\.ServerIdentityUnavailable, sent: false\);/u, 'a failed check is a pre-send code');
  const expectation = code['ServerExpectation.cs'];
  assert.match(expectation, /ProductionPipeRoot = @"ALBERA\\ApprovalAuthority", ProductionServiceName = "AlberaApprovalAuthority"/u);
  assert.match(expectation, /new NTAccount\("NT SERVICE", ServiceName\)\.Translate\(typeof\(SecurityIdentifier\)\)/u);
  assert.match(expectation, /new ResolvedServer\(owner, ServicePid\(ServiceName\), RequireSessionZero: true\)/u);
  assert.match(expectation, /Production \{ get; \} = new\(ProductionPipeRoot, ProductionServiceName, null, null\)/u);
  assert.match(expectation, /ApproverPipe => PipeRoot \+ @"\\approver\\v1"/u);
  assert.equal(/submit/iu.test(allCode), false, 'the approver never names the submit pipe or verb');
});

test('the wire protocol: only list and decide, only approve / deny / presence_unavailable, frames of 1..2048 bytes, exactly the Authority\'s error codes', () => {
  const commands = code['ApproverCommands.cs'];
  assert.deepEqual([...new Set([...commands.matchAll(/\\"verb\\":\\"(\w+)\\"/gu)].map((m) => m[1]))].sort(), ['decide', 'list']);
  assert.deepEqual([...new Set([...commands.matchAll(/\\"decision\\":\\"(\w+)\\"/gu)].map((m) => m[1]))].sort(), ['approve', 'deny', 'presence_unavailable']);
  assert.match(commands, /AuthorityCodes = \["authority_unavailable", "request_invalid", "request_expired", "human_denied", "presence_unavailable", "presence_mismatch", "queue_full"\]/u);
  assert.match(code['PipeChannel.cs'], /MaxFrameBytes = 2048/u);
  assert.match(code['PipeChannel.cs'], /body\.Length is < 1 or > MaxFrameBytes/u);
  assert.match(code['PipeChannel.cs'], /length > MaxFrameBytes/u);
  assert.match(code['PipeChannel.cs'], /length < 1 \|\|/u);
  assert.match(code['PipeChannel.cs'], /await pipe\.ReadAsync\(new byte\[1\], token\) != 0/u, 'the reply must be followed by end of stream');
  // The approval id is pasted into request text, so only the Authority's uuid grammar may reach it.
  assert.match(code['PendingView.cs'], /UuidPattern = "\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$"/u);
  assert.equal([...commands.matchAll(/RequireApprovalId\(approvalId\);/gu)].length, 2, 'approve and deny validate the id before building a request');
  assert.match(code['CommandLine.cs'], /IsApprovalId\(approved\)/u);
});

test('policy set: the tier change is described first, Hello is asked only when the change loosens the policy, after a console check and a typed yes, over the policy message of the hash computed here', () => {
  const policy = code['PolicyCommand.cs'];
  assert.ok(policy, 'PolicyCommand.cs exists');
  assert.match(policy, /internal sealed class PolicyCommand\(IApproverChannel channel, IPresenceSigner signer, TextWriter output, TextWriter errors, TextReader input, bool interactive, WebAuthnKit\? webAuthn = null\)/u);
  // The verbs and the words that go into a request: only these two verbs, and the policy comes from the contract's own TierPolicy (known tier, known actions, revision + 1).
  assert.deepEqual([...new Set([...policy.matchAll(/\\"verb\\":\\"(\w+)\\"/gu)].map((m) => m[1]))].sort(), ['policy', 'policy_set']);
  assert.match(policy, /TierPolicy\.TryCreate\(current\.Revision \+ 1, tier, prompts\) \?\? throw new Stop\(ExitCodes\.BadUsage, "bad_policy"\)/u);
  assert.match(code['CommandLine.cs'], /TierPolicy\.TryCreate\(0, tier, prompts\) is \{ \} policy \? new CommandLine\("policy", null, "set", null, policy\.Tier, policy\.Prompts\) : null/u, 'unknown tiers and actions are not commands');
  const set = policy.slice(policy.indexOf('public Task<int> SetAsync'), policy.indexOf('// The policy in force, read from the Authority'));
  const order = ['ReadCurrentAsync()', 'next.Loosens(current)', 'Describe(current)', 'Change(current, next, loosens)', 'if (loosens && !interactive)', 'ChooseRouteAsync()', 'if (!Confirmed())', 'signing.Sign(route, PolicyChange.Message(next, kid, audience))', 'CallAsync(request)'].map((token) => set.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `read -> effect -> show -> console -> key choice (remote_session stops here) -> yes -> sign -> send (${order})`);
  assert.equal([...policy.matchAll(/signing\.Sign\(/gu)].length, 1, 'one signing site');
  assert.equal(/signer\.Sign\(/u.test(policy), false, 'the command never calls the Hello signer itself: PresenceSigning picks the key');
  assert.ok(set.indexOf('signing.Sign(') > set.indexOf('if (loosens)'), 'the signer is reached only inside the loosening branch');
  assert.match(policy, /SigningRoute route = loosens \? await ChooseRouteAsync\(\) : SigningRoute\.UsingHello;/u, 'a change that only adds prompts never asks the Authority for its keys');
  assert.equal(/PresenceMessage|SelfCheckMessage|albera\.presence|albera\.selfcheck/u.test(policy), false, 'the policy command never builds a presence or self-check message');
  // The current policy is read with the contract's strict reader and hashed here; the Authority's hash must agree.
  assert.match(policy, /TierPolicy\.TryParse\(Encoding\.UTF8\.GetBytes\(policy\.GetRawText\(\)\)\) is \{ \} parsed && version\.GetString\(\) == parsed\.Hash\(\)/u);
  assert.equal(/submit/iu.test(policy), false);
  // The entry point dispatches it after the self-check and enroll branches, with the same channel and signer as approve.
  assert.match(code['Program.cs'], /if \(command\.Verb == "policy"\)\s*\{\s*PolicyCommand policy = new\(new PipeChannel\(wiring\.Expectation, wiring\.TimeoutMs\), wiring\.Signer, Console\.Out, Console\.Error, Console\.In, wiring\.Interactive, wiring\.WebAuthn\);/u);
  assert.ok(code['Program.cs'].indexOf('if (command.Verb == "enroll")') < code['Program.cs'].indexOf('if (command.Verb == "policy")'));
});

test('approve: refuse on a digest mismatch BEFORE the signer is asked; the signed digest is the one this app recomputed, never the Authority\'s; one signing site', () => {
  const approve = sliceBetween(code['ApproverCommands.cs'], 'public Task<int> ApproveAsync', 'private async Task<int> SignAndDecideAsync');
  const order = ['RequireApprovalId(', 'if (!interactive)', 'FetchAllAsync()', 'Renderer.Render(', 'view.DigestMatches', 'ChooseRouteAsync()', 'Confirmed()', 'SignAndDecideAsync(view, route)'].map((token) => approve.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `validate -> console check -> list -> show -> digest check -> key choice (remote_session stops here, before the yes) -> confirm -> sign and decide (${order})`);
  assert.equal([...code['ApproverCommands.cs'].matchAll(/signing\.Sign\(/gu)].length, 1, 'one signing site');
  assert.equal(/signer\.Sign\(/u.test(code['ApproverCommands.cs']), false, 'the command never calls the Hello signer itself: PresenceSigning picks the key');
  // The signing and the decide moved into one private method that the CLI (after the typed yes) and the GUI (ApproveShownAsync, after its own digest refusal) both end in.
  const signAndDecide = sliceBetween(code['ApproverCommands.cs'], 'private async Task<int> SignAndDecideAsync', 'public Task<int> DenyAsync');
  const tail = ['signing.Sign(', 'return await DecideAsync('].map((token) => signAndDecide.indexOf(token));
  assert.ok(tail.every((at) => at > 0) && tail[1] > tail[0], `sign -> decide (${tail})`);
  assert.equal([...code['ApproverCommands.cs'].matchAll(/SignAndDecideAsync\(/gu)].length, 3, 'defined once, called by the CLI approve and by ApproveShownAsync only');
  assert.match(signAndDecide, /PresenceMessage\.Build\(view\.ApprovalId, view\.RecomputedDigest, view\.Challenge\)/u);
  assert.equal(/AuthorityDigest/u.test(code['ApproverCommands.cs']), false, 'the Authority-sent digest is only compared (PendingView), never used by the command');
  assert.match(code['PendingView.cs'], /DigestMatches => string\.Equals\(AuthorityDigest, RecomputedDigest, StringComparison\.Ordinal\)/u);
  assert.match(code['PendingView.cs'], /string recomputed = ActionDigest\.Compute\(purpose, dto\);/u, 'the contract\'s own digest code');
  assert.match(code['PendingView.cs'], /StrictJson\.Parse\(Encoding\.UTF8\.GetBytes\(entry\.GetProperty\("action"\)\.GetRawText\(\)\), 3\)/u, 'the action is re-read with the strict reader');
  assert.match(signAndDecide, /SignStatus\.Signed =>[\s\S]*SignStatus\.Unavailable =>[\s\S]*_ => throw new Stop\(ExitCodes\.SignerUnavailable/u, 'no usable Hello key sends nothing');
});

test('rendering: every string a person is shown goes through SafeText (printable ASCII only), and every digest input is rendered', () => {
  const renderer = code['Renderer.cs'];
  assert.match(code['SafeText.cs'], /c is >= ' ' and <= '~'/u, 'only printable ASCII passes');
  for (const field of ['view.Purpose', 'view.Action.Action', 'view.Action.ProjectId', 'view.Action.ComputerId', 'view.OperationId', 'name', 's)']) {
    assert.ok(renderer.includes(`Show(${field}`), `${field} is shown through Show()`);
  }
  assert.match(renderer, /string Show\(string value\) \{ string quoted = SafeText\.Quote\(value, out int n\);/u);
  assert.match(renderer, /view\.Action\.Args\.OrderBy\(a => a\.Key, StringComparer\.Ordinal\)/u, 'every arg, in the digest\'s order');
  assert.equal(/\.Append\(view\.(?:Purpose|OperationId|Action\.(?:Action|ProjectId|ComputerId)|Challenge)\b/u.test(renderer), false, 'no unquoted string from the request');
  assert.equal(/(?:output|errors)\.Write\([^;]*\b(?:text|reply|root)\b/u.test(code['ApproverCommands.cs']), false, 'a reply text is never printed raw');
});

test('build:approver builds and records a SHA-256; it does not install, register or start anything, and the package never contains it', () => {
  assert.match(publish, /RestoreLockedMode=true/u);
  assert.match(publish, /\.manifest\.json/u);
  assert.match(publish, /captureExecutableIdentity/u);
  assert.match(publish, /--self-contained/u);
  assert.match(publish, /const executableName = 'AlberaApprover\.exe';/u);
  assert.equal(/spawn(?:Sync)?\(\s*(?:executable|output)\b/u.test(publish), false);
  assert.equal(/\bsc(?:\.exe)?\b|New-Service|Start-Process|runas|schtasks|icacls|Set-Acl|certutil|tpmtool|New-SelfSignedCertificate|signtool|Add-AppxPackage/iu.test(publish), false);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:approver'], 'node scripts/publish-windows-approver.mjs');
  const { 'build:approver': _build, ...otherScripts } = pkg.scripts;
  assert.equal(JSON.stringify({ ...pkg, scripts: otherScripts }).includes('approver'), false, 'package.json names the approver only in its build script');
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'start', 'demo', 'test']) assert.equal(String(pkg.scripts[lifecycle] ?? '').includes('approver'), false, lifecycle);
  assert.match(read('scripts', 'package-smoke.mjs'), /windows-approver\|AlberaApprover/u);
  assert.match(read('scripts', 'arch-check.mjs'), /^const APPROVER_REF = /mu, 'arch rule 11 exists');
});

test('issue #101: the attestation rule accepts Success, plus NotSupported (empty buffers) only on the explicit flag, and the Hello file applies it to the key it just made, removing the key otherwise', () => {
  const store = code['HelloKeyStore.cs'];
  assert.match(store, /public const string AcceptedStatus = "Success";/u);
  assert.match(store, /public const string OptInStatus = "NotSupported";/u);
  assert.match(store, /public const string OptInFlag = "--accept-unattested";/u);
  assert.match(store, /public static bool Accepts\(string status, int chainBytes, int statementBytes, bool acceptUnattested\) =>\s*\(status == AcceptedStatus && chainBytes > 0 && statementBytes > 0\) \|\| \(acceptUnattested && IsOptInResult\(status, chainBytes, statementBytes\)\);/u, 'Success, or the opt-in result when the flag is on: no third way');
  assert.match(store, /public static bool IsOptInResult\(string status, int chainBytes, int statementBytes\) => status == OptInStatus && chainBytes == 0 && statementBytes == 0;/u);
  assert.equal([...allCode.matchAll(/AttestationPolicy\.Accepts\(/gu)].length, 2, 'the real store and the fake store call the policy; nothing else has an opinion on what is attested');
  assert.equal([...store.matchAll(/\bAccepts\(/gu)].length, 2, 'inside the policy file: the definition and the summary that uses it');
  assert.match(helloCode, /KeyCredentialStatus\.Success => Attested\(created\.Credential, acceptUnattested\)/u, 'a created key is attested before it is reported');
  assert.equal(/KeyCredentialStatus\.Success => Present\(created\.Credential\)/u.test(helloCode), false, 'the create path never reports an unattested key');
  const attested = sliceBetween(helloCode, 'private static KeyLookup Attested(', 'private static bool RemoveCreatedKey');
  assert.match(attested, /status = attestation\.Status\.ToString\(\);/u, 'the status is compared as text; an unknown value cannot match');
  assert.match(attested, /catch \(Exception ex\) when \(ex is not OutOfMemoryException\)\s*\{\s*status = "Exception";/u, 'an exception from the API is a refusal, not a pass');
  assert.match(attested, /if \(AttestationPolicy\.Accepts\(status, chainBytes, statementBytes, acceptUnattested\)\)[\s\S]*return KeyLookup\.NotAttested\(/u);
  // The flag has one reader and one consumer: the parser makes it only for `enroll` / `enroll --replace`, Program hands it to EnrollCommand alone, and the only literal is the policy constant.
  // Since WebAuthn one more command carries the same opt-in: `enroll --webauthn` (a WebAuthn key is made with attestation none). `keys add` does not exist (keys are added only by the elevated set-approver).
  assert.deepEqual([...code['CommandLine.cs'].matchAll(/args is \[([^\]]*--accept-unattested[^\]]*)\]/gu)].map((m) => m[1]),
    ['"enroll", "--accept-unattested"', '"enroll", "--replace", "--accept-unattested"', '"enroll", "--webauthn", "--accept-unattested"'], 'only these three argument lists carry the flag');
  assert.deepEqual([...allCode.matchAll(/command\.AcceptUnattested/gu)].length, 2, 'two places read the parsed flag, both in Program.cs');
  assert.deepEqual([...code['Program.cs'].matchAll(/command\.AcceptUnattested/gu)].length, 2);
  assert.match(code['Program.cs'], /new EnrollCommand\([^;]*\)\.Run\(command\.Option, command\.AcceptUnattested\);/u, 'and it hands it to enroll');
  assert.match(code['Program.cs'], /new EnrollWebAuthnCommand\([^;]*\)\.Run\(command\.AcceptUnattested\);/u, 'to enroll --webauthn');
  assert.equal(/keys.AddAsync|AddAsync|"add"/u.test(code['Program.cs'] + code['KeysCommand.cs'] + code['PresenceSigning.cs']), false, 'there is no keys add: no command, no method, no verb');
  assert.equal(/AcceptUnattested|acceptUnattested/u.test(code['ApproverCommands.cs'] + code['PolicyCommand.cs'] + code['SelfCheckCommand.cs']), false, 'approve, policy and the self-check cannot see the flag');
  assert.deepEqual([...code['EnrollCommand.cs'].matchAll(/store\.Create\(replace: (true|false), acceptUnattested\)/gu)].map((m) => m[1]), ['true', 'false'], 'create and replace pass the flag; nothing else creates a key');
});

// ---- GUI mode (`AlberaApprover.exe --tray`: Gui*.cs, ApprovalPrompt.cs, ApprovalQueue.cs) -----------------------------------------------------------------------------------------------
const guiWindow = code['GuiApprovalWindow.cs'];
const guiTray = code['GuiTrayHost.cs'];
const guiFiles = ['GuiApprovalWindow.cs', 'GuiTrayHost.cs', 'GuiNative.cs', 'ApprovalPrompt.cs', 'ApprovalQueue.cs'];
const guiCode = guiFiles.map((name) => code[name]).join('\n');
const methodBody = (source, signature) => { const at = source.indexOf(signature); return at < 0 ? '' : source.slice(at, source.indexOf('\n    }\n', at) + 7); };

test('GUI mode: the only call that approves anything is in the click-handler path of a match-code button; there is no auto, remember, all or on-timeout approval', () => {
  for (const name of guiFiles) assert.ok(code[name], `${name} exists`);
  // The whole program has one GUI approve call: defined in ApproverCommands.cs, called once, from the correct-pick branch of HandleChoiceAsync.
  assert.deepEqual(Object.entries(code).filter(([, text]) => /ApproveShownAsync|SignAndDecideAsync/u.test(text)).map(([name]) => name).sort(), ['ApproverCommands.cs', 'GuiApprovalWindow.cs']);
  assert.equal([...allCode.matchAll(/ApproveShownAsync\(/gu)].length, 2, 'defined once and called once');
  assert.match(methodBody(guiWindow, 'internal async Task HandleChoiceAsync'), /case PickOutcome\.Correct:[\s\S]*ApproveShownAsync\(prompt\.View!, window\)/u, 'the call is in the correct-pick branch of HandleChoiceAsync (with the window as the prompt\'s parent)');
  assert.equal([...guiWindow.matchAll(/HandleChoiceAsync\(/gu)].length, 2, 'HandleChoiceAsync: its definition and one caller');
  assert.match(methodBody(guiWindow, 'private async void OnChoiceClick'), /await HandleChoiceAsync\(index\)/u, 'the caller is the click handler');
  assert.equal([...guiWindow.matchAll(/\.Click \+= OnChoiceClick/gu)].length, 1, 'OnChoiceClick is wired to the match-code buttons only');
  assert.match(guiWindow, /MouseOnlyButton button = new\(\) \{ Text = prompt\.Choices\[i\]/u, 'and those are MouseOnlyButtons made from the prompt\'s candidates');
  assert.equal([...allCode.matchAll(/\\"decision\\":\\"approve\\"/gu)].length, 1, 'one place builds an approve decision');
  assert.equal(/\.Sign\(/u.test(guiCode), false, 'the GUI files never ask the signer themselves');
  assert.equal(/ApproveAll|approveAll|AutoApprove|autoApprove|ApproveOn|Remember|remember|TrustAlways|SkipPrompt|DecisionTimeout|OnTimeout|DefaultDecision/u.test(allCode), false, 'no "approve all", "remember" or "approve on timeout"');
  // The timer only refreshes the buttons and the clock; the tray host only lists and opens windows.
  assert.match(guiWindow, /tick\.Tick \+= \(_, _\) => ApplyState\(\);/u);
  assert.equal(/Approve(?!r)|Hello|\.Sign\(|decide/u.test(guiTray + code['GuiNative.cs'].replace(/Windows Hello itself[^\n]*/u, '').replace(/before Windows Hello asks[^\n]*/u, '')), false, 'the tray host and the native helpers do not name approval, Hello or signing');
});

test('GUI mode: shown without taking focus, no default button, Enter and Space do nothing, buttons wait 1 s and stop at expiry, one window per request, polled every 2 s', () => {
  assert.match(guiWindow, /protected override bool ShowWithoutActivation => true;/u);
  assert.match(guiWindow, /AcceptButton = null;\s*CancelButton = null;/u);
  assert.equal(/AcceptButton = (?!null)|CancelButton = (?!null)|NotifyDefault|DialogResult/u.test(guiWindow), false, 'no default or dialog button');
  assert.match(guiWindow, /SetStyle\(ControlStyles\.Selectable, false\);\s*TabStop = false;/u, 'a button never takes the keyboard focus');
  assert.match(guiWindow, /protected override bool IsInputKey\(Keys keyData\) => false;/u);
  assert.match(guiWindow, /\(keyData & Keys\.KeyCode\) is Keys\.Enter or Keys\.Space \|\|/u, 'Enter and Space are swallowed for the whole window');
  assert.match(guiWindow, /pressedByMouse = mevent\.Button == MouseButtons\.Left;[\s\S]*if \(real\) base\.OnClick\(e\);/u, 'only a real left mouse press makes a click');
  assert.match(guiWindow, /Shown \+= \(_, _\) => GuiNative\.FlashTaskbar\(Handle\);/u, 'the taskbar button flashes');
  assert.equal(/\.Activate\(|\.Focus\(|ActiveControl|SetForegroundWindow|BringToFront\(\)/u.test(guiWindow + guiTray), false, 'nothing here asks for the focus');
  // Topmost and no-activate are creation styles (WS_EX_TOPMOST | WS_EX_NOACTIVATE); the Form.TopMost property (which can activate together with ShowWithoutActivation) is not used.
  assert.match(guiWindow, /ExTopmost = 0x00000008, ExNoActivate = 0x08000000;/u);
  assert.match(guiWindow, /parameters\.ExStyle \|= ExTopmost \| ExNoActivate;/u);
  assert.equal(/\bTopMost\b/u.test(guiWindow + guiTray), false, 'Form.TopMost is never set');
  assert.equal(/BM_CLICK/u.test(guiWindow + read('docs', 'architecture', 'approver-app.md').replace(/a posted `BM_CLICK`/u, '')), false, 'no claim that a BM_CLICK is dropped: a synthetic click from the same account is a known limit, Hello is the last line');
  assert.equal([...guiCode.matchAll(/GuiNative\.BringToFront\(/gu)].length, 1, 'the window is brought to the front once: after the correct pick, before Windows Hello asks');
  assert.match(methodBody(guiWindow, 'internal async Task HandleChoiceAsync'), /case PickOutcome\.Correct:[\s\S]*GuiNative\.BringToFront\(Handle\);[\s\S]*ApproveShownAsync/u);
  const prompt = code['ApprovalPrompt.cs'];
  assert.match(prompt, /ClickDelayMs = 1000/u);
  assert.match(prompt, /ClickDelayElapsed\(now\) && !IsExpired\(now\)/u, 'the choice buttons need the delay and an unexpired request');
  assert.match(prompt, /public bool IsExpired\(DateTimeOffset now\) => View is \{ \} view && now\.ToUnixTimeSeconds\(\) >= view\.ExpiresAt;/u);
  assert.match(prompt, /WrongPicksToDeny = 2/u);
  assert.match(guiTray, /PollMs = 2000/u, 'the list is asked for every 2 seconds');
  // Closing a window is not a way to reset the guesses: the tray keeps the wrong picks per request and hands them on, and a window closed after a wrong pick sends deny.
  assert.match(guiTray, /wrongPicks\.For\(id\)/u, 'a new window starts with the request\'s earlier wrong picks');
  assert.match(guiTray, /wrongPicks\.Record\(id, window\.WrongMask\)/u, 'and the closing window hands its wrong picks to the ledger');
  assert.match(methodBody(guiWindow, 'protected override void OnFormClosing'), /state\.WrongCount >= 1 && !state\.Finished[\s\S]*DenyAndCloseAsync\(\)/u, 'closing after a wrong pick sends deny');
  assert.match(methodBody(guiWindow, 'private async Task DenyAndCloseAsync'), /await SendDenyAsync\(\)/u);
  assert.match(code['ApprovalPrompt.cs'], /state\.WrongCount < WrongPicksToDeny/u, 'after two wrong picks on record no candidate can be picked');
  assert.match(methodBody(guiTray, 'private void RequestExit'), /open\.Close\(\)/u, 'quitting the tray closes the open window first');
  assert.match(code['ApprovalQueue.cs'], /new QueueView\(unhandled\[0\], unhandled\.Count - 1, closed\)/u, 'one request opens, the rest wait');
});

test('GUI mode: reuses the CLI\'s list, digest recompute, presence message and decide (no copy); the match code is MatchCode.Choices of the RECOMPUTED digest; hidden characters remove the approve buttons', () => {
  assert.match(guiTray, /new\(new PipeChannel\(wiring\.Expectation, wiring\.TimeoutMs\), wiring\.Signer, TextWriter\.Null, TextWriter\.Null, TextReader\.Null, clock, interactive: false, webAuthn: wiring\.WebAuthn\)/u, 'the same pipe channel (server verified first) and the same signer seam');
  assert.match(guiTray, /NewCommands\(\)\.ListPendingAsync\(\)/u);
  assert.match(guiTray, /bool blocked = await NewCommands\(\)\.SigningBlockedAsync\(\);[\s\S]*ApprovalPrompt\.From\(item, clock\(\), blocked\)/u, 'the window learns before it is built whether this session can sign at all (a remote session with no WebAuthn key)');
  assert.equal(/JsonDocument|PendingParser|ActionDigest|PresenceMessage|CallAsync|"verb"/u.test(guiCode), false, 'no second parser, digest, presence message or wire request in the GUI files');
  assert.match(code['ApprovalPrompt.cs'], /MatchCode\.Choices\(view\.ApprovalId, view\.RecomputedDigest\)/u);
  assert.equal(/AuthorityDigest/u.test(guiCode), false, 'the Authority-sent digest is never used by the GUI');
  assert.match(code['ApprovalPrompt.cs'], /if \(!view\.DigestMatches\) return BlockReason\.DigestMismatch;\s*if \(AllStrings\(view\)\.Any\(HasHiddenCharacters\)\) return BlockReason\.HiddenCharacters;/u);
  assert.match(code['ApprovalPrompt.cs'], /UnicodeCategory\.Control or UnicodeCategory\.Format or UnicodeCategory\.LineSeparator or UnicodeCategory\.ParagraphSeparator/u);
  assert.match(code['ApprovalPrompt.cs'], /public IReadOnlyList<string> Choices => CanApprove \? choices!\.Choices : \[\];/u, 'no candidates (no buttons) unless approval is allowed');
  assert.match(guiWindow, /if \(prompt\.CanApprove\)\s*\{[\s\S]*MouseOnlyButton button = new\(\)/u, 'the match-code buttons are built only when approval is allowed');
  assert.match(code['ApproverCommands.cs'], /if \(!view\.DigestMatches\) throw new Stop\(ExitCodes\.Refused, "digest_mismatch"\);\s*return await SignAndDecideAsync\(view, await ChooseRouteAsync\(\), window\);/u, 'the GUI path refuses a digest mismatch like the CLI, then chooses the key');
  assert.match(code['Program.cs'], /if \(command\.Verb == "tray"\) return TrayApp\.Run\(wiring\);/u);
  assert.match(code['CommandLine.cs'], /args is \["--tray"\]\) return new CommandLine\("tray", null, null\)/u);
});

test('GUI mode: three Win32 calls (taskbar flash, bring to front, drop the console), Windows Forms as a framework property only, and no registration of itself (the installer\'s job)', () => {
  assert.deepEqual(importsOf(code['GuiNative.cs']).sort(), ['kernel32.dll!FreeConsole', 'user32.dll!FlashWindowEx', 'user32.dll!SetForegroundWindow']);
  assert.deepEqual([...project.matchAll(/<UseWindowsForms>(\w+)<\/UseWindowsForms>/gu)].map((m) => m[1]), ['true'], 'Windows Forms is switched on once, as a property (a framework that ships with .NET, no package)');
  assert.equal(/Microsoft\.Win32\.Registry|RegistryKey|CurrentVersion\\Run|schtasks|Startup/u.test(allCode), false, 'the app never writes its own Run key; the installer does');
  assert.match(guiTray, /@"Local\\AlberaApproverTray"/u, 'one tray per logon session');
  assert.match(guiTray, /thread\.SetApartmentState\(ApartmentState\.STA\);/u);
  assert.match(guiTray, /quit = ApprovalQueue\.ShouldQuit\(outcome\);/u, 'a tray started for another account ends on access_denied');
  assert.match(guiTray, /Visible = false \}/u, 'no icon before the first answer');
  assert.match(read('docs', 'architecture', 'approver-app.md'), /## GUI mode/u, 'the GUI mode is documented');
});

// ---- WebAuthn (docs/architecture/approver-webauthn.md; WebAuthn*.cs, ApproverKeyRecord.cs, PresenceSigning.cs, KeyRecordFile.cs, EnrollWebAuthnCommand.cs, KeysCommand.cs) ----------------------------------------------------
const keysCommand = code['KeysCommand.cs'];
const presenceSigning = code['PresenceSigning.cs'];
const enrollWebAuthn = code['EnrollWebAuthnCommand.cs'];
const inOrder = (text, tokens) => {
  const at = tokens.map((token) => text.indexOf(token));
  assert.ok(at.every((position) => position >= 0) && at.every((position, i) => i === 0 || position > at[i - 1]), `${tokens.join(' -> ')} (${at})`);
};

test('WebAuthn platform code: webauthn.dll is called from one shipped-only file with a fixed list of imports, version 1 structures, user verification required, attestation none; no private key and no output', () => {
  assert.ok(webAuthnCode, 'WebAuthn.cs exists');
  assert.match(project, /<Compile Remove="WebAuthn\.cs" Condition="'\$\(AlberaApproverTestFaults\)' == 'true'" \/>/u, 'the test-faults build does not contain the platform file');
  assert.deepEqual(importsOf(webAuthnCode).sort(), ['kernel32.dll!GetConsoleWindow', 'user32.dll!GetForegroundWindow', 'webauthn.dll!WebAuthNAuthenticatorGetAssertion', 'webauthn.dll!WebAuthNAuthenticatorMakeCredential',
    'webauthn.dll!WebAuthNFreeAssertion', 'webauthn.dll!WebAuthNFreeCredentialAttestation', 'webauthn.dll!WebAuthNGetErrorName']);
  assert.deepEqual(Object.entries(code).filter(([name, text]) => name !== 'WebAuthn.cs' && /webauthn\.dll|WebAuthNAuthenticator|WebAuthNFree/u.test(text)).map(([name]) => name), [], 'no other file calls the platform API');
  assert.deepEqual([...allCode.matchAll(/class (\w+)(?:\([^)]*\))? : IWebAuthnAuthenticator/gu)].map((m) => m[1]).sort(), ['PlatformWebAuthn', 'SoftwareAuthenticator'], 'the platform one, and the software one of the test seam');
  // Shipped wiring uses the platform authenticator and the Remote Desktop flag (SM_REMOTESESSION); the test-faults wiring does not reach it (its kit comes from --test-webauthn only).
  const wiring = sources['Program.cs'].match(/#if ALBERA_APPROVER_TEST_FAULTS\n([\s\S]*?)#else\n([\s\S]*?)#endif/u);
  assert.match(wiring[2], /new WebAuthnKit\(new PlatformWebAuthn\(\), \(\) => System\.Windows\.Forms\.SystemInformation\.TerminalServerSession, new KeyRecordStore\(KeyRecordStore\.DefaultDirectory\)\)/u);
  assert.equal(/PlatformWebAuthn|WebAuthnKit/u.test(wiring[1]), false, 'a test build never reaches the real platform authenticator');
  // The probe-verified call shape: every structure and options block is version 1, the user verification requirement is "required" (1), the attestation preference is "none" (1), the rp id is the contract's.
  assert.equal([...webAuthnCode.matchAll(/dwVersion = Version1/gu)].length >= 8, true);
  assert.equal(/dwVersion = (?!Version1)/u.test(webAuthnCode), false, 'no structure of another version');
  assert.match(webAuthnCode, /Version1 = 1, RequireUserVerification = 1, AttestationNone = 1, AnyAttachment = 0;/u);
  assert.match(webAuthnCode, /dwUserVerificationRequirement = RequireUserVerification, dwAttestationConveyancePreference = AttestationNone/u);
  assert.match(webAuthnCode, /dwUserVerificationRequirement = RequireUserVerification,\s*CredentialList/u);
  assert.match(webAuthnCode, /pwszId = pins\.Str\(WebAuthnContract\.RpId\)/u);
  assert.match(webAuthnCode, /WebAuthNAuthenticatorGetAssertion\(Parent\(window\), WebAuthnContract\.RpId, ref clientData/u);
  assert.equal(/PrivateKey|Pkcs8|Export|Console\.|File\.|Process|Environment|HttpClient|Socket|Registry/u.test(webAuthnCode), false, 'no key export, no output, no file, no process, no network');
  // Every platform result is freed in a finally; only definite cancellations are "no proof", everything else sends nothing.
  assert.equal([...webAuthnCode.matchAll(/finally \{ Native\.WebAuthNFree/gu)].length, 2);
  assert.match(webAuthnCode, /Outcome\(int hr\) => hr is NteUserCancelled or ErrorCancelled or ErrorTimeout \? WebAuthnStatus\.Cancelled : WebAuthnStatus\.NotReady;/u);
});

test('WebAuthn proof bytes: the client data, the authenticator data rule, the assertion JSON and the key messages are the contract\'s, defined once, and domain-separated from every other signed message', () => {
  const proof = code['WebAuthnProof.cs'];
  assert.match(proof, /RpId = "approver\.albera\.local", Origin = "albera:\/\/approver";/u);
  assert.match(proof, /\$"\{\{\\"type\\":\\"webauthn\.get\\",\\"challenge\\":\\"\{B64\.Url\(SHA256\.HashData\(message\)\)\}\\",\\"origin\\":\\"\{Origin\}\\",\\"crossOrigin\\":false\}\}"/u, 'the exact client data of an assertion');
  assert.equal([...allCode.matchAll(/webauthn\.get/gu)].length, 1, 'built in one place');
  assert.match(proof, /data\.Length == AuthenticatorDataBytes && data\.AsSpan\(0, 32\)\.SequenceEqual\(RpIdHash\(\)\) && \(data\[32\] & UserPresent\) != 0 && \(data\[32\] & UserVerified\) != 0 && \(data\[32\] & \(AttestedData \| Extensions\)\) == 0/u, 'the Authority\'s rule: 37 bytes, rp id hash, UP and UV set, AT and ED clear');
  assert.match(proof, /AuthenticatorDataBytes = 37/u);
  assert.match(proof, /UserPresent = 0x01, UserVerified = 0x04, AttestedData = 0x40, Extensions = 0x80/u);
  assert.match(proof, /\$"\{\{\\"kind\\":\\"webauthn\\",\\"credentialId\\":\\"\{B64\.Url\(CredentialId\)\}\\",\\"authenticatorData\\":\\"\{Convert\.ToBase64String\(AuthenticatorData\)\}\\",\\"signature\\":\\"\{Convert\.ToBase64String\(Signature\)\}\\"\}\}"/u, 'the proof object, in the contract\'s key order');
  assert.match(proof, /RemoveDomain = "albera\.keyremove\.v1"/u);
  assert.match(proof, /\$"\{RemoveDomain\}\\0\{keyId\}\\0\{challenge\}"/u, 'the remove message is the domain word, the key id and the challenge: no record hash, so a key from another device can be removed');
  const domains = ['albera.presence.v1', 'albera.selfcheck.v1', 'albera.policy.v1', 'albera.keyremove.v1'];
  for (const a of domains) for (const b of domains) if (a !== b) assert.equal(`${b}\0`.startsWith(`${a}\0`), false, `${a} must not be a prefix of ${b}`);
  assert.equal(allCode.split('albera.keyremove.v1').length - 1, 1);
  assert.equal(/keyadd|KeyMessages\.Add|AddDomain/u.test(allCode), false, 'there is no add message: keys are added only by the elevated set-approver');
  // The canonical record: the contract's key order, credentialId only for a WebAuthn key, and the key id is "webauthn-" / "hello-" + 8 bytes of SHA-256 over the SPKI.
  const record = code['ApproverKeyRecord.cs'];
  assert.match(record, /\$"\{\{\\"keyId\\":\\"\{KeyId\}\\",\\"kind\\":\\"\{Kind\}\\",\\"alg\\":\{Alg\},\\"publicKey\\":\\"\{Convert\.ToBase64String\(PublicKey\)\}\\"\{tail\}\}\}"/u);
  assert.match(record, /\$",\\"credentialId\\":\\"\{B64\.Url\(CredentialId\)\}\\""/u);
  assert.match(code['HelloKeyStore.cs'], /public static string Of\(string prefix, byte\[\] spki\) => prefix \+ "-" \+ Convert\.ToHexStringLower\(SHA256\.HashData\(spki\)\.AsSpan\(0, 8\)\);/u);
  // Public key material only: key objects are made from a public SPKI or public parameters; there is no key generation, no private parameter and no signing in the shipped code.
  for (const [, call] of [...shippedCode.matchAll(/ECDsa\.Create\(([^;]*)\);/gu)]) assert.ok(call === '' || (call.startsWith('new ECParameters') && /Q = /u.test(call) && !/\bD = /u.test(call)), `ECDsa.Create(${call})`);
  assert.equal(/\bD = |GenerateKey|ExportParameters\(true\)|\.SignHash|\.SignData|\.SignHashAsync/u.test(shippedCode), false);
});

test('WebAuthn signing choice: the Authority\'s `keys` decides; WebAuthn when a WebAuthn key is registered, Hello only on a local session, remote_session otherwise; one place picks, each command stops before the typed yes', () => {
  assert.match(presenceSigning, /RemoteSessionCode = "remote_session"/u);
  // The session can change while a tray keeps running (console <-> Remote Desktop): the flag is a reader called at every signing attempt, never a value read once at start.
  assert.match(code['WebAuthnSigner.cs'], /record WebAuthnKit\(IWebAuthnAuthenticator Authenticator, Func<bool> IsRemoteSession, KeyRecordStore Records\)/u);
  assert.match(presenceSigning, /SigningRoute\.Choose\(keys, kit\.IsRemoteSession\(\)\)/u);
  assert.equal(/\bbool RemoteSession\b|webAuthn\.RemoteSession\b|kit\.RemoteSession\b/u.test(allCode), false, 'no stored remote-session value');
  assert.match(code['Program.cs'], /new WebAuthnKit\(new PlatformWebAuthn\(\), \(\) => System\.Windows\.Forms\.SystemInformation\.TerminalServerSession,/u, 'the entry point passes a reader');
  assert.equal(allCode.split('"remote_session"').length - 1, 1, 'the code is defined once and used through the constant');
  const choose = sliceBetween(presenceSigning, 'public static SigningRoute Choose', 'internal sealed class PresenceSigning');
  inOrder(choose, ['k.IsWebAuthn', 'new SigningRoute(RouteKind.WebAuthn, credentials)', 'remoteSession ? new SigningRoute(RouteKind.RemoteNoKey, []) : UsingHello']);
  const signingClass = sliceBetween(presenceSigning, 'internal sealed class PresenceSigning', '// The four key verbs.');
  assert.match(signingClass, /if \(kit is null\) return SigningRoute\.UsingHello;/u, 'without a WebAuthn kit the Authority is never asked for its keys: Hello only, as before WebAuthn');
  assert.match(signingClass, /catch \(AuthorityRefusal refusal\) when \(refusal\.Code == "request_invalid"\) \{ keys = \[\]; \}/u, 'an Authority from before WebAuthn does not know the verb: it has Hello keys only');
  assert.match(signingClass, /RouteKind\.WebAuthn when kit is not null => new WebAuthnSigner\(kit\.Authenticator\)\.Sign\(message, route\.CredentialIds, window\),\s*RouteKind\.Hello => hello\.Sign\(message\),/u);
  assert.deepEqual(Object.entries(code).filter(([name, text]) => name !== 'TestSeam.cs' && /\.Sign\(/u.test(text)).map(([name, text]) => `${name}:${[...text.matchAll(/\.Sign\(/gu)].length}`).sort(),
    ['ApproverCommands.cs:1', 'KeysCommand.cs:1', 'PolicyCommand.cs:1', 'PresenceSigning.cs:2', 'SelfCheckCommand.cs:1'], 'every signing call site, by file');
  // The verbs the approver speaks: the old two, and the three key verbs (no key_add), each from one place.
  assert.deepEqual([...new Set([...presenceSigning.matchAll(/\\"verb\\":\\"(\w+)\\"/gu)].map((m) => m[1]))].sort(), ['key_challenge', 'key_remove', 'keys']);
  assert.match(presenceSigning, /Codes = \["authority_unavailable", "request_invalid", "request_expired", "human_denied", "presence_unavailable", "presence_mismatch", "queue_full",\s*"challenge_unknown", "challenge_expired", "key_unknown", "last_key", "too_many_keys"\]/u);
  assert.match(presenceSigning, /MaxKeys = 16/u);
  // A reply is accepted only in the contract's exact shape; a challenge is 22 base64url characters.
  assert.match(presenceSigning, /Challenge = ActionDigest\.FromEcma\("\^\[A-Za-z0-9_-\]\{22\}\$"\)/u);
  assert.match(presenceSigning, /WebAuthnKeyId = ActionDigest\.FromEcma\("\^webauthn-\[0-9a-f\]\{16\}\$"\)/u);
  // The decide frame keeps its shape: the presence value is the quoted base64 signature of Hello or the proof object, from one function.
  assert.match(presenceSigning, /PresenceJson\(SignResult signed\) => signed\.Proof is \{ \} proof \? proof\.ToJson\(\) : \$"\\"\{Convert\.ToBase64String\(signed\.Signature!\)\}\\""/u);
  assert.equal([...allCode.matchAll(/\\"presence\\":/gu)].length, 2, 'decide and policy_set carry the presence value, built from PresenceJson');
  // Each command asks for the route before the typed yes, so the remote-session message comes first.
  inOrder(sliceBetween(code['ApproverCommands.cs'], 'public Task<int> ApproveAsync', 'private async Task<SigningRoute> ChooseRouteAsync'), ['ChooseRouteAsync()', 'Confirmed()']);
  inOrder(sliceBetween(keysCommand, 'public Task<int> RemoveAsync', 'private static string ProofJson'), ['SigningRoute.Choose(keys, webAuthn.IsRemoteSession())', 'Confirmed("remove this key")', 'directory.RemoveChallengeAsync(']);
});

test('keys remove and enroll --webauthn: the unattested opt-in, the console and every refusal come before anything is made or sent; the remove proof is over a message built from the key id and the challenge only (no record, so a key from another device can be removed); success is reported only when the key list shows it; there is no keys add', () => {
  assert.ok(enrollWebAuthn && keysCommand, 'both commands exist');
  inOrder(enrollWebAuthn, ['if (kit is null)', 'if (!acceptUnattested)', 'if (!interactive)', 'string sid = currentUserSid();', 'WebAuthnCreator.Create(', 'kit.Records.TrySave(', 'record file:']);
  assert.match(enrollWebAuthn, /UnattestedLine = "attestation: none \(accepted with --accept-unattested: this key is NOT proven to be hardware-backed\)"/u, 'the same style of warning line as the Hello enroll');
  assert.equal(/IApproverChannel|PipeChannel|CallAsync|KeyDirectory|ServerExpectation/u.test(enrollWebAuthn), false, 'enroll --webauthn never talks to the Authority: no channel, no key directory');
  const remove = sliceBetween(keysCommand, 'public Task<int> RemoveAsync', 'private static string ProofJson');
  inOrder(remove, ['if (!interactive)', 'directory.ListAsync()', '"key_unknown"', '"last_key"', 'SigningRoute.Choose(keys, webAuthn.IsRemoteSession())', 'PresenceSigning.RemoteSessionCode', 'Confirmed("remove this key")',
    'directory.RemoveChallengeAsync(target.KeyId)', 'signing.Sign(route, KeyMessages.Remove(target.KeyId, challenge))', 'directory.RemoveAsync(target.KeyId, challenge, by)', 'result: key removed', 'removed.PolicyReset']);
  assert.match(remove, /removed\.Keys\.Any\(k => k\.KeyId == target\.KeyId\)\) throw new ChannelException\(ChannelCodes\.InvalidResponse, sent: true\)/u, 'a remove the key list does not show is an unknown outcome');
  assert.match(remove, /if \(removed\.PolicyReset\) output\.Write\("policy: set back to careful/u, 'the person is told when the policy went back to careful');
  assert.match(presenceSigning, /bool policyReset = reply\.TryGetProperty\("policyReset", out JsonElement flag\);[\s\S]*if \(policyReset && flag\.ValueKind != JsonValueKind\.True\) throw Invalid\(\);/u, 'policyReset is accepted only as true, and only from key_remove');
  assert.equal(/ApproverKeyRecord|KeyRecordStore|IHelloKeyStore|\.Records\b|RecordOf/u.test(keysCommand), false, 'keys remove needs no record of the key and no Hello key store: a key from another device (a lost one) can be removed from here');
  // The refusals the Authority also makes are made here first, so no prompt is wasted.
  for (const code_ of ['key_unknown', 'last_key', 'not_interactive', 'not_confirmed']) assert.ok(keysCommand.includes(`"${code_}"`), code_);
  // The grammar: keys list | keys remove <keyId>, the id in the Authority's id grammar. There is no keys add.
  assert.match(code['CommandLine.cs'], /args is \["keys", "remove", \{ \} removed\] && IsKeyId\(removed\)/u);
  assert.match(code['Program.cs'], /if \(command\.Verb == "keys"\)\s*\{\s*KeysCommand keys = new\(new PipeChannel\(wiring\.Expectation, wiring\.TimeoutMs\), wiring\.Signer, wiring\.WebAuthn, Console\.Out, Console\.Error, Console\.In, wiring\.Interactive\);/u);
  assert.ok(code['Program.cs'].indexOf('if (command.Option == "webauthn")') < code['Program.cs'].indexOf('if (command.Verb == "enroll")'), 'enroll --webauthn is dispatched before the Hello enroll and needs no pipe');
  assert.ok(code['Program.cs'].indexOf('if (command.Option == "check")') < code['Program.cs'].indexOf('if (command.Option == "webauthn")'));
});

test('key record files: the only file code of the approver; it creates one file per key id under %LOCALAPPDATA%\\Albera\\approver-keys, never overwrites, deletes, moves or appends, and builds no other path', () => {
  assert.ok(recordFileCode, 'KeyRecordFile.cs exists');
  assert.match(recordFileCode, /Path\.Combine\(Environment\.GetFolderPath\(Environment\.SpecialFolder\.LocalApplicationData\), "Albera", "approver-keys"\)/u, 'one fixed folder');
  assert.match(recordFileCode, /new\(@"\^\(\?:webauthn\|hello\)-\[0-9a-f\]\{16\}\\z", RegexOptions\.CultureInvariant\)/u, 'a file name is a derived key id and nothing else (\\z: a trailing newline cannot pass)');
  assert.equal([...recordFileCode.matchAll(/Path\.Combine\(Folder/gu)].length, 1, 'one place builds a file path');
  assert.equal([...recordFileCode.matchAll(/FileMode\.CreateNew/gu)].length, 1, 'a file is created, never opened for writing');
  assert.equal(/FileMode\.(?!CreateNew)|File\.(?:Delete|Move|Copy|Replace|Write|Create|Append|Open|SetAttributes)|FileAccess\.(?!Write)|Directory\.(?!CreateDirectory)|Truncate|Overwrite|Symlink|Junction/u.test(recordFileCode), false);
  assert.deepEqual(Object.entries(code).filter(([, text]) => /\.TrySave\(/u.test(text)).map(([name]) => name).sort(), ['EnrollWebAuthnCommand.cs'], 'only enroll --webauthn writes a record');
  assert.equal(/\.Find\(|ReadAllBytes|Records\b/u.test(code['KeysCommand.cs'] + code['PresenceSigning.cs'] + code['ApproverCommands.cs'] + code['PolicyCommand.cs']), false, 'nothing reads a record file: it is enroll output only (set-approver reads it)');
  assert.equal([...recordFileCode.matchAll(/File\.ReadAllBytes\(path\)\.AsSpan\(\)\.SequenceEqual\(bytes\)/gu)].length, 1, 'the one read: an existing file is compared with the bytes about to be written, so a second run is not a failure');
});
