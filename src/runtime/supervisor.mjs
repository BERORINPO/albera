// Parent-liveness supervisor for an approved child process. The provider launch payload travels
// over a private pipe, never through the guardian's command line or environment.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GUARDIAN_PATH = fileURLToPath(new URL('./guardian.mjs', import.meta.url));
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGABRT']);

/** Start an approved executable under a small guardian that cleans it up if this parent disappears. */
export function spawnSupervised(executable, args, options) {
  const launch = JSON.stringify({ type: 'launch', executable, args, cwd: options.cwd, env: options.env });
  if (Buffer.byteLength(launch) > MAX_PROTOCOL_BYTES) throw new TypeError('supervisor_request_too_large');

  const guardian = spawn(process.execPath, [GUARDIAN_PATH], {
    cwd: options.cwd,
    env: guardianEnvironment(options.env),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return new SupervisedChild(guardian, launch);
}

class SupervisedChild extends EventEmitter {
  supervised = true;
  pid = undefined;
  exitCode = null;
  signalCode = null;
  killed = false;
  #guardian;
  #buffer = '';
  #providerExited = false;
  #closed = false;

  constructor(guardian, launch) {
    super();
    this.#guardian = guardian;
    guardian.once('error', () => this.#fail());
    guardian.once('close', (code, signal) => {
      if (!this.#providerExited) this.#fail();
      this.#closed = true;
      if (this.exitCode === null && this.signalCode === null) {
        this.exitCode = Number.isInteger(code) ? code : 1;
        this.signalCode = typeof signal === 'string' ? signal : null;
      }
      this.emit('close', this.exitCode, this.signalCode);
    });
    guardian.stdout.setEncoding('utf8');
    guardian.stdout.on('data', (chunk) => this.#consume(chunk));
    guardian.stdout.on('error', () => this.#fail());
    guardian.stdin.on('error', () => this.#fail());
    guardian.stdin.write(`${launch}\n`);
  }

  kill(signal = 'SIGTERM') {
    if (!SIGNALS.has(signal) || this.#closed || !this.#guardian.stdin.writable) return false;
    this.killed = true;
    try { return this.#guardian.stdin.write(`${JSON.stringify({ type: 'stop', signal })}\n`); }
    catch { return false; }
  }

  #consume(chunk) {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > MAX_PROTOCOL_BYTES) return this.#fail();
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { return this.#fail(); }
      if (message?.type === 'started' && Number.isSafeInteger(message.pid) && message.pid > 0 && this.pid === undefined) {
        this.pid = message.pid;
        this.emit('spawn');
      } else if (message?.type === 'exit'
        && (message.code === null || Number.isSafeInteger(message.code))
        && (message.signal === null || SIGNALS.has(message.signal))) {
        this.#providerExited = true;
        this.exitCode = message.code;
        this.signalCode = message.signal;
      } else if (message?.type === 'error') this.#fail();
      else return this.#fail();
    }
  }

  #fail() {
    if (this.#providerExited || this.#closed) return;
    this.#providerExited = true;
    this.exitCode = 1;
    this.emit('error', new Error('supervisor_failed'));
    // Ask the guardian to clean up its provider before any caller considers killing the guardian.
    try { this.#guardian.stdin.write('{"type":"stop","signal":"SIGKILL"}\n'); } catch { /* pipe already closed */ }
  }
}

function guardianEnvironment(source) {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'TMPDIR']);
  const env = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (allowed.has(key.toUpperCase()) && typeof value === 'string') env[key] = value;
  }
  if (process.platform === 'win32' && !Object.keys(env).some((key) => key.toUpperCase() === 'SYSTEMROOT')) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot) env.SystemRoot = systemRoot;
  }
  return env;
}
