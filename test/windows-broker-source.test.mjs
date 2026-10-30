import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for the Host Broker prototype (ADR-002 Proposed / NOT VERIFIED). They run on every OS and need no .NET SDK.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const program = read('src', 'runtime', 'windows-broker', 'Program.cs');
const project = read('src', 'runtime', 'windows-broker', 'Albera.WindowsBroker.csproj');
const publish = read('scripts', 'publish-windows-broker.mjs');

test('Broker source stays a fixed-action prototype with no process launch, service or Hyper-V code', () => {
  assert.deepEqual([...program.matchAll(/action != "([^"]+)"/gu)].map((m) => m[1]), ['synthetic.noop']);
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /ServiceBase/u, /ServiceController/u, /\bsc\.exe\b/u, /powershell/iu, /Hyper-?V/iu, /Get-VM/u, /SetAccessControl/u]) {
    assert.equal(forbidden.test(program), false, `Program.cs must not match ${forbidden}`);
  }
});

test('Broker pipe is ephemeral, owned by the Broker\'s own SID and grants only that SID; start-up fails if the owner cannot be set', () => {
  // PipeOptions.CurrentUserOnly cannot be combined with a PipeSecurity, so the same DACL is written out: one ACE, this process's own user SID.
  assert.equal(/PipeOptions\.CurrentUserOnly\s*[,)]/u.test(program), false, 'CurrentUserOnly is rejected together with a PipeSecurity; the DACL is explicit');
  assert.match(program, /NamedPipeServerStreamAcl\.Create\(pipeName, PipeDirection\.InOut, 1,/u);
  assert.match(program, /security\.SetOwner\(self\);/u);
  assert.deepEqual([...program.matchAll(/\.AddAccessRule\(([^;]+)\);/gu)].map((m) => m[1]), ['new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow)']);
  assert.match(program, /self = identity\.User \?\? throw/u, 'the owner comes from the process token user SID');
  assert.equal(/WellKnownSidType|\bEveryone\b|AuthenticatedUser|BuiltinUsers|NetworkSid|AnonymousSid/u.test(program), false, 'no broad principal is ever granted');
  assert.match(program, /BROKER_FATAL=PIPE_OWNER_UNAVAILABLE/u);
  assert.match(program, /!self\.Equals\(pipe\.GetAccessControl\(\)\.GetOwner\(typeof\(SecurityIdentifier\)\)\)/u, 'the live pipe owner is read back and compared');
});

