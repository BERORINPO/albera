import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// The Broker's Hyper-V desktop adapter (HyperVDesktop.cs, PngEncoder.cs; ADR-002 Amendment 2026-11-03) compiled by source include into a throwaway console in a temp
// dir and driven with a FAKE WMI connection (test/hyperv-desktop-dotnet-harness). That proves the adapter's own logic: what it refuses before WMI is touched, the exact
// WMI traffic it produces, the release order after a failed input (and the one retry on a new connection), and that no exception text leaves it. The same harness drives the desktop
// lease table (DesktopLeases.cs) with a fake clock. It does not prove real WMI behaviour: that is the opt-in live
// test at the bottom and, for the service identity, the disposable-VM run. Skipped without a .NET 10 SDK. The source-level pins are in windows-broker-hyperv-desktop-source.test.mjs.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const brokerDir = path.join(root, 'src', 'runtime', 'windows-broker');
const harnessProject = path.join(root, 'test', 'hyperv-desktop-dotnet-harness', 'HyperVDesktopHarness.csproj');

function unavailableReason() {
  try {
    const sdks = execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return sdks.split(/\r?\n/u).some((line) => /^10\./u.test(line)) ? false : '.NET 10 SDK unavailable';
  } catch { return 'dotnet unavailable'; }
}

