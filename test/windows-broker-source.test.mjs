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
// The service host lives in four more files of the same project (partial class Program + ServiceConfig + ServiceHost + ServicePathGuard). Code only: comments may name what is NOT used.
const serviceHost = read('src', 'runtime', 'windows-broker', 'ServiceHost.cs');
const serviceConfig = read('src', 'runtime', 'windows-broker', 'ServiceConfig.cs');
const serviceLoop = read('src', 'runtime', 'windows-broker', 'ServiceLoop.cs');
const servicePathGuard = read('src', 'runtime', 'windows-broker', 'ServicePathGuard.cs');
const databaseFolderPin = read('src', 'runtime', 'windows-broker', 'DatabaseFolderPin.cs');
const stripComments = (source) => source.replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const brokerCode = [program, serviceHost, serviceConfig, serviceLoop, servicePathGuard, databaseFolderPin].map(stripComments).join('\n');

test('Broker source stays a fixed-action prototype with no process launch, installer or Hyper-V code', () => {
  assert.deepEqual([...program.matchAll(/action != "([^"]+)"/gu)].map((m) => m[1]), ['synthetic.noop']);
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /ServiceBase/u, /ServiceController/u, /\bsc\.exe\b/u, /powershell/iu, /Hyper-?V/iu, /Get-VM/u, /SetAccessControl/u]) {
    assert.equal(forbidden.test(program), false, `Program.cs must not match ${forbidden}`);
    assert.equal(forbidden.test(brokerCode), false, `no Broker source file may match ${forbidden}`);
  }
});

test('Broker pipe is ephemeral, owned by the Broker\'s own SID and grants only that SID; start-up fails if the owner cannot be set', () => {
  // PipeOptions.CurrentUserOnly cannot be combined with a PipeSecurity, so the same DACL is written out: one ACE, this process's own user SID.
  assert.equal(/PipeOptions\.CurrentUserOnly\s*[,)]/u.test(program), false, 'CurrentUserOnly is rejected together with a PipeSecurity; the DACL is explicit');
  assert.match(program, /NamedPipeServerStreamAcl\.Create\(pipeName, PipeDirection\.InOut, 1,/u);
  assert.match(program, /security\.SetOwner\(self\);/u);
  // Exactly two grants ever: the Broker itself, and (service mode only) the one configured Control Plane SID with the exact 0x00120083 mask.
  assert.deepEqual([...program.matchAll(/\.AddAccessRule\(([^;]+)\);/gu)].map((m) => m[1]), [
    'new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow)',
    'new PipeAccessRule(controlPlane, ControlPlaneAccess, AccessControlType.Allow)',
  ]);
  assert.match(program, /const PipeAccessRights ControlPlaneAccess = \(PipeAccessRights\)0x00120083;/u, 'the Control Plane ACE is exactly 0x00120083');
  assert.match(program, /!controlPlane\.Equals\(self\)/u, 'no second ACE for the Broker\'s own SID');
  assert.match(program, /self = identity\.User \?\? throw/u, 'the owner comes from the process token user SID');
  assert.equal(/WellKnownSidType|\bEveryone\b|AuthenticatedUser|BuiltinUsers|NetworkSid|AnonymousSid/u.test(program), false, 'no broad principal is ever granted');
  assert.match(program, /BROKER_FATAL=PIPE_OWNER_UNAVAILABLE/u);
  assert.match(program, /!self\.Equals\(pipe\.GetAccessControl\(\)\.GetOwner\(typeof\(SecurityIdentifier\)\)\)/u, 'the live pipe owner is read back and compared');
});

