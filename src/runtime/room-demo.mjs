// `albera-runtime room --demo`: the whole control room with 3 fake VMs and no network.
// A drawing mock Broker stands in for Hyper-V and a scripted client stands in for the AI. One VM keeps clicking,
// one stalls behind a dialog (so Bero should notice), one ends with a DONE claim. Nothing here touches a VM.
import { crc32, deflateSync } from 'node:zlib';
import { createAgentFleet } from './agent-fleet.mjs';
import { createAgentStatusBoard } from './agent-status-board.mjs';
import { MODEL_PRICES } from './desktop-agent-loop.mjs';
import { HyperVDesktopDriver } from './hyperv-desktop-driver.mjs';
import { fakeReply, fakeText, fakeToolUse } from './fake-computer-use-client.mjs';
import { createRoomHost, NUDGE_TASK } from './room-host.mjs';
import * as journalModule from './room-journal.mjs';
import * as figuresModule from './room-figures.mjs';
import * as directorModule from './bero-director.mjs';

export const DEMO_SCREEN = Object.freeze({ width: 800, height: 500 });
export const DEMO_VMS = Object.freeze([
  Object.freeze({ vmId: 'demo-photos', label: 'Photos', task: 'Sort the photo folder by date and open the newest photo.', script: 'clicker' }),
  Object.freeze({ vmId: 'demo-tests', label: 'Tests', task: 'Run the test suite in the test app and report the result.', script: 'staller' }),
  Object.freeze({ vmId: 'demo-form', label: 'Booking form', task: 'Fill in the booking form and save it.', script: 'finisher' }),
]);
const DIALOG = Object.freeze({ x: 250, y: 170, w: 300, h: 140, ok: [400, 285] });
const SHADES = Object.freeze([70, 90, 110]);
const USAGE = Object.freeze({ input_tokens: 3000, output_tokens: 120 });

/** Is every room part (C journal + figures, D director) there? Returns the names of the missing ones. */
export function missingRoomParts(modules = { journalModule, figuresModule, directorModule }) {
  const missing = [];
  if (typeof modules.journalModule?.createRoomJournal !== 'function') missing.push('room-journal (part C)');
  if (typeof modules.figuresModule?.buildFigure !== 'function') missing.push('room-figures (part C)');
  if (typeof modules.directorModule?.createBeroDirector !== 'function') missing.push('bero-director (part D)');
  return missing;
}

// ---- a mock Broker that draws a simple desktop, so the cameras show something that changes ----

/** One grayscale PNG per VM: a window, small marks where the AI clicked, and a dialog while one is open. */
export function createDemoBroker({ width = DEMO_SCREEN.width, height = DEMO_SCREEN.height } = {}) {
  const screens = new Map(); // vmId -> { shade, marks, dialog }
  const inputs = [];
  const screenOf = (vmId) => {
    if (!screens.has(vmId)) screens.set(vmId, { shade: SHADES[screens.size % SHADES.length], marks: [], dialog: false });
    return screens.get(vmId);
  };
  return {
    inputs,
    openDialog(vmId) { screenOf(vmId).dialog = true; },
    hasDialog(vmId) { return screenOf(vmId).dialog; },
    async captureVmScreen(request) { return drawScreen(screenOf(request.vmId), width, height); },
    async sendVmInput(request) {
      inputs.push(request);
      const screen = screenOf(request.vmId);
      const at = request.action?.coordinate;
      if (Array.isArray(at)) {
        screen.marks = [...screen.marks.slice(-29), at];
        if (screen.dialog && inside(at, DIALOG)) screen.dialog = false;
      }
      return { ok: true };
    },
  };
}

function inside([x, y], box) { return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h; }

function drawScreen(screen, width, height) {
  const rows = Buffer.alloc((width + 1) * height);
  const fill = (x0, y0, w, h, value) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      rows.fill(value, y * (width + 1) + 1 + Math.max(0, x0), y * (width + 1) + 1 + Math.min(width, x0 + w));
    }
  };
  fill(0, 0, width, height, screen.shade);
  fill(40, 30, width - 80, height - 80, 225); // window
  fill(40, 30, width - 80, 24, 150); // title bar
  fill(0, height - 30, width, 30, 40); // task bar
  for (const [x, y] of screen.marks) fill(x - 4, y - 4, 9, 9, 60);
  if (screen.dialog) {
    fill(DIALOG.x - 2, DIALOG.y - 2, DIALOG.w + 4, DIALOG.h + 4, 20);
    fill(DIALOG.x, DIALOG.y, DIALOG.w, DIALOG.h, 245);
    fill(DIALOG.x, DIALOG.y, DIALOG.w, 22, 120);
    fill(DIALOG.ok[0] - 40, DIALOG.ok[1] - 12, 80, 24, 170);
  }
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0; // filter byte
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

// ---- scripted AI ----

const click = (n, x, y, note) => fakeReply([{ type: 'text', text: note }, fakeToolUse('left_click', { coordinate: [x, y] }, `toolu_${n}`)], { usage: USAGE });
const look = (n, note) => fakeReply([{ type: 'text', text: note }, fakeToolUse('screenshot', {}, `toolu_${n}`)], { usage: USAGE });
const NEVER = Symbol('never');

