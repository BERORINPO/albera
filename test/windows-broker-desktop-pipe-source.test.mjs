import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for the Broker's desktop pipe (DesktopPipe.cs, DesktopProtocol.cs; ADR-002 "Amendment 2026-11-03", "Desktop pipe"), `view` sessions only. They run on every OS and need
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
  assert.ok(inOrder(session, 'ReadRequestAsync(pipe, first: !opened, stop)', 'TryParseOpen(frame', 'DesktopOpened', 'TryParseCapture(frame'), 'frame -> open -> accepted -> capture');
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
  assert.match(protocol, /DesktopLimits\.IsCaptureSize\(width, height\) && \(long\)width \* height <= MaxCapturePixels \? null : DesktopDeny\.CaptureSize;/u, 'the contract bounds and the pixel cap, before the slot is asked for');
  const throttle = rawPipe.slice(rawPipe.indexOf('internal sealed class CaptureThrottle'));
  assert.match(throttle, /elapsed >= minInterval \? TimeSpan\.Zero : minInterval - elapsed;/u);
});

test('view only: an act open is always refused, input is never accepted or sent, and the adapter\'s only call is Capture', () => {
  const open = between(protocol, 'internal static string? TryParseOpen(', 'internal static string? TryParseCapture(');
  assert.ok(inOrder(open, 'if (mode == "act") return DesktopDeny.ActUnsupported;', 'if (mode != "view" || open.Count != 2) return DesktopDeny.OpenShape;'), 'act is refused before the rest of the shape is looked at; only "view" passes');
  assert.match(protocol, /if \(top\.ContainsKey\("input"\)\) return DesktopDeny\.ViewInput;/u);
  assert.deepEqual([...pipe.matchAll(/_desktop\.(\w+)\(/gu)].map((m) => m[1]), ['Capture']);
  assert.equal(/\bInput\(|DesktopStep|[Ll]easeId|[Ll]easeGeneration|\blease\b|\bLease\b/u.test(pipe + protocol), false, 'no input call, no step type, no lease');
});

test('only fixed text leaves the Broker: three reply shapes on the wire, and the log carries fixed words and reason words only', () => {
  const writes = [...pipe.matchAll(/WriteAsync\(pipe, ([^;]+?), stop\);/gu)].map((m) => m[1]);
  assert.deepEqual(writes, ['BrokerReply.Denied.Body', 'DesktopOpened', 'Encoding.UTF8.GetBytes($"{{\\"ok\\":true,\\"width\\":{width},\\"height\\":{height},\\"bytes\\":{png.Length}}}")', 'png']);
  assert.match(pipe, /DesktopOpened = Encoding\.UTF8\.GetBytes\("\{\\"ok\\":true\}"\);/u);
  const printed = [...pipe.replace(/#if ALBERA_BROKER_TEST_FAULTS[\s\S]*?#endif/gu, '').matchAll(/Console\.WriteLine\(([^;]+)\);/gu)].map((m) => m[1]);
  assert.deepEqual(printed.filter((arg) => !/^"[A-Z_=]+"$/u.test(arg)), ['"DESKTOP_DENY=" + reason', 'isControlPlane ? "DESKTOP_PEER=authenticated" : "DESKTOP_PEER=denied"'], 'every other line is a fixed literal');
  assert.equal(/\.Message\b|\.ToString\(|\.StackTrace|\.InnerException|ex\.Data\b/u.test(pipe + protocol), false, 'no exception text is read');
  assert.deepEqual([...protocol.matchAll(/(\w+) = "([a-z_]+)"/gu)].map((m) => m[2]),
    ['peer', 'frame_size', 'open_shape', 'act_unsupported', 'computer_unknown', 'request_shape', 'view_input', 'capture_shape', 'capture_size', 'capture_busy'], 'the reason words of this layer (the adapter\'s own are pinned in windows-broker-hyperv-desktop-source.test.mjs)');
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
