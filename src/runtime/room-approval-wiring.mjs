import { WSL2_ISOLATION } from './broker-contract/wsl2-run-lease.mjs';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createApprovedOperationFlow } from './approved-operation-flow.mjs';
import { createTaskStartGate, isStartableTask } from './task-start-gate.mjs';
import { ID_PATTERN } from './broker-contract/action-digest.mjs';
import { isVmId } from './broker-contract/network-attestation.mjs';
import { openSqliteEnvironmentStore } from './sqlite-operation-store.mjs';
import { getApprovalStatus, submitApproval, authoritySubmitPipeName, validateServerExpectation as validateAuthorityExpectation } from './approval-authority-client.mjs';
import { brokerPipePath, sendBrokerFence, sendBrokerInspect, sendBrokerRequest, validateServerExpectation as validateBrokerExpectation } from './windows-broker-client.mjs'; // arch-allow: the Broker pipe client is composed here, the one place that wires the real clients to the task-start gate
import { createWindowsDesktopBrokerClient } from './windows-desktop-broker-client.mjs';

// `albera-runtime room --require-start-approval --approval <file>` (#115 follow-up, step A3; desktop path: ADR-002 "Amendment 2026-11-03", option C): the composition that makes the room's start gate real
// and routes the room's screens and input through the Host Broker's desktop pipe. It is the wiring point (entry role): it reads the settings file, opens the durable flow journal, binds the real
// pipe clients and builds the gate of task-start-gate.mjs on the approved-operation flow. No decision is made here.
//
//   settings file (JSON, strict: unknown keys are refused; it holds paths, names and public hashes, never a secret):
//     { "version": 1, "projectId": "...",
//       "broker": { "pipeName": "...", "expect": { "serviceName": "..." } },
//       "authority": { "pipeRoot": "...", "expect": { "serviceName": "..." } },
//       "journal": "<absolute path of the SQLite store>",
//       "computers": { "<hyper-v vm name>": "<computerId>" },
//       "desktop": { "helperPath": "<absolute path of the installed pipe client helper>", "helperSha256": "<64 hex of that exe>" },
//       "attestation": null }
//
// The gated room reaches no Hyper-V API itself (the Control Plane account has no Hyper-V rights): the screens and the input go to the Broker's desktop pipe `<broker.pipeName>_desktop`, whose server
// must be the service `broker.expect.serviceName` (owner SID, the SCM's PID, session 0). A service-name expectation is required and the `{ ownerSid, pid }` form is not accepted here. No image hash
// (`imageSha256`) is used or accepted: the Control Plane's restricted identity cannot open the Broker's process (lab, 2026-11-03: OpenProcess denied even for PROCESS_QUERY_LIMITED_INFORMATION), so a
// helper asked to hash the image would always end `server_identity_unavailable`; replacing the Broker's image needs an administrator (Program Files), which is outside the threat model. The helper
// at `desktop.helperPath` must be the build `desktop.helperSha256` (a file Node hashes itself); the same pinned helper starts the fence, claim, inspect, submit and status requests too, so a swapped
// helper cannot answer `claimed` for a start nobody approved. `computers` maps the room's VM names to the Broker's computer ids. The hands' desktop session
// is the approved task.start operation. Not available in the gated room (refused at start, `runtime_room_gated_out_of_scope`): guest capture, done checks, the guest helper and a task.start checkpoint
// attestation (`attestation` must be null); each needs its own ADR amendment.
//
// Errors are fixed codes (`runtime_room_approval_*`); the file's content and its paths are never printed.
// The clients and the store are injectable so the unit tests open no pipe, no database and no helper process.

