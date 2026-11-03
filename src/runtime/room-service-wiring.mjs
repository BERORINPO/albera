import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { createAgentStatusBoard } from './agent-status-board.mjs';
import { createControlPlaneSecretStore } from './control-plane-secret-store.mjs';
import { HyperVDesktopDriver } from './hyperv-desktop-driver.mjs';
import { createWindowsFolderGuard } from './room-service-folder-guard.mjs';
import { createRoomBootstrapFile, createWindowsFileStore } from './room-bootstrap-file.mjs';
import { createRoomHost } from './room-host.mjs';
import { createRoomFeedbackRoutes } from './room-feedback-routes.mjs';
import { createRoomJobRoutes } from './room-job-routes.mjs';
import { missingRoomParts } from './room-demo.mjs';
import { openRoomApproval } from './room-approval-wiring.mjs';
import { createRoomJobApprovals, createSubmitWatch } from './room-service-approvals.mjs';
import { loadServiceConfig, roomServicePaths } from './room-service-config.mjs';
import { createRoomServiceHands } from './room-service-hands.mjs';
import { createRoomSettingsRoutes } from './room-settings-routes.mjs';
import * as roomJournalModule from './room-journal.mjs';
import * as roomFiguresModule from './room-figures.mjs';
import * as beroDirectorModule from './bero-director.mjs';
import { ALBERA_VERSION } from './albera-version.mjs';

// `albera-runtime room-service --data-root <dataRoot>`: the Control Plane service's one resident command (docs/architecture/control-plane-service.md section 2; PR4d). The .NET host starts it
// (PR2: `<node> <appPath>\src\runtime\entry.mjs room-service --data-root <dataRoot>`, cwd appPath, stdin NUL, a nine-variable environment) and keeps its stdout and stderr in capped log files.
// This file is the wiring point (entry role): it opens the parts that already exist and joins them. No decision is made here.
//   - the gated room's approval wiring (settings, pinned helper, durable flow journal, desktop client), with the submit asking for the digest check (`includeDigest`: the client also sends
//     `expectedDigest`, the Authority recomputes it) and reporting each accepted submit to the job screen;
//   - the DPAPI secret store (credential field of the room, and the one the hands read their token from);
//   - the room host on the SERVICE launch route: the one-time code goes ONLY to the bootstrap file `ui\room.json`, the host listens on 127.0.0.1 and nowhere else, and this process prints no
//     port, no URL and no code (the host captures this process's output into log files);
//   - the hands: Claude Code per approved task.start, in a new empty configuration folder per run (room-service-hands.mjs);
//   - the feedback panel, OFF unless the service file says `feedback: true` (room-service-config.mjs): then the route GET /api/feedback is registered and the room's CSP connect-src gets the intake's
//     one origin. The one thing it reports about this installation is the ALBERA version (albera-version.mjs; `deps.version` in tests).
// The bootstrap file sink is REQUIRED. Without a sink the room host would take its CLI launch route and hand the code to whoever called listen(); so a missing sink refuses the start before anything
// is opened, and so does a settings file with no `ui` block to build one from. The approval flow's durable journal is required too (openRoomApproval refuses without it).
// A `ui\room.json` of an earlier run is removed first thing, before the approval wiring is opened, and replaced by the new port and code as soon as the host listens; if that write fails the start fails.
// Every other failure clears the file again when no host was made, so a failed start never leaves an old port and code behind.
// Errors are fixed codes (`room_service_*`, `runtime_room_approval_*`); settings content and paths are never printed. The clients, stores and the driver are injectable (`deps`) so the tests
// open no pipe, no database, no helper and no real claude.

const fail = (what) => new Error(`room_service_${what}`);
const FIXED_CODE_RE = /^(?:room_service|runtime_room_approval|runtime_room_gated)_[a-z_]+$/u;
const USAGE_OR_SETTINGS_RE = /^(?:room_service_config_[a-z_]+|room_service_needs_data_root|room_service_sink_required|runtime_room_approval_[a-z_]+)$/u;
const MCP_ENTRY = fileURLToPath(new URL('./albera-desktop-mcp-main.mjs', import.meta.url));

/** Parse `room-service` arguments (after the command): exactly `--data-root <absolute path>`, or `--help`. Pure. */
export function parseRoomServiceArgs(args, platform = process.platform) {
  const Path = platform === 'win32' ? path.win32 : path;
  const options = { command: 'room-service', dataRoot: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg !== '--data-root') throw new Error('invalid_runtime_option');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (options.dataRoot !== null) throw new Error('runtime_option_must_be_unique');
    if (!Path.isAbsolute(value)) throw new Error('runtime_path_must_be_absolute');
    options.dataRoot = value;
  }
  if (!options.help && options.dataRoot === null) throw new Error('room_service_needs_data_root');
  return Object.freeze(options);
}

/**
 * Open everything and start serving. Resolves `{ close }` once the room listens and `ui\room.json` is written. It does not return the port or the code.
 * @param {{ dataRoot: string }} options
 * @param {{ bootstrapSink?: object|null, io?: object, approvalDeps?: object, secretStore?: object, createBootstrapStore?: Function, mcpEntryPath?: string,
 *   driverOptions?: object, createDriver?: Function, claudeGuard?: object, claudeInstallDir?: string, log?: (line: string) => void, captureIntervalMs?: number, tickMs?: number,
 *   version?: string }} [deps] test seams; the defaults are the real parts. `version` is the ALBERA version the feedback panel sends (default ALBERA_VERSION,
 *   albera-version.mjs, which a test keeps equal to package.json).
 */
