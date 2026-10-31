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
const codeWithoutPolicyStore = Object.entries(code).filter(([name]) => name !== 'PolicyStore.cs').map(([, text]) => text).join('\n');
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

test('the Authority never starts a process, registers a service, uses the network or creates, imports, exports or deletes a key, and writes no file outside PolicyStore.cs', () => {
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /ServiceBase/u, /ServiceController/u, /\bsc\.exe\b/u, /powershell/iu, /Hyper-?V/iu, /Get-VM/u, /SetAccessControl/u,
    /OpenSCManager|CreateService|ChangeServiceConfig|ControlService|DeleteService|OpenService|QueryServiceStatus/u, /System\.ServiceProcess|Microsoft\.Extensions\.Hosting/u,
    /HttpClient|System\.Net\.Sockets|TcpClient|WebRequest/u,
    /Environment\.GetEnvironmentVariable/u, /CngKey\.(?:Create|Import)|CngKeyCreationParameters|CngKeyBlobFormat|ExportPolicy\s*=[^=]|SetProperty|\.Delete\(\)|NCryptDeleteKey|NCryptCreate|ExportPkcs8PrivateKey|ExportECPrivateKey|ExportParameters\(true\)/u,
    /KeyCredentialManager|Windows\.Security\.Credentials/u]) {
    assert.equal(forbidden.test(allCode), false, `no Authority source may match ${forbidden}`);
  }
  // Since issue #115 step 3 the Authority writes ONE file, the tier policy, and only from PolicyStore.cs (see the policy test below). Nothing else writes, deletes, moves or copies a file.
  assert.equal(/File\.(?:Write|Create|Delete|Move|Copy|Append|Replace)|FileMode\.(?:Create|CreateNew|Append|Truncate|OpenOrCreate)|FileAccess\.(?:Write|ReadWrite)|MoveFileEx|DeleteFile|WriteAllText|WriteAllBytes/u.test(codeWithoutPolicyStore), false,
    'no file is written outside PolicyStore.cs');
});

