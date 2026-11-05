import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  CLAUDE_DISALLOWED_TOOLS, MCP_CONFIG_FILE, PREFLIGHT_REASONS, buildClaudeEnvironment, makeIo, preflight,
} from './claude-code-driver.mjs';
import { MAIN_AI_SYSTEM_PROMPT, buildTurnMessage } from './main-ai-contract.mjs';
import { terminatePosixTree } from './posix-tree-termination.mjs';
import { loadClaudeToken, makeRunFolders, removeRunFolder } from './room-service-hands.mjs';
import { terminateWindowsTree } from './windows-tree-termination.mjs';

// The main AI adapter (docs/architecture/mission-approval.md "Main AI adapter"; control-plane-service.md section 6): ONE turn of conversation is one `claude -p` run of the pinned executable with
// no tools at all, an EMPTY MCP configuration, the owner's stored token and its own new run folder. It holds no pipe, no key and no desktop: all it can do is write text, and the host checks that
// text (main-ai-contract.mjs). Its Fake is fake-main-ai.mjs. The rules are the hands' (room-service-hands.mjs, claude-code-driver.mjs), applied to a run that must not be able to do anything:
//   - `claudeGuard.check(executable)` first (the executable and its folders are administrator-only), then the token is read from the secret store for this one run; the process environment is never
//     read for a credential. A missing token is `credential_missing`, not a generic failure (the screen tells the owner where to put it).
//   - A NEW folder `<runRoot>\run-<16 hex>\{config,work}` per turn, checked by the driver's own preflight (pinned SHA-256 of the executable, empty folders, no CLAUDE.md above the work folder) and
//     deleted when the turn is over, whatever the outcome. They have the hands' name shape, so the startup sweep of room-service-hands.mjs also removes what a killed service left behind.
//   - The child is asked for no tool (`--tools ""`, the usual names denied again) and sees no MCP server. A stream `init` that lists a tool or an MCP server, or any `tool_use`, ends the run.
//   - A turn has a time limit. At the limit, on `stop()` and on `close()` the process tree of the PID started HERE is ended (taskkill /PID <pid> /T /F through windows-tree-termination.mjs, the
//     process group on POSIX), never by image name, and never after the child has exited (a PID may be reused). One turn at a time (`busy`).
// The person's words travel on stdin, not in the command line. Failures are the fixed codes of MAIN_AI_FAILURES. Logs (`log(line)`) carry codes only: never words, a token, a path or the model's text.

export const MAIN_AI_LIMITS = Object.freeze({ turnMs: 90_000, initMs: 30_000, exitGraceMs: 3000, killSettleMs: 8000, closeWaitMs: 12_000, maxOutputBytes: 1024 * 1024 });
const SAFE_TOKEN = /^[A-Za-z0-9_:.-]{1,80}$/u;
const refuse = (code) => Object.freeze({ ok: false, code });
const sleepUnref = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** The command line after the executable. Pure. `model` may be null. */
export function buildMainAiArgs({ mcpConfigPath, model = null }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--tools', '', '--disallowedTools', ...CLAUDE_DISALLOWED_TOOLS, '--disable-slash-commands',
    ...(model === null ? [] : ['--model', model]),
    '--append-system-prompt', MAIN_AI_SYSTEM_PROMPT,
  ];
}

/** stdout -> one call per JSON line. A line that is not JSON is ignored; more than `maxBytes` in all ends the run through `onTooLarge`. */
function lineReader(onMessage, maxBytes, onTooLarge) {
  let buffer = '';
  let seen = 0;
  return (chunk) => {
    seen += chunk.length;
    if (seen > maxBytes) { onTooLarge(); return; }
    buffer += chunk;
    let start = 0;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n', start)) {
      let message = null;
      try { message = JSON.parse(buffer.slice(start, newline)); } catch { /* not a message */ }
      start = newline + 1;
      if (message !== null) onMessage(message);
    }
    buffer = buffer.slice(start);
  };
}

/** What a finished child means: the reason we stopped it, else its `result` message. */
function outcomeOf(out) {
  if (out.halt !== null) return refuse(out.halt);
  if (!out.verified) return refuse('capability_unverified'); // the child never proved it has no tool: whatever it said is not used
  if (out.result === null) return refuse('no_reply');
  if (out.result.isError) return refuse('claude_error');
  return out.result.text.length > 0 ? Object.freeze({ ok: true, text: out.result.text }) : refuse('no_reply');
}

