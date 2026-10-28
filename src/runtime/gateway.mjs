// Runtime Gateway: isolated lifecycle boundary. It is intentionally not connected to the read-only Observer.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSupervised } from './supervisor.mjs';
import { probeCliVersion } from './cli-version.mjs';
import { isVersionAtLeast, PROFILE_MINIMUM_VERSIONS } from './profile-policy.mjs';
import { runWindowsTaskkill } from './windows-tree-termination.mjs';
import { buildProviderLaunch, RUNTIME_PROFILES, RUNTIME_PROVIDERS } from './agent-harness-adapter.mjs';
import { GatewayError } from './errors.mjs';
import { captureExecutableIdentity, sameExecutableIdentity } from './executable-identity.mjs';
export { buildProviderLaunch, RUNTIME_PROFILES, RUNTIME_PROVIDERS } from './agent-harness-adapter.mjs';
export { GatewayError } from './errors.mjs';
const MAX_ARGS = 128;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_RUNS = 64;
const MAX_EVENTS = 256;
const MAX_EVENT_SUBSCRIBERS = 8;
const MAX_ACTIVE = 4;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const STOP_GRACE_MS = 3000;
const STREAM_INPUT_MODE = 'claude-stream-json';
const STREAM_INPUT_PREFIX = 'ALBERA follow-up:\n';
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

/** @typedef {{id: string, provider: string, profile: string, inputMode: string|null, inputPending: boolean, status: 'starting'|'running'|'stopping'|'stopped'|'exited'|'failed', stopReason: 'user_cancel'|'timeout'|'host_shutdown'|null, startedAt: number|null, finishedAt: number|null, exitCode: number|null, signal: string|null, treeStopConfirmed: boolean|null, timer: ReturnType<typeof setTimeout>|null, child: import('node:child_process').ChildProcess}} Run */

/**
 * Memory-only lifecycle gateway. `authorize` is a trusted host callback, not request data; default denies.
 * @param {{roots: string[], authorize?: (request: object) => boolean|Promise<boolean>, platform?: string, maxActive?: number, runTimeoutMs?: number, spawnImpl?: typeof spawn, resolveExecutableImpl?: (provider: string, options: object) => Promise<string|null>, probeVersionImpl?: (executable: string, options: object) => Promise<string>, buildLaunchImpl?: (provider: string, profile: string, prompt: string) => {profile: string, args: string[]}, env?: NodeJS.ProcessEnv, now?: () => number, signalTreeImpl?: (pid: number, signal: 'SIGTERM'|'SIGKILL', child: import('node:child_process').ChildProcess) => void|Promise<void>, signalTreeFallbackImpl?: (pid: number, signal: 'SIGTERM'|'SIGKILL', child: import('node:child_process').ChildProcess) => void|Promise<void>}} options
 */
export class RuntimeGateway {
  #roots; #platform; #maxActive; #runTimeoutMs; #spawn; #resolveExecutable; #probeVersion; #buildLaunch; #authorize; #env; #now; #signalTree; #signalTreeFallback; #closing = false;
  /** @type {Map<string, Run>} */ #runs = new Map();
  #pendingStarts = 0;
  /** @type {Array<{id: number, runId: string, provider: string, type: string, at: number, code?: number|null, signal?: string|null}>} */ #events = [];
  #eventSubscribers = new Set();
  #nextEventId = 1;

