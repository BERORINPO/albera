// PROTOTYPE. OPT-IN screen capture from INSIDE a Hyper-V guest, for VMs whose host thumbnail does not work
// (a GPU-partitioned VM keeps showing its boot logo there). The guest runs a small helper (hyperv-guest/screen-helper.ps1,
// installed with `albera-runtime guest-capture install`) that saves the newest frame every ~1 s; this module reads it
// over PowerShell Direct. Input still goes through the host's synthetic mouse and keyboard (desktop-io.ps1).
// Runs as the same OS user as the caller (needs "Hyper-V Administrators"); it is NOT the privileged Host Broker of ADR-002.
// Transport: a fixed `pwsh -File <fixed path>` process; requests are JSON lines on stdin. No command line is ever
// assembled from data. The guest password is read from the file each time a process starts and goes only into its
// first stdin line: never into argv, env, a log line, an event or an error.
// The frame is untrusted guest data: the Driver checks it like any screen (size, PNG signature, IHDR) and nothing on the
// host decodes the image. One long-lived process (one PowerShell Direct session) per opted-in VM, because a new
// process per frame costs 3-4 s (pwsh start + session open) against ~0.2 s per frame on an open session. Bounds:
// at most one process per VM named at start, one request in flight per VM, a timeout on every request (the process is
// killed and started again on the next capture), at most 16 MiB per answer, and a 10 s pause after a failed start.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firstExisting, pwshCandidates, readPassword } from './hyperv-guest-check-prototype.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./hyperv-guest/capture-io.ps1', import.meta.url));
export const GUEST_CAPTURE_PWSH_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH]);
export const GUEST_CAPTURE_START_TIMEOUT_MS = 90_000; // opening PowerShell Direct took up to ~38 s on a busy guest
export const GUEST_CAPTURE_READ_TIMEOUT_MS = 15_000;
export const GUEST_CAPTURE_SETUP_TIMEOUT_MS = 180_000;
export const GUEST_CAPTURE_RETRY_MS = 10_000;
export const MAX_GUEST_CAPTURE_LINE_BYTES = 16 * 1024 * 1024;
const VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USER_RE = /^(?:\.\\)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\/)(?![\\/])/;
const SAFE_CODES = new Set([
  'desktop_unavailable', 'desktop_vm_not_found', 'desktop_input_rejected', 'desktop_broker_timeout',
  'desktop_guest_auth_failed', 'desktop_guest_frame_missing', 'desktop_guest_frame_stale', 'desktop_guest_password_unreadable',
]);
export const GUEST_SETUP_OPS = Object.freeze(['install', 'remove']);

const captureError = (code) => Object.assign(new Error(code), { code, outcome: 'unknown' });
const safeCode = (code) => (SAFE_CODES.has(code) ? code : 'desktop_unavailable');

function checkOptions({ user, passwordFile, pwsh, openProcess }) {
  if (typeof user !== 'string' || !USER_RE.test(user)) throw new TypeError('invalid_guest_capture_user');
  if (typeof passwordFile !== 'string' || passwordFile.length === 0) throw new TypeError('guest_password_file_required');
  if ((pwsh !== undefined && !(typeof pwsh === 'string' && ABSOLUTE_RE.test(pwsh))) || typeof openProcess !== 'function') {
    throw new TypeError('invalid_guest_capture_options');
  }
}

/** Resolves pwsh to an absolute path once (a bare "pwsh" could start a planted pwsh.exe from the current directory). */
function pwshResolver(pwsh) {
  const candidates = pwsh === undefined ? pwshCandidates() : [pwsh];
  let found;
  return async () => (found === undefined ? (found = await firstExisting(candidates)) : found);
}

/**
 * The guest screens of the VMs named in `vms`. `capture` resolves to the PNG bytes (untrusted) or throws an Error whose
 * `code` is a fixed desktop_* code. `close` stops every process.
 * @param {{vms: string[], user?: string, passwordFile: string, pwsh?: string, openProcess?: Function,
 *   startTimeoutMs?: number, readTimeoutMs?: number, retryMs?: number, now?: () => number}} options
 *   `openProcess({command, args})` is for tests; the default spawns pwsh and returns {write, onLine, onClose, kill}.
 */