/**
 * @param {{ claude: { executable: string, executableSha256: string, model: string|null }, secretStore: { load: Function }, runRoot: string, claudeGuard: { check: Function },
 *   log?: (line: string) => void, timeoutMs?: number }} options
 *   Test seams: spawnImpl, killTreeImpl, io, platform, systemRoot, newRunId, limits (overrides of MAIN_AI_LIMITS).
 * @returns {{ turn: Function, stop: () => void, close: () => Promise<void> }} `turn({ words, state })` resolves { ok: true, text } or { ok: false, code }, and never rejects
 */
export function createClaudeMainAi({
  claude, secretStore, runRoot, claudeGuard, log = () => {}, timeoutMs, spawnImpl = spawn, killTreeImpl = null, io, platform = process.platform,
  systemRoot = process.env.SystemRoot ?? 'C:\\Windows', newRunId, limits: limitOverrides = {},
} = {}) {
  if (typeof claude?.executable !== 'string' || typeof claude?.executableSha256 !== 'string' || typeof secretStore?.load !== 'function' || typeof claudeGuard?.check !== 'function'
    || !path.isAbsolute(String(runRoot))) throw new TypeError('invalid_main_ai_dependencies');
  const limits = { ...MAIN_AI_LIMITS, ...limitOverrides, ...(timeoutMs === undefined ? {} : { turnMs: timeoutMs }) };
  const files = makeIo(io);
  let current = null; // { stopRequested, halt, done } of the turn that is running
  let closed = false;

  const note = (line) => { try { log(line); } catch { /* logging must not break a turn */ } };

  function killTree(child) {
    if (killTreeImpl) return Promise.resolve(killTreeImpl(child));
    return platform === 'win32'
      ? terminateWindowsTree(child.pid, { systemRoot, spawnImpl: spawn, killFallback: () => child.kill('SIGKILL') })
      : terminatePosixTree(child.pid, 'SIGTERM', { fallbackImpl: () => child.kill('SIGKILL') });
  }

  /** The folder checks, then the empty MCP configuration and the command line. A fixed code when anything is wrong. */
  async function prepare(folders, token) {
    try { await preflight({ executable: claude.executable, executableSha256: claude.executableSha256, workDir: folders.workDir, configDir: folders.configDir, io: files }); } catch (error) {
      return { code: PREFLIGHT_REASONS.has(error?.message) ? error.message : 'preflight_failed' };
    }
    const tempDir = path.join(folders.configDir, 'tmp');
    const mcpConfigPath = path.join(folders.configDir, MCP_CONFIG_FILE);
    try {
      await files.mkdir(tempDir, { recursive: true });
      await files.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }), { encoding: 'utf8', mode: 0o600 });
    } catch { return { code: 'preflight_failed' }; }
    return { args: buildMainAiArgs({ mcpConfigPath, model: claude.model ?? null }), env: buildClaudeEnvironment({ oauthToken: token, configDir: folders.configDir, tempDir, platform, systemRoot }) };
  }

  /** Start the child and wait for it to be gone. Resolves the outcome (never rejects). `run.halt` ends it from outside. */
  function runChild({ args, env, cwd, message }, run) {
    return new Promise((resolve) => {
      const out = { halt: null, result: null, verified: false };
      const timers = [];
      let child;
      let settled = false;
      let killing = false;
      let killDone = Promise.resolve();
      const settle = () => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        void killDone.then(() => resolve(outcomeOf(out)));
      };
      const stopTree = () => {
        if (killing || !child || child.exitCode !== null || child.signalCode !== null || !Number.isSafeInteger(child.pid)) return; // only a child that is still ours: a finished PID may be reused
        killing = true;
        killDone = killTree(child).then((r) => { if (r?.treeConfirmed !== true) note('main-ai tree_stop_unconfirmed'); }, () => { note('main-ai tree_stop_unconfirmed'); });
        timers.push(setTimeout(settle, limits.killSettleMs)); // a child that never reports its end must not hold the caller
      };
      const halt = (code) => { if (out.halt === null && out.result === null) out.halt = code; stopTree(); }; // the first reason wins; a turn that has its result is only cleaned up
      run.halt = halt;
      try { child = spawnImpl(claude.executable, args, { cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] }); } catch { out.halt = 'spawn_failed'; settle(); return; }
      child.once('error', () => { if (!Number.isSafeInteger(child.pid)) { out.halt = 'spawn_failed'; settle(); } });
      child.once('close', settle);
      child.once('exit', () => { timers.push(setTimeout(settle, limits.exitGraceMs)); }); // a grandchild holding stdout keeps `close` away for ever, and a finished child cannot be stopped
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('error', () => {});
      const onResult = () => { child.stdin.end(); timers.push(setTimeout(stopTree, limits.exitGraceMs)); }; // the input ends and Claude Code exits by itself; if it does not, the tree is stopped
      child.stdout.on('data', lineReader((message) => onMessage(message, out, halt, onResult), limits.maxOutputBytes, () => halt('output_too_large')));
      timers.push(setTimeout(() => halt('timeout'), limits.turnMs));
      timers.push(setTimeout(() => { if (!out.verified) halt('capability_unverified'); }, limits.initMs)); // no proof in time: the child is stopped
      if (run.stopRequested) halt('stopped');
      else child.stdin.write(`${message}\n`);
    });
  }

  async function execute(input, run) {
    let folders = null;
    let result;
    try {
      const trusted = await Promise.resolve().then(() => claudeGuard.check(claude.executable)).catch(() => false); // before the token is opened: an executable that is not trusted never sees it
      const credential = trusted ? await loadClaudeToken(secretStore) : { code: 'claude_untrusted' };
      if (credential.code) result = refuse(credential.code);
      else if (run.stopRequested) result = refuse('stopped');
      else {
        folders = await makeRunFolders(runRoot, newRunId);
        const ready = await prepare(folders, credential.token);
        const message = JSON.stringify({ type: 'user', message: { role: 'user', content: buildTurnMessage(input) }, parent_tool_use_id: null });
        result = ready.code ? refuse(ready.code) : await runChild({ args: ready.args, env: ready.env, cwd: folders.workDir, message }, run);
      }
    } catch { result = refuse('main_ai_failed'); } // the cause is not shown: it may name a path or a value
    if (folders && !(await removeRunFolder(folders.runDir))) note('main-ai cleanup_failed');
    note(result.ok ? 'main-ai ended ok' : `main-ai ended code=${result.code}`);
    return result;
  }

  function turn(input) {
    if (closed) return Promise.resolve(refuse('closed'));
    if (current !== null) return Promise.resolve(refuse('busy'));
    const run = { stopRequested: false, halt: null, done: null };
    current = run;
    run.done = execute(input, run).finally(() => { current = null; });
    return run.done;
  }

  function stop() {
    if (current === null) return;
    current.stopRequested = true;
    current.halt?.('stopped');
  }

  return Object.freeze({
    turn,
    /** End the turn that is running (the time limit does the same by itself). */
    stop,
    /** Refuse new turns, end the running one and wait (bounded) for its folders to go. */
    async close() {
      closed = true;
      const waiting = current?.done;
      stop();
      if (waiting) await Promise.race([waiting, sleepUnref(limits.closeWaitMs)]);
    },
  });
}