export const APPROVAL_SETTINGS_VERSION = 1;
export const MAX_APPROVAL_SETTINGS_BYTES = 16 * 1024;
/** The one refusal for every feature the gated room does not have yet. The CLI prints the line and exits 1. */
export const GATED_OUT_OF_SCOPE = 'runtime_room_gated_out_of_scope';
export const GATED_OUT_OF_SCOPE_LINE = `${GATED_OUT_OF_SCOPE}: guest capture, done checks, the guest helper and task.start checkpoint attestation are not available with --require-start-approval (ADR-002, Amendment 2026-11-03).`;
const MAX_COMPUTERS = 8;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID_RE = new RegExp(ID_PATTERN);
const TOP_KEYS = ['version', 'projectId', 'broker', 'authority', 'journal', 'computers', 'desktop', 'attestation', 'wsl2'];
const BROKER_KEYS = ['pipeName', 'expect'];
const AUTHORITY_KEYS = ['pipeRoot', 'expect'];
const COMPUTER_KEYS = ['computerId', 'vmId', 'expectedGeneration', 'isolation', 'repositoryId'];
const WSL2_KEYS = ['pipeName', 'serverSid', 'serverImageSha256', 'git'];
const WSL2_PIPE_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const SID_RE = /^S-1-\d{1,10}(?:-\d{1,10}){1,15}$/u;
/** The one folder the pipe client helper may be in when it serves a WSL2 job: setup's tree hash covers it, and only administrators can write it (ADR-012, SEC-1). */
export const PIPE_CLIENT_INSTALL_DIR = String.raw`C:\Program Files\Albera\bin\pipe-client`;
/** The git the quarantine runs parses a hostile pack as the Control Plane's identity, so it must be where only administrators can write. */
export const GIT_INSTALL_DIR = String.raw`C:\Program Files\Git`;
const isInsideFolder = (file, folder) => { const rel = path.win32.relative(folder.toLowerCase(), String(file).toLowerCase()); return rel !== '' && !rel.startsWith('..') && !path.win32.isAbsolute(rel); };
const DESKTOP_KEYS = ['helperPath', 'helperSha256'];
const ATTESTATION_KEYS = ['keyFile', 'keyId', 'cloneRoot'];
const fail = (what) => new Error(`runtime_room_approval_${what}`);
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => isPlain(value) && Object.keys(value).every((key) => keys.includes(key));
const hasExactly = (value, keys) => hasOnly(value, keys) && Object.keys(value).length === keys.length;
// Absolute, already normalized (no "..", no drive-relative "\x"), and not a UNC share: the same file whatever directory the room was started in.
const isAbsolutePath = (value) => typeof value === 'string' && value.length > 0 && path.isAbsolute(value) && path.resolve(value) === value && !/^[\\/]{2}/u.test(value);

/**
 * Take `--approval <file>` out of the room's arguments. `--require-start-approval` and `--approval` come as a pair: either one alone is a fixed error.
 * @returns {{ rest: string[], approvalFile: string|null }} `rest` still holds `--require-start-approval` (the room parser takes it out itself)
 */
export function takeRoomApprovalArgs(args) {
  const rest = [];
  let approvalFile = null;
  for (let i = 0; i < args.length; i++) {
    if (String(args[i]) !== '--approval') { rest.push(args[i]); continue; }
    if (approvalFile !== null) throw new Error('runtime_option_must_be_unique');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    approvalFile = value;
  }
  const asked = rest.filter((arg) => String(arg) === '--require-start-approval').length;
  if (asked > 1) throw new Error('runtime_option_must_be_unique');
  if (asked === 1 && approvalFile === null) throw new Error('runtime_room_start_approval_needs_settings');
  if (asked === 0 && approvalFile !== null) throw new Error('runtime_room_approval_needs_start_approval');
  return { rest: rest.filter((arg) => String(arg) !== '--require-start-approval'), approvalFile };
}

function parseComputer(value) {
  if (typeof value === 'string') return ID_RE.test(value) ? Object.freeze({ computerId: value }) : null;
  if (!hasOnly(value, COMPUTER_KEYS) || typeof value.computerId !== 'string' || !ID_RE.test(value.computerId)) return null;
  if (value.isolation !== undefined || value.repositoryId !== undefined) { // a WSL2 computer has no VM, and names the repository its runs start from (ADR-012, decision 4)
    if (value.isolation !== WSL2_ISOLATION || typeof value.repositoryId !== 'string' || !ID_RE.test(value.repositoryId) || value.vmId !== undefined || value.expectedGeneration !== undefined) return null;
    return Object.freeze({ computerId: value.computerId, isolation: value.isolation, repositoryId: value.repositoryId });
  }
  const named = value.vmId !== undefined || value.expectedGeneration !== undefined;
  if (named && (!isVmId(value.vmId) || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1)) return null;
  return Object.freeze({ computerId: value.computerId, ...(named ? { vmId: value.vmId, expectedGeneration: value.expectedGeneration } : {}) });
}