  constructor({ roots, authorize = () => false, platform = process.platform, maxActive = MAX_ACTIVE, runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS, spawnImpl = spawnSupervised, resolveExecutableImpl = resolveProviderExecutable, probeVersionImpl = probeCliVersion, buildLaunchImpl = (provider, profile, prompt) => buildProviderLaunch(provider, prompt, profile), env = process.env, now = Date.now, signalTreeImpl, signalTreeFallbackImpl } = {}) {
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
    this.#probeVersion = probeVersionImpl;
    if (typeof buildLaunchImpl !== 'function') throw new TypeError('buildLaunchImpl must be a function');
    this.#buildLaunch = buildLaunchImpl;
    this.#authorize = authorize;
    this.#env = env;
    this.#now = now;
    this.#signalTreeFallback = signalTreeFallbackImpl ?? ((pid, signal, child) => signalProcessTree(pid, signal, child, this.#platform, spawn));
    this.#signalTree = signalTreeImpl ?? ((pid, signal, child) => child.supervised === true
      ? child.stopTree(signal)
      : this.#signalTreeFallback(pid, signal, child));
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
    const inputMode = launch.inputMode ?? null;
    const initialInput = launch.initialInput ?? null;
    if ((inputMode !== null && inputMode !== STREAM_INPUT_MODE)
      || (inputMode === null && initialInput !== null)
      || (inputMode !== null && (provider !== RUNTIME_PROVIDERS.claude || profile !== RUNTIME_PROFILES.readOnlyStreaming))
      || (profile === RUNTIME_PROFILES.readOnlyStreaming && inputMode !== STREAM_INPUT_MODE)
      || (inputMode !== null && (typeof initialInput !== 'string' || initialInput.includes('\0') || Buffer.byteLength(initialInput) > MAX_PROMPT_BYTES))) {
      throw new GatewayError('unsupported_profile');
    }
    const launchArgs = [...launch.args];
    this.#pruneRuns();
    const active = [...this.#runs.values()].filter((run) => isActive(run.status)).length;
    if (active + this.#pendingStarts >= this.#maxActive || this.#runs.size + this.#pendingStarts >= MAX_RUNS) throw new GatewayError('capacity');
    this.#pendingStarts++;
    try {
      const { path: resolvedCwd, identity: cwdIdentity } = await this.#allowedDirectory(cwd);
      if (this.#closing) throw new GatewayError('gateway_closed');
      let executable;
      try { executable = await this.#resolveExecutable(provider, { platform: this.#platform }); }
      catch { throw new GatewayError('executable_unavailable'); }
      if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new GatewayError('executable_unavailable');
      executable = await validateExecutable(executable, this.#platform);
      const executableIdentity = await getExecutableIdentity(executable);
      if (this.#closing) throw new GatewayError('gateway_closed');
      const environment = childEnvironment(provider, this.#env);
      const minimumCliVersion = PROFILE_MINIMUM_VERSIONS[profile];
      const authorized = await this.#authorizeSafely({
        action: 'start', provider, profile, executable, cwd: resolvedCwd, args: launchArgs,
        cwdIdentity,
        executableSha256: executableIdentity.sha256,
        minimumCliVersion, versionCheck: true,
        ...(initialInput === null ? {} : { initialInput }),
        environment: environmentSummary(provider, environment),
        platform: this.#platform, maxDurationMs: this.#runTimeoutMs, maxActive: this.#maxActive,
      });
      if (this.#closing) throw new GatewayError('gateway_closed');
      if (!authorized) throw new GatewayError('confirmation_required');
      await this.#allowedDirectory(cwd, cwdIdentity);
      let currentExecutable;
      try { currentExecutable = await validateExecutable(executable, this.#platform); }
      catch { throw new GatewayError('executable_unavailable'); }
      if (currentExecutable !== executable || !sameExecutableIdentity(await getExecutableIdentity(currentExecutable), executableIdentity)) {
        throw new GatewayError('executable_unavailable');
      }
      let installedVersion;
      try { installedVersion = await this.#probeVersion(executable, { platform: this.#platform }); }
      catch { throw new GatewayError('cli_version_unavailable'); }
      if (!isVersionAtLeast(installedVersion, minimumCliVersion)) throw new GatewayError('cli_version_unavailable');
      try { currentExecutable = await validateExecutable(executable, this.#platform); }
      catch { throw new GatewayError('executable_unavailable'); }
      if (currentExecutable !== executable || !sameExecutableIdentity(await getExecutableIdentity(currentExecutable), executableIdentity)) {
        throw new GatewayError('executable_unavailable');
      }
      const { path: currentCwd } = await this.#allowedDirectory(cwd, cwdIdentity);
      // These executable checks await filesystem operations. Shutdown can begin during
      // the final identity query, so check again adjacent to spawn with no await between.
      if (this.#closing) throw new GatewayError('gateway_closed');

      let child;
      try {
        child = this.#spawn(executable, launchArgs, {
          cwd: currentCwd, env: environment, shell: false,
          detached: this.#platform !== 'win32', windowsHide: true, stdio: 'ignore',
          ...(inputMode === null ? {} : { inputMode, initialInput }),
        });
      } catch { throw new GatewayError('spawn_failed'); }
      const run = /** @type {Run} */ ({
        id: randomUUID(), provider, profile, inputMode, inputPending: false, status: 'starting', stopReason: null, startedAt: null, finishedAt: null,
        exitCode: null, signal: null, treeStopConfirmed: null, timer: null, child,
      });
      this.#runs.set(run.id, run);
      child.once('spawn', () => {
        if (run.status !== 'starting') return;
        run.status = 'running'; run.startedAt = this.#now(); this.#emit(run, 'started');
        run.timer = setTimeout(() => { void this.#requestStop(run, 'timeout').catch(() => safeKill(run.child)); }, this.#runTimeoutMs);
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
        if (child.jobObjectManaged === true) {
          if (typeof child.treeStopConfirmed === 'boolean') run.treeStopConfirmed = child.treeStopConfirmed;
          else if (run.treeStopConfirmed !== false) run.treeStopConfirmed = null;
        }
        run.status = (child.jobObjectManaged === true && child.treeStopConfirmed !== true) || run.treeStopConfirmed === false
          ? 'failed'
          : run.status === 'stopping' ? 'stopped' : 'exited';
        run.finishedAt = this.#now(); this.#emit(run, run.status, { code: run.exitCode, signal: run.signal });
      });
      return this.#snapshot(run);
    } finally { this.#pendingStarts--; }
  }

  /** Stop a known run only after trusted host authorization for that run ID. */
  async stop(id) {
    if (this.#closing) throw new GatewayError('gateway_closed');
    const run = this.#runs.get(id);
    if (!run) throw new GatewayError('unknown_run');
    if (!isActive(run.status) || run.status === 'stopping') return this.#snapshot(run);
    if (!await this.#authorizeSafely({ action: 'stop', provider: run.provider, runId: run.id, force: this.#platform === 'win32' })) throw new GatewayError('confirmation_required');
    if (this.#closing) throw new GatewayError('gateway_closed');
    await this.#requestStop(run);
    return this.#snapshot(run);
  }

  /** Send one bounded follow-up only after independent host approval for this exact text. */
  async sendInput(id, text) {
    if (this.#closing) throw new GatewayError('gateway_closed');
    const run = this.#runs.get(id);
    if (!run) throw new GatewayError('unknown_run');
    if (run.inputMode !== STREAM_INPUT_MODE || typeof run.child.writeInput !== 'function') throw new GatewayError('input_unavailable');
    if (run.status !== 'running') throw new GatewayError('input_not_ready');
    if (run.inputPending) throw new GatewayError('input_busy');
    if (typeof text !== 'string' || text.length === 0 || text.includes('\0')
      || Buffer.byteLength(text) + Buffer.byteLength(STREAM_INPUT_PREFIX) > MAX_PROMPT_BYTES) throw new GatewayError('invalid_args');
    run.inputPending = true;
    try {
      const message = `${STREAM_INPUT_PREFIX}${text}`;
      if (!await this.#authorizeSafely({ action: 'input', provider: run.provider, profile: run.profile, runId: run.id, text: message })) {
        throw new GatewayError('confirmation_required');
      }
      if (this.#closing) throw new GatewayError('gateway_closed');
      if (run.status !== 'running') throw new GatewayError('input_not_ready');
      try { await run.child.writeInput(message); }
      catch { throw new GatewayError('input_failed'); }
      this.#emit(run, 'input_sent');
      return this.#snapshot(run);
    } finally { run.inputPending = false; }
  }

  get(id) { const run = this.#runs.get(id); if (!run) throw new GatewayError('unknown_run'); return this.#snapshot(run); }
  list() { return [...this.#runs.values()].map((run) => this.#snapshot(run)); }

  /** Bounded lifecycle events; launch input, paths, environment and process output are excluded. */
  events({ after = 0, limit = 100 } = {}) {
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const take = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
    return this.#events.filter((event) => event.id > cursor).slice(0, take).map((event) => ({ ...event }));
  }

  /** Subscribe to lifecycle changes so trusted hosts can persist them without waiting for a poll. */
  subscribeEvents(listener) {
    if (typeof listener !== 'function') throw new TypeError('event listener must be a function');
    if (this.#eventSubscribers.size >= MAX_EVENT_SUBSCRIBERS) throw new RangeError('event_listener_capacity');
    this.#eventSubscribers.add(listener);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      return this.#eventSubscribers.delete(listener);
    };
  }

  /** Host shutdown cleanup; returns active run IDs and IDs whose process-tree cleanup is uncertain. */
  async close({ timeoutMs = STOP_GRACE_MS + 1000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_RUN_TIMEOUT_MS) throw new TypeError('invalid shutdown timeout');
    this.#closing = true;
    const active = [...this.#runs.values()].filter((run) => isActive(run.status));
    const uncertain = [...this.#runs.values()].filter((run) => run.treeStopConfirmed === false).map((run) => run.id);
    // Subscribe before requesting stop: a supervised child can report its provider exit
    // before the guardian process itself emits the definitive `close` event.
    const closeWaits = active.map((run) => waitForClose(run.child));
    // Start all stops immediately, but keep the caller's timeout over both the stop
    // adapter and process-close phases. A hung platform helper must not hang host close.
    const pendingStops = new Set(active.map((run) => run.id));
    const stopRequests = active.map((run) => this.#requestStop(run, 'host_shutdown')
      .catch(() => {})
      .finally(() => pendingStops.delete(run.id)));
    if (!active.length) return uncertain;
    let timer;
    await Promise.race([
      Promise.all([...closeWaits, ...stopRequests]).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return [...new Set([
      ...uncertain,
      ...pendingStops,
      ...active.filter((run) => isActive(run.status) || run.treeStopConfirmed === false).map((run) => run.id),
    ])];
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

  async #requestStop(run, reason = 'user_cancel') {
    if (!isActive(run.status) || run.status === 'stopping') return;
    run.status = 'stopping';
    run.stopReason = reason;
    this.#emit(run, 'stop_requested', { stopReason: reason });
    const pid = run.child.pid;
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      if (run.child.jobObjectManaged === true) {
        run.treeStopConfirmed = typeof run.child.treeStopConfirmed === 'boolean' ? run.child.treeStopConfirmed : null;
        if (run.treeStopConfirmed !== true) this.#emit(run, 'stop_failed', { stopReason: reason });
        return;
      }
      // Do not signal a stale PID after the direct child has exited. Windows cannot reliably
      // enumerate descendants from an exited parent, so report cleanup as uncertain.
      if (Number.isInteger(pid) && pid > 0) {
        run.treeStopConfirmed = false;
        this.#emit(run, 'stop_failed');
      }
      return;
    }
    try {
      let treeResult;
      if (Number.isInteger(pid) && pid > 0) treeResult = await this.#signalTree(pid, 'SIGTERM', run.child);
      else if (run.child.kill('SIGTERM') === false) throw new Error('child_signal_failed');
      if (Number.isInteger(pid) && pid > 0) {
        run.treeStopConfirmed = run.child.supervised === true
          ? (typeof treeResult?.treeConfirmed === 'boolean' ? treeResult.treeConfirmed : null)
          : (typeof treeResult?.treeConfirmed === 'boolean' ? treeResult.treeConfirmed : true);
        if (run.treeStopConfirmed === false) this.#emit(run, 'stop_failed', { stopReason: reason });
      }
    } catch {
      let fallbackConfirmed = false;
      let fallbackRequested = false;
      if (run.child.supervised === true && run.child.jobObjectManaged !== true && Number.isInteger(pid) && pid > 0
        && run.child.exitCode === null && run.child.signalCode === null && run.child.closed !== true) {
        try {
          // If the Guardian pipe/ack failed, terminate the known provider process group/tree
          // through the OS adapter instead of only asking the possibly failed Guardian again.
          const fallbackResult = await this.#signalTreeFallback(pid, 'SIGTERM', run.child);
          fallbackConfirmed = fallbackResult?.treeConfirmed === true;
          fallbackRequested = fallbackResult?.terminationRequested === true;
        } catch { /* keep cleanup uncertain and still ask the Guardian/direct child to stop */ }
      }
      if (Number.isInteger(pid) && pid > 0) {
        run.treeStopConfirmed = fallbackConfirmed;
        if (!fallbackConfirmed) this.#emit(run, 'stop_failed', { stopReason: reason });
      }
      if (!fallbackConfirmed && !fallbackRequested) {
        try {
          if (run.child.kill('SIGTERM') === false) throw new Error('child_signal_failed');
        } catch {
          if (run.status === 'stopping') { run.status = 'running'; this.#emit(run, 'stop_failed', { stopReason: reason }); }
          throw new GatewayError('stop_failed');
        }
      }
    }
    run.timer = setTimeout(() => {
      if (run.status !== 'stopping') return;
      const childPid = run.child.pid;
      try {
        const escalation = Number.isInteger(childPid) && childPid > 0
          ? this.#signalTree(childPid, 'SIGKILL', run.child)
          : safeKill(run.child);
        Promise.resolve(escalation).then((result) => {
          if (typeof result?.treeConfirmed === 'boolean') run.treeStopConfirmed = result.treeConfirmed;
          if (run.treeStopConfirmed === false) this.#emit(run, 'stop_failed', { stopReason: reason });
        }).catch(() => {
          if (Number.isInteger(childPid) && childPid > 0 && run.treeStopConfirmed !== false) {
            run.treeStopConfirmed = false;
            this.#emit(run, 'stop_failed', { stopReason: reason });
          }
          safeKill(run.child);
        });
      } catch {
        if (Number.isInteger(childPid) && childPid > 0 && run.treeStopConfirmed !== false) {
          run.treeStopConfirmed = false;
          this.#emit(run, 'stop_failed', { stopReason: reason });
        }
        safeKill(run.child);
      }
    }, STOP_GRACE_MS);
    run.timer.unref?.();
  }

  async #allowedDirectory(cwd, expectedIdentity) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new GatewayError('cwd_not_allowed');
    try {
      const target = await realpath(cwd);
      const details = await stat(target, { bigint: true });
      if (!details.isDirectory()) throw new GatewayError('cwd_not_allowed');
      const identity = `${details.dev}:${details.ino}`;
      if (expectedIdentity !== undefined && identity !== expectedIdentity) throw new GatewayError('cwd_not_allowed');
      for (const root of this.#roots) {
        const allowedRoot = await realpath(root);
        const relative = path.relative(allowedRoot, target);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return { path: target, identity };
      }
    } catch (error) { if (error instanceof GatewayError) throw error; }
    throw new GatewayError('cwd_not_allowed');
  }

  #emit(run, type, extra = {}) {
    const event = Object.freeze({ id: this.#nextEventId++, runId: run.id, provider: run.provider, type, at: this.#now(), ...extra });
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    for (const listener of [...this.#eventSubscribers]) {
      try {
        const result = listener(event);
        if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
      } catch { /* observers cannot interrupt the authorized process lifecycle */ }
    }
  }
  #snapshot(run) {
    return {
      id: run.id, provider: run.provider, status: run.status, profile: run.profile,
      stopReason: run.stopReason,
      ...(run.inputMode === null ? {} : { inputMode: run.inputMode }),
      startedAt: run.startedAt, finishedAt: run.finishedAt, exitCode: run.exitCode, signal: run.signal,
      treeStopConfirmed: run.treeStopConfirmed,
    };
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
async function getExecutableIdentity(executable) {
  try { return await captureExecutableIdentity(executable); }
  catch { throw new GatewayError('executable_unavailable'); }
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
  if (child.closed === true) return Promise.resolve();
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
  // Windows cannot deliver a graceful POSIX signal to a process tree. /F is disclosed to
  // the host authorization callback before a user-requested stop and is also used for cleanup.
  await runWindowsTaskkill(pid, { systemRoot, spawnImpl });
}
