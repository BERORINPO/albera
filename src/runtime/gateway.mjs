// Runtime Gateway: isolated lifecycle boundary. It is intentionally not connected to the read-only Observer.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const RUNTIME_PROVIDERS = Object.freeze({ claude: 'claude', codex: 'codex', opencode: 'opencode' });
export const RUNTIME_PROFILES = Object.freeze({ readOnly: 'read-only' });
const MAX_ARGS = 128;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_RUNS = 64;
const MAX_EVENTS = 256;
const MAX_ACTIVE = 4;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const STOP_GRACE_MS = 3000;
const BASE_ENV = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
]);
const PROVIDER_ENV = Object.freeze({
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'CODEX_HOME'],
  opencode: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
});
const PROVIDER_ENDPOINT_ENV = Object.freeze({
  claude: ['ANTHROPIC_BASE_URL'],
  codex: ['OPENAI_BASE_URL'],
  opencode: ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'],
});

export class GatewayError extends Error {
  /** @param {'confirmation_required'|'unknown_provider'|'invalid_args'|'cwd_not_allowed'|'executable_unavailable'|'capacity'|'unknown_run'|'spawn_failed'|'stop_failed'|'authorization_failed'|'gateway_closed'|'unsupported_profile'|'profile_unavailable'} code */
  constructor(code) { super(code); this.name = 'GatewayError'; this.code = code; }
}

