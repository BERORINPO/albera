import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { desktopMcpLimitArgs, parseDesktopMcpArgs } from './albera-desktop-mcp-args.mjs';
import { ID_PATTERN } from './broker-contract/action-digest.mjs';
import { createClaudeCodeDriver } from './claude-code-driver.mjs';

// The room service's hands: one Claude Code run per approved task.start (docs/architecture/control-plane-service.md section 6; PR4d). It is wiring: every decision is made elsewhere
// (the approval flow says a start was approved, the driver runs and limits one `claude -p`, the secret store opens the credential). What this file adds is the order of the steps and
// the rules that sit between them:
//   1. The VM check comes FIRST. The approved action may name a Hyper-V `vmId` and a generation (job routes pass them on as `hands.start({ vmId, expectedGeneration })`); they must be exactly what the
//      settings say for that computer. Same rule the other way: a computer the settings name with a VM must be approved with that VM. A mismatch is `vm_unknown` and NOTHING else happens: no credential
//      is opened, no folder is made, no process is started.
//   2. The credential is read from the secret store (`claude-oauth-token`) for this one run. The process environment is never read for a credential (no ANTHROPIC_API_KEY, no token variable).
//      The driver passes it to the child as CLAUDE_CODE_OAUTH_TOKEN and nothing else (claude-code-driver.mjs buildClaudeEnvironment, an allowlist).
//   3. Every run gets a NEW folder `<runRoot>\run-<16 hex>\{config,work}`, made empty here (config is the child's CLAUDE_CONFIG_DIR, HOME and USERPROFILE) and deleted when the run is over, whatever
//      the outcome. The driver refuses a config or work folder that is not empty. `sweep()` removes the folders an earlier, killed service left behind (only names of that exact shape).
//   4. One run per computer. `stop`/`stopAll` end only the runs started here, through the driver (which stops the PID it started and its tree, never by image name).
// Events reach the room's board and ledger in the same shape the API-key loop uses (start, action, step, end; usd is 0 on a subscription). The result is a CLAIM, as in the driver.
// Failures are fixed codes. Logs (`log(line)`) carry codes only: never a task, a token, a path or the Broker's text.

export const CREDENTIAL_NAME = 'claude-oauth-token';
const ID_RE = new RegExp(ID_PATTERN, 'u');
const RUN_DIR_RE = /^run-[0-9a-f]{16}$/u;
const TOKEN_RE = /^[\x21-\x7e]{8,4096}$/u;
const SCREEN = Object.freeze({ width: 1024, height: 768 }); // the MCP server's default; the pixel to Broker coordinate mapping is measurement item M13
const CLEANUP_RETRIES = Object.freeze({ maxRetries: 5, retryDelay: 100 });
const CLOSE_WAIT_MS = 12_000;
const refuse = (code) => Object.freeze({ ok: false, code });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const sleepUnref = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * @param {{ targets: Map<string, { computerId: string, vmId?: string, expectedGeneration?: number }>, secretStore: { load: Function }, runRoot: string,
 *   claude: { executable: string, executableSha256: string, model: string|null, maxMs: number, maxToolCalls: number },
 *   mcp: { command: string, entryPath: string, broker: { pipeName: string, serviceName: string, helperPath: string, helperSha256: string } },
 *   onEvent?: (vmName: string, event: object) => void, log?: (line: string) => void,
 *   createDriver?: Function, driverOptions?: object, newRunId?: () => string, now?: () => number }} options
 *   `targets` = the settings' `computers` (Hyper-V VM name -> computer). `createDriver`, `driverOptions`, `newRunId` and `now` are test seams (the driver's own seams pass through `driverOptions`).
 */
