// Private child-process guardian. Its stdin is a liveness pipe: EOF means the approved Gateway
// disappeared, so the provider process group must be terminated before this helper exits.
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_ARGS = 128;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
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
  if (!message || message.type !== 'launch' || typeof message.executable !== 'string' || !path.isAbsolute(message.executable)
    || !Array.isArray(message.args) || message.args.length > MAX_ARGS || message.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || message.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > MAX_ARG_BYTES
    || typeof message.cwd !== 'string' || !path.isAbsolute(message.cwd)
    || !message.env || typeof message.env !== 'object' || Array.isArray(message.env)
    || Object.entries(message.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))
    || Buffer.byteLength(JSON.stringify(message.env)) > MAX_ENV_BYTES) return false;
  configured = true;
  return true;
}

function startProvider(message) {
  if (!parentAlive) return finish(0);
  try {
    provider = spawn(message.executable, message.args, {
      cwd: message.cwd, env: message.env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore',
    });
  } catch { return fail(); }
  provider.once('error', () => finish(1, { type: 'error' }));
  provider.once('spawn', () => {
    providerPid = provider.pid;
    send({ type: 'started', pid: providerPid });
    if (!parentAlive || stopping) void terminateTree('SIGTERM', providerPid);
  });
  provider.once('close', (code, signal) => {
    providerExited = true;
    if (!parentAlive && !cleanupComplete) return;
    finish(0, { type: 'exit', code: Number.isInteger(code) ? code : null, signal: typeof signal === 'string' ? signal : null });
  });
}

async function terminateTree(signal, pid) {
  if (cleanupComplete || terminationStarted || !Number.isInteger(pid) || pid < 1) return;
  terminationStarted = true;
  stopping = true;
  if (process.platform === 'win32') {
    await taskkillTree(pid);
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

function taskkillTree(pid) {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root) { try { provider?.kill('SIGKILL'); } catch { /* process already exited */ } return Promise.resolve(); }
  return new Promise((resolve) => {
    let killer;
    try { killer = spawn(path.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { try { provider?.kill('SIGKILL'); } catch { /* process already exited */ } resolve(); return; }
    killer.once('error', () => { try { provider?.kill('SIGKILL'); } catch { /* process already exited */ } resolve(); });
    killer.once('close', () => resolve());
  });
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