function parseComputers(raw) {
  const names = isPlain(raw) ? Object.keys(raw) : [];
  if (names.length < 1 || names.length > MAX_COMPUTERS || !names.every((name) => VM_RE.test(name))) throw fail('computers');
  const out = new Map();
  const ids = new Set();
  for (const name of names) {
    const computer = parseComputer(raw[name]);
    // One computer id per VM: the approval names the computer, the hands run on the VM name, so two names for one id would let one approval start another VM.
    if (!computer || ids.has(computer.computerId)) throw fail('computers');
    // An attested computer must be the VM the Hyper-V Broker checkpoints (albera-<computerId>); otherwise the checkpoint and the attestation would be of another VM than the hands.
    if (computer.vmId !== undefined && name !== `albera-${computer.computerId}`) throw fail('computers');
    ids.add(computer.computerId);
    out.set(name, computer);
  }
  return out;
}

/** The desktop section, or null when absent (approval-check does not need it; the gated room does, see `desktopOptions`). */
function parseDesktop(raw) {
  if (raw === undefined || raw === null) return null;
  if (!hasExactly(raw, DESKTOP_KEYS) || !isAbsolutePath(raw.helperPath) || typeof raw.helperSha256 !== 'string' || !SHA256_RE.test(raw.helperSha256)) throw fail('desktop');
  return Object.freeze({ helperPath: raw.helperPath, helperSha256: raw.helperSha256 });
}

/** The WSL bridge, or null when absent. The helper is the desktop's pinned one, so it must be the installed one; `git` is the program the quarantine runs. */
function parseWsl2(raw, desktop) {
  if (raw === undefined) return null;
  const image = raw?.serverImageSha256;
  if (!hasOnly(raw, WSL2_KEYS) || typeof raw.pipeName !== 'string' || !WSL2_PIPE_RE.test(raw.pipeName) || typeof raw.serverSid !== 'string' || !SID_RE.test(raw.serverSid)
    || (image !== undefined && (typeof image !== 'string' || !SHA256_RE.test(image))) || !isAbsolutePath(raw.git)) throw fail('wsl2');
  if (!desktop || !isInsideFolder(desktop.helperPath, PIPE_CLIENT_INSTALL_DIR) || !isInsideFolder(raw.git, GIT_INSTALL_DIR)) throw fail('wsl2');
  return Object.freeze({ pipeName: raw.pipeName, serverSid: raw.serverSid, ...(image === undefined ? {} : { serverImageSha256: image }), git: raw.git });
}

function parseAttestation(raw) {
  if (raw === undefined || raw === null) return null;
  if (!hasExactly(raw, ATTESTATION_KEYS) || !isAbsolutePath(raw.keyFile) || !isAbsolutePath(raw.cloneRoot) || typeof raw.keyId !== 'string' || !ID_RE.test(raw.keyId)) throw fail('attestation');
  return Object.freeze({ keyFile: raw.keyFile, keyId: raw.keyId, cloneRoot: raw.cloneRoot });
}

/** Run a client's own validator; whatever it throws becomes this section's fixed code. */
function validated(section, check) {
  try { return check(); } catch { throw fail(section); }
}

/**
 * Parse and validate the settings text. Pure. Throws an Error whose message is a fixed code, never the content.
 * A computer that names its Hyper-V vmId only makes sense with `attestation`; one without it is refused. `desktop` may be absent here: only the gated room requires it.
 */