test('Broker fault-injection seam is compiled out of the shipped build and the pipe stays first-instance only', () => {
  // Every reference to the injected faults sits inside #if ALBERA_BROKER_TEST_FAULTS ... #endif (plus the unconditional enum declaration).
  const outsideSeam = program.replace(/#if ALBERA_BROKER_TEST_FAULTS[\s\S]*?#endif/gu, '').replace(/enum ImpersonationFault[^\n]*/u, '');
  assert.equal(/serve-fault|RevertFails|RevertThrows|RevertLies/u.test(outsideSeam), false, 'fault names must only appear inside the test-only #if block');
  assert.match(project, /Condition="'\$\(AlberaBrokerTestFaults\)' == 'true'"/u);
  // MSBuild reads environment variables as properties, so the publish pins the switch off as a global property.
  assert.match(publish, /'-p:AlberaBrokerTestFaults=false'/u, 'the publish script must pin the test seam off');
  assert.equal(/AlberaBrokerTestFaults=(?!false')|ALBERA_BROKER_TEST_FAULTS/u.test(publish), false, 'the publish script must never enable the test seam');
  assert.match(program, /NamedPipeServerStreamAcl\.Create\(pipeName, PipeDirection\.InOut, 1,/u, 'maxNumberOfServerInstances == 1 is what makes .NET set FILE_FLAG_FIRST_PIPE_INSTANCE');
});

test('Broker project asks for no elevation, no service wrapper and no extra package', () => {
  assert.equal(/ApplicationManifest|requestedExecutionLevel|WindowsService|UseWindowsServices/iu.test(project), false);
  assert.deepEqual([...project.matchAll(/<PackageReference Include="([^"]+)" Version="([^"]+)"/gu)].map((m) => `${m[1]}@${m[2]}`), ['Microsoft.Data.Sqlite@10.0.14']);
  assert.match(project, /<AssemblyName>albera-windows-broker<\/AssemblyName>/u);
});

test('Broker publish script only builds, writes a SHA-256 manifest and does not install or start anything', () => {
  assert.match(publish, /RestoreLockedMode=true/u);
  assert.match(publish, /\.manifest\.json/u);
  assert.match(publish, /captureExecutableIdentity/u);
  assert.equal(/spawn(?:Sync)?\(\s*(?:broker|output)\b/u.test(publish), false);
  assert.equal(/\bsc(?:\.exe)?\b|New-Service|Start-Process|runas|schtasks|icacls|Set-Acl/iu.test(publish), false);
});

// The trusted pipe client helper (verifies the pipe server before it writes). Same source-level guards, any OS, no .NET SDK needed.
const pipeClientProgram = read('src', 'runtime', 'windows-broker-pipe-client', 'Program.cs');
const pipeClientCode = pipeClientProgram.replace(/^\s*\/\/.*$/gmu, '');
const pipeClientProject = read('src', 'runtime', 'windows-broker-pipe-client', 'Albera.WindowsBrokerPipeClient.csproj');
const pipeClientLock = JSON.parse(read('src', 'runtime', 'windows-broker-pipe-client', 'packages.lock.json'));

test('pipe client helper is small, dependency-free and locked: BCL and P/Invoke only', () => {
  assert.ok(pipeClientProgram.replace(/\n$/u, '').split('\n').length <= 200, 'Program.cs stays reviewable (200 lines)');
  assert.deepEqual([...pipeClientProject.matchAll(/<PackageReference /gu)], [], 'no package reference');
  assert.match(pipeClientProject, /<RuntimeIdentifiers>win-x64<\/RuntimeIdentifiers>/u);
  assert.match(pipeClientProject, /<AssemblyName>albera-windows-broker-pipe-client<\/AssemblyName>/u);
  assert.equal(/ApplicationManifest|requestedExecutionLevel|WindowsService|UseWindowsServices/iu.test(pipeClientProject), false);
  assert.deepEqual(Object.values(pipeClientLock.dependencies).map((framework) => Object.keys(framework)), [[], []], 'the lock file pins no package');
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /powershell/iu, /Hyper-?V/iu, /SetAccessControl/u, /AddAccessRule/u, /Impersonat/u]) {
    assert.equal(forbidden.test(pipeClientCode), false, `the pipe client must not match ${forbidden}`);
  }
});

test('pipe client helper opens with SQOS identification and specific rights, and verifies the server before the first write', () => {
  assert.match(pipeClientProgram, /SecuritySqosPresent = 0x00100000/u);
  assert.match(pipeClientProgram, /SecurityIdentification = 0x00010000/u);
  assert.match(pipeClientProgram, /ClientAccess = 0x1 \/\*FILE_READ_DATA\*\/ \| 0x2 \/\*FILE_WRITE_DATA\*\/ \| 0x80 \/\*FILE_READ_ATTRIBUTES\*\/ \| 0x20000 \/\*READ_CONTROL\*\/ \| 0x100000 \/\*SYNCHRONIZE\*\//u, 'the 0x00120083 Control Plane mask');
  assert.equal(/GENERIC_WRITE|0x40000000|FILE_APPEND_DATA/u.test(pipeClientCode.replace(/\/\*.*?\*\//gu, '')), false, 'no GENERIC_WRITE / FILE_APPEND_DATA in code');
  const firstWrite = pipeClientCode.indexOf('pipe.Write(');
  assert.ok(firstWrite > 0 && pipeClientCode.indexOf('pipe.Write(', firstWrite + 1) === -1, 'exactly one write site');
  for (const check of ['GetAccessControl().GetOwner', 'GetNamedPipeServerProcessId(pipe', 'GetNamedPipeServerSessionId(pipe', 'ImageSha256(serverPid)', 'sent = true']) {
    const at = pipeClientCode.indexOf(check);
    assert.ok(at > 0 && at < firstWrite, `${check} must come before the write`);
  }
  assert.ok(pipeClientCode.indexOf('CreateFileW(') < pipeClientCode.indexOf('GetAccessControl().GetOwner'), 'verification happens on the opened handle');
  // A watchdog that reads `sent` outside the lock could report a pre-send code after the receipt was written.
  assert.match(pipeClientCode, /lock \(Gate\) sent = true;/u, 'the send flag is set under Gate');
  assert.match(pipeClientCode, /new\(_ => \{ lock \(Gate\) Finish\(Failure\(sent \?/u, 'the watchdog reads the send flag under Gate');
  assert.equal(/sent = true;/u.test(pipeClientCode.replace(/lock \(Gate\) sent = true;/gu, '')), false, 'no unlocked write of the send flag');
});

test('pipe client helper reports only the documented exit codes and result codes', () => {
  assert.match(pipeClientProgram, /ExitOk = 0, ExitBadInput = 64, ExitInternal = 70;/u);
  const failureLines = pipeClientCode.split('\n').filter((codeLine) => codeLine.includes('Failure(') && !codeLine.includes('string Failure('));
  const codes = [...new Set(failureLines.flatMap((codeLine) => [...codeLine.matchAll(/"([a-z]+(?:_[a-z]+)*)"/gu)].map((m) => m[1])).filter((word) => word !== 'ok' && word !== 'code'))].sort(); // 'ok' and 'code' are JSON property names in Relay
  assert.deepEqual(codes, ['access_denied', 'broker_unavailable', 'denied', 'invalid_request', 'invalid_response', 'response_too_large', 'server_identity_mismatch', 'server_identity_unavailable', 'timeout', 'transport_error']);
});

test('build:windows-broker also builds the pipe client and neither is wired into the package', () => {
  assert.match(publish, /Albera\.WindowsBrokerPipeClient\.csproj/u);
  assert.match(publish, /RestoreLockedMode=true/u);
  assert.equal(JSON.stringify(JSON.parse(read('package.json'))).includes('pipe-client'), false);
});
