// PROTOTYPE. Read-only checks inside a Hyper-V guest over PowerShell Direct (spec/room.md §7).
// Runs as the same OS user as the caller (needs the local "Hyper-V Administrators" group); it is NOT the
// privileged Host Broker of ADR-002. Used only by `albera-runtime room --checks` (a local command the user starts).
// Transport: a fixed `pwsh -File <fixed path>` process. The VM name, the user, the password and the checks travel
// as one JSON request on stdin. No command line is ever assembled from data.
// The guest password is read from the file at each run and goes only into that stdin request: never into argv,
// env, a log line, an event, an error or a report. Only one finding code per check comes back from the VM.
// pwsh is started by an absolute path, resolved once: a bare "pwsh" would make Windows search the current directory
// first, so a planted pwsh.exe there could receive the password on stdin.
import { spawn } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReport, unavailable, validChecks, validVmName } from './fake-guest-checker.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./hyperv-guest/check-io.ps1', import.meta.url));
export const GUEST_CHECK_PWSH_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH]);
export const GUEST_CHECK_TIMEOUT_MS = 60_000;
const USER_RE = /^(?:\.\\)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PASSWORD_BYTES = 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const SAFE_CODES = new Set(['guest_vm_not_found', 'guest_vm_not_running', 'guest_auth_failed', 'guest_unavailable', 'guest_check_invalid']);

const isAbsolutePath = (p) => typeof p === 'string' && (path.win32.isAbsolute(p) || path.posix.isAbsolute(p)) && !/^\\\\/.test(p);

/**
 * Where PowerShell 7 is installed, in order: the MSI install (%ProgramFiles%\PowerShell\7\pwsh.exe), then the
 * Microsoft Store install's app alias (%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe). Only absolute paths.
 */
export function pwshCandidates(env = process.env) {
  const programFiles = isAbsolutePath(env.ProgramFiles) ? env.ProgramFiles : 'C:\\Program Files';
  const out = [path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')];
  if (isAbsolutePath(env.LOCALAPPDATA)) out.push(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  return out;
}

/** The first candidate that exists, or null. lstat, not stat: a Store app alias is a reparse point that stat refuses. */
export async function firstExisting(candidates) {
  for (const candidate of candidates) {
    const found = await lstat(candidate).then((s) => s.isFile() || s.isSymbolicLink(), () => false);
    if (found) return candidate;
  }
  return null;
}

/**
 * @param {{user?: string, passwordFile: string, pwsh?: string, timeoutMs?: number,
 *   runPowerShell?: (request: {command: string, args: readonly string[], input: string, timeoutMs: number}) => Promise<{stdout: string, timedOut?: boolean}>}} options
 *   `pwsh`: an absolute path (default: the first of `pwshCandidates()` that exists), resolved once at the first run.
 *   `runPowerShell` is for tests; the default spawns pwsh with the fixed arguments and writes `input` to stdin.
 */
export function createHyperVGuestChecker({ user = 'Administrator', passwordFile, pwsh, timeoutMs = GUEST_CHECK_TIMEOUT_MS, runPowerShell = spawnPowerShell } = {}) {
  if (typeof user !== 'string' || !USER_RE.test(user)) throw new TypeError('invalid_guest_check_user');
  if (typeof passwordFile !== 'string' || passwordFile.length === 0) throw new TypeError('guest_password_file_required');
  if ((pwsh !== undefined && !isAbsolutePath(pwsh)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('invalid_guest_check_options');
  if (typeof runPowerShell !== 'function') throw new TypeError('invalid_guest_check_options');
  const candidates = Object.freeze(pwsh === undefined ? pwshCandidates() : [pwsh]);
  let pwshPath; // undefined until the first run, then the absolute path or null

  return Object.freeze({
    /** Never throws: every failure is `{verdict: 'unavailable', results: [], code}` with a fixed code. */
    async run(vmId, checks) {
      if (!validVmName(vmId) || !validChecks(checks)) return unavailable('guest_check_invalid');
      if (pwshPath === undefined) pwshPath = await firstExisting(candidates);
      if (!pwshPath) return unavailable('guest_pwsh_missing');
      const password = await readPassword(passwordFile);
      if (password === null) return unavailable('guest_password_unreadable');
      // Only the fields of each kind are sent (validCheck already refused any other key).
      const input = JSON.stringify({ vmName: vmId, user, password, checks: checks.map((c) => ({ ...c })) });
      let out;
      try { out = await runPowerShell({ command: pwshPath, args: GUEST_CHECK_PWSH_ARGS, input, timeoutMs }); }
      catch { return unavailable('guest_unavailable'); }
      if (out?.timedOut) return unavailable('guest_check_timeout');
      const parsed = lastJsonLine(out?.stdout);
      if (parsed?.ok === true) return checkReport(checks, parsed.findings);
      return unavailable(SAFE_CODES.has(parsed?.code) ? parsed.code : 'guest_unavailable');
    },
  });
}

/** The password file's text without a BOM and trailing line breaks, or null (missing, empty, too big). */
export async function readPassword(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(MAX_PASSWORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PASSWORD_BYTES) { buffer.fill(0); return null; }
    const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '').replace(/[\r\n]+$/, '');
    buffer.fill(0);
    return text.length > 0 && !/[\u0000\r\n]/.test(text) ? text : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function lastJsonLine(stdout) {
  if (typeof stdout !== 'string') return null;
  const line = stdout.trim().split(/\r?\n/).pop();
  try { return JSON.parse(line); } catch { return null; }
}

/** Fixed command + fixed args, no shell; stderr is drained and never surfaced (it may hold host paths). */
function spawnPowerShell({ command, args, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new Error('guest_unavailable')); return; }
    const out = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { child.kill(); finish(resolve, { stdout: '', timedOut: true }); }, timeoutMs);
    child.on('error', () => finish(reject, new Error('guest_unavailable')));
    child.stdout.on('data', (data) => {
      outBytes += data.length;
      if (outBytes > MAX_STDOUT_BYTES) { child.kill(); finish(reject, new Error('guest_unavailable')); return; }
      out.push(data);
    });
    child.stderr.on('data', (data) => {
      errBytes += data.length;
      if (errBytes > MAX_STDERR_BYTES) child.stderr.destroy();
    });
    child.on('close', () => finish(resolve, { stdout: Buffer.concat(out).toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
