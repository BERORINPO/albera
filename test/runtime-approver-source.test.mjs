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
  assert.equal(/ApplicationManifest|requestedExecutionLevel|WindowsService|UseWindowsServices|UseWindowsForms|UseWPF/iu.test(project), false, 'no elevation, no service wrapper, no UI framework');
  assert.deepEqual(Object.keys(lockFile.dependencies), ['net10.0-windows10.0.19041', 'net10.0-windows10.0.19041/win-x64']);
  assert.deepEqual(Object.values(lockFile.dependencies).map((framework) => Object.keys(framework)), [[], []], 'the lock file pins no NuGet package (the projection pack is a targeting pack, pinned in the csproj)');
  for (const [name, text] of Object.entries(sources)) {
    assert.equal(/windows-broker|WindowsBroker|windows-approval-authority|Albera\.ApprovalAuthority|approval-authority\.exe/iu.test(text), false, `${name} must not name another project`);
  }
});

test('the approver never starts a process, registers a service, writes a file, uses the network, reads the environment, or creates / imports / exports / deletes a key', () => {
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /ServiceBase/u, /ServiceController/u, /\bsc\.exe\b/u, /powershell/iu, /Hyper-?V/iu, /SetAccessControl/u,
    /CreateService|ChangeServiceConfig|ControlService|DeleteService|StartService/u, /System\.ServiceProcess|Microsoft\.Extensions\.Hosting/u,
    /File\.(?:Write|Create|Delete|Move|Copy|Append|Open)|FileMode\.|FileAccess\.Write|new FileStream|Directory\./u, /HttpClient|System\.Net\.Sockets|TcpClient|WebRequest/u,
    /Environment\.GetEnvironmentVariable|Environment\.ExpandEnvironmentVariables/u, /CngKey|NCrypt|ExportPkcs8PrivateKey|ExportRSAPrivateKey|ExportParameters\(true\)|RSA\.Create\(\d/u,
    /DeleteAsync|RenewAttestationAsync|GetAttestationAsync/u]) {
    assert.equal(forbidden.test(allCode), false, `no approver source may match ${forbidden}`);
  }
  assert.equal(/KeyCredentialManager|Windows\.Security\.Credentials|Windows\.Security\.Cryptography/u.test(codeWithoutHello), false, 'the WinRT Hello API is used only in WindowsHello.cs');
  // The one exception: PresenceSignature.Verify (Presence.cs) makes an RSA object only to import a PUBLIC key (SPKI) for the self-check's local verify; it never generates a key.
  const withoutVerifier = outsideSeam(codeWithoutHello).replace(/using RSA rsa = RSA\.Create\(\);\s*rsa\.ImportSubjectPublicKeyInfo\(spki, out _\);/u, '');
  assert.equal(/RSA\.Create\(\)/u.test(withoutVerifier), false, 'an RSA key object is created only in the test seam (and, public-key import only, in PresenceSignature.Verify)');
  assert.equal([...code['Presence.cs'].matchAll(/RSA\.Create\(\)/gu)].length, 1, 'exactly one RSA object in Presence.cs');
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
  // The WinRT surface: exactly these members, nothing that deletes, exports or attests.
  const used = [...new Set([...helloCode.matchAll(/\b(KeyCredentialManager\.\w+|RetrievePublicKey|RequestSignAsync|CryptographicBuffer\.\w+)\b/gu)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['CryptographicBuffer.CopyToByteArray', 'CryptographicBuffer.CreateFromByteArray', 'KeyCredentialManager.IsSupportedAsync', 'KeyCredentialManager.OpenAsync',
    'KeyCredentialManager.RequestCreateAsync', 'RequestSignAsync', 'RetrievePublicKey']);
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
  assert.match(code['CommandLine.cs'], /Usage = "usage: AlberaApprover list \| approve <approvalId> \| deny <approvalId> \| enroll \[--show \| --replace \| --check \[--expect <approverKeyId>\]\]"/u);
  assert.match(code['ApproverCommands.cs'], /if \(!interactive\) throw new Stop\(ExitCodes\.Refused, "not_interactive"/u);
  assert.equal([...code['Program.cs'].matchAll(/!Console\.IsInputRedirected/gu)].length, 2, 'interactive means stdin is not redirected, in both build branches and nowhere else');
  const enroll = code['EnrollCommand.cs'];
  assert.match(enroll, /if \(option == "show"\) return Show\(\);\s*if \(!interactive\) return Fail\(ExitCodes\.Refused, "not_interactive"\);/u, 'create / replace need a console; show does not');
  assert.match(enroll, /input\.ReadLine\(\) != ReplaceWord\) return Fail\(ExitCodes\.Refused, "not_confirmed"\)/u);
  assert.deepEqual([...enroll.matchAll(/\\"(approver\w+)\\"/gu)].map((m) => m[1]).sort(), ['approverKeyId', 'approverPublicKey', 'approverSid'], 'enroll prints exactly the three config values');
  assert.equal(/PrivateKey|Pkcs8|Export(?!SubjectPublicKeyInfo)/u.test(enroll + code['HelloKeyStore.cs'] + helloCode), false, 'no private material in enroll or the Hello code');
});

test('the fake signer, the test options and the TestSeam exist only inside #if ALBERA_APPROVER_TEST_FAULTS and never in the shipped build', () => {
  assert.equal(/FakePresenceSigner|TestSeam|--test-|ImportPkcs8PrivateKey|SignData/u.test(shippedCode), false, 'fake names only appear inside the test-only #if blocks');
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

test('approve: refuse on a digest mismatch BEFORE the signer is asked; the signed digest is the one this app recomputed, never the Authority\'s; one signing site', () => {
  const approve = sliceBetween(code['ApproverCommands.cs'], 'public Task<int> ApproveAsync', 'public Task<int> DenyAsync');
  const order = ['RequireApprovalId(', 'if (!interactive)', 'FetchAllAsync()', 'Renderer.Render(', 'view.DigestMatches', 'Confirmed()', 'signer.Sign(', 'DecideAsync('].map((token) => approve.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `validate -> console check -> list -> show -> digest check -> confirm -> sign -> decide (${order})`);
  assert.equal([...code['ApproverCommands.cs'].matchAll(/signer\.Sign\(/gu)].length, 1, 'one signing site');
  assert.match(approve, /PresenceMessage\.Build\(view\.ApprovalId, view\.RecomputedDigest, view\.Challenge\)/u);
  assert.equal(/AuthorityDigest/u.test(code['ApproverCommands.cs']), false, 'the Authority-sent digest is only compared (PendingView), never used by the command');
  assert.match(code['PendingView.cs'], /DigestMatches => string\.Equals\(AuthorityDigest, RecomputedDigest, StringComparison\.Ordinal\)/u);
  assert.match(code['PendingView.cs'], /string recomputed = ActionDigest\.Compute\(purpose, dto\);/u, 'the contract\'s own digest code');
  assert.match(code['PendingView.cs'], /StrictJson\.Parse\(Encoding\.UTF8\.GetBytes\(entry\.GetProperty\("action"\)\.GetRawText\(\)\), 3\)/u, 'the action is re-read with the strict reader');
  assert.match(approve, /SignStatus\.Signed =>[\s\S]*SignStatus\.Unavailable =>[\s\S]*_ => throw new Stop\(ExitCodes\.SignerUnavailable/u, 'no usable Hello key sends nothing');
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