export function parseApprovalSettings(text) {
  if (typeof text !== 'string' || text.length > MAX_APPROVAL_SETTINGS_BYTES) throw fail('too_big');
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw fail('not_json'); }
  if (!isPlain(raw)) throw fail('invalid');
  if (Object.keys(raw).some((key) => !TOP_KEYS.includes(key))) throw fail('unknown_key');
  if (raw.version !== APPROVAL_SETTINGS_VERSION) throw fail('version');
  if (typeof raw.projectId !== 'string' || !ID_RE.test(raw.projectId)) throw fail('project');
  const broker = validated('broker', () => {
    if (!hasExactly(raw.broker, BROKER_KEYS)) throw new Error('shape');
    brokerPipePath(raw.broker.pipeName);
    return { pipeName: raw.broker.pipeName, expect: validateBrokerExpectation(raw.broker.expect) };
  });
  const authority = validated('authority', () => {
    if (!hasExactly(raw.authority, AUTHORITY_KEYS)) throw new Error('shape');
    authoritySubmitPipeName(raw.authority.pipeRoot);
    return { pipeRoot: raw.authority.pipeRoot, expect: validateAuthorityExpectation(raw.authority.expect) };
  });
  if (!isAbsolutePath(raw.journal) || path.resolve(raw.journal) !== raw.journal || raw.journal === path.parse(raw.journal).root) throw fail('journal');
  const computers = parseComputers(raw.computers);
  const desktop = parseDesktop(raw.desktop);
  const attestation = parseAttestation(raw.attestation);
  const wsl2 = parseWsl2(raw.wsl2, desktop);
  if (!wsl2 && [...computers.values()].some((computer) => computer.isolation !== undefined)) throw fail('computers');
  if (!attestation && [...computers.values()].some((computer) => computer.vmId !== undefined)) throw fail('computers');
  return Object.freeze({ version: APPROVAL_SETTINGS_VERSION, projectId: raw.projectId, broker, authority, journal: raw.journal, computers, desktop, attestation, wsl2 });
}

/** Read the settings file (a regular file, small) and parse it. The error never names the path. */
export function loadApprovalSettings(file, io = { statSync, readFileSync }) {
  let text;
  try {
    const stat = io.statSync(file);
    if (!stat.isFile() || stat.size > MAX_APPROVAL_SETTINGS_BYTES) throw new Error('too_big');
    text = io.readFileSync(file, 'utf8');
  } catch { throw fail('unreadable'); }
  return parseApprovalSettings(text);
}

/** The room's jobs against the settings: a VM with no computer, or a task that cannot be a task.start argument, is refused before anything is requested. */
export function checkJobsAgainstSettings(settings, jobs) {
  if (!jobs.every((job) => settings.computers.has(job.vmId))) throw fail('vm_unmapped');
  if (!jobs.every((job) => isStartableTask(job.task))) throw fail('task_not_startable');
}

/**
 * The features the gated room does not have yet, asked for on the command line or in the workspace: guest capture (`--guest-capture`, a workspace's `capture: "guest"`), done checks (`--checks`,
 * a workspace's `checks`) and the guest helper's password file. They all need guest credentials, which no Broker config holds (ADR-002 "Amendment 2026-11-03"). With `approvalFile` the settings'
 * `attestation` is asked too (a task.start checkpoint attestation changes VM settings): the file is read here so that every out-of-scope request is refused in one early step, before the API key is
 * looked at; a settings file that cannot be read or parsed throws its own `runtime_room_approval_*` code. Throws GATED_OUT_OF_SCOPE.
 * @param {{ guestCapture?: string[], checks?: object, checksFile?: string|null, guestPasswordFile?: string|null }} options
 * @param {{ approvalFile?: string|null, io?: object }} [settings]
 */
export function refuseGatedOutOfScope(options, { approvalFile = null, io = { statSync, readFileSync } } = {}) {
  const asked = (options.guestCapture?.length ?? 0) > 0 || Object.keys(options.checks ?? {}).length > 0 || Boolean(options.checksFile) || Boolean(options.guestPasswordFile);
  if (asked) throw new Error(GATED_OUT_OF_SCOPE);
  if (approvalFile !== null && loadApprovalSettings(approvalFile, io).attestation) throw new Error(GATED_OUT_OF_SCOPE);
}