/** Builds the harness into `tempDir` and returns the path of its dll. The build's obj folder is kept out of the repository. */
function buildHarness(tempDir) {
  const intermediate = `${path.join(tempDir, 'obj')}${path.sep}`;
  const output = path.join(tempDir, 'out');
  execFileSync('dotnet', ['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:BrokerDir=${brokerDir}${path.sep}`,
    `--property:BaseIntermediateOutputPath=${intermediate}`, `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo'],
  { encoding: 'utf8', stdio: 'pipe', timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return path.join(output, 'HyperVDesktopHarness.dll');
}

const GUID1 = '0123abcd-4567-89ab-cdef-0123456789ab';
const GUID2 = 'fedcba98-7654-3210-fedc-ba9876543210';
const REALIZED = 'Microsoft:Hyper-V:System:Realized';
const DISPOSE = 'Dispose connection';
const FIND_VM = `Find Msvm_ComputerSystem ${GUID1}`;
const ASSOC_KEYBOARD = 'Associated Msvm_ComputerSystem->Msvm_Keyboard';
const ASSOC_MOUSE = 'Associated Msvm_ComputerSystem->Msvm_SyntheticMouse';
const PREAMBLE = [FIND_VM, ASSOC_KEYBOARD, ASSOC_MOUSE];
const press = (vk) => `Invoke Msvm_Keyboard.PressKey KeyCode=UInt32:${vk}`;
const release = (vk) => `Invoke Msvm_Keyboard.ReleaseKey KeyCode=UInt32:${vk}`;
const tap = (vk) => `Invoke Msvm_Keyboard.TypeKey KeyCode=UInt32:${vk}`;
const button = (index, down) => `Invoke Msvm_SyntheticMouse.SetButtonState ButtonIndex=UInt32:${index},IsDown=Boolean:${down ? 'True' : 'False'}`;

/** Splits a PNG into chunks and checks the framing: signature, per-chunk CRC-32 (Node's own implementation), IHDR first, IEND last. */
function decodePng(base64) {
  const png = Buffer.from(base64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), zlib.crc32(png.subarray(at + 4, at + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(chunks[2].data.length, 0);
  const header = chunks[0].data;
  assert.equal(header.length, 13);
  assert.deepEqual([...header.subarray(8)], [8, 2, 0, 0, 0], '8-bit truecolour, no interlace');
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  const scanlines = zlib.inflateSync(chunks[1].data); // also checks the zlib framing and Adler-32
  assert.equal(scanlines.length, height * (1 + 3 * width));
  return { png, width, height, scanlines };
}

const expand = (bits, value) => (bits === 5 ? (value << 3) | (value >> 2) : (value << 2) | (value >> 4));
/** The RGB the encoder must produce for an RGB565 value. */
function rgbOf(value) {
  return [expand(5, value >> 11), expand(6, (value >> 5) & 0x3f), expand(5, value & 0x1f)];
}
function assertPixels(decoded, pixelAt) {
  const { width, height, scanlines } = decoded;
  for (let y = 0; y < height; y++) {
    const row = y * (1 + 3 * width);
    assert.equal(scanlines[row], 0, `row ${y} uses filter none`);
    for (let x = 0; x < width; x++) {
      assert.deepEqual([...scanlines.subarray(row + 1 + 3 * x, row + 4 + 3 * x)], rgbOf(pixelAt(x, y, width)), `pixel ${x},${y}`);
    }
  }
}
const patternPixel = (x, y, width) => (Math.imul(y * width + x, 40503) + 11) & 0xffff; // PixelValue() of the harness
const fakeImagePixel = (x, y, width) => { const i = y * width + x; return ((i * 2) % 251) | (((i * 2 + 1) % 251) << 8); }; // Fake.Image(): byte k of the pixel data is k % 251

describe('Broker Hyper-V desktop adapter against a fake WMI connection', { skip: unavailableReason(), timeout: 300_000 }, () => {
  let tempDir, harnessDll, report;
  const run = (...args) => execFileSync('dotnet', [harnessDll, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

  before(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'albera-hyperv-desktop-'));
    harnessDll = buildHarness(tempDir);
    report = JSON.parse(run());
  });
  after(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  const byName = (list, name) => {
    const found = list.find((item) => (item.report ?? item).name === name);
    assert.ok(found, `scenario ${name}`);
    return found;
  };

  describe('PNG encoder', () => {
    it('writes a valid PNG (signature, IHDR, one IDAT, IEND, CRC-32 and zlib checks) whose pixels are the RGB565 input expanded to 8 bits', () => {
      assert.equal(report.png.length, 6);
      for (const { width, height, png } of report.png) {
        const decoded = decodePng(png);
        assert.deepEqual([decoded.width, decoded.height], [width, height]);
        assertPixels(decoded, patternPixel);
      }
    });

    it('maps full intensity to 255 and zero to 0, and ends with the standard IEND chunk', () => {
      assert.deepEqual(rgbOf(0xffff), [255, 255, 255]);
      assert.deepEqual(rgbOf(0x0000), [0, 0, 0]);
      const { png } = decodePng(report.png[0].png);
      assert.equal(png.subarray(-12).toString('hex'), '0000000049454e44ae426082', 'the fixed IEND chunk, CRC included');
    });

    it('refuses a pixel buffer whose size does not match the dimensions', () => {
      assert.deepEqual(report.pngRefusesBadSize, [true, true, true, true, true]);
    });
  });

  describe('allowlist', () => {
    const contract = {
      Msvm_ComputerSystem: [],
      Msvm_VirtualSystemSettingData: [],
      Msvm_VirtualSystemManagementService: ['GetVirtualSystemThumbnailImage'],
      Msvm_Keyboard: ['PressKey', 'ReleaseKey', 'TypeKey', 'TypeText'],
      Msvm_SyntheticMouse: ['SetAbsolutePosition', 'SetButtonState', 'SetScrollPosition'],
    };

    it('lets exactly the contract classes be queried and exactly the contract methods be executed, and nothing else (case-sensitive)', () => {
      for (const [className, verdict] of Object.entries(report.allowMatrix)) {
        assert.equal(verdict.queryAllowed, className in contract, `query ${className}`);
        assert.deepEqual(verdict.methodsAllowed.sort(), [...(contract[className] ?? [])].sort(), `methods of ${className}`);
      }
    });

    it('refuses an unlisted namespace, class or method inside the gate, before the connection is asked anything', () => {
      for (const c of report.gate) {
        const allowed = ['find a listed class', 'associate listed to listed', 'GetVirtualSystemThumbnailImage on the management service', 'TypeText on the keyboard'].includes(c.name);
        assert.equal(c.outcome, allowed ? 'allowed' : 'allowlist', c.name);
        if (!allowed) assert.deepEqual(c.calls, [], `${c.name}: the fake must not have been touched`);
      }
      assert.equal(report.gate.length, 17);
    });

    it('accepts a VM id only as a lowercase 8-4-4-4-12 GUID with no trailing text', () => {
      assert.deepEqual(report.config.vmIds, [true, false, false, false, false, false, false]);
    });
  });

  describe('requests refused before WMI is touched', () => {
    const untouched = (item) => {
      const r = item.report ?? item;
      assert.equal(r.ok, false, r.name);
      assert.equal(r.connects, 0, `${r.name}: no connection is even opened`);
      assert.deepEqual(r.calls, [], `${r.name}: no WMI call`);
    };

    it('capture: a computerId that is not in the config (whatever its spelling, a GUID or a display name included) is computer_unknown', () => {
      for (const c of report.captureRejected.slice(0, 6)) { untouched(c); assert.equal(c.reason, 'computer_unknown', c.name); }
    });

    it('capture: a width or height outside 64..1920 is capture_size', () => {
      assert.equal(report.captureRejected.length, 13);
      for (const c of report.captureRejected.slice(6)) { untouched(c); assert.equal(c.reason, 'capture_size', c.name); }
    });

    it('input: an unknown computer is computer_unknown; every unknown op, out-of-range value, stray or missing field and every over-limit total is input_steps', () => {
      const cases = report.inputRejected;
      assert.equal(cases.length, 39);
      for (const [i, c] of cases.entries()) {
        untouched(c);
        assert.equal(c.report.reason, i < 2 ? 'computer_unknown' : 'input_steps', c.report.name);
        assert.deepEqual(c.sleeps, [], `${c.report.name}: nothing slept`);
      }
    });
  });

  describe('capture', () => {
    it('queries the VM by its configured GUID, takes the realized settings, calls GetVirtualSystemThumbnailImage once and returns a valid PNG of the pixels', () => {
      const { report: r, png } = byName(report.capture, '640x480');
      assert.equal(r.ok, true);
      assert.deepEqual(r.calls, [
        FIND_VM,
        `Associated Msvm_ComputerSystem->Msvm_VirtualSystemSettingData [VirtualSystemType=${REALIZED}]`,
        'Find Msvm_VirtualSystemManagementService -',
        'Invoke Msvm_VirtualSystemManagementService.GetVirtualSystemThumbnailImage HeightPixels=UInt16:480,TargetSystem=ref:Msvm_VirtualSystemSettingData,WidthPixels=UInt16:640',
        DISPOSE,
      ]);
      assert.equal(r.open, 0, 'every WMI instance was released');
      const decoded = decodePng(png);
      assert.deepEqual([decoded.width, decoded.height], [640, 480]);
      assertPixels(decoded, fakeImagePixel); // the 4-byte thumbnail header is skipped, not drawn
    });

    it('resolves the other configured computer to its own GUID, and accepts the size limits and an odd width', () => {
      assert.equal(byName(report.capture, 'the second computer is queried by its own GUID').report.calls[0], `Find Msvm_ComputerSystem ${GUID2}`);
      for (const [name, width, height] of [['smallest and largest edges', 1920, 64], ['odd size', 333, 201]]) {
        const { report: r, png } = byName(report.capture, name);
        assert.equal(r.ok, true, name);
        const decoded = decodePng(png);
        assert.deepEqual([decoded.width, decoded.height], [width, height]);
        assertPixels(decoded, fakeImagePixel);
      }
    });

    it('reports a missing VM, settings, service or unreachable WMI as desktop_unavailable, and stops at the first missing piece', () => {
      const settings = `Associated Msvm_ComputerSystem->Msvm_VirtualSystemSettingData [VirtualSystemType=${REALIZED}]`;
      assert.deepEqual(byName(report.capture, 'VM not found').report.calls, [FIND_VM, DISPOSE]);
      assert.deepEqual(byName(report.capture, 'no realized settings').report.calls, [FIND_VM, settings, DISPOSE]);
      assert.deepEqual(byName(report.capture, 'no management service').report.calls, [FIND_VM, settings, 'Find Msvm_VirtualSystemManagementService -', DISPOSE]);
      for (const name of ['VM not found', 'no realized settings', 'no management service', 'WMI unreachable']) assert.equal(byName(report.capture, name).report.reason, 'desktop_unavailable', name);
      assert.deepEqual(byName(report.capture, 'WMI unreachable').report.calls, [], 'no connection, no call');
    });

    it('reports a non-zero code, a thrown error, a wrong-sized image, a missing image and an oversize PNG as capture_failed, with no picture', () => {
      for (const name of ['thumbnail returns a non-zero code', 'thumbnail throws', 'image shorter than asked', 'image longer than asked', 'image without header', 'no image data', 'find throws', 'a PNG over 8 MiB is not returned']) {
        const { report: r, png } = byName(report.capture, name);
        assert.equal(r.reason, 'capture_failed', name);
        assert.equal(png, null, name);
        assert.equal(r.open, 0, `${name}: instances released`);
      }
    });

    it('never lets an exception message out: results are fixed words only', () => {
      assert.equal(JSON.stringify([report.capture, report.input]).includes('SECRET'), false);
      const words = new Set([...report.capture, ...report.input].map((c) => c.report.reason));
      for (const word of words) assert.ok([null, 'desktop_unavailable', 'capture_failed', 'input_failed'].includes(word), String(word));
    });
  });

  describe('input', () => {
    it('sends each op as exactly one allowlisted call with typed arguments, waits for sleep steps itself, and skips a zero sleep', () => {
      const c = byName(report.input, 'every op once');
      assert.equal(c.report.ok, true);
      assert.deepEqual(c.report.calls, [
        ...PREAMBLE,
        'Invoke Msvm_SyntheticMouse.SetAbsolutePosition HorizontalPosition=Int32:10,VerticalPosition=Int32:20',
        button(1, true), button(1, false), press(16), tap(65), release(16),
        'Invoke Msvm_Keyboard.TypeText AsciiText=String:hi',
        'Invoke Msvm_SyntheticMouse.SetScrollPosition ScrollPositionDelta=Int32:-120',
        DISPOSE,
      ]);
      assert.deepEqual(c.sleeps, [250]);
      assert.equal(c.report.open, 0);
    });

    it('accepts every limit exactly (position 4095, wheel +-1200, keys 1..254, 512-character text, sleep 10000 and 12000 in total, 256 steps)', () => {
      const limits = byName(report.input, 'limits all accepted');
      assert.equal(limits.report.ok, true);
      assert.equal(limits.report.calls.filter((call) => call.startsWith('Invoke')).length, 8);
      assert.deepEqual(limits.sleeps, [10000, 2000]);
      const many = byName(report.input, '256 steps');
      assert.equal(many.report.ok, true);
      assert.equal(many.report.calls.filter((call) => call.startsWith('Invoke')).length, 256);
    });

    it('reports a missing device, VM or WMI as desktop_unavailable without sending anything', () => {
      for (const name of ['no keyboard device', 'no mouse device', 'VM not found', 'WMI unreachable']) {
        const c = byName(report.input, name);
        assert.equal(c.report.reason, 'desktop_unavailable', name);
        assert.equal(c.report.calls.some((call) => call.startsWith('Invoke')), false, name);
      }
    });

    // The release order after a failed request: buttons first, then keys, each newest first; a press or down is recorded before the call that makes it, a release or up
    // takes it off the list, and a release that itself fails does not stop the others or change the reported reason.
    const failedWith = (name, releases) => {
      const c = byName(report.input, name);
      assert.equal(c.report.reason, 'input_failed', name);
      assert.equal(c.report.calls.at(-1), DISPOSE);
      assert.deepEqual(c.report.calls.slice(c.report.calls.length - 1 - releases.length, -1), releases, `${name}: what was released, in order`);
      assert.equal(c.report.open, 0);
      assert.equal(c.report.connects, 1, `${name}: every release worked, so there was no reason for a second connection`);
      return c;
    };

    it('releases every held button and key, buttons first and newest first, when a step returns a non-zero code', () => {
      const c = failedWith('failure releases buttons then keys, newest first (non-zero code)', [button(2, false), button(1, false), release(17), release(16)]);
      assert.deepEqual(c.report.calls, [...PREAMBLE, press(16), press(17), button(1, true), button(2, true), tap(65), button(2, false), button(1, false), release(17), release(16), DISPOSE]);
    });

    it('does the same when a step throws', () => {
      failedWith('failure releases buttons then keys, newest first (exception)', [button(2, false), button(1, false), release(17), release(16)]);
    });

    it('does not release what the plan already released, releases nothing when nothing is held, and releases the key or button whose own call failed', () => {
      failedWith('a released key and button are not released again', [button(2, false), release(17)]);
      assert.equal(byName(report.input, 'failing first step releases nothing').report.calls.filter((call) => call.includes('ReleaseKey') || call.includes('IsDown=Boolean:False')).length, 0);
      failedWith('the press that fails is released too', [button(1, false), release(16)]);
      failedWith('the down that fails is released too', [button(2, false), release(16)]);
      failedWith('failure in the middle of text leaves nothing held', [release(16)]);
    });

    // Zaku MEDIUM 3 of #161: a release that fails on the failing connection (the RPC may be gone) is tried once more on a NEW one. The fake keeps one log across connections.
    const FIND_AND_DEVICES = [FIND_VM, ASSOC_KEYBOARD, ASSOC_MOUSE];
    const retried = (name) => {
      const c = byName(report.input, name);
      assert.equal(c.report.reason, 'input_failed', `${name}: the reason is still the original failure`);
      assert.equal(c.report.connects, 2, `${name}: exactly one more connection`);
      assert.equal(c.report.open, 0, `${name}: every instance released`);
      return c.report.calls;
    };

    it('releases once more on a new connection what a failed release left held, and only that', () => {
      const calls = retried('a release that fails on the first connection is retried once on a new one and succeeds');
      assert.deepEqual(calls, [
        ...PREAMBLE, press(16), press(17), button(1, true), tap(65),
        button(1, false), release(17), release(16), // first connection: the button and key 17 fail, key 16 works
        ...FIND_AND_DEVICES, button(1, false), release(17), DISPOSE, // new connection: the two that failed, not key 16 again
        DISPOSE,
      ]);
    });

    it('keeps releasing the others when one release fails, and the retry is exactly the ones that failed', () => {
      const calls = retried('a failing release does not stop the others and keeps the original reason');
      assert.deepEqual(calls.slice(calls.indexOf(tap(65)) + 1), [
        button(2, false), button(1, false), release(17), release(16), // every button release and key 17 fail; key 16 still gets its release
        ...FIND_AND_DEVICES, button(2, false), button(1, false), release(17), DISPOSE, DISPOSE,
      ]);
    });

    it('tries a failed release once more and no more: still failing on the new connection ends it, and the reported reason stays input_failed', () => {
      const calls = retried('a release that fails again on the new connection is not tried a third time');
      assert.deepEqual(calls, [
        ...PREAMBLE, press(16), press(17), button(1, true), button(2, true), tap(65),
        button(2, false), button(1, false), release(17), release(16), // first connection: button 1 and key 17 fail
        ...FIND_AND_DEVICES, button(1, false), release(17), DISPOSE, // the retry: those two, once; they fail again and that is the end of it
        DISPOSE,
      ]);
    });

    it('gives up quietly when the new connection cannot be made or has no keyboard, and still reports the original failure', () => {
      const unreachable = retried('no new connection can be made for the retry');
      assert.deepEqual(unreachable, [...PREAMBLE, press(16), tap(65), release(16), DISPOSE], 'the retry asked for a connection, got none, and sent nothing');
      const noKeyboard = retried('the new connection finds no keyboard');
      assert.deepEqual(noKeyboard, [...PREAMBLE, press(16), tap(65), release(16), ...FIND_AND_DEVICES, DISPOSE, DISPOSE], 'it looked, found no keyboard, and sent nothing');
    });

    it('has waited for the sleeps that came before the failure', () => {
      const c = failedWith('sleeps run before a later failure', [release(16)]);
      assert.deepEqual(c.sleeps, [100, 200]);
    });
  });

  // Zaku MEDIUM 2 of #166: the lease's token is given to the adapter, which looks at it before WMI is touched and before every step, releases what is held (the same path as after a
  // failed step), and answers input_cancelled. A step that is already inside WMI is not interrupted.
  describe('input stopped by the lease ending', () => {
    const stopped = (name) => {
      const c = byName(report.inputCancelled, name);
      assert.equal(c.report.reason, 'input_cancelled', name);
      assert.equal(c.report.ok, false, name);
      assert.equal(c.report.open, 0, `${name}: instances released`);
      return c;
    };

    it('touches nothing for a lease that has already ended: no connection, no call', () => {
      const c = stopped('a lease that has already ended touches nothing');
      assert.equal(c.report.connects, 0);
      assert.deepEqual(c.report.calls, []);
    });

    it('stops before the next step when the lease ends between two steps, and releases the button and then the key that were held', () => {
      const c = stopped('a lease that ends between two steps stops before the next one and releases what is held');
      assert.deepEqual(c.report.calls, [...PREAMBLE, press(16), button(1, true), tap(65), button(1, false), release(16), DISPOSE], 'tap(66) and tap(67) were never sent');
      assert.equal(c.report.connects, 1);
    });

    it('stops at the end of a sleep step, not after the steps that follow it, and also when the sleep was the last step (what the plan left held is released)', () => {
      const c = stopped('a lease that ends during a sleep step stops before the step after it');
      assert.deepEqual(c.report.calls, [...PREAMBLE, press(16), release(16), DISPOSE]);
      assert.deepEqual(c.sleeps, [500]);
      const last = stopped('a lease that ends during the last step still releases what the plan left held');
      assert.deepEqual(last.report.calls, [...PREAMBLE, button(2, true), button(2, false), DISPOSE]);
    });

    it('lets a step that is already inside WMI finish, then stops', () => {
      const c = stopped('a lease that ends while a step is inside WMI lets that step finish, then stops');
      assert.deepEqual(c.report.calls, [...PREAMBLE, press(16), release(16), DISPOSE]);
    });

    it('releases once more on a new connection what the failed release left held, as after a failed step', () => {
      const c = stopped('a release that fails after the stop is tried once more on a new connection');
      assert.equal(c.report.connects, 2);
      assert.deepEqual(c.report.calls, [...PREAMBLE, press(16), tap(65), release(16), ...PREAMBLE, release(16), DISPOSE, DISPOSE]);
    });

    it('does not touch a plan that finishes before the lease ends', () => {
      const c = byName(report.inputCancelled, 'a plan that finishes before the lease ends is not touched');
      assert.equal(c.report.ok, true);
      assert.deepEqual(c.report.calls, [...PREAMBLE, press(16), tap(65), release(16), DISPOSE]);
    });

    it('ends the adapter\'s own wait for a 10 s sleep step soon after the token is cancelled', () => {
      const w = report.sleepEndsOnCancel;
      assert.equal(w.reason, 'input_cancelled');
      assert.ok(w.elapsedMs < 5000, `took ${w.elapsedMs} ms: the 10 s sleep was cut short`);
      assert.deepEqual(w.calls, [...PREAMBLE, press(16), release(16), DISPOSE]);
    });
  });

  // DesktopLeases.cs with a fake clock (ADR-002 "Desktop lease (held by the Broker)"). The pipe-level behaviour (the claim that creates a lease, the sessions it closes, a restart) is in
  // runtime-windows-broker-desktop-pipe.test.mjs.
  describe('desktop lease table', () => {
    const step = (name) => {
      const found = report.leases.find((s) => s.name === name);
      assert.ok(found, `step ${name}`);
      return found.value;
    };

    it('opens only for the operation and generation that were granted, for the computer they were granted for, spelled exactly', () => {
      assert.equal(step('open before any claim'), 'lease_unknown');
      assert.equal(step('first grant of room-1'), 1);
      assert.equal(step('first grant of room-1: no refusal word'), '');
      assert.equal(step('open with the granted operation and generation'), null);
      assert.equal(step('open with generation 2'), 'lease_generation');
      assert.equal(step('open with generation 0'), 'lease_generation');
      for (const name of ['open with another operation', 'open for the other computer', 'open with the computer id in another case', 'open with the operation id in another case']) assert.equal(step(name), 'lease_unknown', name);
    });

    it('makes no lease for a computer that is not in the config (or spelled differently), so the table is bounded by the config', () => {
      assert.equal(step('grant for a computer that is not configured'), null);
      assert.equal(step('grant for the id in another case'), null);
      assert.equal(step('grant for a computer that is not configured: the word'), 'computer_unknown');
      assert.equal(step('open after those two refused grants'), 'lease_unknown');
    });

    // Zaku MEDIUM 3 of #166: a task.start claim whose signed args name a VM makes a lease only for the VM the config binds to that computer.
    it('makes no lease for a claim that names a VM other than the one the config binds to the computer (any spelling but the exact one), and a refused grant touches nothing that stands', () => {
      for (const name of ['grant that names the other computer\'s VM', 'grant that names an unrelated VM', 'grant that names the right VM in upper case', 'grant that names an empty VM id']) assert.equal(step(name), null, name);
      assert.equal(step('grant that names the other computer\'s VM: the word'), 'vm_mismatch');
      assert.equal(step('open after the grants that named another VM'), 'lease_unknown', 'no lease, not even a generation was spent: the next grant is generation 1');
      assert.equal(step('first grant of room-1'), 1, 'a claim that names the right VM makes the lease');
      assert.equal(step('first grant of room-2 counts from 1 too'), 1, 'and so does one that names none (the plain { task } form)');
      assert.equal(step('a grant that names another VM leaves the standing lease alone'), null);
      assert.equal(step('a grant that names another VM: the session is not cancelled'), false);
      assert.equal(step('a grant that names another VM: the session\'s refusal'), null);
      assert.equal(step('a grant that names another VM: its operation cannot be opened'), 'lease_unknown');
    });

    it('counts generations per computer, from 1', () => {
      assert.equal(step('first grant of room-1'), 1);
      assert.equal(step('first grant of room-2 counts from 1 too'), 1);
      assert.equal(step('a new claim after the expiry counts on from the expired generation'), 2);
      assert.equal(step('a third claim'), 3);
      assert.equal(step('a disposed session is not touched by the next claim'), 4);
    });

    it('expires exactly 60 minutes after the claim, for a new open and for a session that is already open', () => {
      assert.equal(step('one millisecond before the end of the hour: open'), null);
      assert.equal(step('one millisecond before the end of the hour: refusal'), null);
      assert.equal(step('exactly 60 minutes after the claim: open'), 'lease_expired');
      assert.equal(step('exactly 60 minutes after the claim: refusal of a live session'), 'lease_expired');
      assert.equal(step('exactly 60 minutes after the claim: room-2 too'), 'lease_expired');
    });

    it('a newer claim for the same computer retires the older lease: its sessions are cancelled, it can no longer be opened, and another computer is not touched', () => {
      assert.deepEqual(step('replaced: the older sessions are cancelled'), [true, true]);
      assert.equal(step('replaced: the older session\'s refusal'), 'lease_revoked');
      assert.equal(step('replaced: the older lease cannot be opened'), 'lease_unknown');
      assert.equal(step('replaced: the older lease cannot be opened with the new generation'), 'lease_unknown');
      assert.equal(step('the new lease opens'), null);
      assert.equal(step('the other computer\'s session is untouched by room-1\'s claim'), false);
      assert.equal(step('the third claim closes the second lease\'s session'), true);
      assert.equal(step('an operation that was never claimed'), 'lease_unknown');
    });

    it('a session that has ended is no longer closed by a later claim', () => {
      assert.equal(step('a fourth lease opens and ends its session'), null);
      assert.equal(step('a disposed session was not cancelled'), false);
    });

    // Zaku MEDIUM 1 of #166: the refusal looks at the session's own token too, not only at the table and the clock.
    it('a session whose own token is cancelled refuses while its lease still stands, and the lease itself is untouched', () => {
      assert.equal(step('a live session before its token is cancelled'), null);
      assert.equal(step('a cancelled session refuses while its lease stands'), 'lease_revoked');
      assert.equal(step('and the lease itself still opens'), null);
    });

    it('takes a lifetime of 1..3600 seconds (3600 is the contract\'s 60 minutes) and nothing else', () => {
      assert.equal(report.leaseLifetimes.maximum, 3600);
      assert.deepEqual(report.leaseLifetimes.bounds, ['refused', 'ok', 'ok', 'refused', 'refused']);
      assert.deepEqual([report.leaseLifetimes.before, report.leaseLifetimes.after], ['opened', 'lease_expired'], 'a shorter lifetime ends on its own millisecond');
      assert.equal(report.leaseLifetimes.defaultClock, 'opened', 'with no clock given, the lease runs on the monotonic default');
    });
  });
});

// Opt-in, read only: one real capture of a running VM through the real COM path (ComWmiConnection). Sends no input. The caller needs Hyper-V rights (membership of
// Hyper-V Administrators). Set ALBERA_HYPERV_DESKTOP_VM_ID to the VM's GUID (Msvm_ComputerSystem.Name, any case). The picture is only checked structurally, never kept or shown.
const liveVm = process.env.ALBERA_HYPERV_DESKTOP_VM_ID;
const liveSkip = unavailableReason() || (process.platform !== 'win32' ? 'Windows only' : (liveVm ? false : 'set ALBERA_HYPERV_DESKTOP_VM_ID=<VM GUID> to capture one real VM screen (read only)'));

describe('Broker Hyper-V desktop adapter against the real host (opt-in, read only)', { skip: liveSkip, timeout: 300_000 }, () => {
  it('captures one running VM screen through COM late binding and returns a structurally valid PNG', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'albera-hyperv-live-'));
    try {
      const dll = buildHarness(tempDir);
      const vmId = liveVm.toLowerCase();
      assert.match(vmId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
      const result = JSON.parse(execFileSync('dotnet', [dll, 'live', vmId, '640', '480'], { encoding: 'utf8', stdio: 'pipe', timeout: 120_000, windowsHide: true }));
      assert.deepEqual({ reason: result.reason }, { reason: null }, 'a running VM is captured');
      const decoded = decodePng(result.png);
      assert.deepEqual([decoded.width, decoded.height], [640, 480]);
    } finally { rmSync(tempDir, { recursive: true, force: true }); }
  });
});
