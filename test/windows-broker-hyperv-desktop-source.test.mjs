import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Source-level guards for the Broker's Hyper-V desktop adapter (ADR-002 "Amendment 2026-11-03", option C). They run on every OS and need no .NET SDK. Once the Broker's
// service SID is in Hyper-V Administrators, this code is the only thing between the Broker and the host, so the allowlist is pinned to the contract table here (any new
// class or method fails this test and needs the owner's contract change first). Comments may name what is NOT used, so the checks read code only.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const brokerDir = path.join(root, 'src', 'runtime', 'windows-broker');
const stripComments = (source) => source.replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/ .*$/gmu, '').replace(/\/\*.*?\*\//gu, '');
const sources = Object.fromEntries(readdirSync(brokerDir).filter((name) => name.endsWith('.cs')).map((name) => [name, stripComments(readFileSync(path.join(brokerDir, name), 'utf8'))]));
const desktop = sources['HyperVDesktop.cs'];
const png = sources['PngEncoder.cs'];
const others = Object.entries(sources).filter(([name]) => name !== 'HyperVDesktop.cs');
const allCode = Object.values(sources).join('\n');

// The contract table of "Amendment 2026-11-03", "Two-layer rights matrix" (docs/architecture/adr-002-host-broker-trust-contract.md).
const CONTRACT_ALLOWLIST = {
  Msvm_ComputerSystem: [],
  Msvm_VirtualSystemSettingData: [],
  Msvm_VirtualSystemManagementService: ['GetVirtualSystemThumbnailImage'],
  Msvm_Keyboard: ['PressKey', 'ReleaseKey', 'TypeKey', 'TypeText'],
  Msvm_SyntheticMouse: ['SetAbsolutePosition', 'SetButtonState', 'SetScrollPosition'],
};

test('the allowlist is one table, exactly the contract: five classes, the contract methods, one namespace', () => {
  const table = desktop.slice(desktop.indexOf('private static readonly Dictionary<string, string[]> Classes'), desktop.indexOf('internal static void RequireClass'));
  const rows = [...table.matchAll(/\["(\w+)"\] = \[([^\]]*)\],/gu)].map((m) => [m[1], [...m[2].matchAll(/"(\w+)"/gu)].map((x) => x[1])]);
  assert.deepEqual(Object.fromEntries(rows), CONTRACT_ALLOWLIST);
  assert.equal(rows.length, Object.keys(CONTRACT_ALLOWLIST).length, 'no class listed twice');
  assert.equal(table.match(/^\s+\["/gmu).length, rows.length, 'every entry of the table was read');
  assert.deepEqual([...desktop.matchAll(/Namespace = (@?"[^"]*")/gu)].map((m) => m[1]), ['@"root\\virtualization\\v2"']);
  assert.equal(allCode.match(/virtualization/gu).length, 1, 'the namespace is written once in the whole Broker');
  // No other class or method name of the Hyper-V provider appears anywhere in code (the table is the whole list).
  const classNames = [...new Set([...desktop.matchAll(/\bMsvm_\w+/gu)].map((m) => m[0]))].sort();
  assert.deepEqual(classNames, Object.keys(CONTRACT_ALLOWLIST).sort());
  assert.equal(Object.entries(sources).some(([name, code]) => name !== 'HyperVDesktop.cs' && /Msvm_/u.test(code)), false, 'no other file names a provider class');
});

test('every WMI call goes through the gate, which checks the table before it delegates', () => {
  const gate = desktop.slice(desktop.indexOf('internal sealed class WmiGate'), desktop.indexOf('internal sealed class HyperVDesktop'));
  assert.match(gate, /Find\(string className, string\? name\)\s*\{\s*DesktopAllowlist\.RequireClass\(className\);\s*return _connection\.Find\(className, name\);/u);
  assert.match(gate, /DesktopAllowlist\.RequireClass\(source\.ClassName\);\s*DesktopAllowlist\.RequireClass\(resultClass\);\s*return source\.Associated\(/u);
  assert.match(gate, /DesktopAllowlist\.RequireMethod\(target\.ClassName, method\);\s*return target\.Invoke\(/u);
  assert.match(gate, /connection\.Namespace, DesktopAllowlist\.Namespace, StringComparison\.Ordinal\)\) throw new DesktopRefusal\(DesktopReason\.Allowlist\)/u);
  // The adapter itself reaches WMI through the gate only: the three seam calls appear in the gate and nowhere else outside the COM classes.
  const adapter = desktop.slice(desktop.indexOf('internal sealed class HyperVDesktop'), desktop.indexOf('internal sealed class ComWmiConnection'));
  assert.equal(/\.(Find|Associated|Invoke)\(/u.test(adapter.replace(/\bgate\.(Find|Associated|Call)\(/gu, '')), false, 'the adapter calls gate.* only');
  assert.equal(/_connect\(\)/u.test(adapter), true);
  // The real implementation checks the table too, so it is safe even if something calls it without the gate.
  const com = desktop.slice(desktop.indexOf('internal sealed class ComWmiConnection'));
  assert.match(com, /Find\(string className, string\? name\)\s*\{\s*DesktopAllowlist\.RequireClass\(className\);/u);
  assert.match(com, /Associated\(string resultClass[^)]*\)\s*\{\s*DesktopAllowlist\.RequireClass\(resultClass\);/u);
  assert.match(com, /Invoke\(string method[^)]*\)\s*\{\s*DesktopAllowlist\.RequireMethod\(ClassName, method\);/u);
});

test('WMI is reached in-process through COM late binding in exactly one place; no script host, child process, System.Management or System.Drawing anywhere in the Broker', () => {
  for (const [call, count] of [['ExecQuery', 1], ['ExecMethod_', 1], ['Associators_', 1], ['ConnectServer', 1]]) {
    assert.equal(desktop.split(call).length - 1, count, `${call} is called once`);
    assert.equal(others.some(([, code]) => code.includes(call)), false, `${call} only in HyperVDesktop.cs`);
  }
  const com = desktop.slice(desktop.indexOf('internal sealed class ComWmiConnection'));
  for (const call of ['ExecQuery', 'ExecMethod_', 'Associators_', 'ConnectServer']) assert.equal(com.includes(call), true, `${call} sits inside the COM classes`);
  assert.deepEqual([...allCode.matchAll(/GetTypeFromProgID\("([^"]+)"\)/gu)].map((m) => m[1]), ['WbemScripting.SWbemLocator']);
  assert.match(desktop, /late\.ConnectServer\("\.", DesktopAllowlist\.Namespace\)/u, 'the local machine, the one allowlisted namespace');
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /System\.Management/u, /System\.Drawing/u, /powershell/iu, /\bpwsh\b/iu, /\bwmic(?:\.exe)?\b/iu, /Win32_Process/u, /DllImport/u, /LibraryImport/u, /Assembly\.Load/u, /Invoke-Cim|Get-Cim|Get-VM/u]) {
    assert.equal(forbidden.test(desktop), false, `HyperVDesktop.cs must not match ${forbidden}`);
    assert.equal(forbidden.test(png), false, `PngEncoder.cs must not match ${forbidden}`);
  }
  for (const forbidden of [/Process\.Start/u, /ProcessStartInfo/u, /System\.Management/u, /System\.Drawing/u, /powershell/iu, /\bpwsh\b/iu]) {
    assert.equal(forbidden.test(allCode), false, `no Broker source file may match ${forbidden}`);
  }
  assert.equal(/\bFile\.|\bDirectory\.|HttpClient|\bSocket|NamedPipe|Environment\./u.test(desktop + png), false, 'the adapter touches no file, network, pipe or environment');
  assert.deepEqual([...png.matchAll(/^using ([\w.]+);/gmu)].map((m) => m[1]), ['System.Buffers.Binary', 'System.IO.Compression'], 'the encoder is BCL only');
});

test('the only query text is a table class plus a format-checked GUID, and no exception text or WMI string is ever returned', () => {
  assert.deepEqual([...desktop.matchAll(/\$"([^"]*)"/gu)].map((m) => m[1]), ['SELECT * FROM {className}', "SELECT * FROM {className} WHERE Name = '{name}'"], 'the only interpolated strings in the file');
  const find = desktop.slice(desktop.indexOf('internal sealed class ComWmiConnection'));
  assert.ok(find.indexOf('RequireClass(className)') < find.indexOf('IsVmId(name)') && find.indexOf('IsVmId(name)') < find.indexOf('string query'), 'class and GUID are checked before the text is built');
  assert.equal(/\.Message\b|\.ToString\(|\.StackTrace|\.InnerException|\.Data\b/u.test(desktop), false, 'no exception detail is read');
  assert.equal(/catch \((?!DesktopRefusal\b)\w+ \w+\)/u.test(desktop), false, 'no catch clause names the exception (only the fixed-word DesktopRefusal does), so it cannot be forwarded');
  assert.equal(/Console\.|Debug\.|Trace\.|ILogger/u.test(desktop + png), false, 'and nothing is printed');
  assert.deepEqual([...desktop.matchAll(/\b(?:public|internal) const string ([^;]+);/gu)].filter((m) => m[1].includes('ComputerUnknown')).map((m) => [...m[1].matchAll(/= "([a-z_]+)"/gu)].map((x) => x[1])),
    [['computer_unknown', 'capture_size', 'input_steps', 'desktop_unavailable', 'capture_failed', 'input_failed', 'allowlist', 'input_cancelled']], 'the only reason words');
});

test('bounds: capture 64..1920 and 8 MiB, 256 steps, text 512, sleep 10000 per step and 12000 per request, and the per-op ranges of desktop-io.ps1', () => {
  assert.match(desktop, /MinCapture = 64, MaxCapture = 1920, MaxPngBytes = 8 \* 1024 \* 1024;/u);
  assert.match(desktop, /MaxSteps = 256, MaxTextLength = 512, MaxSleepMs = 10000, MaxSleepTotalMs = 12000;/u);
  const steps = desktop.slice(desktop.indexOf('private static bool IsValidStep'), desktop.indexOf('private static bool InRange'));
  const expectedRanges = [['X', 0, 4095], ['Y', 0, 4095], ['Button', 1, 3], ['Vk', 1, 254], ['Delta', -1200, 1200]];
  for (const [field, min, max] of expectedRanges) assert.match(steps, new RegExp(`InRange\\(step\\.${field}, ${min}, ${max}\\)`, 'u'), `${field} ${min}..${max}`);
  assert.match(steps, /InRange\(step\.Ms, 0, MaxSleepMs\)/u);
  assert.deepEqual([...steps.matchAll(/^\s+"([^=]+)" =>/gmu)].map((m) => m[1].replace(/"/gu, '').split(' or ')).flat(), ['move', 'down', 'up', 'press', 'release', 'tap', 'wheel', 'sleep', 'text'], 'the nine ops of the prototype and no other');
  assert.match(desktop, /c is >= ' ' and <= '~'/u, 'printable ASCII only');
  const original = readFileSync(path.join(root, 'src', 'runtime', 'hyperv-desktop', 'desktop-io.ps1'), 'utf8');
  for (const range of ["'x' 0 4095", "'y' 0 4095", "'button' 1 3", "'vk' 1 254", "'delta' -1200 1200", "'ms' 0 10000"]) assert.ok(original.includes(range), `prototype range ${range}`);
});

test('input releases held buttons then keys in reverse on failure, and records a press before making it', () => {
  const apply = desktop.slice(desktop.indexOf('private void Apply('), desktop.indexOf('private static void Send('));
  assert.match(apply, /case "down": heldButtons\.Add\([^;]+\); Send\(/u, 'recorded before the call');
  assert.match(apply, /case "press": heldKeys\.Add\([^;]+\); Send\(/u);
  assert.match(apply, /case "up": Send\([^;]+\); heldButtons\.Remove\(/u, 'removed after it succeeded');
  assert.match(apply, /case "release": Send\([^;]+\); heldKeys\.Remove\(/u);
  const send = desktop.slice(desktop.indexOf('private DesktopResult SendSteps('), desktop.indexOf('private void Apply('));
  assert.match(send, /catch \(Exception\)\s*\{\s*\(List<uint> stuckKeys, List<uint> stuckButtons\) = ReleaseHeld\(gate, keyboard, mouse, heldKeys, heldButtons\);\s*if \(stuckKeys\.Count \+ stuckButtons\.Count > 0\) ReleaseOnNewConnection\(computer, stuckKeys, stuckButtons\);\s*throw;/u,
    'what could not be released is released once more on a new connection, then the original failure goes on');
  const cancelled = String.raw`if \(cancel\.IsCancellationRequested\) throw new DesktopRefusal\(DesktopReason\.InputCancelled\);`;
  assert.match(send, new RegExp(String.raw`foreach \(DesktopStep step in steps\)[\s\S]*?${cancelled}[\s\S]*?Apply\(gate, keyboard, mouse, step, heldKeys, heldButtons, cancel\);[\s\S]*?${cancelled}[\s\S]*?return new\(null\);`, 'u'),
    'a lease that ended is seen before every step and after the last one, inside the try: the held keys are released and the original path reports it (Zaku MEDIUM 2 of #166)');
  assert.match(desktop, /public DesktopResult Input\(string computerId, IReadOnlyList<DesktopStep> steps, CancellationToken cancel = default\)[\s\S]{0,400}if \(cancel\.IsCancellationRequested\) return new\(DesktopReason\.InputCancelled\);[\s\S]{0,80}return Run\(/u, 'and before WMI is touched');
  assert.match(desktop, /_sleep = sleep \?\? \(\(ms, cancel\) => cancel\.WaitHandle\.WaitOne\(ms\)\);/u, 'a sleep step ends when the token is cancelled');
  assert.equal(/Thread\.Sleep/u.test(desktop), false);
  const retry = desktop.slice(desktop.indexOf('private void ReleaseOnNewConnection('), desktop.indexOf('private void Apply('));
  assert.equal([...retry.matchAll(/_connect\(\)/gu)].length, 1, 'one new connection');
  assert.equal([...retry.matchAll(/ReleaseHeld\(/gu)].length, 1, 'one release pass on it, never a loop');
  assert.equal(/\b(?:for|while|foreach)\b/u.test(retry), false, 'and nothing that could try again');
  assert.match(retry, /catch \(Exception\) \{\s*\}/u, 'best effort: nothing escapes (the caller reports the original failure)');
  const releasing = desktop.slice(desktop.indexOf('private static (List<uint> Keys, List<uint> Buttons) ReleaseHeld('), desktop.indexOf('internal sealed class ComWmiConnection'));
  assert.ok(releasing.indexOf('heldButtons.Count - 1') < releasing.indexOf('heldKeys.Count - 1'), 'buttons before keys');
  assert.equal([...releasing.matchAll(/for \(int i = \w+\.Count - 1; i >= 0; i--\)/gu)].length, 2, 'newest first');
});

test('only the desktop pipe calls the adapter, for capture and (act sessions) input: the claim path never sees the adapter or the computers', () => {
  const desktopPipe = ['DesktopPipe.cs', 'DesktopProtocol.cs'];
  for (const [name, code] of others.filter(([file]) => file !== 'PngEncoder.cs' && !desktopPipe.includes(file))) {
    assert.equal(/HyperVDesktop|ComWmi|WmiGate|DesktopAllowlist|DesktopLimits|PngEncoder|IWmi/u.test(code), false, `${name} does not reference the adapter`);
  }
  assert.equal(/Hyper-?V/iu.test(sources['ServiceConfig.cs']), false);
  assert.match(sources['ServiceConfig.cs'], /ComputerBinding/u);
  const claimPath = [sources['Program.cs'], sources['ServiceHost.cs'], sources['ServiceLoop.cs'], sources['BrokerRequests.cs']].join('\n');
  assert.equal(/\bComputers\b|ComputerBinding/u.test(claimPath), false, 'the claim pipe and its request handlers do not read the computers');
  // The desktop pipe: one construction of the adapter, two calls (Capture, and Input from an act session that holds the lease), and the step type only where the request is read.
  assert.equal([...sources['DesktopPipe.cs'].matchAll(/new HyperVDesktop\(config\.Computers, ComWmiConnection\.TryConnect\)/gu)].length, 1, 'the real WMI connection, no seam');
  assert.deepEqual([...sources['DesktopPipe.cs'].matchAll(/_desktop\.(\w+)\(/gu)].map((m) => m[1]), ['Capture', 'Input']);
  assert.equal(allCode.match(/\.Input\(/gu).length, 1, 'one caller of the adapter\'s Input in the Broker');
  const stepUsers = Object.entries(sources).filter(([, code]) => /DesktopStep|AreValidSteps/u.test(code)).map(([name]) => name).sort();
  assert.deepEqual(stepUsers, ['DesktopPipe.cs', 'DesktopProtocol.cs', 'HyperVDesktop.cs'], 'the input step type: the adapter, the grammar that reads it, and the pipe that passes it on');
});

test('service config: optional computers key, at most 8 entries of exactly { computerId, vmId }, ids and GUIDs distinct, one fixed reason word', () => {
  const config = sources['ServiceConfig.cs'];
  assert.match(config, /MaxComputers = 8;/u);
  assert.match(config, /ComputersKey = "computers";/u);
  assert.match(config, /ComputerFields = \["computerId", "vmId"\];/u);
  assert.match(config, /Computers = "computers"/u);
  assert.match(config, /bool hasComputers = seen\.Remove\(ComputersKey\);[^\n]*\n\s+if \(!seen\.SetEquals\(Keys\)\) return null;/u, 'the one optional key is taken out before the exact-key check, so every other key is still required or refused');
  assert.match(config, /hasComputers \? ReadComputers\(root\.GetProperty\(ComputersKey\)\) : \[\];/u, 'no key: valid, no computers');
  assert.match(config, /element\.GetArrayLength\(\) > MaxComputers\) return null;/u);
  assert.match(config, /seen\.SetEquals\(ComputerFields\)\) return null;/u);
  assert.match(config, /!AuthorityKey\.IsKeyId\(computerId\) \|\| !ComputerBinding\.IsVmId\(vmId\)\) return null;/u, 'contract id grammar and lowercase GUID');
  assert.equal([...config.matchAll(/Select\(c => c\.(ComputerId|VmId)\)\.Distinct\(StringComparer\.Ordinal\)\.Count\(\) == computers\.Count/gu)].length, 2, 'both distinct');
  assert.match(config, /new ServiceConfig\(pipeName, database, authorityKeys, sid, generation, leaseId, policyVersion, computers\);/u);
});