const PIPE_CLIENTS = ['sendBrokerFence', 'sendBrokerRequest', 'sendBrokerInspect', 'submitApproval', 'getApprovalStatus'];

/**
 * The five claim/approval pipe clients, each told to start the installed helper (`desktop.helperPath`) and to refuse any other build (`desktop.helperSha256`). Without this they would start the
 * helper from the repository's build output, and a swapped helper could answer `claimed` for a start nobody approved. Same shape as approval-check's `withHelper`, plus the pin.
 */
function withPinnedHelper(deps, { helperPath, helperSha256 }) {
  const bound = { ...deps };
  for (const name of PIPE_CLIENTS) bound[name] = (options) => deps[name]({ ...options, helperPath, helperSha256 });
  return bound;
}

/**
 * What the desktop client needs, from the settings: the Broker's desktop pipe (`<pipeName>_desktop`, derived by the client) with a service-name expectation (never an image hash, see the header),
 * and the pinned helper. Anything else is `runtime_room_approval_desktop`: no `desktop` section, no service name, a PID (the `{ ownerSid, pid }` form can be spoofed by any same-user process), or an
 * `imageSha256` (the helper could never verify it as the Control Plane, and the claim path would end the same way).
 */
function desktopOptions(settings) {
  const { pipeName, expect } = settings.broker;
  const { desktop } = settings;
  if (!desktop || typeof expect.serviceName !== 'string' || expect.pid !== undefined || expect.imageSha256 !== undefined) throw fail('desktop');
  return { pipeName, expect: { ...expect }, helperPath: desktop.helperPath, helperSha256: desktop.helperSha256 };
}

const desktopError = (code) => Object.assign(new Error(code), { code, outcome: 'not_applied' });

/**
 * The `{ captureVmScreen, sendVmInput }` object HyperVDesktopDriver takes as its Broker, over the desktop Broker client. The room names VMs by their Hyper-V name; the Broker knows computer ids, so
 * `computerIdFor(vmName)` translates (a VM with no computer is `desktop_vm_not_found`, nothing sent). The lease reaches the Broker as the operation id only: the Node side's generation counts jobs, not
 * the Broker's leases, so it is left out and the Broker joins the lease that is current for that operation.
 */
export function createGatedDesktopBroker({ client, computerIdFor }) {
  const computer = (vmId) => {
    const computerId = computerIdFor(vmId);
    if (computerId === undefined) throw desktopError('desktop_vm_not_found');
    return computerId;
  };
  return Object.freeze({
    captureVmScreen: async ({ vmId, width, height }) => client.captureVmScreen({ vmId: computer(vmId), width, height }),
    sendVmInput: async ({ vmId, action, lease }) => client.sendVmInput({ vmId: computer(vmId), action, lease: { desktopSessionId: lease?.desktopSessionId } }),
  });
}

function brokerPort(settings, clients) {
  const { pipeName, expect } = settings.broker;
  return {
    fence: ({ computerId }) => clients.sendBrokerFence({ pipeName, expect, computerId }),
    claim: (request) => clients.sendBrokerRequest({ pipeName, expect, ...request }),
    inspect: ({ operationId }) => clients.sendBrokerInspect({ pipeName, expect, operationId }),
  };
}

/**
 * `includeDigest: true` makes every submit also carry `expectedDigest` (the client's own computation; the Authority recomputes it and answers `request_invalid` on a difference).
 * `onSubmitted(fields, reply)` sees each accepted submit (the room service uses it to learn the approval id while the flow is still waiting); its failure never reaches the flow.
 */
function authorityPort(settings, clients, { includeDigest = false, onSubmitted } = {}) {
  const { pipeRoot, expect } = settings.authority;
  return {
    async submit(fields) {
      const reply = await clients.submitApproval({ pipeRoot, expect, ...fields, ...(includeDigest ? { includeDigest: true } : {}) });
      if (reply?.ok === true && onSubmitted) { try { onSubmitted(fields, reply); } catch { /* a listener must not break the flow */ } }
      return reply;
    },
    status: ({ approvalId }) => clients.getApprovalStatus({ pipeRoot, expect, approvalId }),
  };
}

