import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for the Approval Authority (ADR-002 "Receipt v2", Proposed / NOT VERIFIED). They run on every OS and need no .NET SDK.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(root, 'src', 'runtime', 'windows-approval-authority');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const sources = Object.fromEntries(readdirSync(directory).filter((f) => f.endsWith('.cs')).map((f) => [f, readFileSync(path.join(directory, f), 'utf8')]));
const project = read('src', 'runtime', 'windows-approval-authority', 'Albera.ApprovalAuthority.csproj');
const lockFile = JSON.parse(read('src', 'runtime', 'windows-approval-authority', 'packages.lock.json'));
const publish = read('scripts', 'publish-windows-approval-authority.mjs');
const stripComments = (source) => source.replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const code = Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, stripComments(text)]));
const allCode = Object.values(code).join('\n');
const outsideSeam = (text) => text.replace(/#if ALBERA_AUTHORITY_TEST_FAULTS[\s\S]*?#endif/gu, '');
const shippedCode = Object.entries(code).filter(([name]) => name !== 'TestSeam.cs').map(([, text]) => outsideSeam(text)).join('\n');
const importsOf = (source) => [...source.matchAll(/\[DllImport\("([^"]+)"[^\]]*\)\]\s*(?:private|internal|public) static extern \w+ (\w+)\(/gu)].map((m) => `${m[1]}!${m[2]}`);

test('the Authority is a separate project: no package, no reference to the Broker, the contract by source include only', () => {
  assert.deepEqual([...project.matchAll(/<PackageReference /gu)], [], 'no package reference');
  assert.equal(/ProjectReference|windows-broker|WindowsBroker/iu.test(project), false, 'the Broker is not referenced');
  assert.deepEqual([...project.matchAll(/<Compile Include="([^"]+)"/gu)].map((m) => m[1]), ['../broker-contract/*.cs']);
  assert.match(project, /<AssemblyName>albera-approval-authority<\/AssemblyName>/u);
  assert.match(project, /<RuntimeIdentifiers>win-x64<\/RuntimeIdentifiers>/u);
  assert.equal(/ApplicationManifest|requestedExecutionLevel|WindowsService|UseWindowsServices/iu.test(project), false, 'no elevation, no service wrapper');
  assert.deepEqual(Object.values(lockFile.dependencies).map((framework) => Object.keys(framework)), [[], []], 'the lock file pins no package');
  for (const [name, text] of Object.entries(sources)) assert.equal(/windows-broker|WindowsBroker/iu.test(text), false, `${name} must not name the Broker project`);
});

test('the Authority never starts a process, registers a service, writes a file, uses the network or creates, imports, exports or deletes a key', () => {
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /ServiceBase/u, /ServiceController/u, /\bsc\.exe\b/u, /powershell/iu, /Hyper-?V/iu, /Get-VM/u, /SetAccessControl/u,
    /OpenSCManager|CreateService|ChangeServiceConfig|ControlService|DeleteService|OpenService|QueryServiceStatus/u, /System\.ServiceProcess|Microsoft\.Extensions\.Hosting/u,
    /File\.(?:Write|Create|Delete|Move|Copy|Append)|FileMode\.(?:Create|CreateNew|Append|Truncate)|FileAccess\.Write/u, /HttpClient|System\.Net\.Sockets|TcpClient|WebRequest/u,
    /Environment\.GetEnvironmentVariable/u, /CngKey\.(?:Create|Import)|CngKeyCreationParameters|CngKeyBlobFormat|ExportPolicy\s*=[^=]|SetProperty|\.Delete\(\)|NCryptDeleteKey|NCryptCreate|ExportPkcs8PrivateKey|ExportECPrivateKey|ExportParameters\(true\)/u,
    /KeyCredentialManager|Windows\.Security\.Credentials/u]) {
    assert.equal(forbidden.test(allCode), false, `no Authority source may match ${forbidden}`);
  }
});

test('the test fakes and the serve-loop / request entries exist only inside #if ALBERA_AUTHORITY_TEST_FAULTS and never in the shipped build', () => {
  assert.equal(/FakeReceiptSigner|FakePresenceVerifier|ProofFor|UnavailableProof|serve-loop|ServeLoopForTest|RequestForTest|AUTHORITY_PUBLIC_KEY|albera-test-approval-authority|albera-fake-presence/u.test(shippedCode), false,
    'fake names only appear inside the test-only #if blocks');
  assert.match(sources['TestSeam.cs'].trimStart(), /^#if ALBERA_AUTHORITY_TEST_FAULTS/u, 'TestSeam.cs is one #if block');
  assert.match(sources['TestSeam.cs'].trimEnd(), /#endif$/u);
  assert.match(sources['Presence.cs'], /#if ALBERA_AUTHORITY_TEST_FAULTS\n[\s\S]*class FakePresenceVerifier[\s\S]*#endif/u);
  assert.match(sources['Signers.cs'], /#if ALBERA_AUTHORITY_TEST_FAULTS\n[\s\S]*class FakeReceiptSigner[\s\S]*#endif/u);
  assert.match(project, /Condition="'\$\(AlberaAuthorityTestFaults\)' == 'true'"/u);
  assert.match(project, /<DefineConstants>\$\(DefineConstants\);ALBERA_AUTHORITY_TEST_FAULTS<\/DefineConstants>/u);
  assert.equal([...outsideSeam(sources['Program.cs']).matchAll(/ALBERA_AUTHORITY_TEST_FAULTS/gu)].length, 0, 'the entry file has no stray reference to the switch outside its #if blocks');
  // MSBuild reads environment variables as properties, so the publish pins the switch off as a global property and never turns it on.
  assert.match(publish, /'-p:AlberaAuthorityTestFaults=false'/u);
  assert.equal(/AlberaAuthorityTestFaults=(?!false')|ALBERA_AUTHORITY_TEST_FAULTS/u.test(publish), false, 'the publish script must never enable the test fakes');
});

test('the Authority only builds and only reports; the real signer opens an existing machine key and the real verifier pins one RSA-2048 key', () => {
  assert.match(code['Signers.cs'], /CngKey\.Open\(keyName, [^;]*CngKeyOpenOptions\.MachineKey \| CngKeyOpenOptions\.Silent\)/u, 'NCRYPT_MACHINE_KEY_FLAG');
  assert.match(code['Signers.cs'], /CngAlgorithm\.ECDsaP256/u);
  assert.match(code['Signers.cs'], /DSASignatureFormat\.IeeeP1363FixedFieldConcatenation/u);
  assert.match(code['Signers.cs'], /public string Issuer => ReceiptV2\.Issuer;/u, 'the real signer signs as the production issuer');
  assert.match(code['Presence.cs'], /KeyBits = 2048/u);
  assert.match(code['Presence.cs'], /RSASignaturePadding\.Pkcs1/u);
  assert.match(code['Presence.cs'], /HashAlgorithmName\.SHA256/u);
  assert.match(code['Presence.cs'], /used == spki\.Length && rsa\.KeySize == KeyBits/u, 'exactly one RSA-2048 SPKI');
});

test('each pipe: first instance only, owner = own SID, DACL = own SID plus ONE configured principal with 0x00120083, never a broad principal', () => {
  const pipeHost = code['PipeHost.cs'];
  assert.match(pipeHost, /NamedPipeServerStreamAcl\.Create\(pipeName, PipeDirection\.InOut, 1,/u, 'max instances 1 = FILE_FLAG_FIRST_PIPE_INSTANCE');
  assert.match(pipeHost, /security\.SetOwner\(self\);/u);
  assert.match(pipeHost, /self = identity\.User \?\? throw/u);
  assert.deepEqual([...pipeHost.matchAll(/\.AddAccessRule\(([^;]+)\);/gu)].map((m) => m[1]), [
    'new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow)',
    'new PipeAccessRule(principal, ClientAccess, AccessControlType.Allow)',
  ]);
  assert.match(pipeHost, /const PipeAccessRights ClientAccess = \(PipeAccessRights\)0x00120083;/u);
  assert.equal(/WellKnownSidType|\bEveryone\b|AuthenticatedUser|BuiltinUsers|NetworkSid|AnonymousSid|PipeOptions\.CurrentUserOnly\s*[,)]/u.test(allCode), false, 'no broad principal');
  assert.match(pipeHost, /!self\.Equals\(pipe\.GetAccessControl\(\)\.GetOwner\(typeof\(SecurityIdentifier\)\)\)/u, 'the live owner is read back');
  // The two pipes get different principals and different roles: the Control Plane SID only on submit, the approver SID only on approver.
  const runtime = code['AuthorityRuntime.cs'];
  assert.match(runtime, /PipeHost\.CreatePipe\(config\.SubmitPipe, config\.ControlPlaneSid, out int failure\)/u);
  assert.match(runtime, /PipeHost\.CreatePipe\(config\.ApproverPipe, config\.ApproverSid, out failure\)/u);
  assert.match(runtime, /ServeAsync\(submit, PipeRole\.Submit, config\.ControlPlaneSid,/u);
  assert.match(runtime, /ServeAsync\(approver, PipeRole\.Approver, config\.ApproverSid,/u);
  assert.equal([...runtime.matchAll(/CreatePipe\(/gu)].length, 2, 'exactly two pipes');
  assert.match(code['AuthorityConfig.cs'], /public string SubmitPipe => PipeRoot \+ @"\\submit\\v1";/u);
  assert.match(code['AuthorityConfig.cs'], /public string ApproverPipe => PipeRoot \+ @"\\approver\\v1";/u);
});

test('peer check: impersonate, read the SID and revert on the same thread (no await in between); a revert that fails ends the process with 71', () => {
  const pipeHost = code['PipeHost.cs'];
  const method = pipeHost.slice(pipeHost.indexOf('private static string? ReadPeerSid'), pipeHost.indexOf('private static void RevertOrTerminate'));
  assert.equal(/\bawait\b/u.test(method), false, 'no await between ImpersonateNamedPipeClient and the revert');
  assert.match(method, /finally \{ RevertOrTerminate\(\); \}/u);
  assert.match(pipeHost, /TerminateProcess\(GetCurrentProcess\(\), ExitCodes\.ImpersonationRevertFailed\)/u);
  assert.match(code['ExitCodes.cs'], /ImpersonationRevertFailed = 71;/u);
  const handle = pipeHost.slice(pipeHost.indexOf('HandleConnectionAsync(NamedPipeServerStream'), pipeHost.indexOf('private static async Task WaitForClientToReadAsync'));
  assert.ok(handle.indexOf('ReadFrameAsync(') < handle.indexOf('ReadPeerSid(pipe)') && handle.indexOf('ReadPeerSid(pipe)') < handle.indexOf('handler(role, frame)'), 'frame -> peer -> handler');
  assert.match(handle, /allowed \? handler\(role, frame\) : AuthorityProtocol\.Error\(AuthorityCodes\.RequestInvalid\)/u, 'a peer that is not the configured SID never reaches the handler');
  assert.match(pipeHost, /MaxFrameLength = AuthorityProtocol\.MaxFrameBytes;/u);
  assert.match(code['Protocol.cs'], /MaxFrameBytes = 2048/u, '2 KiB frames');
});

test('the service host talks to the SCM through three advapi32 P/Invokes only, accepts STOP only and reports RUNNING from one place', () => {
  const host = code['ServiceHost.cs'];
  assert.deepEqual(importsOf(host), ['advapi32.dll!StartServiceCtrlDispatcherW', 'advapi32.dll!RegisterServiceCtrlHandlerExW', 'advapi32.dll!SetServiceStatus']);
  assert.match(host, /ServiceWin32OwnProcess = 0x10/u);
  assert.match(host, /AcceptStop = 0x1;/u);
  assert.deepEqual([...host.matchAll(/case (Control\w+)/gu)].map((m) => m[1]), ['ControlStop', 'ControlInterrogate']);
  assert.equal([...host.matchAll(/Report\(Running\)/gu)].length, 1);
  assert.match(host, /AuthorityConfig\.TryLoad\(configPath, strictSeparation: true,/u, 'the service refuses a shared Control Plane / approver SID');
  const runtime = code['AuthorityRuntime.cs'];
  const created = runtime.indexOf('PipeHost.CreatePipe(config.ApproverPipe');
  assert.ok(created > 0 && created < runtime.indexOf('onReady();'), 'both pipes exist before the service is ready');
  assert.ok(runtime.indexOf('CngMachineKeySigner.Open(') < runtime.indexOf('RunAsync(config, core'), 'the signing key is opened before any pipe exists');
  assert.match(runtime, /return ExitCodes\.SignerUnavailable;/u);
  // The signing key's protection is read off the opened key (SigningKeyGuard, read-only) before any pipe exists; a failure is its own exit code, 78.
  assert.ok(runtime.indexOf('KeyProtectionFault(signer)') > runtime.indexOf('CngMachineKeySigner.Open(') && runtime.indexOf('KeyProtectionFault(signer)') < runtime.indexOf('RunAsync(config, core'), 'the key guard runs after the open and before any pipe');
  assert.match(runtime, /return ExitCodes\.SigningKeyUnprotected;/u);
  assert.match(code['ExitCodes.cs'], /SignerUnavailable = 77;/u);
  assert.match(code['ExitCodes.cs'], /SigningKeyUnprotected = 78;/u);
  const guard = code['SigningKeyGuard.cs'];
  assert.match(guard, /"Security Descr"/u, 'NCRYPT_SECURITY_DESCR_PROPERTY');
  assert.match(guard, /policy != CngExportPolicies\.None\) return Reason\.Exportable;/u, 'export policy must be exactly None');
  assert.match(guard, /sid\.Equals\(service\) \|\| sid\.Equals\(LocalSystem\) \|\| sid\.Equals\(Administrators\)/u, 'the only principals');
  assert.equal(/Everyone|WellKnownSidType|BuiltinUsers|AuthenticatedUser/u.test(guard), false, 'a whitelist, never a list of broad SIDs to tolerate');
});

test('the wire protocol: exactly four verbs, two per pipe, and exactly the documented error codes', () => {
  assert.deepEqual([...code['Protocol.cs'].matchAll(/\(PipeRole\.(\w+), "(\w+)"\) =>/gu)].map((m) => `${m[1]}:${m[2]}`), ['Submit:submit', 'Submit:status', 'Approver:list', 'Approver:decide']);
  const codes = [...code['ReceiptBuilder.cs'].matchAll(/(\w+) = "([a-z_]+)"/gu)].map((m) => m[2]);
  assert.deepEqual(codes, ['authority_unavailable', 'request_invalid', 'request_expired', 'human_denied', 'presence_unavailable', 'presence_mismatch', 'queue_full']);
  assert.deepEqual([...code['Protocol.cs'].matchAll(/case "(\w+)":/gu)].map((m) => m[1]), ['approve', 'deny', 'presence_unavailable']);
  // Replies never echo request text: every Error() call takes a constant.
  for (const call of allCode.matchAll(/\bError\(([^)]*)\)/gu)) assert.match(call[1], /^(?:AuthorityCodes\.\w+|string code|outcome\.Code|)$/u, `Error(${call[1]})`);
  assert.equal(/Console\.WriteLine\([^)]*(?:frame|request|json|r\[)/u.test(shippedCode), false, 'nothing from a request is ever printed');
});

test('a receipt is only made after presence verified, is checked with the contract before it is signed, and the digest is never taken from the request', () => {
  const core = code['AuthorityCore.cs'];
  const approve = core.slice(core.indexOf('private (PendingEntry Next, string? Code) Approve'), core.indexOf('private static PendingEntry Finish'));
  const order = ['presence.Verify(', 'ReceiptBuilder.Build(', 'ReceiptBuilder.Check(', 'signer.Sign('].map((token) => approve.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `verify -> build -> check -> sign (${order})`);
  assert.equal([...core.matchAll(/signer\.Sign\(/gu)].length, 1, 'one signing site');
  assert.match(core, /PresenceResult\.Verified\) return/u, 'anything but Verified stops before signing');
  assert.match(core, /string digest;\s*try \{ digest = ActionDigest\.Compute\(request\.Purpose, ReceiptBuilder\.DtoOf\(request\.Dto\)\); \}/u, 'the Authority computes the digest');
  assert.equal(/expectedDigest\s*(?:!=|==)\s*null\s*\?|digest\s*=\s*expectedDigest/u.test(core), false, 'the supplied digest is never the digest');
  assert.match(code['ReceiptBuilder.cs'], /\["actionDigest"\] = entry\.ActionDigest/u);
  assert.match(code['ReceiptBuilder.cs'], /foreach \(FieldSpec field in ReceiptV2\.Fields\)/u, 'the field order is the contract\'s');
  assert.match(code['PendingStore.cs'], /MaxPending = 32, MaxEntries = 64, DefaultTtlSeconds = 120/u);
  const protocol = code['Protocol.cs'];
  assert.match(protocol, /"brokerChallenge"/u);
  assert.equal(/brokerEpoch|leaseGeneration/u.test(code['AuthorityCore.cs'].replace(/request\.|r\.|Request\./gu, '')), false, 'epoch and generation travel only inside the request record');
});

test('build:approval-authority builds and records a SHA-256; it does not install, register or start anything, and the package never contains it', () => {
  assert.match(publish, /RestoreLockedMode=true/u);
  assert.match(publish, /\.manifest\.json/u);
  assert.match(publish, /captureExecutableIdentity/u);
  assert.match(publish, /--self-contained/u);
  assert.equal(/spawn(?:Sync)?\(\s*(?:executable|output)\b/u.test(publish), false);
  assert.equal(/\bsc(?:\.exe)?\b|New-Service|Start-Process|runas|schtasks|icacls|Set-Acl|certutil|tpmtool|New-SelfSignedCertificate/iu.test(publish), false);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:approval-authority'], 'node scripts/publish-windows-approval-authority.mjs');
  const { 'build:approval-authority': _build, ...otherScripts } = pkg.scripts;
  assert.equal(JSON.stringify({ ...pkg, scripts: otherScripts }).includes('approval-authority'), false, 'package.json names the Authority only in its build script');
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'start', 'demo', 'test']) assert.equal(String(pkg.scripts[lifecycle] ?? '').includes('approval-authority'), false, lifecycle);
  assert.match(read('scripts', 'package-smoke.mjs'), /windows-approval-authority\|albera-approval-authority/u);
});