/** Build a provider-specific, read-only launch vector. No caller-supplied argv is accepted. */
export function buildProviderLaunch(provider, prompt, profile = RUNTIME_PROFILES.readOnly) {
  if (!Object.hasOwn(RUNTIME_PROVIDERS, provider)) throw new GatewayError('unknown_provider');
  if (profile !== RUNTIME_PROFILES.readOnly) throw new GatewayError('unsupported_profile');
  if (typeof prompt !== 'string' || prompt.includes('\0') || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new GatewayError('invalid_args');
  // Keep user text in a clearly labeled positional prompt, so leading CLI-looking text cannot
  // be reinterpreted as an option by provider argument parsers.
  const taskPrompt = `ALBERA task:\n${prompt}`;
  let args;
  if (provider === 'claude') {
    // Claude Code's restricted mode removes command-running tools and confines file tools to the project.
    args = ['--restricted', '--permission-mode', 'plan', '--print', '--max-turns', '1', '--no-session-persistence', taskPrompt];
  } else {
    // Codex's read-only filesystem sandbox does not prove MCP side effects are disabled, and
    // OpenCode merges remote, user, project, plugin and inline configuration. Until ALBERA owns
    // and verifies the complete per-run tool/configuration policy, fail closed for both.
    throw new GatewayError('profile_unavailable');
  }
  validateArgs(args);
  return Object.freeze({ profile, args: Object.freeze(args) });
}

/** Resolve a fixed provider command from PATH. Windows command shims (.cmd/.bat) are never accepted. */
export async function resolveProviderExecutable(provider, { platform = process.platform, pathValue, env = process.env } = {}) {
  const command = RUNTIME_PROVIDERS[provider];
  if (!command) return null;
  const windows = platform === 'win32';
  const pathApi = windows ? path.win32 : path;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const searchPath = pathValue ?? (pathKey ? env[pathKey] : undefined) ?? '';
  const directories = searchPath.split(windows ? ';' : path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = pathApi.join(directory, `${command}${windows ? '.exe' : ''}`);
    try {
      const canonical = await realpath(candidate);
      const details = await stat(canonical);
      if (!details.isFile()) continue;
      if (windows && path.win32.extname(canonical).toLowerCase() !== '.exe') continue;
      if (!windows) await access(canonical, fsConstants.X_OK);
      return canonical;
    } catch { /* search the next PATH entry without exposing OS errors */ }
  }
  return null;
}

/** @typedef {{id: string, provider: string, status: 'starting'|'running'|'stopping'|'stopped'|'exited'|'failed', startedAt: number|null, finishedAt: number|null, exitCode: number|null, signal: string|null, treeStopConfirmed: boolean|null, timer: ReturnType<typeof setTimeout>|null, child: import('node:child_process').ChildProcess}} Run */

/**
 * Memory-only lifecycle gateway. `authorize` is a trusted host callback, not request data; default denies.
 * @param {{roots: string[], authorize?: (request: object) => boolean|Promise<boolean>, platform?: string, maxActive?: number, runTimeoutMs?: number, spawnImpl?: typeof spawn, resolveExecutableImpl?: (provider: string, options: object) => Promise<string|null>, buildLaunchImpl?: (provider: string, profile: string, prompt: string) => {profile: string, args: string[]}, env?: NodeJS.ProcessEnv, now?: () => number, signalTreeImpl?: (pid: number, signal: 'SIGTERM'|'SIGKILL', child: import('node:child_process').ChildProcess) => void|Promise<void>}} options
 */
export class RuntimeGateway {
  #roots; #platform; #maxActive; #runTimeoutMs; #spawn; #resolveExecutable; #buildLaunch; #authorize; #env; #now; #signalTree; #closing = false;
  /** @type {Map<string, Run>} */ #runs = new Map();
  #pendingStarts = 0;
  /** @type {Array<{id: number, runId: string, provider: string, type: string, at: number, code?: number|null, signal?: string|null}>} */ #events = [];
  #nextEventId = 1;

  constructor({ roots, authorize = () => false, platform = process.platform, maxActive = MAX_ACTIVE, runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS, spawnImpl = spawn, resolveExecutableImpl = resolveProviderExecutable, buildLaunchImpl = (provider, profile, prompt) => buildProviderLaunch(provider, prompt, profile), env = process.env, now = Date.now, signalTreeImpl } = {}) {
    if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) throw new TypeError('RuntimeGateway requires absolute allowed roots');
    if (typeof authorize !== 'function') throw new TypeError('RuntimeGateway requires a host authorization callback');
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > MAX_ACTIVE) throw new TypeError('maxActive must be between 1 and 4');
    if (!Number.isInteger(runTimeoutMs) || runTimeoutMs < 1 || runTimeoutMs > MAX_RUN_TIMEOUT_MS) throw new TypeError('runTimeoutMs must be between 1 and 3600000');
    this.#roots = [...new Set(roots)];
    this.#platform = platform;
    this.#maxActive = maxActive;
    this.#runTimeoutMs = runTimeoutMs;
    this.#spawn = spawnImpl;
    this.#resolveExecutable = resolveExecutableImpl;
    if (typeof buildLaunchImpl !== 'function') throw new TypeError('buildLaunchImpl must be a function');
    this.#buildLaunch = buildLaunchImpl;
    this.#authorize = authorize;
    this.#env = env;
    this.#now = now;
    this.#signalTree = signalTreeImpl ?? ((pid, signal, child) => signalProcessTree(pid, signal, child, this.#platform, this.#spawn));
  }

  /** Start a fixed provider executable after trusted host authorization of the exact launch tuple. */
  async start(request = {}) {
    if (this.#closing) throw new GatewayError('gateway_closed');
    if (request === null || typeof request !== 'object' || Object.hasOwn(request, 'args')) throw new GatewayError('invalid_args');
    const { provider, cwd, prompt, profile = RUNTIME_PROFILES.readOnly } = request;
    if (!Object.hasOwn(RUNTIME_PROVIDERS, provider)) throw new GatewayError('unknown_provider');
    const launch = this.#buildLaunch(provider, profile, prompt);
    if (!launch || launch.profile !== profile || !Array.isArray(launch.args)) throw new GatewayError('unsupported_profile');
    validateArgs(launch.args);
    const launchArgs = [...launch.args];
    this.#pruneRuns();
    const active = [...this.#runs.values()].filter((run) => isActive(run.status)).length;
    if (active + this.#pendingStarts >= this.#maxActive || this.#runs.size + this.#pendingStarts >= MAX_RUNS) throw new GatewayError('capacity');
    this.#pendingStarts++;
    try {
      const resolvedCwd = await this.#allowedDirectory(cwd);
      if (this.#closing) throw new GatewayError('gateway_closed');
      let executable;
      try { executable = await this.#resolveExecutable(provider, { platform: this.#platform }); }
      catch { throw new GatewayError('executable_unavailable'); }
      if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new GatewayError('executable_unavailable');
      executable = await validateExecutable(executable, this.#platform);
      if (this.#closing) throw new GatewayError('gateway_closed');
      const environment = childEnvironment(provider, this.#env);
      const authorized = await this.#authorizeSafely({
        action: 'start', provider, profile, executable, cwd: resolvedCwd, args: launchArgs,
        environment: environmentSummary(provider, environment),
        platform: this.#platform, maxDurationMs: this.#runTimeoutMs, maxActive: this.#maxActive,
      });
      if (this.#closing) throw new GatewayError('gateway_closed');
      if (!authorized) throw new GatewayError('confirmation_required');

      let child;
      try {
        child = this.#spawn(executable, launchArgs, {
          cwd: resolvedCwd, env: environment, shell: false,
          detached: this.#platform !== 'win32', windowsHide: true, stdio: 'ignore',
        });
      } catch { throw new GatewayError('spawn_failed'); }
      const run = /** @type {Run} */ ({
        id: randomUUID(), provider, status: 'starting', startedAt: null, finishedAt: null,
        exitCode: null, signal: null, treeStopConfirmed: null, timer: null, child,
      });
      this.#runs.set(run.id, run);
      child.once('spawn', () => {
        if (run.status !== 'starting') return;
        run.status = 'running'; run.startedAt = this.#now(); this.#emit(run, 'started');
        run.timer = setTimeout(() => { void this.#requestStop(run).catch(() => safeKill(run.child)); }, this.#runTimeoutMs);
        run.timer.unref?.();
      });
      child.once('error', () => {
        if (!isActive(run.status)) return;
        this.#clearTimer(run); run.status = 'failed'; run.finishedAt = this.#now(); this.#emit(run, 'failed');
      });
      child.once('close', (code, signal) => {
        this.#clearTimer(run);
        if (run.status === 'failed') return;
        run.exitCode = Number.isInteger(code) ? code : null;
        run.signal = typeof signal === 'string' ? signal : null;
        run.status = run.status === 'stopping'
          ? (run.treeStopConfirmed === false ? 'failed' : 'stopped')
          : 'exited';
        run.finishedAt = this.#now(); this.#emit(run, run.status, { code: run.exitCode, signal: run.signal });
      });
      return this.#snapshot(run);
    } finally { this.#pendingStarts--; }
  }

  /** Stop a known run only after trusted host authorization for that run ID. */
  async stop(id) {
    const run = this.#runs.get(id);
    if (!run) throw new GatewayError('unknown_run');
    if (!isActive(run.status) || run.status === 'stopping') return this.#snapshot(run);
    if (!await this.#authorizeSafely({ action: 'stop', provider: run.provider, runId: run.id, force: this.#platform === 'win32' })) throw new GatewayError('confirmation_required');
    await this.#requestStop(run);
    return this.#snapshot(run);
  }

  get(id) { const run = this.#runs.get(id); if (!run) throw new GatewayError('unknown_run'); return this.#snapshot(run); }
  list() { return [...this.#runs.values()].map((run) => this.#snapshot(run)); }

  /** Bounded lifecycle events; launch input, paths, environment and process output are excluded. */
  events({ after = 0, limit = 100 } = {}) {
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const take = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
    return this.#events.filter((event) => event.id > cursor).slice(0, take).map((event) => ({ ...event }));
  }

  /** Host shutdown cleanup; returns active run IDs and IDs whose process-tree cleanup is uncertain. */
  async close({ timeoutMs = STOP_GRACE_MS + 1000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_RUN_TIMEOUT_MS) throw new TypeError('invalid shutdown timeout');
    this.#closing = true;
    const active = [...this.#runs.values()].filter((run) => isActive(run.status));
    const uncertain = [...this.#runs.values()].filter((run) => run.treeStopConfirmed === false).map((run) => run.id);
    await Promise.allSettled(active.map((run) => this.#requestStop(run)));
    if (!active.length) return uncertain;
    let timer;
    await Promise.race([
      Promise.all(active.map((run) => waitForClose(run.child))),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
    return [...new Set([...uncertain, ...active.filter((run) => isActive(run.status) || run.treeStopConfirmed === false).map((run) => run.id)])];
  }

  async #authorizeSafely(request) {
    try {
      const immutableRequest = Object.freeze({
        ...request,
        ...(Array.isArray(request.args) ? { args: Object.freeze([...request.args]) } : {}),
      });
      return await this.#authorize(immutableRequest) === true;
    }
    catch { throw new GatewayError('authorization_failed'); }
  }

  async #requestStop(run) {
    if (!isActive(run.status) || run.status === 'stopping') return;
    run.status = 'stopping'; this.#emit(run, 'stop_requested');
    const pid = run.child.pid;
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      // Do not signal a stale PID after the direct child has exited. Windows cannot reliably
      // enumerate descendants from an exited parent, so report cleanup as uncertain.
      if (Number.isInteger(pid) && pid > 0) {
        run.treeStopConfirmed = false;
        this.#emit(run, 'stop_failed');
      }
      return;
    }
    try {
      if (Number.isInteger(pid) && pid > 0) await this.#signalTree(pid, 'SIGTERM', run.child);
      else if (run.child.kill('SIGTERM') === false) throw new Error('child_signal_failed');
      if (Number.isInteger(pid) && pid > 0) run.treeStopConfirmed = true;
    } catch {
      if (Number.isInteger(pid) && pid > 0) {
        run.treeStopConfirmed = false;
        this.#emit(run, 'stop_failed');
      }
      try {
        if (run.child.kill('SIGTERM') === false) throw new Error('child_signal_failed');
      } catch {
        if (run.status === 'stopping') { run.status = 'running'; this.#emit(run, 'stop_failed'); }
        throw new GatewayError('stop_failed');
      }
    }
    run.timer = setTimeout(() => {
      if (run.status !== 'stopping') return;
      const childPid = run.child.pid;
      try {
        const escalation = Number.isInteger(childPid) && childPid > 0
          ? this.#signalTree(childPid, 'SIGKILL', run.child)
          : safeKill(run.child);
        Promise.resolve(escalation).catch(() => {
          if (Number.isInteger(childPid) && childPid > 0 && run.treeStopConfirmed !== false) {
            run.treeStopConfirmed = false;
            this.#emit(run, 'stop_failed');
          }
          safeKill(run.child);
        });
      } catch {
        if (Number.isInteger(childPid) && childPid > 0 && run.treeStopConfirmed !== false) {
          run.treeStopConfirmed = false;
          this.#emit(run, 'stop_failed');
        }
        safeKill(run.child);
      }
    }, STOP_GRACE_MS);
    run.timer.unref?.();
  }

  async #allowedDirectory(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new GatewayError('cwd_not_allowed');
    try {
      const target = await realpath(cwd);
      if (!(await stat(target)).isDirectory()) throw new GatewayError('cwd_not_allowed');
      for (const root of this.#roots) {
        const allowedRoot = await realpath(root);
        const relative = path.relative(allowedRoot, target);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return target;
      }
    } catch (error) { if (error instanceof GatewayError) throw error; }
    throw new GatewayError('cwd_not_allowed');
  }

  #emit(run, type, extra = {}) {
    this.#events.push({ id: this.#nextEventId++, runId: run.id, provider: run.provider, type, at: this.#now(), ...extra });
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
  }
  #snapshot(run) {
    return { id: run.id, provider: run.provider, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, exitCode: run.exitCode, signal: run.signal, treeStopConfirmed: run.treeStopConfirmed };
  }
  #clearTimer(run) { if (run.timer) clearTimeout(run.timer); run.timer = null; }
  #pruneRuns() {
    for (const [id, run] of this.#runs) {
      if (this.#runs.size < MAX_RUNS) break;
      if (isActive(run.status) || run.treeStopConfirmed === false) continue;
      this.#clearTimer(run); this.#runs.delete(id);
    }
  }
}

async function validateExecutable(executable, platform) {
  try {
    const canonical = await realpath(executable);
    const details = await stat(canonical);
    if (!details.isFile()) throw new GatewayError('executable_unavailable');
    if (platform === 'win32') {
      if (path.win32.extname(canonical).toLowerCase() !== '.exe') throw new GatewayError('executable_unavailable');
    } else await access(canonical, fsConstants.X_OK);
    return canonical;
  } catch { throw new GatewayError('executable_unavailable'); }
}
function validateArgs(args) {
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new GatewayError('invalid_args');
  if (args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > MAX_ARG_BYTES) throw new GatewayError('invalid_args');
}
function childEnvironment(provider, source = process.env) {
  const allowed = new Set([...BASE_ENV, ...PROVIDER_ENV[provider]].map((key) => key.toUpperCase()));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === 'string'));
}
function environmentSummary(provider, environment) {
  const findValue = (name) => {
    const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : environment[key];
  };
  const providerVariables = PROVIDER_ENV[provider]
    .filter((name) => findValue(name) !== undefined)
    .sort();
  const endpointOverrides = PROVIDER_ENDPOINT_ENV[provider].flatMap((name) => {
    const value = findValue(name);
    if (value === undefined) return [];
    try {
      const endpoint = new URL(value);
      return [{ variable: name, protocol: endpoint.protocol.slice(0, -1), host: endpoint.host || null }];
    } catch {
      return [{ variable: name, protocol: 'invalid', host: null }];
    }
  });
  return Object.freeze({
    providerVariables: Object.freeze(providerVariables),
    endpointOverrides: Object.freeze(endpointOverrides.map((endpoint) => Object.freeze(endpoint))),
  });
}
function isActive(status) { return status === 'starting' || status === 'running' || status === 'stopping'; }
function safeKill(child) { try { child.kill('SIGKILL'); } catch { /* child may have exited */ } }
function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', resolve));
}
async function signalProcessTree(pid, signal, child, platform, spawnImpl) {
  if (platform !== 'win32') {
    try { process.kill(-pid, signal); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return; throw error; }
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('system_root_unavailable');
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  // Windows cannot deliver a graceful POSIX signal to a process tree. /F is disclosed to
  // the host authorization callback before a user-requested stop and is also used for cleanup.
  const args = ['/PID', String(pid), '/T', '/F'];
  await new Promise((resolve, reject) => {
    let killer;
    try { killer = spawnImpl(taskkill, args, { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch (error) { reject(error); return; }
    killer.once('error', reject);
    killer.once('close', (code) => code === 0 ? resolve() : reject(new Error('taskkill_failed')));
  });
}