const sleepUnref = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
const freshOperationId = () => `start-${randomBytes(8).toString('hex')}`;
const REAL = Object.freeze({
  sendBrokerFence, sendBrokerRequest, sendBrokerInspect, submitApproval, getApprovalStatus,
  openStore: openSqliteEnvironmentStore, createDesktopClient: createWindowsDesktopBrokerClient,
  newOperationId: freshOperationId, now: Date.now, sleep: sleepUnref,
});

/**
 * Open everything a gated room needs and return its start gate and the Broker object that carries its screens and input.
 * @param {{ approvalFile: string, jobs: { vmId: string, task: string }[], io?: object, deps?: object, authority?: { includeDigest?: boolean, onSubmitted?: Function } }} options `io` = { statSync, readFileSync };
 *   `deps` replaces the real clients, store and desktop client (tests); `authority` = the submit options of authorityPort (the room service sets both)
 * @returns {Promise<{ gate: { startApproved: Function }, desktopBroker: object, notice: string, requestInitialStarts: (host: { requestStart: Function }) => Promise<string[]>, close: () => void,
 *   flow: { run: Function }, settings: object, newOperationId: () => string }>} `flow`, `settings` and `newOperationId` are what the room service builds its job screen's approvals from
 */
export async function openRoomApproval({ approvalFile, jobs, io = { statSync, readFileSync }, deps = {}, authority: authorityOptions = {} } = {}) {
  const d = { ...REAL, ...deps };
  const settings = loadApprovalSettings(approvalFile, io);
  if (settings.attestation) throw new Error(GATED_OUT_OF_SCOPE); // a checkpoint attestation changes VM settings: not for the first gated run
  checkJobsAgainstSettings(settings, jobs);
  let desktopClient; // lazy: nothing is started or opened until the first capture
  let pipes; // the claim and approval clients, bound to the same pinned helper
  try {
    const desktop = desktopOptions(settings);
    pipes = withPinnedHelper(d, desktop);
    desktopClient = d.createDesktopClient(desktop);
  } catch { throw fail('desktop'); } // missing settings or options the client refuses
  let store;
  try { store = await d.openStore(settings.journal); } catch { void desktopClient.close().catch(() => {}); throw fail('journal_unavailable'); }
  const close = () => {
    void Promise.resolve().then(() => desktopClient.close()).catch(() => {}); // the helper processes end; a second call is harmless
    try { store.close(); } catch { /* already closed */ }
  };
  try {
    const flow = createApprovedOperationFlow({ broker: brokerPort(settings, pipes), authority: authorityPort(settings, pipes, authorityOptions), journal: store.flowJournal(), now: d.now, sleep: d.sleep });
    const computerIdFor = (vmId) => settings.computers.get(vmId)?.computerId;
    const gate = createTaskStartGate({ flow, projectId: settings.projectId, newOperationId: d.newOperationId, computerIdFor });
    const desktopBroker = createGatedDesktopBroker({ client: desktopClient, computerIdFor });
    // Each initial job is requested through the room host's start path (the gate): the answer is 'pending_approval' at once, the outcome is a ledger entry.
    const requestInitialStarts = (host) => Promise.all(jobs.map((job) => host.requestStart(job.vmId, job.task)));
    const notice = 'Hands start only after approval: each start is a task.start operation; the ledger records start_approved or start_refused. Screens and input go through the Host Broker desktop pipe, not through this account.';
    return Object.freeze({ gate, desktopBroker, notice, requestInitialStarts, close, flow, settings, newOperationId: d.newOperationId });
  } catch {
    close();
    throw fail('wiring_failed');
  }
}

// Shared with approval-check.mjs (the single-operation check composes the same two ports and the same real clients).
// (The flow's optional Broker attestation port is not wired here: the gated room refuses a task.start checkpoint attestation, see GATED_OUT_OF_SCOPE.)
export { authorityPort, brokerPort, REAL as REAL_APPROVAL_DEPS };