/**
 * The start-up self-check. This child has NO tool and NO MCP server, and that is the only boundary (it reaches the same pipes as the Control Plane), so the `init` message must PROVE it:
 * `tools` and `mcp_servers` both present, both empty. Anything else ends the run: a non-empty list is `unexpected_capability`, a list that is missing (or no `init` at all, or a reply before it)
 * is `capability_unverified`. The check of the hands (six tools and one MCP server, control-plane-service.md 6.3) is not reused: it would accept exactly what this child must not have.
 */
function readInit(message, out, halt) {
  const { tools, mcp_servers: servers } = message;
  if (!Array.isArray(tools) || !Array.isArray(servers)) halt('capability_unverified');
  else if (tools.length > 0 || servers.length > 0) halt('unexpected_capability');
  else out.verified = true;
}

const hasToolUse = (message) => Array.isArray(message.message?.content) && message.message.content.some((block) => block?.type === 'tool_use');

/** One stream message: the self-check above, any tool use, and the final `result`. Nothing is taken from a reply that came before the proof. */
function onMessage(message, out, halt, onResult) {
  const type = message?.type;
  if (type === 'system' && message.subtype === 'init') readInit(message, out, halt);
  else if (type === 'assistant' && hasToolUse(message)) halt('unexpected_tool_use');
  else if (type === 'assistant' || type === 'result') {
    if (!out.verified) halt('capability_unverified');
    else if (type === 'result' && out.result === null) {
      const subtype = SAFE_TOKEN.test(message.subtype ?? '') ? message.subtype : 'unknown';
      out.result = { isError: message.is_error === true || message.subtype !== 'success', text: typeof message.result === 'string' ? message.result : '', subtype };
      onResult();
    }
  }
}