export async function startRoomService({ dataRoot } = {}, deps = {}) {
  const log = deps.log ?? (() => {});
  const paths = roomServicePaths(dataRoot);
  const config = loadServiceConfig(paths.serviceConfig, deps.io, deps.claudeInstallDir === undefined ? undefined : { installDir: deps.claudeInstallDir });
  const sink = 'bootstrapSink' in deps ? deps.bootstrapSink
    : createRoomBootstrapFile({ filePath: paths.uiFile, acl: config.ui.acl, store: (deps.createBootstrapStore ?? createWindowsFileStore)() });
  if (typeof sink?.publish !== 'function' || typeof sink?.clear !== 'function') throw fail('sink_required'); // before any file, pipe or process is opened
  // A room.json of an earlier run goes NOW, before anything can fail: a start that fails later must not leave an old port and code behind (zaku SEC-002). Not being able to remove it is not fatal
  // here; listen() replaces it, and a start that fails after this point tries again.
  const clearSink = () => Promise.resolve().then(() => sink.clear()).catch(() => {});
  await clearSink();
  const missing = missingRoomParts({ journalModule: roomJournalModule, figuresModule: roomFiguresModule, directorModule: beroDirectorModule });
  if (missing.length) throw fail('parts_missing');

  const watch = createSubmitWatch();
  const approval = await openRoomApproval({
    approvalFile: paths.approvalFile, jobs: [], io: deps.io, deps: deps.approvalDeps, authority: { includeDigest: true, onSubmitted: watch.onSubmitted },
  });
  let room;
  let hands;
  try {
    const { settings } = approval;
    const secretStore = deps.secretStore ?? createControlPlaneSecretStore({ secretsDir: paths.secretsDir, helperPath: settings.desktop.helperPath, helperSha256: settings.desktop.helperSha256 });
    const board = createAgentStatusBoard();
    const labelOf = (vmName) => vmName.slice(0, 32);
    hands = createRoomServiceHands({
      targets: settings.computers, secretStore, runRoot: paths.runRoot, claude: config.claude, log: (line) => log(line),
      claudeGuard: deps.claudeGuard ?? createWindowsFolderGuard({ installDir: config.claudeInstallDir }),
      mcp: { command: process.execPath, entryPath: deps.mcpEntryPath ?? MCP_ENTRY, broker: { pipeName: settings.broker.pipeName, serviceName: settings.broker.expect.serviceName, ...settings.desktop } },
      driverOptions: deps.driverOptions, ...(deps.createDriver === undefined ? {} : { createDriver: deps.createDriver }),
      onEvent: (vmName, event) => { board.record(vmName, event); room?.recordFleetEvent(vmName, event); },
    });
    const approvals = createRoomJobApprovals({
      flow: approval.flow, projectId: settings.projectId, computerIds: [...settings.computers.values()].map((c) => c.computerId), watch, newOperationId: approval.newOperationId,
    });
    const targets = () => [...settings.computers].map(([vmName, c]) => ({ computerId: c.computerId, label: vmName }));
    const apiRoutes = [
      ...createRoomSettingsRoutes({ secretStore }), ...createRoomJobRoutes({ approvals, hands: { start: hands.start, stopAll: hands.stopAll }, targets }),
      ...(config.feedback ? createRoomFeedbackRoutes({ version: deps.version ?? ALBERA_VERSION }) : []), // the route and the CSP origin go together: both or neither
    ];
    room = createRoomHost({
      vms: [...settings.computers.keys()].map((vmId) => ({ vmId, label: labelOf(vmId), task: '' })), board, fleet: hands.fleet, startGate: approval.gate, apiRoutes, feedback: config.feedback,
      journal: roomJournalModule.createRoomJournal({}), director: beroDirectorModule.createBeroDirector({ buildFigure: roomFiguresModule.buildFigure, labelOf }),
      driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker: approval.desktopBroker, resolveCurrentLease }),
      bootstrapSink: sink, onBootstrapError: (code) => log(String(code).replace(/[^a-z_]/gu, '')),
      ...(deps.captureIntervalMs === undefined ? {} : { captureIntervalMs: deps.captureIntervalMs }), ...(deps.tickMs === undefined ? {} : { tickMs: deps.tickMs }),
    });
    await hands.sweep(); // folders of runs an earlier service left behind
    await room.listen(0); // 127.0.0.1 only (room-host.mjs); the port goes to the sink and nowhere else
  } catch (error) {
    await hands?.close().catch(() => {});
    await room?.close().catch(() => {}); // the host clears the file itself
    if (!room) await clearSink(); // no host was made, so nobody else will
    approval.close();
    throw error?.message === 'room_bootstrap_publish_failed' ? fail('bootstrap_failed') : error; // the room.json write failed: the room is not reachable, so the service does not run
  }
  let closing = null;
  return Object.freeze({
    close() {
      closing ??= (async () => {
        await hands.close();
        await room.close(); // clears the bootstrap file
        approval.close();
      })();
      return closing;
    },
  });
}

/**
 * The command as `albera-runtime` runs it: prints fixed lines, sets the exit code (2 = settings or usage, 1 = anything else), stays up until a signal.
 * @param {{ dataRoot: string }} options @param {object} [deps] see startRoomService @param {{ log: Function, error: Function }} [out]
 */
export async function runRoomService(options, deps = {}, out = console) {
  const say = (line) => out.log(`ALBERA room-service: ${line}`);
  let service;
  try { service = await startRoomService(options, { ...deps, log: (line) => say(line) }); } catch (error) {
    const code = typeof error?.message === 'string' && FIXED_CODE_RE.test(error.message) ? error.message : 'room_service_start_failed';
    out.error(`ALBERA room-service: ${code}`);
    process.exitCode = USAGE_OR_SETTINGS_RE.test(code) ? 2 : 1;
    return null;
  }
  say('started'); // no port, no URL, no code: the host keeps this output in a log file
  const stop = () => { void service.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return service;
}