test('Broker fault-injection seam is compiled out of the shipped build and the pipe stays first-instance only', () => {
  // Every reference to the injected faults sits inside #if ALBERA_BROKER_TEST_FAULTS ... #endif (plus the unconditional enum declaration).
  const outsideSeam = [program, serviceHost, serviceConfig, serviceLoop, servicePathGuard, databaseFolderPin].map((source) => source.replace(/#if ALBERA_BROKER_TEST_FAULTS[\s\S]*?#endif/gu, '').replace(/enum ImpersonationFault[^\n]*/u, '')).join('\n');
  assert.equal(/serve-fault|RevertFails|RevertThrows|RevertLies|serve-loop|ServeLoopForTest/u.test(outsideSeam), false, 'fault names and the serve-loop test entry must only appear inside the test-only #if block');
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

// The service host (`service <config>`): the Broker is itself the SCM service process. Source guards only (any OS, no .NET SDK); the behaviour is
// covered by runtime-windows-broker-service-host.test.mjs (host) and the VM lab (SCM).
const importsOf = (source) => [...source.matchAll(/\[DllImport\("([^"]+)"[^\]]*\)\]\s*(?:private|internal|public) static extern \w+ (\w+)\(/gu)].map((m) => `${m[1]}!${m[2]}`);

test('service host talks to the SCM through three advapi32 P/Invokes only and never creates, changes, starts or stops a service', () => {
  assert.deepEqual(importsOf(serviceHost), ['advapi32.dll!StartServiceCtrlDispatcherW', 'advapi32.dll!RegisterServiceCtrlHandlerExW', 'advapi32.dll!SetServiceStatus']);
  for (const forbidden of [/OpenSCManager/u, /CreateService/u, /ChangeServiceConfig/u, /ControlService/u, /DeleteService/u, /\bStartService[AW]?\(/u, /OpenService/u, /QueryServiceStatus/u, /System\.ServiceProcess/u, /Microsoft\.Extensions\.Hosting/u]) {
    assert.equal(forbidden.test(brokerCode), false, `the Broker must not match ${forbidden}`);
  }
  assert.match(serviceHost, /ServiceWin32OwnProcess = 0x10/u, 'own-process service');
});

test('service host accepts STOP only, reports RUNNING only once the pipe exists, and bounds the stop path', () => {
  assert.match(serviceHost, /AcceptStop = 0x1;/u);
  assert.match(serviceHost, /ControlsAccepted = state == Running \? AcceptStop : 0,/u, 'STOP is the only accepted control');
  assert.deepEqual([...serviceHost.matchAll(/case (Control\w+)/gu)].map((m) => m[1]), ['ControlStop', 'ControlInterrogate']);
  assert.equal([...serviceHost.matchAll(/Report\(Running\)/gu)].length, 1, 'RUNNING is reported from exactly one place');
  assert.match(serviceHost, /RunServiceLoopAsync\(config, stop, \(\) => Report\(Running\)\)/u, '... the loop\'s on-ready callback');
  // In the loop the callback runs after the first pipe exists and before the first wait for a client.
  const created = serviceLoop.indexOf('CreateBrokerPipe(config.PipeName');
  const announced = serviceLoop.indexOf('onReady();');
  const waited = serviceLoop.indexOf('WaitForConnectionAsync(stop)');
  assert.ok(created > 0 && created < announced && announced < waited, 'pipe created -> onReady -> wait for a client');
  assert.match(serviceLoop, /if \(pipe is null\) return failure;/u, 'a pipe that cannot be (re)created ends the service with its fixed code');
  // Bounded stop: the idle wait and the frame read honour the stop token, a stalled client has a deadline, the host waits a fixed grace.
  assert.match(serviceLoop, /CreateLinkedTokenSource\(stop\)/u);
  assert.match(serviceLoop, /deadline\.CancelAfter\(ConnectionDeadline\)/u);
  assert.match(serviceLoop, /HandleConnectionAsync\(pipe, settings, deadline\.Token\)/u);
  assert.match(serviceHost, /loop\.Wait\(StopGrace\)/u);
  assert.equal(/\.Wait\(\)|Timeout\.Infinite|Task\.Delay\(/u.test(stripComments(serviceHost + serviceLoop)), false, 'no unbounded wait in the service host or loop');
  assert.match(serviceHost, /if \(stoppedReported \|\| \(state == Running && stopping\)\) return;/u, 'nothing after STOPPED, and RUNNING never overtakes STOP');
});

test('service loop creates the first-instance pipe once and reuses that instance, and `serve` still serves exactly one request', () => {
  assert.equal([...brokerCode.matchAll(/NamedPipeServerStreamAcl\.Create\(/gu)].length, 1, 'one pipe construction site for serve and service: same owner, same DACL, max 1 instance');
  // Changed from "a new pipe per request" (hardening finding 2): disposing and re-creating between two requests left a gap in which any local user
  // could take the name, and the Broker then stopped with 70. The instance is now kept; this pin is stricter about the name, not weaker.
  const loop = serviceLoop.slice(serviceLoop.indexOf('internal static async Task<int> RunServiceLoopAsync('), serviceLoop.indexOf('private static async Task WaitForClientToReadAsync('));
  assert.equal([...loop.matchAll(/CreateBrokerPipe\(/gu)].length, 1, 'the loop creates the pipe exactly once');
  assert.ok(loop.indexOf('CreateBrokerPipe(') < loop.indexOf('while (!stop.IsCancellationRequested)'), '... before the loop, not inside it');
  assert.equal(/\.Dispose\(\)/u.test(loop), false, 'no dispose of the pipe inside the loop (the `await using` at the end is the only release)');
  assert.match(loop, /await pipe\.WaitForConnectionAsync\(stop\);[\s\S]*DisconnectForNextClient\(pipe\);/u, 'serve a client, then Disconnect and wait again on the same instance');
  assert.match(serviceLoop, /try \{ pipe\.Disconnect\(\); \}\s+catch \(InvalidOperationException\)\s+\{\s+if \(!DisconnectNamedPipe\(pipe\.SafePipeHandle\)\) throw/u, 'the instance is reset even when .NET thinks it is not connected');
  assert.match(serviceLoop, /pipe\.WaitForPipeDrain/u, 'Disconnect throws unread data away: wait (bounded) for the client to read first');
  const serve = program.slice(program.indexOf('private static async Task<int> ServeAsync('), program.indexOf('private sealed record BrokerSettings'));
  assert.match(serve, /await pipe\.WaitForConnectionAsync\(\)\.WaitAsync\(TimeSpan\.FromSeconds\(20\)\);\s+await HandleConnectionAsync\(pipe, settings, CancellationToken\.None\);\s+return 0;/u);
  assert.equal(/\bwhile\b|\bfor\b/u.test(serve), false, '`serve` has no loop');
  assert.match(program, /args\.Length == 7 && args\[0\] == "serve"/u);
});

test('service exit codes are fixed and the dispatcher is called before the config is read', () => {
  assert.deepEqual([...program.matchAll(/const int (Exit\w+) = (\d+);/gu)].map((m) => `${m[1]}=${m[2]}`), [
    'ExitPipeUnavailable=70', 'ExitImpersonationRevertFailed=71', 'ExitPipeOwnerUnavailable=72',
    'ExitServiceConfigInvalid=73', 'ExitNotStartedByScm=74', 'ExitServiceLoopFailed=75',
  ]);
  assert.equal(/TryLoad\(/u.test(program), false, 'Main never reads the service config itself');
  assert.match(program, /args\.Length == 2 && args\[0\] == "service"\) return ServiceHost\.Run\(args\[1\]\);/u);
  const run = serviceHost.slice(serviceHost.indexOf('public static int Run('), serviceHost.indexOf('private static void ServiceMain('));
  assert.equal(/TryLoad\(|Directory|File\.|SqliteConnection|NamedPipe/u.test(run), false, 'outside the SCM nothing is read, opened or created before the dispatcher fails');
  assert.equal([...serviceHost.matchAll(/TryLoad\(/gu)].length, 1, 'the config is read in ServiceMain only');
  assert.match(run, /StartServiceCtrlDispatcherW\(table\)\) return exitCode;/u);
  assert.match(serviceHost, /Report\(Stopped, code == 0 \? 0 : ErrorServiceSpecificError, \(uint\)code\)/u, 'fatal: STOPPED with the fixed code as the service-specific exit code');
  // The revert-failure kill reports STOPPED(71) from a fresh thread (this one may still carry the client token) before TerminateProcess.
  assert.ok(program.indexOf('NotifyServiceTermination(ExitImpersonationRevertFailed)') < program.indexOf('_ = TerminateProcess('));
  assert.match(serviceLoop, /Thread reporter = new\(/u);
});

test('VM lab tooling runs the real Broker as the service and checks two requests, STOP and the fatal exit codes (script not executed here)', () => {
  const guest = read('test', 'windows-service-lab', 'lab-guest.ps1');
  const inputs = read('scripts', 'windows-service-lab-inputs.mjs');
  assert.equal(/[^\t\n -~]/u.test(guest), false, 'lab-guest.ps1 stays ASCII only (Windows PowerShell 5.1 reads it)');
  assert.match(guest, /\$BinPathBroker = "\$BrokerExe service \$BrokerConfig"/u);
  assert.match(guest, /\$bin = if \(\$n -eq \$B\) \{ \$BinPathBroker \} else/u, 'the Broker service object is created with the real Broker as its binPath');
  assert.match(guest, /Start-LabBroker[\s\S]*?\(Get-Svc \$B\)\.State -eq 'Running'/u, 'READY is the service reaching RUNNING');
  const ids = [...guest.matchAll(/^Step '([^']+)'/gmu)].map((m) => m[1]);
  assert.ok(ids.includes('g_two_requests_one_service_then_stop') && ids.includes('g_fatal_exit_codes'), ids.join(','));
  const two = guest.slice(guest.indexOf("Step 'g_two_requests_one_service_then_stop'"), guest.indexOf("Step 'g_fatal_exit_codes'"));
  assert.match(two, /Invoke-HelperAs \$C 'helper-g1' \$R4A/u);
  assert.match(two, /Invoke-HelperAs \$C 'helper-g2' \$R4B/u);
  assert.match(two, /& sc\.exe stop \$B/u, 'SERVICE_CONTROL_STOP');
  assert.match(two, /\$after\.ExitCode -eq 0\) -and \(\$after\.ServiceSpecificExitCode -eq 0\)/u, 'a clean stop');
  assert.match(two, /\$svc3\.ProcessId -eq \$pidG/u, 'the service PID is unchanged across requests');
  assert.match(guest, /\$squat\.ServiceSpecificExitCode -eq 70\) -and \(\$bad\.ExitCode -eq 1066\) -and \(\$bad\.ServiceSpecificExitCode -eq 73/u);
  assert.match(inputs, /r4a', 'r4b'/u);
  assert.equal([...inputs.matchAll(/generateKeyPairSync\(/gu)].length, 1, 'r4a and r4b are signed by one authority key');
});

test('service config accepts exactly five keys, validates every value and never echoes file content', () => {
  assert.match(serviceConfig, /Keys = \["pipeName", "database", "publicKey", "controlPlaneSid", "generation"\];/u);
  assert.match(serviceConfig, /seen\.SetEquals\(Keys\)/u, 'no unknown and no missing key');
  assert.match(serviceConfig, /!seen\.Add\(property\.Name\)/u, 'a repeated key is refused');
  assert.match(serviceConfig, /Program\.TryParseSid\(sid\) is null\) return null;/u, 'the Control Plane SID passes the same single-principal rule as `serve`');
  assert.match(serviceConfig, /MaxDepth = 2/u);
  assert.match(serviceConfig, /MaxFileBytes = 4096/u);
  assert.match(serviceConfig, /Path\.GetFullPath\(path\), path, StringComparison\.Ordinal/u, 'only a path that is already in its canonical absolute form');
  assert.match(serviceConfig, /ImportSubjectPublicKeyInfo\(key, out int used\);\s+return used == key\.Length/u);
  const reasonClass = serviceConfig.slice(serviceConfig.indexOf('internal static class Reason'), serviceConfig.indexOf('public static ServiceConfig? TryLoad'));
  assert.deepEqual([...reasonClass.matchAll(/ = "([a-z_]+)"/gu)].map((m) => m[1]).sort(),
    ['config_keys', 'config_path', 'config_syntax', 'config_too_large', 'config_unreadable', 'config_untrusted', 'control_plane_sid', 'database', 'database_directory', 'database_pin', 'database_untrusted', 'generation', 'pipe_name', 'public_key']);
  // The only interpolated console lines are a reason word, a Win32 error number or a fixed stage word (restricted-client), never a config value.
  const interpolated = [...brokerCode.matchAll(/Console\.WriteLine\((\$"[^"]*")\);/gu)].map((m) => m[1]);
  assert.deepEqual(interpolated, ['$"RESTRICTED_TOKEN_SETUP=BLOCKED_{stage}"', '$"SERVICE_DISPATCHER_ERROR={error}"', '$"SERVICE_CONFIG=invalid:{reason}"', '$"SERVICE_CONFIG=invalid:{reason}"']);
});

// Hardening after the CISO review of the service host (decision-log row 2026-10-30+broker-service-hardening). Source guards; behaviour is in
// runtime-windows-broker-service-hardening.test.mjs.
test('service path guard: BCL only, read-only, and TryLoad / TryParse refuse an untrusted config file or database folder with exit 73', () => {
  assert.deepEqual(importsOf(servicePathGuard), [], 'no P/Invoke: the owner and the DACL come from the BCL');
  for (const forbidden of [/SetAccessControl/u, /SetOwner/u, /SetAccessRule/u, /AddAccessRule/u, /ModifyAccessRule/u, /Directory\.(CreateDirectory|Delete)/u, /File\.(Delete|Create|Move)/u, /CreateSymbolicLink/u]) {
    assert.equal(forbidden.test(stripComments(servicePathGuard)), false, `the guard must not match ${forbidden}`);
  }
  // Exactly the write-ish rights, by number: write-data, append-data (add file / add subdirectory), delete-child, delete, write-DAC, write-owner, generic write / all.
  assert.match(servicePathGuard, /WriteData = 0x2, AppendData = 0x4, DeleteChild = 0x40, Delete = 0x10000, WriteDac = 0x40000, WriteOwner = 0x80000,\s+GenericAll = 0x10000000, GenericWrite = 0x40000000;/u);
  assert.match(servicePathGuard, /WriteRights = WriteData \| AppendData \| DeleteChild \| Delete \| WriteDac \| WriteOwner \| GenericAll \| GenericWrite;/u);
  assert.match(servicePathGuard, /new\("S-1-5-18"\), Administrators = new\("S-1-5-32-544"\), CreatorOwner = new\("S-1-3-0"\)/u, 'trusted: SYSTEM, Administrators, CREATOR OWNER (and the running SID)');
  assert.match(servicePathGuard, /sid\.Equals\(self\) \|\| sid\.Equals\(LocalSystem\) \|\| sid\.Equals\(Administrators\) \|\| sid\.Equals\(CreatorOwner\);/u);
  assert.match(servicePathGuard, /identity\.User is not \{ \} self\) return false;/u, 'the running SID is the process token user; no separate test rule');
  assert.match(servicePathGuard, /descriptor\.DiscretionaryAcl is not \{ \} dacl\) return false;/u, 'a NULL DACL is untrusted');
  assert.match(servicePathGuard, /\(known\.AccessMask & WriteRights\) != 0 && !IsTrustedPrincipal\(known\.SecurityIdentifier, self\)\) return false;/u);
  assert.match(servicePathGuard, /if \(ace is not KnownAce known\) return false;/u, 'an allow ACE the guard cannot read is refused');
  assert.equal(/InheritOnly|InheritanceFlags|PropagationFlags/u.test(stripComments(servicePathGuard)), false, 'inherit-only ACEs are NOT skipped: they decide who owns the next file');
  assert.match(servicePathGuard, /for \(string\? current = path; current is not null; current = Path\.GetDirectoryName\(current\)\)\s+if \(\(File\.GetAttributes\(current\) & FileAttributes\.ReparsePoint\) != 0\) return true;/u, 'the path and every parent');
  assert.match(servicePathGuard, /catch \(Exception ex\) when \(ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or NotSupportedException\) \{ return false; \}/u, 'fail closed');
  assert.deepEqual([...servicePathGuard.matchAll(/JournalSuffixes = \[([^\]]*)\]/gu)].map((m) => m[1]), ['"", "-wal", "-shm", "-journal"']);
  // Wiring: the config is checked on the open handle (FileShare.Read), before its length or content is used; the database folder right after it exists.
  const load = serviceConfig.slice(serviceConfig.indexOf('public static ServiceConfig? TryLoad'), serviceConfig.indexOf('internal static ServiceConfig? TryParse'));
  assert.ok(load.indexOf('FileShare.Read') < load.indexOf('IsTrustedConfigFile(configPath, file)') && load.indexOf('IsTrustedConfigFile(configPath, file)') < load.indexOf('file.Length'));
  assert.match(load, /reason = Reason\.ConfigUntrusted; return null;/u);
  assert.match(serviceConfig, /Directory\.Exists\(Path\.GetDirectoryName\(database\)\)\) return null;\s+reason = Reason\.DatabaseUntrusted;\s+if \(!ServicePathGuard\.IsTrustedDatabaseLocation\(database\)\) return null;/u);
});

test('Control Plane SID: S-1-5-80 needs exactly five sub-authorities after 80, an S-1-5-21 SID must resolve to a user, a failed lookup is a refusal', () => {
  const parse = program.slice(program.indexOf('internal static SecurityIdentifier? TryParseSid('), program.indexOf('// Impersonate, read the peer SID'));
  assert.match(parse, /value\.StartsWith\("S-1-5-80-", StringComparison\.Ordinal\) && parts\.Length == 9 && sid\.BinaryLength == 32/u, 'S-1-5-80-0 (ALL SERVICES) and every other shape fail');
  assert.match(parse, /value\.StartsWith\("S-1-5-21-", StringComparison\.Ordinal\) && parts\.Length == 8 && sid\.IsAccountSid\(\) && IsUserSid\(sid\)/u);
  assert.match(parse, /private const int SidTypeUser = 1;/u);
  assert.match(parse, /LookupAccountSidW\(null, binary, [^;]*\) && use == SidTypeUser;/u, 'false from the lookup (unknown SID, unreachable domain) is false here');
  assert.equal(/sid\.IsAccountSid\(\) \? sid : null/u.test(program), false, 'IsAccountSid alone (true for any S-1-5-21 group) no longer decides');
});

test('reply to a committed claim is written under its own budget, below the stop grace, and a wrongly typed receipt number is a denial', () => {
  assert.match(program, /ReplyWriteTimeout = TimeSpan\.FromSeconds\(2\);/u);
  assert.match(program, /using CancellationTokenSource replyBudget = new\(ReplyWriteTimeout\);\s+await WriteFrameAsync\(pipe, response, replyBudget\.Token\);/u, 'not ioToken: STOP and the 15 s deadline cannot cancel the answer');
  const handle = program.slice(program.indexOf('private static async Task HandleConnectionAsync('), program.indexOf('private static int PipeOwnerUnavailable'));
  assert.equal(/WriteFrameAsync\([^)]*ioToken/u.test(handle), false);
  const seconds = (source, name) => Number(new RegExp(`${name} = TimeSpan\\.FromSeconds\\((\\d+)\\)`, 'u').exec(source)?.[1]);
  assert.ok(seconds(program, 'ReplyWriteTimeout') + seconds(serviceLoop, 'ReplyDrainGrace') < seconds(serviceHost, 'StopGrace'), 'reply write + drain stay inside the stop grace');
  // GetInt64 on a string / object / null throws InvalidOperationException, which nothing catches: only RequiredInt64 may read a number.
  assert.deepEqual([...brokerCode.matchAll(/\.(GetInt64|GetInt32|GetDouble)\(\)/gu)].map((m) => m[0]), [], 'no direct number getter');
  assert.match(program, /is \{ ValueKind: JsonValueKind\.Number \} number && number\.TryGetInt64\(out long value\) \? value : throw new JsonException\(\);/u);
  assert.deepEqual([...program.matchAll(/RequiredInt64\(r, "(\w+)"\)/gu)].map((m) => m[1]), ['leaseGeneration', 'expiresAt']);
});

// Accept condition C3 (decision-log row 2026-10-30+adr002-broker-accept-conditions). Source guards; behaviour is in runtime-windows-broker-service-hardening.test.mjs.
test('database folder pin: one kernel32 import, no FILE_SHARE_DELETE, taken before the pipe exists and held until the serve loop ends', () => {
  assert.deepEqual(importsOf(databaseFolderPin), ['kernel32.dll!CreateFileW']);
  const pin = stripComments(databaseFolderPin);
  assert.match(pin, /CreateFileW\(folder, FileListDirectory, FileShareRead/u, 'a data right (FILE_LIST_DIRECTORY): a handle with attribute rights only is ignored by the share-mode check and would pin nothing');
  assert.match(pin, /FileListDirectory = 0x1, FileShareRead = 0x1, FileShareWrite = 0x2,/u);
  assert.match(pin, /FileShareRead \| FileShareWrite, IntPtr\.Zero, OpenExisting,/u, 'the share mode is read + write only');
  assert.equal(/FileShareDelete|FILE_SHARE_DELETE/iu.test(pin), false, 'FILE_SHARE_DELETE is never named; the share mask is exactly read + write');
  assert.match(pin, /FileFlagBackupSemantics \| FileFlagOpenReparsePoint/u, 'a directory is opened, and a junction is opened as itself');
  assert.match(pin, /ServicePathGuard\.IsTrustedDatabaseLocation\(database\)/u, 'the guard is run again on the pinned folder');
  const pinned = serviceLoop.indexOf('using SafeFileHandle? databaseFolder = DatabaseFolderPin.TryPin(config.Database);');
  assert.ok(pinned > 0, '`using` ties the handle to the loop');
  assert.ok(pinned < serviceLoop.indexOf('CreateBrokerPipe(config.PipeName'), 'pinned before the pipe is created, so RUNNING is never reported without the pin');
  assert.match(serviceLoop, /ServiceConfig\.Reason\.DatabasePin\);\s+return ExitServiceConfigInvalid;/u, 'no pin, no service (73)');
});