export function createRoomServiceHands({
  targets, secretStore, runRoot, claude, mcp, onEvent = () => {}, log = () => {}, createDriver = createClaudeCodeDriver, driverOptions = {},
  newRunId = () => `run-${randomBytes(8).toString('hex')}`, now = Date.now,
} = {}) {
  if (!(targets instanceof Map) || targets.size < 1 || typeof secretStore?.load !== 'function' || !path.isAbsolute(String(runRoot)) || !claude || !mcp?.broker) throw new TypeError('invalid_room_service_hands_dependencies');
  const byComputer = new Map([...targets].map(([vmName, target]) => [target.computerId, { vmName, target }]));
  const runs = new Map(); // computerId -> { stopRequested, driver, done }
  const jobs = new Map(); // vmName -> how many runs were started (the ledger's job number)
  let closed = false;

  const note = (line) => { try { log(line); } catch { /* logging must not break a run */ } };
  const emit = (vmName, event) => { try { onEvent(vmName, Object.freeze(event)); } catch { /* a listener must not break a run */ } };

  /** The approved action's VM against the settings' VM, in both directions (see the head of the file). */
  function vmMatches(target, vmId, expectedGeneration) {
    return target.vmId === vmId && target.expectedGeneration === expectedGeneration;
  }

  async function loadToken() {
    let secret;
    try { secret = await secretStore.load(CREDENTIAL_NAME); } catch (error) {
      return { code: error?.code === 'not_found' ? 'credential_missing' : error?.code === 'unprotect_failed' ? 'credential_unreadable' : 'credential_error' };
    }
    try {
      const text = secret.toString('latin1'); // the store's Buffer, wiped below (a copy of it would outlive the wipe)
      return TOKEN_RE.test(text) ? { token: text } : { code: 'credential_invalid' };
    } finally { secret.fill?.(0); }
  }

  async function makeRunFolders() {
    const runDir = path.join(runRoot, newRunId());
    if (!RUN_DIR_RE.test(path.basename(runDir))) throw new Error('run_folder_name');
    await mkdir(runRoot, { recursive: true });
    await mkdir(runDir); // not recursive: a folder that already exists is an error, never reused
    const folders = { runDir, configDir: path.join(runDir, 'config'), workDir: path.join(runDir, 'work') };
    await mkdir(folders.configDir);
    await mkdir(folders.workDir);
    return folders;
  }

  async function removeRunFolder(runDir) {
    try { await rm(runDir, { recursive: true, force: true, ...CLEANUP_RETRIES }); } catch { note('hands cleanup_failed'); }
  }

  /** The MCP server's command line (the driver appends the two limit flags). Checked with the server's own parser, so a value it would refuse is refused here. */
  function mcpServerOf({ computerId, operationId }) {
    const { broker } = mcp;
    const flags = ['--computer', computerId, '--operation', operationId, '--screen', `${SCREEN.width}x${SCREEN.height}`,
      '--pipe-name', broker.pipeName, '--service-name', broker.serviceName, '--helper', broker.helperPath, '--helper-sha256', broker.helperSha256];
    parseDesktopMcpArgs([...flags, ...desktopMcpLimitArgs({ maxCalls: claude.maxToolCalls, expiresAtMs: now() + claude.maxMs })]);
    return { command: mcp.command, args: [mcp.entryPath, ...flags] };
  }

  function eventsOf(vmName, started) {
    return (event) => {
      if (event.type === 'start') started.resolve({ ok: true });
      else if (event.type === 'tool_call') {
        emit(vmName, { type: 'action', action: event.tool });
        emit(vmName, { type: 'step', step: event.count, usd: 0, note: '' });
      }
    };
  }

  async function execute({ vmName, computerId, task, operationId }, run, started) {
    let folders = null;
    let result;
    try {
      const credential = await loadToken();
      if (credential.code) result = { outcome: 'error', reason: credential.code, claim: '', toolCalls: 0 };
      else if (run.stopRequested) result = { outcome: 'stopped', reason: 'stopped_by_human', claim: '', toolCalls: 0 };
      else {
        const mcpServer = mcpServerOf({ computerId, operationId });
        folders = await makeRunFolders();
        const driver = createDriver({
          executable: claude.executable, executableSha256: claude.executableSha256, task, oauthToken: credential.token, workDir: folders.workDir, configDir: folders.configDir,
          mcpServer, limits: { maxMs: claude.maxMs, maxToolCalls: claude.maxToolCalls }, ...(claude.model === null ? {} : { model: claude.model }),
          onEvent: eventsOf(vmName, started), ...driverOptions,
        });
        run.driver = driver;
        if (run.stopRequested) driver.stop('stopped_by_human');
        result = await driver.run();
      }
    } catch { result = { outcome: 'error', reason: 'hands_failed', claim: '', toolCalls: 0 }; } // the cause is not shown: it may name a path or a value
    if (folders) await removeRunFolder(folders.runDir);
    started.resolve({ ok: false, code: 'start_error' }); // a no-op once the child has started
    note(`hands ended outcome=${result.outcome} reason=${result.reason}`);
    emit(vmName, { type: 'end', outcome: result.outcome, claim: result.claim ?? '', steps: result.toolCalls, actions: result.toolCalls, usd: 0, reason: result.reason });
  }

  /**
   * Start one run. Synchronous part: the checks, then `{ ok: true, started }` where `started` resolves `{ ok: true }` once Claude Code is running, or `{ ok: false, code }` when the run ended before that
   * (no credential, a folder that could not be made, a binary that is not the pinned one). Or `{ ok: false, code }` at once: `vm_unknown`, `busy`, `not_started`.
   */
  function launch({ computerId, task, operationId, vmId, expectedGeneration } = {}) {
    const entry = byComputer.get(computerId);
    if (!entry || !vmMatches(entry.target, vmId, expectedGeneration)) return refuse('vm_unknown');
    if (closed || typeof task !== 'string' || task.length === 0 || typeof operationId !== 'string' || !ID_RE.test(operationId)) return refuse('not_started');
    if (runs.has(computerId)) return refuse('busy');
    const { vmName } = entry;
    const run = { stopRequested: false, driver: null, done: null };
    const started = defer();
    jobs.set(vmName, (jobs.get(vmName) ?? 0) + 1);
    emit(vmName, { type: 'start', job: jobs.get(vmName), task });
    runs.set(computerId, run);
    run.done = execute({ vmName, computerId, task, operationId }, run, started).finally(() => { runs.delete(computerId); });
    return Object.freeze({ ok: true, started: started.promise });
  }

  function stopRun(run) {
    run.stopRequested = true;
    run.driver?.stop('stopped_by_human');
  }

  /** Stop every run started here. Returns how many were running. The runs end (and their folders go) a moment later. */
  function stopAll() {
    for (const run of runs.values()) stopRun(run);
    return runs.size;
  }

  /** The fleet the room host takes (the same four calls the API-key fleet has); every start here is an approved operation, named by its id as the desktop session. */
  const fleet = Object.freeze({
    initialJobCount: 0,
    startJob(vmName, task, { desktopSessionId } = {}) {
      const entry = targets.get(vmName);
      if (!entry) return refuse('vm_unknown');
      if (desktopSessionId === undefined) return refuse('desktop_session_invalid');
      const out = launch({ computerId: entry.computerId, task, operationId: desktopSessionId });
      return out.ok ? Object.freeze({ ok: true }) : out;
    },
    stopVm(vmName) {
      const run = runs.get(targets.get(vmName)?.computerId);
      if (!run) return false;
      stopRun(run);
      return true;
    },
    async idle(vmName) { await runs.get(targets.get(vmName)?.computerId)?.done; },
  });

  return Object.freeze({
    fleet,
    /** For the job screen: resolves when Claude Code runs, or says why it did not. */
    async start(request) {
      const out = launch(request);
      return out.ok ? out.started : out;
    },
    stopAll,
    /** Remove the folders of runs an earlier service left behind. Resolves with how many went; a failure is logged and not thrown. */
    async sweep() {
      let removed = 0;
      try {
        for (const name of await readdir(runRoot)) {
          if (!RUN_DIR_RE.test(name)) continue;
          await rm(path.join(runRoot, name), { recursive: true, force: true, ...CLEANUP_RETRIES });
          removed += 1;
        }
      } catch (error) { if (error?.code !== 'ENOENT') note('hands sweep_failed'); }
      return removed;
    },
    /** Refuse new runs, stop the running ones and wait (bounded) for their folders to go. */
    async close() {
      closed = true;
      const waiting = [...runs.values()].map((run) => run.done);
      stopAll();
      await Promise.race([Promise.allSettled(waiting), sleepUnref(CLOSE_WAIT_MS)]);
    },
  });
}