test('the test fakes and the serve-loop / request entries exist only inside #if ALBERA_AUTHORITY_TEST_FAULTS and never in the shipped build', () => {
  assert.equal(/FakeReceiptSigner|FakePresenceVerifier|CheckForTest|ProofFor|UnavailableProof|serve-loop|ServeLoopForTest|RequestForTest|AUTHORITY_PUBLIC_KEY|albera-test-approval-authority|albera-fake-presence|ServiceSidForTest|trust-sid/u.test(shippedCode), false,
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
  assert.ok(runtime.indexOf('signer.ProtectionFault()') > runtime.indexOf('CngMachineKeySigner.Open(') && runtime.indexOf('signer.ProtectionFault()') < runtime.indexOf('RunAsync(config, core'), 'the key guard runs after the open and before any pipe');
  assert.match(runtime, /return ExitCodes\.SigningKeyUnprotected;/u);
  assert.match(code['ExitCodes.cs'], /SignerUnavailable = 77;/u);
  assert.match(code['ExitCodes.cs'], /SigningKeyUnprotected = 78;/u);
  const guard = code['SigningKeyGuard.cs'];
  assert.match(guard, /"Security Descr"/u, 'NCRYPT_SECURITY_DESCR_PROPERTY');
  assert.match(guard, /policy != CngExportPolicies\.None\) return Reason\.Exportable;/u, 'export policy must be exactly None');
  assert.match(guard, /sid\.Equals\(service\) \|\| sid\.Equals\(LocalSystem\) \|\| sid\.Equals\(Administrators\)/u, 'the only principals');
  assert.equal(/Everyone|WellKnownSidType|BuiltinUsers|AuthenticatedUser/u.test(guard), false, 'a whitelist, never a list of broad SIDs to tolerate');
  // The trusted SID is the per-service SID of the fixed service name, required in the token's enabled groups, never the token user (LocalService / NetworkService / a user account are shared).
  assert.match(guard, /ServiceName = "AlberaApprovalAuthority"/u);
  assert.match(guard, /SHA1\.HashData\(System\.Text\.Encoding\.Unicode\.GetBytes\(serviceName\.ToUpperInvariant\(\)\)\)/u, 'the SCM derivation');
  assert.match(guard, /new SecurityIdentifier\("S-1-5-80-"/u);
  assert.match(guard, /principal\.IsInRole/u, 'enabled groups only');
  assert.equal(/\.User\b/u.test(guard + code['AuthorityRuntime.cs'] + code['Signers.cs'] + code['ServicePathGuard.cs']), false, 'the token user is never the trusted SID');
  // The config-file guard trusts the same per-service SID (SigningKeyGuard.ServiceName), required as an enabled token group, and nothing when it is absent.
  const pathGuard = code['ServicePathGuard.cs'];
  assert.match(pathGuard, /SigningKeyGuard\.ResolveServiceSid\(new WindowsPrincipal\(identity\)\.IsInRole, out SecurityIdentifier sid\) is null \? sid : null;/u, 'enabled groups only');
  assert.match(pathGuard, /CurrentServiceSid\(\) is \{ \} service && IsTrusted\(file\.GetAccessControl\(\), service\)/u, 'no service SID in the token: the config is not trusted');
  assert.match(pathGuard, /sid\.Equals\(service\) \|\| sid\.Equals\(LocalSystem\) \|\| sid\.Equals\(Administrators\) \|\| sid\.Equals\(CreatorOwner\);/u);
  assert.match(sources['ServicePathGuard.cs'], /#if ALBERA_AUTHORITY_TEST_FAULTS\n[^#]*ServiceSidForTest[\s\S]*?#endif/u, 'the stand-in SID exists only in the test-faults build');
  assert.match(sources['Program.cs'], /#if ALBERA_AUTHORITY_TEST_FAULTS\n[^#]*"--trust-sid"/u, 'and is set only by --trust-sid inside the test-only #if block');
  assert.match(code['Signers.cs'], /SigningKeyGuard\.CheckCurrentProcess\(key\)/u);
  assert.match(sources['SigningKeyGuard.cs'], /#if ALBERA_AUTHORITY_TEST_FAULTS\n[^#]*CheckForTest[\s\S]*?#endif/u, 'the explicit-SID check exists only in the test-faults build');
  assert.match(guard, /private static string\? Check\(CngKey key/u);
});

test('the wire protocol: exactly six verbs (two on the submit pipe, four on the approver pipe, the two policy verbs among them), and exactly the documented error codes', () => {
  assert.deepEqual([...code['Protocol.cs'].matchAll(/\(PipeRole\.(\w+), "(\w+)"\) =>/gu)].map((m) => `${m[1]}:${m[2]}`),
    ['Submit:submit', 'Submit:status', 'Approver:list', 'Approver:decide', 'Approver:policy', 'Approver:policy_set']);
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
  // Two signing sites, and no more: Approve (above, after the presence proof) and SignByPolicy, reached only from Submit for an action the policy in force lets through.
  assert.equal([...core.matchAll(/signer\.Sign\(/gu)].length, 2, 'two signing sites');
  const policySite = core.slice(core.indexOf('private PendingEntry? SignByPolicy'));
  assert.ok(policySite.indexOf('ReceiptBuilder.BuildPolicy(') > 0 && policySite.indexOf('ReceiptBuilder.BuildPolicy(') < policySite.indexOf('ReceiptBuilder.Check(') && policySite.indexOf('ReceiptBuilder.Check(') < policySite.indexOf('signer.Sign('), 'build -> check -> sign');
  assert.equal([...core.matchAll(/SignByPolicy\(/gu)].length, 3, 'declared once, called twice (without an attestation, and with a proven one)');
  assert.match(core, /if \(!current\.NeedsPerson\(request\.Dto\.Action\)\) return store\.Submit\(request, digest, \(entry, now\) => SignByPolicy\(entry, current\.Hash\(\), now\)\);/u, 'the decision is made from the action the Authority validated and the policy in force, under the policy lock');
  assert.match(core, /return store\.Submit\(request, digest\);\s*\}\);/u, 'everything else queues for a person');
  assert.match(core, /policy\.With\(current =>/u);
  assert.equal(/request\.(?:Tier|Basis|Policy)|expectedDigest[^;]*NeedsPerson/u.test(core), false, 'nothing in the request feeds the decision');
  assert.match(core, /PresenceResult\.Verified\) return/u, 'anything but Verified stops before signing');
  assert.match(core, /string digest;\s*try \{ digest = ActionDigest\.Compute\(request\.Purpose, ReceiptBuilder\.DtoOf\(request\.Dto\)\); \}/u, 'the Authority computes the digest');
  assert.equal(/expectedDigest\s*(?:!=|==)\s*null\s*\?|digest\s*=\s*expectedDigest/u.test(core), false, 'the supplied digest is never the digest');
  assert.match(code['ReceiptBuilder.cs'], /\["actionDigest"\] = entry\.ActionDigest/u);
  assert.match(code['ReceiptBuilder.cs'], /foreach \(FieldSpec field in fields\.Concat\(optional\.Where\(o => values\.ContainsKey\(o\.Name\)\)\)\)/u, 'the field order is the contract\'s, then the optional fields that are present');
  assert.match(code['ReceiptBuilder.cs'], /Write\(ReceiptV2\.Fields, /u);
  assert.match(code['ReceiptBuilder.cs'], /Write\(ReceiptV3\.Fields, /u);
  assert.match(code['PendingStore.cs'], /MaxPending = 32, MaxEntries = 64, DefaultTtlSeconds = 120/u);
  const protocol = code['Protocol.cs'];
  assert.match(protocol, /"brokerChallenge"/u);
  assert.equal(/brokerEpoch|leaseGeneration/u.test(code['AuthorityCore.cs'].replace(/request\.|r\.|Request\./gu, '')), false, 'epoch and generation travel only inside the request record');
});

test('the attested path (#115 step 3b): only for an action the policy in force can skip with an attestation, checked under the policy lock with the pinned key against the submit\'s own fields, the clock read after the signature, nothing else feeds it', () => {
  const core = code['AuthorityCore.cs'];
  const submit = core.slice(core.indexOf('policy.With(current =>'), core.indexOf('return result.Status switch'));
  assert.match(submit, /if \(current\.CanSkipWithAttestation\(request\.Dto\.Action\) && ProvenBy\(request, attestation, digest\) is \{ \} proven\)/u, 'the policy decides first; the attestation is only looked at for an attested action');
  assert.match(submit, /proven\.ExpiresAt - now >= MinAttestedReceiptSeconds \? SignAttested\(entry, current\.Hash\(\), now, proven\) : entry/u, 'too little left of the attestation means the entry stays pending');
  // #128: an attested request that cannot be signed stays the pending entry (a person is asked); only the plain policy site above may answer authority_unavailable.
  const attested = core.slice(core.indexOf('private PendingEntry SignAttested'), core.indexOf('private static string? CodeFor'));
  assert.match(attested, /PendingEntry\? signed = SignByPolicy\(entry, policyHash, now, proven\);\s*if \(signed is not null\) return signed;[^]*return entry;/u, 'SignAttested returns the signed entry, or the pending one it was given');
  assert.equal(/return null/u.test(attested), false, 'the attested path never returns null (null is authority_unavailable)');
  assert.equal(/SignByPolicy\(entry, current\.Hash\(\), now, proven\)/u.test(submit), false, 'the attested site goes through SignAttested only');
  const proven = core.slice(core.indexOf('private Proven? ProvenBy'), core.indexOf('private Proven? Refused'));
  assert.match(proven, /request\.Dto\.Action == TaskStartAction \? ProvenTaskStart\(request, attestation, vmId, generation, actionDigest\) : ProvenNone\(request, attestation, vmId, generation\)/u, 'task.start is judged by the task-start kind, every other attested action by the network kind: never the other way round');
  assert.match(proven, /attestationKey is null\) return Refused\("no_key_pinned"\)/u, 'no pinned key: never accepted');
  assert.match(proven, /request\.Dto\.Args\.GetValueOrDefault\("expectedGeneration"\) is not long generation \|\| generation < 1\) return Refused\("generation_missing"\)/u, 'the generation comes from the action the human sees (digest-bound args)');
  assert.match(proven, /Args\.GetValueOrDefault\("vmId"\) is not string vmId \|\| !NetworkAttestation\.IsVmId\(vmId\)\) return Refused\("vm_id_missing"\)/u, 'a start that names no well-formed VM is never attested');
  assert.match(proven, /AttestationExpected expected = new\(request\.Dto\.ComputerId, vmId, generation, request\.Dto\.ProjectId, request\.LeaseId, request\.LeaseGeneration\)/u, 'the network bindings come from the submit\'s own fields too');
  assert.match(proven, /TaskStartExpected expected = new\(request\.Dto\.ComputerId, vmId, generation, request\.Dto\.ProjectId, request\.LeaseId, request\.LeaseGeneration, request\.OperationId, actionDigest\)/u, 'and so do the task-start bindings, the operation and the action digest included (#133)');
  assert.match(core, /string digest;\s+try \{ digest = ActionDigest\.Compute\(request\.Purpose, ReceiptBuilder\.DtoOf\(request\.Dto\)\); \}/u, 'the digest the statement is bound to is the one the Authority computed itself from the DTO it will sign');
  assert.equal(/ProvenBy\([^)]*expectedDigest/u.test(core), false, 'the optional cross-check digest from the Control Plane never feeds the attestation check');
  assert.match(proven, /new\(request\.Dto\.ComputerId, vmId, generation, request\.Dto\.ProjectId, request\.LeaseId, request\.LeaseGeneration\)/u, 'every binding comes from the submit\'s own validated fields, the VM included (there is no way to leave it out)');
  assert.equal(/AttestationExpected\([^)]*\bnull\b/u.test(core), false, 'no null escape for the VM id');
  assert.match(proven, /NetworkAttestation\.Verify\(attestation, clock, attestationKey!\.Verify, expected\)/u, 'verified with the pinned key and the Authority\'s own clock (read after the signature check inside Verify)');
  assert.match(proven, /TaskStartAttestation\.Verify\(attestation, clock, attestationKey!\.Verify, expected\)/u, 'the task-start kind is verified the same way');
  assert.match(proven, /Network != NetworkAttestation\.None\) return Refused/u, 'only "none" counts');
  assert.match(proven, /Network != TaskStartAttestation\.None\) return Refused[^\n]*\n\s+if \(!TaskStartAttestation\.ProvesCheckpointedNoNetwork\(verdict\.Value\)\) return Refused/u, 'task.start needs "none" AND a Production checkpoint');
  assert.equal(/attestation\.(?:Tier|Basis|Network)|Policy\(\)\s*=\s*attestation/u.test(core), false, 'the claim feeds nothing but the proof');
  // The receipt carries the digest and ends no later than the evidence does.
  const site = core.slice(core.indexOf('private PendingEntry? SignByPolicy'));
  assert.match(site, /Math\.Min\(ReceiptV2\.DefaultTtlSeconds, proven\.ExpiresAt - now\)/u);
  assert.match(site, /ReceiptBuilder\.BuildPolicy\(entry, identity, signer\.Issuer, Ids\.NewUuid\(\), Ids\.NewBits128\(\), now, policyHash, proven\?\.Digest, ttl\)/u);
  // The pinned key is config only: both keys or neither, verified at load, never created, imported from a request or written.
  const config = code['AuthorityConfig.cs'];
  assert.match(config, /pinned is not \(0 or 2\)/u, 'both keys or neither');
  assert.match(config, /DecodeAttestationKey\(Get\("attestationKeyId"\), Get\("attestationPublicKey"\)\)/u);
  assert.match(code['AuthorityRuntime.cs'], /AttestationKeyOf\(config\)/u);
  assert.match(code['PinnedAttestationKey.cs'], /curve\.IsNamed && curve\.Oid\.Value == NistP256Oid/u, 'a named P-256 key only');
  assert.match(code['PinnedAttestationKey.cs'], /signature\.Length != SignatureBytes\) return false/u);
  assert.equal(/ECDsa\.Create\([^)]*\)[^;]*ImportECPrivateKey|ImportPkcs8PrivateKey|Sign(?:Data|Hash)\(/u.test(code['PinnedAttestationKey.cs']), false, 'the Authority holds only the public half');
  // The wire: `attestation` is one more optional submit key and nothing else is read from it by the protocol layer.
  assert.match(code['Protocol.cs'], /HasKeys\(r, SubmitKeys, optional: \["expectedDigest", "attestation"\]\)/u);
  assert.match(code['Protocol.cs'], /r\.GetValueOrDefault\("attestation"\)\)/u);
});

