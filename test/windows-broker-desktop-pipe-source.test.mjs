import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for the Broker's desktop pipe (DesktopPipe.cs, DesktopProtocol.cs; DesktopLeases.cs; ADR-002 "Amendment 2026-11-03", "Desktop pipe" and "Desktop lease"): view and act sessions. They run on every OS and need
// no .NET SDK. The behaviour is in runtime-windows-broker-desktop-pipe.test.mjs. Code only: comments may name what is NOT done.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFileSync(path.join(root, 'src', 'runtime', 'windows-broker', name), 'utf8').replace(/\r\n/gu, '\n');
const stripComments = (source) => source.replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '');
const rawPipe = read('DesktopPipe.cs');
const pipe = stripComments(rawPipe);
const protocol = stripComments(read('DesktopProtocol.cs'));
const program = stripComments(read('Program.cs'));
const loop = stripComments(read('ServiceLoop.cs'));
const config = stripComments(read('ServiceConfig.cs'));
const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const inOrder = (source, ...marks) => marks.every((mark, i) => source.includes(mark) && (i === 0 || source.indexOf(mark) > source.indexOf(marks[i - 1])));

test('the desktop pipe exists only for a config with computers, under the claim pipe\'s name plus a fixed suffix', () => {
  assert.match(config, /internal static string DesktopPipeName\(string pipeName\) => pipeName \+ "_desktop";/u);
  assert.match(config, /computers\.Count > 0 && DesktopPipeName\(pipeName\)\.Length > MaxPipeNameLength\) return null;/u, 'and the name stays a plain pipe name');
  const create = between(pipe, 'internal static DesktopPipeHost? Create(', 'internal void Start(');
  assert.ok(inOrder(create, 'if (config.Computers.Count == 0) return host;', 'CreateBrokerPipe('), 'no computers: no instance is created');
  assert.match(create, /ServiceConfig\.DesktopPipeName\(config\.PipeName\)/u);
});

