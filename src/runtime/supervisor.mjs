// Parent-liveness supervisor for an approved child process. The provider launch payload travels
// over a private pipe, never through the guardian's command line or environment.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GUARDIAN_PATH = fileURLToPath(new URL('./guardian.mjs', import.meta.url));
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_PENDING_INPUTS = 4;
const INPUT_ACK_TIMEOUT_MS = 5000;
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGABRT']);

/** Start an approved executable under a small guardian that cleans it up if this parent disappears. */
export function spawnSupervised(executable, args, options) {
  const launch = JSON.stringify({ type: 'launch', executable, args, cwd: options.cwd, env: options.env,
    ...(options.inputMode === undefined ? {} : { inputMode: options.inputMode, initialInput: options.initialInput }) });
  if (Buffer.byteLength(launch) > MAX_PROTOCOL_BYTES) throw new TypeError('supervisor_request_too_large');

  const guardian = spawn(process.execPath, [GUARDIAN_PATH], {
    cwd: options.cwd,
    env: guardianEnvironment(options.env),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return new SupervisedChild(guardian, launch, options.inputMode === 'claude-stream-json');
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
  #inputEnabled;
  #pendingInputs = new Map();

  constructor(guardian, launch, inputEnabled = false) {
    super();
    this.#guardian = guardian;
    this.#inputEnabled = inputEnabled;
    guardian.once('error', () => this.#fail());
    guardian.once('close', (code, signal) => {
      if (!this.#providerExited) this.#fail();
      this.#closed = true;
      this.#rejectPendingInputs();
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

  writeInput(text) {
    if (!this.#inputEnabled || typeof text !== 'string' || text.length === 0 || text.includes('\0')
      || Buffer.byteLength(text) > MAX_INPUT_BYTES || this.#closed || !this.#guardian.stdin.writable) {
      return Promise.reject(new Error('input_unavailable'));
    }
    if (this.#pendingInputs.size >= MAX_PENDING_INPUTS) return Promise.reject(new Error('input_busy'));
    const requestId = randomUUID();
    const line = `${JSON.stringify({ type: 'input', requestId, text })}\n`;
    if (Buffer.byteLength(line) > MAX_INPUT_BYTES + 256 || this.#guardian.stdin.writableLength + Buffer.byteLength(line) > MAX_PROTOCOL_BYTES) {
      return Promise.reject(new Error('input_backpressure'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingInputs.delete(requestId);
        reject(new Error('input_ack_timeout'));
        this.#fail();
      }, INPUT_ACK_TIMEOUT_MS);
      timer.unref?.();
      this.#pendingInputs.set(requestId, { resolve, reject, timer });
      try {
        this.#guardian.stdin.write(line, (error) => {
          if (!error) return;
          const pending = this.#pendingInputs.get(requestId);
          if (!pending) return;
          this.#pendingInputs.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error('input_pipe_failed'));
        });
      } catch {
        const pending = this.#pendingInputs.get(requestId);
        if (pending) {
          this.#pendingInputs.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error('input_pipe_failed'));
        }
      }
    });
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
      } else if (message?.type === 'input_accepted' && typeof message.requestId === 'string') {
        const pending = this.#pendingInputs.get(message.requestId);
        if (!pending) return this.#fail();
        this.#pendingInputs.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve();
      } else if (message?.type === 'input_rejected' && typeof message.requestId === 'string') {
        const pending = this.#pendingInputs.get(message.requestId);
        if (!pending) return this.#fail();
        this.#pendingInputs.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.reject(new Error('input_rejected'));
      } else if (message?.type === 'error') this.#fail();
      else return this.#fail();
    }
  }

  #fail() {
    if (this.#providerExited || this.#closed) return;
    this.#providerExited = true;
    this.#rejectPendingInputs();
    this.exitCode = 1;
    this.emit('error', new Error('supervisor_failed'));
    // Ask the guardian to clean up its provider before any caller considers killing the guardian.
    try { this.#guardian.stdin.write('{"type":"stop","signal":"SIGKILL"}\n'); } catch { /* pipe already closed */ }
  }

  #rejectPendingInputs() {
    for (const pending of this.#pendingInputs.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('supervisor_failed'));
    }
    this.#pendingInputs.clear();
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
