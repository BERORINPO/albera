// Private child-process guardian. Its stdin is a liveness pipe: EOF means the approved Gateway
// disappeared, so the provider process group must be terminated before this helper exits.
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { terminateWindowsTree } from './windows-tree-termination.mjs';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_ARGS = 128;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const INPUT_MODE = 'claude-stream-json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGABRT']);
const PARENT_EXIT_GRACE_MS = 300;
let input = '';
let parentAlive = true;
let configured = false;
let provider;
let providerPid;
let providerExited = false;
let cleanupComplete = false;
let stopping = false;
let terminationStarted = false;
let finished = false;
let inputMode = null;
let initialInput = null;

process.stdin.setEncoding('utf8');
process.stdout.on('error', () => { /* the Gateway may disappear before a final status can be reported */ });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_LINE_BYTES) return fail();
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { return fail(); }
    if (!configured && validateLaunch(message)) startProvider(message);
    else if (configured && message?.type === 'stop' && SIGNALS.has(message.signal)) {
      stopping = true;
      if (provider && !providerPid) return;
      if (providerPid && !providerExited) void terminateTree(message.signal, providerPid);
    } else if (configured && message?.type === 'input' && inputMode === INPUT_MODE
      && UUID_RE.test(message.requestId ?? '') && typeof message.text === 'string'
      && message.text.length > 0 && !message.text.includes('\0') && Buffer.byteLength(message.text) <= MAX_INPUT_BYTES) {
      if (stopping || providerExited) send({ type: 'input_rejected', requestId: message.requestId });
      else sendProviderInput(message.text, (error) => send({ type: error ? 'input_rejected' : 'input_accepted', requestId: message.requestId }));
    } else return fail();
  }
});
process.stdin.on('end', () => {
  parentAlive = false;
  if (!provider) return finish(0);
  if (!providerExited && providerPid) void terminateTree('SIGTERM', providerPid);
  else if (providerExited) finish(0);
});
process.stdin.resume();

function validateLaunch(message) {
  const keys = Object.keys(message ?? {}).sort();
  const baseKeys = ['args', 'cwd', 'env', 'executable', 'type'];
  const inputKeys = [...baseKeys, 'initialInput', 'inputMode'].sort();
  const validKeys = (keys.length === baseKeys.length && keys.every((key, index) => key === baseKeys[index]))
    || (keys.length === inputKeys.length && keys.every((key, index) => key === inputKeys[index]));
  if (!message || message.type !== 'launch' || typeof message.executable !== 'string' || !path.isAbsolute(message.executable)
    || !validKeys
    || !Array.isArray(message.args) || message.args.length > MAX_ARGS || message.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || message.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > MAX_ARG_BYTES
    || typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd)
    || !message.env || typeof message.env !== 'object' || Array.isArray(message.env)
    || Object.entries(message.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
    || Buffer.byteLength(JSON.stringify(message.env)) > MAX_ENV_BYTES
    || (Object.hasOwn(message, 'inputMode') && (message.inputMode !== INPUT_MODE || typeof message.initialInput !== 'string'
      || message.initialInput.length === 0 || message.initialInput.includes('\0') || Buffer.byteLength(message.initialInput) > MAX_INPUT_BYTES))
    || (!Object.hasOwn(message, 'inputMode') && Object.hasOwn(message, 'initialInput'))) return false;
  configured = true;
  inputMode = message.inputMode ?? null;
  initialInput = message.initialInput ?? null;
  return true;
}

function startProvider(message) {
  if (!parentAlive) return finish(0);
  try {
    provider = spawn(message.executable, message.args, {
      cwd: message.cwd, env: message.env, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: inputMode === INPUT_MODE ? ['pipe', 'ignore', 'ignore'] : 'ignore',
    });
  } catch { return fail(); }
  provider.once('error', () => finish(1, { type: 'error' }));
  provider.once('spawn', () => {
    providerPid = provider.pid;
    send({ type: 'started', pid: providerPid });
    if (initialInput !== null) sendProviderInput(initialInput, (error) => { if (error) void terminateTree('SIGKILL', providerPid); });
    if (!parentAlive || stopping) void terminateTree('SIGTERM', providerPid);
  });
  provider.once('close', (code, signal) => {
    providerExited = true;
    if (!parentAlive && !cleanupComplete) return;
    finish(0, { type: 'exit', code: Number.isInteger(code) ? code : null, signal: typeof signal === 'string' ? signal : null });
  });
}

function sendProviderInput(text, callback) {
  if (inputMode !== INPUT_MODE || !provider?.stdin || provider.stdin.destroyed || provider.stdin.writableEnded
    || provider.stdin.writableLength > MAX_INPUT_BYTES * 4) return callback(new Error('input_unavailable'));
  const message = JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  const line = `${message}\n`;
  if (Buffer.byteLength(line) > MAX_INPUT_BYTES + 256 || provider.stdin.writableLength + Buffer.byteLength(line) > MAX_INPUT_BYTES * 4) {
    return callback(new Error('input_backpressure'));
  }
  try { provider.stdin.write(line, (error) => callback(error ?? null)); }
  catch (error) { callback(error); }
}

async function terminateTree(signal, pid) {
  if (cleanupComplete || terminationStarted || !Number.isInteger(pid) || pid < 1) return;
  terminationStarted = true;
  stopping = true;
  if (process.platform === 'win32') {
    await terminateWindowsTree(pid, {
      systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      spawnImpl: spawn,
      killFallback: () => provider?.kill('SIGKILL') ?? false,
    });
  } else {
    signalGroup(pid, signal);
    if (signal !== 'SIGKILL') {
      await new Promise((resolve) => setTimeout(resolve, PARENT_EXIT_GRACE_MS));
      signalGroup(pid, 'SIGKILL');
    }
  }
  cleanupComplete = true;
  if (providerExited || !provider) finish(0, providerExited ? { type: 'exit', code: provider.exitCode ?? null, signal: provider.signalCode ?? null } : undefined);
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (!error || error.code !== 'ESRCH') { try { provider?.kill('SIGKILL'); } catch { /* process already exited */ } } }
}

function send(message) {
  if (!process.stdout.destroyed && !process.stdout.writableEnded) process.stdout.write(`${JSON.stringify(message)}\n`);
}
function fail() {
  if (provider && !providerExited) {
    parentAlive = false;
    stopping = true;
    if (providerPid) void terminateTree('SIGKILL', providerPid);
    return;
  }
  finish(1, { type: 'error' });
}
function finish(code, message) {
  if (finished) return;
  finished = true;
  if (message) send(message);
  process.stdin.pause();
  process.stdin.destroy();
  process.stdout.end(() => { process.exitCode = code; });
}