test('the tier policy: one file, written only by PolicyStore.cs (create-new temp, flushed, trust-checked, moved with write-through, read back), read at start before the key is opened, and an invalid one is exit 79', () => {
  const store = code['PolicyStore.cs'];
  assert.match(store, /public const string FileName = "policy\.json";/u);
  assert.match(store, /Path\.Combine\(Path\.GetDirectoryName\(configPath\)!, FileName\)/u, 'the policy lives next to the config file');
  const persist = store.slice(store.indexOf('private bool Persist('), store.indexOf('private static void Remove('));
  const order = ['FileMode.CreateNew', 'stream.Write(Envelope(next, signed, presence))', 'stream.Flush(flushToDisk: true)', 'ServicePathGuard.IsTrustedConfigFile(temp, stream)', 'MoveFileExW(temp, file!', 'ReadFile(file!', 'faulted = true'].map((token) => persist.indexOf(token));
  assert.ok(order.every((at) => at > 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `temp -> write -> flush -> trust check -> move -> read back -> fault (${order})`);
  assert.match(persist, /FileOptions\.WriteThrough/u);
  assert.match(store, /MoveReplaceExisting = 0x1, MoveWriteThrough = 0x8/u);
  assert.deepEqual([...store.matchAll(/FileMode\.(\w+), FileAccess\.(\w+)/gu)].map((m) => `${m[1]}:${m[2]}`), ['Open:Read', 'CreateNew:Write'], 'a read of the policy and the one temp file');
  assert.equal([...store.matchAll(/File\.Delete\(/gu)].length, 1, 'File.Delete removes only the temp file');
  assert.equal([...store.matchAll(/\[DllImport/gu)].length, 1, 'one P/Invoke, for the move');
  // The change is decided and stored inside one lock, in this order: revision, presence only for a loosening change, then the file, then memory.
  const change = store.slice(store.indexOf('public string? Change('), store.indexOf('// Called under the lock.'));
  const steps = ['faulted) return', 'next.Revision != current.Revision + 1', 'next.Loosens(current)', 'verify(next, proof)', 'Persist(next, nextAuthorized, nextProof)', '(current, authorized, authorizedProof) = (next'].map((token) => change.indexOf(token));
  assert.ok(steps.every((at) => at > 0) && steps.every((at, i) => i === 0 || at > steps[i - 1]), `fault -> revision -> loosens -> verify -> persist -> memory (${steps})`);
  assert.match(change, /lock \(gate\)/u);
  assert.match(code['AuthorityCore.cs'], /PolicyChange\.Message\(next, identity\.Kid, identity\.Audience\), proof\)/u, 'the presence check is over the policy message, bound to this Authority');
  assert.equal(/PresenceMessage\.Build/u.test(change + code['AuthorityCore.cs'].slice(code['AuthorityCore.cs'].indexOf('VerifyPolicyChange'), code['AuthorityCore.cs'].indexOf('SignByPolicy'))), false, 'a policy change is never checked against a presence message');
  // Authorization is stored with the policy and checked on every load: trust check, strict shape, then the signature (bound to kid and audience) before the policy is used.
  const read = store.slice(store.indexOf('private static Loaded? ReadFile('), store.indexOf('// The strict shape'));
  const readOrder = ['IsTrustedConfigFile(path, stream)', 'Parse(bytes)', 'IsAuthorized(loaded, identity, verifier)', 'return loaded;'].map((token) => read.indexOf(token));
  assert.ok(readOrder.every((at) => at > 0) && readOrder.every((at, i) => i === 0 || at > readOrder[i - 1]), `trust -> shape -> signature -> use (${readOrder})`);
  assert.match(store, /verifier\.Verify\(PolicyChange\.Message\(loaded\.Authorized, identity\.Kid, identity\.Audience\), loaded\.Presence!\)/u);
  assert.match(store, /loaded\.Policy\.SkippableActions\(\)\.IsSubsetOf\(loaded\.Authorized\.SkippableActions\(\)\)/u, 'a policy never skips more than what was signed (with or without an attestation)');
  assert.match(store, /if \(loaded\.Authorized is null\) return loaded\.Policy\.SkippableActions\(\)\.Count == 0;/u, 'no signature is only fine for a policy that skips nobody, attested or not');
  assert.match(store, /Reason\.Unsigned|Unsigned = "policy_unsigned"/u);
  assert.match(sources['PolicyStore.cs'], /Out of scope, on purpose: putting an OLDER file back/u, 'rollback by a trusted writer is documented as out of scope');
  // The folder is trusted at the config load (exit 73), after the config file's own check and before anything is read from the folder, so a squatted policy.json never reaches the policy loader.
  const config = code['AuthorityConfig.cs'];
  assert.ok(config.indexOf('IsTrustedConfigFile(configPath, file)') > 0 && config.indexOf('IsTrustedConfigFile(configPath, file)') < config.indexOf('IsTrustedConfigFolder(Path.GetDirectoryName(configPath)!)') && config.indexOf('IsTrustedConfigFolder(') < config.indexOf('file.Length > MaxFileBytes'), 'file -> folder -> read');
  assert.match(config, /reason = Reason\.ConfigFolderUntrusted; return null;/u);
  assert.match(code['ServicePathGuard.cs'], /public static bool IsTrustedConfigFolder\(string folder\) =>/u);
  assert.match(code['ServicePathGuard.cs'], /IsTrustedDescriptor\(new DirectoryInfo\(folder\)\.GetAccessControl\(\)\.GetSecurityDescriptorBinaryForm\(\), service\)/u, 'the folder gets the same rules as the file');
  // Start-up: config, then policy, then the signing key; an invalid file is 79 and is reported with a fixed word, never the file content.
  const host = code['ServiceHost.cs'];
  assert.ok(host.indexOf('AuthorityConfig.TryLoad(configPath') < host.indexOf('PolicyStore.TryLoad(configPath') && host.indexOf('PolicyStore.TryLoad(configPath') < host.indexOf('RunLoopAsync(config, policy'), 'config -> policy -> run');
  assert.match(host, /ReportStopped\(ExitCodes\.PolicyInvalid\)/u);
  assert.match(code['ExitCodes.cs'], /PolicyInvalid = 79;/u);
  assert.match(code['Program.cs'], /return ExitCodes\.PolicyInvalid;/u, 'service-check refuses the same file');
  assert.match(code['AuthorityRuntime.cs'], /RunProductionAsync\(AuthorityConfig config, PolicyStore policy, CancellationToken stop, Action onReady\)/u);
  assert.match(code['AuthorityRuntime.cs'], /IdentityOf\(config\), UnixNow, policy, Console\.WriteLine, attestation\);/u, 'the loaded policy is what the core uses');
  assert.equal(/SERVICE_POLICY=[^"]*\{(?!policyReason|policy\.Current\.Tier)/u.test(code['ServiceHost.cs'] + code['Program.cs'] + sources['TestSeam.cs']), false, 'only reason words and the tier are printed');
  // The policy is never lowered by a fallback: no catch in the loader turns a failure into the default policy.
  assert.equal(/TierPolicy\.Default/u.test(store.slice(store.indexOf('public static PolicyStore? TryLoad'), store.indexOf('private static TierPolicy? ReadFile'))), true, 'only "no file" gives the default');
  assert.match(store, /catch \(Exception ex\) when \(ex is FileNotFoundException or DirectoryNotFoundException\)\s*\{\s*exists = false;/u, 'only a missing file counts as no file');
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