test('up to 16 instances, made like the claim pipe (same owner, DACL, remote-client rejection), the first with the first-instance flag, none ever released while serving', () => {
  assert.match(pipe, /private const uint MaxInstances = 16;/u);
  const create = between(pipe, 'internal static DesktopPipeHost? Create(', 'internal void Start(');
  assert.match(create, /CreateBrokerPipe\([^;]*out failure, MaxInstances, firstInstance: i == 0\);/u, 'the first instance claims the name, the others join it');
  assert.match(create, /for \(uint i = 0; i < MaxInstances; i\+\+\)/u);
  assert.equal(/LocalPipe\.|NamedPipeServerStream(?:Acl)?\.Create|new NamedPipeServerStream\(|PipeSecurity|AddAccessRule|SetOwner|SetAccessControl|PipeAccessRights/u.test(pipe + protocol), false, 'no pipe, DACL or owner code of its own: everything goes through CreateBrokerPipe');
  assert.match(program, /LocalPipe\.Create\(pipeName, OwnedBySelf\(out SecurityIdentifier self, allowedSid\), maxInstances, firstInstance\)/u, 'CreateBrokerPipe is still the only construction site');
  assert.match(program, /CreateBrokerPipe\(string pipeName, string allowedSid, out int failure, uint maxInstances = 1, bool firstInstance = true\)/u, '... and the claim pipe keeps the defaults');
  assert.match(loop, /CreateBrokerPipe\(config\.PipeName, config\.ControlPlaneSid, out int failure\);/u, 'the claim pipe is created exactly as before');
  const slot = between(pipe, 'private async Task RunSlotAsync(', 'private async Task ServeSessionAsync(');
  assert.equal(/Dispose\(/u.test(slot), false, 'a slot resets its instance (Disconnect) and never disposes it: the name is never free for a squatter');
  assert.deepEqual([...pipe.matchAll(/\bpipe\.Dispose\(\)/gu)].length, 1, 'instances are disposed in one place only (DisposeInstances: STOP, or a failed start)');
  assert.match(slot, /DisconnectForNextClient\(pipe\);/u);
});

test('every connection\'s peer is checked after the first frame\'s length bytes and before anything of the request is read or parsed; a peer that is not the Control Plane, or cannot be read, is refused', () => {
  const read_ = between(pipe, 'private async Task<(byte[]? Frame, string? Refusal)> ReadRequestAsync(', 'private bool IsControlPlane(');
  assert.ok(inOrder(read_, 'ReadExactlyAsync(size, idle.Token)', 'if (first && !IsControlPlane(pipe)) return (null, DesktopDeny.Peer);', 'BitConverter.ToInt32(size)', 'new byte[length]', 'ReadExactlyAsync(frame, idle.Token)'));
  const check = between(pipe, 'private bool IsControlPlane(', 'private async Task<string?> CaptureAndReplyAsync(');
  assert.match(check, /string\.Equals\(ReadPeerSid\(pipe, ImpersonationFault\.None\), _config\.ControlPlaneSid, StringComparison\.Ordinal\)/u, 'the user SID of the thread token, compared as an exact string');
  assert.match(check, /catch \(UnauthorizedAccessException\) \{ isControlPlane = false; \}/u, 'fail closed');
  const session = between(pipe, 'private async Task<string?> RunSessionAsync(', 'private async Task<(byte[]? Frame');
  assert.ok(inOrder(session, 'ReadRequestAsync(pipe, first: !opened, lease?.Token ?? CancellationToken.None, stop)', 'TryParseOpen(frame', 'Leases.TryOpen(', 'WriteAsync(pipe, DesktopOk, stop)', 'TryParseRequest(frame'), 'frame -> open -> lease -> accepted -> request');
});

test('bounds: 16 KiB request, 60 s idle in the shipped build, 200 ms between captures of one session, one capture in the whole Broker, a pixel cap, the 8 MiB reply cap', () => {
  assert.match(protocol, /MaxRequestBytes = 16 \* 1024;/u);
  assert.match(pipe, /if \(length is < 1 or > MaxRequestBytes\) return \(null, DesktopDeny\.FrameSize\);/u);
  assert.match(pipe, /idle\.CancelAfter\(DesktopIdleTimeout\);/u);
  // Outside the test-only block the idle time is the contract's 60 s; the knob that shortens it is inside #if ALBERA_BROKER_TEST_FAULTS only.
  assert.match(rawPipe.slice(rawPipe.indexOf('#else'), rawPipe.indexOf('#endif')), /DesktopIdleTimeout = TimeSpan\.FromSeconds\(60\);/u);
  assert.equal(/ALBERA_BROKER_TEST_DESKTOP/u.test(rawPipe.replace(/#if ALBERA_BROKER_TEST_FAULTS[\s\S]*?#endif/gu, '')), false, 'the time knobs are not in the shipped build');
  assert.match(pipe, /MinCaptureInterval = TimeSpan\.FromMilliseconds\(200\)/u);
  assert.match(pipe, /SemaphoreSlim CaptureSlot = new\(1, 1\);/u);
  const capture = between(pipe, 'private async Task<string?> CaptureAndReplyAsync(', 'private async Task<DesktopResult> CaptureInSlotAsync(');
  assert.ok(inOrder(capture, 'throttle.WaitBeforeNext()', 'CaptureSlot.WaitAsync(CaptureQueueTimeout, stop)', 'throttle.Started();', 'CaptureInSlotAsync('), 'wait out the 200 ms, take the one slot, start');
  assert.match(capture, /finally \{ CaptureSlot\.Release\(\); \}/u, 'the slot is always given back');
  assert.ok(inOrder(capture, 'png.Length > DesktopLimits.MaxPngBytes', 'WriteAsync(pipe, Encoding.UTF8.GetBytes($"{{\\"ok\\":true'), 'a PNG beyond 8 MiB is refused before anything is written');
  assert.match(protocol, /MaxCapturePixels = 1920 \* 1080;/u);
  assert.match(protocol, /if \(!DesktopLimits\.IsCaptureSize\(width, height\) \|\| \(long\)width \* height > MaxCapturePixels\) return DesktopDeny\.CaptureSize;/u, 'the contract bounds and the pixel cap, before the slot is asked for');
  const throttle = rawPipe.slice(rawPipe.indexOf('internal sealed class CaptureThrottle'));
  assert.match(throttle, /elapsed >= minInterval \? TimeSpan\.Zero : minInterval - elapsed;/u);
});

test('modes: only view and act; an act open carries exactly an operationId and a leaseGeneration >= 1 and is checked against the Broker\'s lease; input is for act sessions only', () => {
  const open = between(protocol, 'internal static string? TryParseOpen(', 'private static bool TryActFields(');
  assert.match(open, /mode is not \("view" or "act"\)\) return DesktopDeny\.OpenShape;/u, 'no third mode');
  assert.match(open, /if \(fields\.Count != \(act \? 4 : 2\)\) return DesktopDeny\.OpenShape;/u, 'view: computerId + mode; act: those + operationId + leaseGeneration, and nothing else');
  assert.ok(inOrder(open, 'TryActFields(', 'DesktopDeny.ComputerUnknown'), 'the lease fields are shaped before the computer is looked up');
  const act = between(protocol, 'private static bool TryActFields(', 'internal static string? TryParseRequest(');
  assert.match(act, /AuthorityKey\.IsKeyId\(id\)/u);
  assert.match(act, /!Integer\(generationElement, out generation\) \|\| generation < 1\) return false;/u);
  assert.match(protocol, /return act \? TryParseInput\(input, out request\) : DesktopDeny\.ViewInput;/u, 'a view session never parses input');
  const session = between(pipe, 'private async Task<string?> RunSessionAsync(', 'private async Task<(byte[]? Frame');
  assert.match(session, /if \(open\.IsAct && \(lease = Leases\.TryOpen\(computerId, open\.OperationId!, open\.LeaseGeneration, out string leaseRefusal\)\) is null\) return leaseRefusal;/u);
  assert.match(session, /TryParseRequest\(frame, lease is not null, out DesktopRequest\? request\)/u, 'input is parsed only when the session holds a lease');
  assert.match(session, /request!\.IsInput\s*\? await InputAndReplyAsync\(pipe, lease!, computerId, request\.Steps!, stop\)/u);
  assert.match(session, /finally \{ lease\?\.Dispose\(\); \}/u, 'the session\'s hold on the lease ends with it');
  assert.match(session, /if \(lease is \{ Token\.IsCancellationRequested: true \}\) return lease\.Refusal\(\) \?\? DesktopLeases\.Deny\.Revoked;/u, 'a lease that ended closes the session with a refusal, not as an idle close');
  assert.deepEqual([...pipe.matchAll(/_desktop\.(\w+)\(/gu)].map((m) => m[1]), ['Capture', 'Input']);
});

test('input: one request at a time per computer, the wait for the turn ends with the lease, the lease asked again once the request holds its turn, a running request stops when the lease ends, and a request that never returns stops the Broker', () => {
  const input = between(pipe, 'private async Task<string?> InputAndReplyAsync(', 'private async Task<DesktopResult> InputInTurnAsync(');
  assert.ok(inOrder(input, 'CreateLinkedTokenSource(stop, lease.Token)', 'turn.WaitAsync(InputQueueTimeout, waiting.Token)', 'lease.Refusal()', 'InputInTurnAsync(computerId, steps, lease.Token)', 'finally { turn.Release(); }', 'WriteAsync(pipe, DesktopOk, stop)'),
    'wait for the turn (it ends with the lease) -> lease -> send, with the lease\'s token -> give the turn back -> only then answer');
  assert.match(input, /catch \(OperationCanceledException\) when \(!stop\.IsCancellationRequested\) \{ return lease\.Refusal\(\) \?\? DesktopLeases\.Deny\.Revoked; \}/u, 'a lease that ended while waiting is a refusal, a STOP is not');
  assert.match(input, /if \(result\.Reason == DesktopReason\.InputCancelled\) return lease\.Refusal\(\) \?\? DesktopLeases\.Deny\.Revoked;/u, 'a request the lease stopped half-way ends with the lease\'s own reason word');
  const inTurn = between(pipe, 'private async Task<DesktopResult> InputInTurnAsync(', 'private static async Task WriteAsync(');
  assert.match(inTurn, /Task\.Run\(\(\) => _desktop\.Input\(computerId, steps, leaseEnded\)\)/u, 'the adapter gets the lease\'s token and looks at it before every step');
  assert.match(pipe, /_inputTurns = config\.Computers\.ToDictionary\(c => c\.ComputerId, _ => new SemaphoreSlim\(1, 1\), StringComparer\.Ordinal\);/u, 'a turn for each configured computer');
  assert.match(pipe, /InputHungTimeout = TimeSpan\.FromMinutes\(5\)/u);
  assert.match(pipe, /Task\.WhenAny\(input, hungTimer\) != input\)[\s\S]{0,400}DESKTOP=INPUT_HUNG[\s\S]{0,80}TerminateForDesktopFailure\(\);/u);
  // The watchdog's timer belongs to the request (Zaku LOW of #166): made with a token, and cancelled whichever way the request ends, so no 5-minute timer is left behind per input.
  assert.ok(inOrder(inTurn, 'Task hungTimer = Task.Delay(InputHungTimeout, timerStop.Token);', 'Task.WhenAny(input, hungTimer)', 'finally { timerStop.Cancel(); }', 'DesktopResult result = await input;'));
  assert.equal(/Task\.Delay\(InputHungTimeout\)/u.test(pipe), false, 'no watchdog timer without a token');
  assert.match(protocol, /if \(list\.GetArrayLength\(\) is < 1 or > DesktopLimits\.MaxSteps\) return DesktopDeny\.InputSteps;/u, 'the step count is checked before a step is read');
  assert.ok(inOrder(protocol, 'ReadStep(element)', 'DesktopLimits.AreValidSteps(steps)', 'new DesktopRequest(Steps: steps)'), 'every step is shaped, then the adapter\'s own limits decide, before anything is sent');
  assert.match(protocol, /StepFields = \["op", "x", "y", "button", "vk", "delta", "ms", "text"\];/u, 'the fields of the adapter\'s DesktopStep and no others');
});

test('the lease: made only by a task.start claim that was just recorded, held in memory, bounded by the config and by 60 minutes, and the test seams for it are not in the shipped build', () => {
  const leases = stripComments(read('DesktopLeases.cs'));
  assert.match(leases, /MaxLifetimeSeconds = 60 \* 60;/u);
  assert.equal(/File\.|Directory\.|Sqlite|Journal|Environment\.(?!TickCount64\b)|Registry|HttpClient|Socket|NamedPipe/u.test(leases), false, 'memory only: no file, journal, environment or pipe');
  assert.match(leases, /if \(_computers\.FirstOrDefault\(c => string\.Equals\(c\.ComputerId, computerId, StringComparison\.Ordinal\)\) is not \{ \} computer\) \{ refusal = NoGrant\.ComputerUnknown; return null; \}/u, 'a computer that is not configured gets no lease');
  assert.match(leases, /if \(claimedVmId is not null && !string\.Equals\(claimedVmId, computer\.VmId, StringComparison\.Ordinal\)\) \{ refusal = NoGrant\.VmMismatch; return null; \}/u, 'a claim that names a VM other than the configured one gets no lease (Zaku MEDIUM 3 of #166)');
  assert.ok(inOrder(leases, 'NoGrant.ComputerUnknown', 'NoGrant.VmMismatch', 'generation = (previous?.Generation ?? 0) + 1;'), 'both refusals come before anything is counted or replaced');
  assert.match(leases, /generation = \(previous\?\.Generation \?\? 0\) \+ 1;/u);
  assert.match(leases, /_byComputer\[computerId\] = new Lease\(computerId, operationId, generation, _nowMs\(\) \+ _lifetimeSeconds \* 1000\);/u, 'deadline = the monotonic clock at the claim + the lifetime');
  assert.ok(inOrder(leases, 'closing = previous?.Retire() ?? [];', '_byComputer[computerId] = new Lease(', 'foreach (LeaseSession session in closing) session.Close();'), 'the older lease\'s sessions are taken away with the replacement, then closed');
  assert.match(leases, /lifetimeSeconds is < 1 or > MaxLifetimeSeconds\) throw new ArgumentOutOfRangeException/u);
  // The only caller of Grant is the claim path, after the journal row is written and never for a replay (a replay returns before this point).
  const claims = stripComments(read('BrokerRequests.cs'));
  assert.equal([...[claims, pipe, protocol, program, loop].join('\n').matchAll(/\.Grant\(/gu)].length, 1, 'one caller of Grant in the whole Broker');
  assert.ok(inOrder(claims, 'if (replay)', 'return Success(context.RecordedState!, claimed, replayed: true);', 'Journal.ClaimAsync(', 'if (kind == Journal.ClaimKind.Rejected) return Deny(reason);', 'Console.WriteLine("CLAIM=PERSISTED_UNKNOWN");', 'GrantDesktopLease(settings, dto!, operationId);', 'return Success(Journal.UnknownState, claimed, replayed: false);'));
  assert.match(claims, /if \(encodedAction is not null\) GrantDesktopLease\(settings, dto!, operationId\);/u, 'only the three-key task.start form');
  const grant = between(claims, 'private static void GrantDesktopLease(', 'private static string? ChallengeRefusal(');
  assert.match(grant, /string\? claimedVmId = dto\["args"\] is IReadOnlyDictionary<string, object> args && args\.TryGetValue\(VmIdArgument, out object\? vm\) \? vm as string : null;/u, 'the VM the signed args name, if any');
  assert.match(grant, /leases\.Grant\(\(string\)dto\["computerId"\], operationId, claimedVmId, out string refusal\) is not null\) Console\.WriteLine\("LEASE=GRANTED"\);\s+else if \(refusal == DesktopLeases\.NoGrant\.VmMismatch\) Console\.WriteLine\("LEASE=VM_MISMATCH"\);/u, 'the computer from the claimed DTO, the operation from the receipt, the VM checked by the table; one fixed log word for a mismatch');
  assert.equal(/Console\.WriteLine\([^"]/u.test(grant), false, 'fixed words only');
  // The table belongs to the desktop host and reaches the claim path through the settings; the one-shot `serve` has none.
  assert.match(pipe, /Leases = new DesktopLeases\(config\.Computers, lifetimeSeconds: DesktopLeaseSeconds\);/u);
  assert.match(loop, /settings = started with \{ Leases = desktop\.Leases \};/u);
  assert.match(program, /long Epoch = 0, DesktopLeases\? Leases = null\);/u);
  // Shipped build: the lifetime is the contract's 60 minutes; the knob that shortens it exists only in the test build.
  assert.match(rawPipe.slice(rawPipe.indexOf('#else'), rawPipe.indexOf('#endif')), /DesktopLeaseSeconds = DesktopLeases\.MaxLifetimeSeconds;/u);
  assert.equal(/ALBERA_BROKER_TEST_DESKTOP_LEASE_SECONDS|ALBERA_BROKER_TEST_DESKTOP_INPUT_HOLD_MS|DesktopInputHold|input_enter/u.test(rawPipe.replace(/#if ALBERA_BROKER_TEST_FAULTS[\s\S]*?#endif/gu, '')), false);
  assert.deepEqual([...leases.matchAll(/"(lease_[a-z]+)"/gu)].map((m) => m[1]), ['lease_unknown', 'lease_generation', 'lease_expired', 'lease_revoked'], 'the reason words of the lease');
});

test('the lease\'s deadline is on a monotonic clock, never a wall-clock time: setting the clock back cannot stretch a lease (Zaku MEDIUM 1 of #166)', () => {
  const leases = stripComments(read('DesktopLeases.cs'));
  assert.match(leases, /_nowMs = nowMs \?\? \(\(\) => Environment\.TickCount64\);/u, 'the default clock is the process\'s monotonic tick count');
  assert.equal(/DateTime|UtcNow|DateTimeOffset|TimeProvider|NowSeconds|Stopwatch|GetSystemTime|ToUnixTime/u.test(leases), false, 'no wall-clock time anywhere in the lease table');
  assert.equal([...leases.matchAll(/_nowMs\(\)/gu)].length, 3, 'read in exactly three places: the deadline at the grant, the time left at an open, the check');
  assert.match(leases, /return _nowMs\(\) >= lease\.DeadlineMs \? Deny\.Expired : null;/u);
  assert.match(leases, /public string\? Refusal\(\) => _owner\.Check\(_lease\) \?\? \(Token\.IsCancellationRequested \? Deny\.Revoked : null\);/u, 'a session whose own token is cancelled refuses, whatever the table says');
  assert.equal(/NowSeconds|UtcNow|DateTime/u.test(pipe), false, 'the desktop pipe hands the table no clock');
});

test('only fixed text leaves the Broker: three reply shapes on the wire, and the log carries fixed words and reason words only', () => {
  const writes = [...pipe.matchAll(/WriteAsync\(pipe, ([^;]+?), stop\);/gu)].map((m) => m[1]);
  assert.deepEqual(writes, ['BrokerReply.Denied.Body', 'DesktopOk', 'Encoding.UTF8.GetBytes($"{{\\"ok\\":true,\\"width\\":{width},\\"height\\":{height},\\"bytes\\":{png.Length}}}")', 'png', 'DesktopOk'], 'denied; open accepted; capture header and picture; input sent');
  assert.match(pipe, /DesktopOk = Encoding\.UTF8\.GetBytes\("\{\\"ok\\":true\}"\);/u);
  const printed = [...pipe.replace(/#if ALBERA_BROKER_TEST_FAULTS[\s\S]*?#endif/gu, '').matchAll(/Console\.WriteLine\(([^;]+)\);/gu)].map((m) => m[1]);
  assert.deepEqual(printed.filter((arg) => !/^"[A-Z_=]+"$/u.test(arg)), ['"DESKTOP_DENY=" + reason', 'isControlPlane ? "DESKTOP_PEER=authenticated" : "DESKTOP_PEER=denied"'], 'every other line is a fixed literal');
  assert.equal(/\.Message\b|\.ToString\(|\.StackTrace|\.InnerException|ex\.Data\b/u.test(pipe + protocol), false, 'no exception text is read');
  assert.deepEqual([...protocol.matchAll(/(\w+) = "([a-z_]+)"/gu)].map((m) => m[2]),
    ['peer', 'frame_size', 'open_shape', 'computer_unknown', 'request_shape', 'view_input', 'capture_shape', 'capture_size', 'capture_busy', 'input_shape', 'input_steps', 'input_busy'],
    'the reason words of this layer (the adapter\'s own are pinned in windows-broker-hyperv-desktop-source.test.mjs, the lease\'s below)');
  const session = between(pipe, 'private async Task ServeSessionAsync(', 'private async Task<string?> RunSessionAsync(');
  assert.ok(inOrder(session, 'Console.WriteLine("DESKTOP_DENY=" + reason);', 'BrokerReply.Denied.Body'), 'a refusal is the logged reason, then the one fixed frame, then the connection is reset by the slot');
});

test('the service loop makes the desktop pipe with the claim pipe, before the epoch, and starts serving it just before READY; the one-shot `serve` has none', () => {
  assert.ok(inOrder(loop, 'CreateBrokerPipe(config.PipeName', 'DesktopPipeHost.Create(config, out int desktopFailure)', 'if (desktop is null) return desktopFailure;', 'BeginEpochOrRefuseAsync(settings)', 'desktop.Start(stop);', 'Console.WriteLine("BROKER_READY");', 'onReady();', 'WaitForConnectionAsync(stop)'));
  assert.match(loop, /await using DesktopPipeHost\? desktop = /u, 'released with the claim pipe, whichever way the loop ends');
  assert.equal(/Desktop/u.test(between(program, 'private static async Task<int> ServeAsync(', 'private static async Task<bool> RefuseUnusableJournalAsync(')), false, '`serve` is untouched');
});

test('a hung capture and a desktop instance that cannot be reset stop the Broker (fail closed, exit 80; Zaku review of #164)', () => {
  const pipe = read('DesktopPipe.cs');
  assert.match(pipe, /CaptureHungTimeout = TimeSpan\.FromSeconds\(15\)/u);
  assert.match(pipe, /Task\.WhenAny\(capture, Task\.Delay\(CaptureHungTimeout\)\) != capture\)[\s\S]{0,400}DESKTOP=CAPTURE_HUNG[\s\S]{0,80}TerminateForDesktopFailure\(\);/u);
  assert.match(pipe, /try \{ DisconnectForNextClient\(pipe\); \}[\s\S]{0,400}DESKTOP=SLOT_RESET_FAILED[\s\S]{0,80}TerminateForDesktopFailure\(\);/u);
  assert.match(pipe, /NotifyServiceTermination\(ExitDesktopFailed\);\s*_ = TerminateProcess\(GetCurrentProcess\(\), ExitDesktopFailed\);/u);
});
