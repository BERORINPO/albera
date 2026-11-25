// A stand-in for the child process `claude -p` as main-ai-claude.mjs starts it: `spawnImpl` makes a fake child (pid, stdin, stdout, exit events) and hands it to a script. Nothing here starts a
// process or reads a credential. The kill seam records the PID it was asked to stop and makes the fake child exit, so a test can see WHICH process the adapter ended.
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';

let nextPid = 40_000;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = nextPid++;
    this.exitCode = null;
    this.signalCode = null;
    this.input = '';
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.gotInput = new Promise((resolve) => { this.stdin.once('data', () => resolve()); });
    this.stdin.on('data', (chunk) => { this.input += chunk; });
    this.ended = new Promise((resolve) => { this.stdin.once('end', () => resolve()); });
  }

  say(message) { this.stdout.write(`${JSON.stringify(message)}\n`); }

  exit(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (signal === null) this.exitCode = code; else this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.emit('close', code, signal);
  }

  /** The process ends but something else still holds its stdout: `exit` comes, `close` never does. */
  exitHeld(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  kill() { this.exit(null, 'SIGKILL'); return true; }
}

/** The stream-json lines of a run that answers with `text`: init (no tools, no MCP server), the assistant text, the result. `init` and `result` patch those messages. */
export function replyLines(text, { init = {}, result = {} } = {}) {
  return [
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [], ...init },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, result: text, ...result },
  ];
}

/** A script: when the user message arrives, say `lines`; when the input ends, exit like `claude -p` does. */
export const answers = (lines) => async (child) => {
  await child.gotInput;
  for (const line of lines) child.say(line);
  void child.ended.then(() => child.exit(0));
};

/** A script that never answers and never exits (a stuck child). */
export const hangs = () => async () => {};

/** @param {(child: FakeChild, record: object) => unknown} script */
export function createFakeClaude(script) {
  const spawned = [];
  const killed = [];
  function spawnImpl(executable, args, options) {
    const child = new FakeChild();
    const at = args.indexOf('--mcp-config');
    const record = {
      executable, args, options, child,
      mcpConfig: at >= 0 ? readFileSync(args[at + 1], 'utf8') : null, // read now: the folder is gone when the run is over
      cwdEntries: readdirSync(options.cwd),
    };
    spawned.push(record);
    setImmediate(() => { void script(child, record); });
    return child;
  }
  function killTreeImpl(child) {
    killed.push(child.pid);
    child.kill();
    return Promise.resolve({ treeConfirmed: true });
  }
  return { spawnImpl, killTreeImpl, spawned, killed };
}