/** The response for step `i` (0-based) of a script, NEVER to wait until stopped, or null when the script is over. */
export function demoStep(script, i) {
  if (script === 'clicker') return click(i, 120 + ((i * 97) % 560), 90 + ((i * 53) % 330), `Moving photo ${i + 1} into its date folder`);
  if (script === 'staller') {
    if (i < 3) return click(i, 160 + i * 120, 140, `Starting test group ${i + 1}`);
    return NEVER; // the test app shows a dialog and the AI waits forever
  }
  if (script === 'finisher') {
    const steps = [
      click(0, 300, 120, 'Opening the booking form'), click(1, 300, 200, 'Choosing the date'),
      click(2, 300, 260, 'Entering the guest name'), click(3, 520, 400, 'Pressing Save'),
    ];
    return steps[i] ?? (i === steps.length ? fakeText('DONE: the booking form is filled in and saved.', 'end_turn', USAGE) : null);
  }
  if (script === 'nudge') {
    return [look(0, 'Looking for what blocks the screen'), click(1, DIALOG.ok[0], DIALOG.ok[1], 'Pressing OK on the dialog'),
      fakeText('DONE: closed the "Unsaved changes" dialog with OK.', 'end_turn', USAGE)][i] ?? null;
  }
  if (script === 'recheck') return [look(0, 'Checking the screen'), fakeText('DONE: the screen shows the saved booking.', 'end_turn', USAGE)][i] ?? null;
  return i === 0 ? fakeText('FAILED: the demo has no script for this task.', 'end_turn', USAGE) : null;
}

/** A computer-use client that plays a script, one response every `delayMs`, and honours the stop signal. */
export function createDemoClient(script, { delayMs = 1500, onStep = () => {} } = {}) {
  let i = 0;
  return {
    async send(_messages, _system, { signal } = {}) {
      const step = demoStep(script, i);
      onStep(i);
      i++;
      await wait(step === NEVER ? 2 ** 31 - 1 : delayMs, signal);
      if (!step || step === NEVER) throw Object.assign(new Error('demo_script_over'), { code: 'demo_script_over' });
      return step;
    },
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { code: 'computer_use_aborted' })); };
    if (signal?.aborted) { aborted(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Which script a job gets: the VM's own one for its first task, the card scripts for the host's fixed tasks. */
function scriptFor(vm, task) {
  if (task === vm.task) return vm.script;
  if (task === NUDGE_TASK) return 'nudge';
  if (task.startsWith('Do not change anything')) return 'recheck';
  return 'unknown';
}

// ---- the demo room ----

/**
 * Start the demo room on 127.0.0.1. Throws `room_parts_missing` (with the part names in `missing`) when the
 * journal, figures or director modules are still stubs. Returns `{ url, bootstrapCode, close() }`.
 */
export async function startRoomDemo({ port = 0, delayMs = 1500, stallMs = 20_000, now = Date.now, modules } = {}) {
  const parts = modules ?? { journalModule, figuresModule, directorModule };
  const missing = missingRoomParts(parts);
  if (missing.length) throw Object.assign(new Error(`room_parts_missing: ${missing.join(', ')}`), { code: 'room_parts_missing', missing });

  const broker = createDemoBroker();
  const board = createAgentStatusBoard({ now });
  const journal = parts.journalModule.createRoomJournal({ now });
  const labels = new Map(DEMO_VMS.map((vm) => [vm.vmId, vm.label]));
  const director = parts.directorModule.createBeroDirector({ buildFigure: parts.figuresModule.buildFigure, stallMs, labelOf: (vmId) => labels.get(vmId) ?? vmId });
  let host;
  const fleet = createAgentFleet({
    jobs: DEMO_VMS.map(({ vmId, task }) => ({ vmId, task })), board, keepAlive: true, now,
    createDriver: (vmId, lease) => new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease, screen: DEMO_SCREEN, now }),
    createClient: (vmId, task) => {
      const vm = DEMO_VMS.find((v) => v.vmId === vmId);
      const script = scriptFor(vm, task);
      // The stalling VM opens its dialog right after its last click.
      return createDemoClient(script, { delayMs, onStep: (i) => { if (script === 'staller' && i === 3) broker.openDialog(vmId); } });
    },
    limits: { maxSteps: 400, maxUsd: 0.5, maxMs: 30 * 60_000 }, prices: MODEL_PRICES['claude-haiku-5-5'], totalMaxUsd: 1,
    onEvent: (vmId, event) => host?.recordFleetEvent(vmId, event),
  });
  host = createRoomHost({
    vms: DEMO_VMS.map(({ vmId, label, task }) => ({ vmId, label, task })), board, journal, director, fleet, now,
    driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease, screen: DEMO_SCREEN, now }),
  });
  const address = await host.listen(port);
  const running = fleet.run().catch(() => null);
  return Object.freeze({
    url: address.url, bootstrapCode: address.bootstrapCode, host, fleet, broker,
    async close() {
      fleet.close('demo_closed');
      await running;
      await host.close();
    },
  });
}