export function createGuestScreenSource({
  vms, user = 'Administrator', passwordFile, pwsh, openProcess = openLineProcess,
  startTimeoutMs = GUEST_CAPTURE_START_TIMEOUT_MS, readTimeoutMs = GUEST_CAPTURE_READ_TIMEOUT_MS, retryMs = GUEST_CAPTURE_RETRY_MS, now = Date.now,
} = {}) {
  checkOptions({ user, passwordFile, pwsh, openProcess });
  if (!Array.isArray(vms) || vms.length < 1 || !vms.every((vm) => typeof vm === 'string' && VM_NAME_RE.test(vm))) {
    throw new TypeError('invalid_guest_capture_vms');
  }
  const resolvePwsh = pwshResolver(pwsh);
  const sessions = new Map(vms.map((vm) => [vm, { proc: null, waiting: null, queue: Promise.resolve(), failedAt: -Infinity, failedCode: null }]));
  let closed = false;

  const ask = (s, line, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.waiting = null; stop(s); reject(captureError('desktop_broker_timeout')); }, timeoutMs);
    s.waiting = { resolve, reject, timer };
    s.proc.write(`${line}\n`);
  });

  function stop(s) {
    const proc = s.proc;
    s.proc = null;
    if (s.waiting) { clearTimeout(s.waiting.timer); s.waiting.reject(captureError('desktop_unavailable')); s.waiting = null; }
    proc?.kill();
  }

  async function start(s, vmId) {
    const command = await resolvePwsh();
    if (!command) throw captureError('desktop_unavailable');
    const password = await readPassword(passwordFile);
    if (password === null) throw captureError('desktop_guest_password_unreadable');
    let proc;
    try { proc = openProcess({ command, args: GUEST_CAPTURE_PWSH_ARGS }); }
    catch { throw captureError('desktop_unavailable'); }
    s.proc = proc;
    proc.onLine((line) => {
      if (s.proc !== proc || !s.waiting) return;
      const { resolve, timer } = s.waiting;
      clearTimeout(timer);
      s.waiting = null;
      resolve(parseLine(line));
    });
    proc.onClose(() => { if (s.proc === proc) stop(s); });
    const reply = await ask(s, JSON.stringify({ op: 'serve', vmName: vmId, user, password }), startTimeoutMs);
    if (reply?.ok !== true) { stop(s); throw captureError(safeCode(reply?.code)); }
  }

  async function read(s, vmId, width, height) {
    if (closed) throw captureError('desktop_unavailable');
    if (!s.proc) {
      if (now() - s.failedAt < retryMs) throw captureError(s.failedCode);
      try { await start(s, vmId); }
      catch (error) { s.failedAt = now(); s.failedCode = safeCode(error.code); throw captureError(s.failedCode); }
    }
    const reply = await ask(s, JSON.stringify({ op: 'read', width, height }), readTimeoutMs);
    if (reply?.ok === true && typeof reply.png === 'string') return Buffer.from(reply.png, 'base64');
    throw captureError(safeCode(reply?.code));
  }

  return Object.freeze({
    handles: (vmId) => sessions.has(vmId),
    /** One request in flight per VM: a second caller (the wall and an agent) waits for the first. */
    capture({ vmId, width, height }) {
      const s = sessions.get(vmId);
      if (!s) return Promise.reject(captureError('desktop_vm_not_found'));
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
        return Promise.reject(captureError('desktop_input_rejected'));
      }
      const result = s.queue.then(() => read(s, vmId, width, height));
      s.queue = result.catch(() => {});
      return result;
    },
    close() {
      closed = true;
      for (const s of sessions.values()) stop(s);
    },
  });
}

/**
 * Install or remove the guest helper of one VM (`albera-runtime guest-capture install|remove`). Never throws:
 * `{ok: true}` or `{ok: false, code}` with a fixed code.
 */
export async function runGuestCaptureSetup({
  op, vmId, user = 'Administrator', passwordFile, pwsh, openProcess = openLineProcess, timeoutMs = GUEST_CAPTURE_SETUP_TIMEOUT_MS,
} = {}) {
  checkOptions({ user, passwordFile, pwsh, openProcess });
  if (!GUEST_SETUP_OPS.includes(op) || typeof vmId !== 'string' || !VM_NAME_RE.test(vmId)) return { ok: false, code: 'desktop_input_rejected' };
  const command = await pwshResolver(pwsh)();
  if (!command) return { ok: false, code: 'guest_pwsh_missing' };
  const password = await readPassword(passwordFile);
  if (password === null) return { ok: false, code: 'guest_password_unreadable' };
  let proc;
  try { proc = openProcess({ command, args: GUEST_CAPTURE_PWSH_ARGS }); }
  catch { return { ok: false, code: 'desktop_unavailable' }; }
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, code: 'desktop_broker_timeout' }); }, timeoutMs);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    proc.onLine((line) => done(parseLine(line)));
    proc.onClose(() => done(null));
    proc.write(`${JSON.stringify({ op, vmName: vmId, user, password })}\n`);
  });
  proc.kill();
  return reply?.ok === true ? { ok: true } : { ok: false, code: safeCode(reply?.code) };
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** Fixed command + fixed args, no shell; stdout is split into lines (16 Mi characters at most each); stderr is drained, never surfaced. */
export function openLineProcess({ command, args }) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lineHandlers = [];
  const closeHandlers = [];
  let buffer = '';
  let closed = false;
  const close = () => { if (!closed) { closed = true; for (const fn of closeHandlers) fn(); } };
  child.on('error', close);
  child.on('close', close);
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    buffer += data;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      for (const fn of lineHandlers) fn(line);
    }
    if (buffer.length > MAX_GUEST_CAPTURE_LINE_BYTES) { buffer = ''; child.kill(); }
  });
  return {
    write: (text) => { if (!closed) child.stdin.write(text); },
    onLine: (fn) => { lineHandlers.push(fn); },
    onClose: (fn) => { closeHandlers.push(fn); },
    kill: () => { if (!closed) child.kill(); },
  };
}
