import { createPrivateKey, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createApprovedOperationFlow } from './approved-operation-flow.mjs';
import { createTaskStartGate, isStartableTask } from './task-start-gate.mjs';
import { ID_PATTERN } from './broker-contract/action-digest.mjs';
import { isVmId } from './broker-contract/network-attestation.mjs';
import { createEcdsaAttestationSigner } from './ecdsa-attestation-signer.mjs';
import { createHyperVEnvironmentBrokerPrototype } from './hyperv-environment-broker-prototype.mjs';
import { openSqliteEnvironmentStore } from './sqlite-operation-store.mjs';
import { getApprovalStatus, submitApproval, authoritySubmitPipeName, validateServerExpectation as validateAuthorityExpectation } from './approval-authority-client.mjs';
import { brokerPipePath, sendBrokerFence, sendBrokerInspect, sendBrokerRequest, validateServerExpectation as validateBrokerExpectation } from './windows-broker-client.mjs'; // arch-allow: the Broker pipe client is composed here, the one place that wires the real clients to the task-start gate

// `albera-runtime room --require-start-approval --approval <file>` (#115 follow-up, step A3): the composition that makes the room's start gate real. It is the wiring point (entry role):
// it reads the settings file, opens the durable flow journal, binds the real pipe clients and builds the gate of task-start-gate.mjs on the approved-operation flow. No decision is made here.
//
//   settings file (JSON, strict: unknown keys are refused; it holds paths and names, never a secret):
//     { "version": 1, "projectId": "...",
//       "broker": { "pipeName": "...", "expect": { "serviceName": "..." } },
//       "authority": { "pipeRoot": "...", "expect": { "serviceName": "..." } },
//       "journal": "<absolute path of the SQLite store>",
//       "computers": { "<hyper-v vm name>": "<computerId>" | { "computerId": "...", "vmId": "<hyper-v vm guid>", "expectedGeneration": 1 } },
//       "attestation": null | { "keyFile": "<absolute path of a PKCS#8 PEM P-256 private key>", "keyId": "...", "cloneRoot": "<absolute path>" } }
//
// Errors are fixed codes (`runtime_room_approval_*`); the file's content, its paths and any key material are never printed.
// The clients, the store and the prototype are injectable so the unit tests open no pipe, no database and no key file.

export const APPROVAL_SETTINGS_VERSION = 1;
export const MAX_APPROVAL_SETTINGS_BYTES = 16 * 1024;
const MAX_KEY_FILE_BYTES = 4096;
const MAX_COMPUTERS = 8;
const VM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID_RE = new RegExp(ID_PATTERN);
const TOP_KEYS = ['version', 'projectId', 'broker', 'authority', 'journal', 'computers', 'attestation'];
const BROKER_KEYS = ['pipeName', 'expect'];
const AUTHORITY_KEYS = ['pipeRoot', 'expect'];
const COMPUTER_KEYS = ['computerId', 'vmId', 'expectedGeneration'];
const ATTESTATION_KEYS = ['keyFile', 'keyId', 'cloneRoot'];
const fail = (what) => new Error(`runtime_room_approval_${what}`);
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value, keys) => isPlain(value) && Object.keys(value).every((key) => keys.includes(key));
const hasExactly = (value, keys) => hasOnly(value, keys) && Object.keys(value).length === keys.length;
const isAbsolutePath = (value) => typeof value === 'string' && value.length > 0 && path.isAbsolute(value);

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
  const named = value.vmId !== undefined || value.expectedGeneration !== undefined;
  if (named && (!isVmId(value.vmId) || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1)) return null;
  return Object.freeze({ computerId: value.computerId, ...(named ? { vmId: value.vmId, expectedGeneration: value.expectedGeneration } : {}) });
}

function parseComputers(raw) {
  const names = isPlain(raw) ? Object.keys(raw) : [];
  if (names.length < 1 || names.length > MAX_COMPUTERS || !names.every((name) => VM_RE.test(name))) throw fail('computers');
  const out = new Map();
  for (const name of names) {
    const computer = parseComputer(raw[name]);
    if (!computer) throw fail('computers');
    out.set(name, computer);
  }
  return out;
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
 * A computer that names its Hyper-V vmId only makes sense with `attestation`; one without it is refused.
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
  const attestation = parseAttestation(raw.attestation);
  if (!attestation && [...computers.values()].some((computer) => computer.vmId !== undefined)) throw fail('computers');
  return Object.freeze({ version: APPROVAL_SETTINGS_VERSION, projectId: raw.projectId, broker, authority, journal: raw.journal, computers, attestation });
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

/** Load the PKCS#8 PEM key (by path, small regular file) and make the Broker's signer. The error never names the path or the key. */
function loadSigner(attestation, io, createKey) {
  try {
    const stat = io.statSync(attestation.keyFile);
    if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) throw new Error('key_file');
    return createEcdsaAttestationSigner({ keyId: attestation.keyId, privateKey: createKey(io.readFileSync(attestation.keyFile, 'utf8')) });
  } catch { throw fail('attestation_unavailable'); }
}

/** The flow's optional Broker attestation port: the Hyper-V prototype answers the envelope or null; the flow wants `{ ok, attestation }`. */
function taskStartPort(prototype) {
  return async (ask) => {
    const envelope = await prototype.attestTaskStart(ask);
    return envelope ? { ok: true, attestation: envelope } : { ok: false, code: 'attestation_unavailable' };
  };
}

function brokerPort(settings, clients, prototype) {
  const { pipeName, expect } = settings.broker;
  return {
    fence: ({ computerId }) => clients.sendBrokerFence({ pipeName, expect, computerId }),
    claim: (request) => clients.sendBrokerRequest({ pipeName, expect, ...request }),
    inspect: ({ operationId }) => clients.sendBrokerInspect({ pipeName, expect, operationId }),
    ...(prototype ? { attestTaskStart: taskStartPort(prototype) } : {}),
  };
}

function authorityPort(settings, clients) {
  const { pipeRoot, expect } = settings.authority;
  return {
    submit: (fields) => clients.submitApproval({ pipeRoot, expect, ...fields }),
    status: ({ approvalId }) => clients.getApprovalStatus({ pipeRoot, expect, approvalId }),
  };
}

const sleepUnref = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
const freshOperationId = () => `start-${randomBytes(8).toString('hex')}`;
const REAL = Object.freeze({
  sendBrokerFence, sendBrokerRequest, sendBrokerInspect, submitApproval, getApprovalStatus,
  openStore: openSqliteEnvironmentStore, createPrototype: createHyperVEnvironmentBrokerPrototype,
  createKey: (pem) => createPrivateKey({ key: pem, format: 'pem' }), newOperationId: freshOperationId, now: Date.now, sleep: sleepUnref,
});

/**
 * Open everything a gated room needs and return its start gate.
 * @param {{ approvalFile: string, jobs: { vmId: string, task: string }[], io?: object, deps?: object }} options `io` = { statSync, readFileSync }; `deps` replaces the real clients, store, prototype and key reader (tests)
 * @returns {Promise<{ gate: { startApproved: Function }, attested: boolean, notice: string, requestInitialStarts: (host: { requestStart: Function }) => Promise<string[]>, close: () => void }>}
 */
export async function openRoomApproval({ approvalFile, jobs, io = { statSync, readFileSync }, deps = {} } = {}) {
  const d = { ...REAL, ...deps };
  const settings = loadApprovalSettings(approvalFile, io);
  checkJobsAgainstSettings(settings, jobs);
  const signer = settings.attestation ? loadSigner(settings.attestation, io, d.createKey) : null;
  let store;
  try { store = await d.openStore(settings.journal); } catch { throw fail('journal_unavailable'); }
  const close = () => { try { store.close(); } catch { /* already closed */ } };
  try {
    const prototype = signer ? d.createPrototype({ goldenImages: {}, cloneRoot: settings.attestation.cloneRoot, attestationSigner: signer }) : null;
    const flow = createApprovedOperationFlow({ broker: brokerPort(settings, d, prototype), authority: authorityPort(settings, d), journal: store.flowJournal(), now: d.now, sleep: d.sleep });
    const gate = createTaskStartGate({
      flow, projectId: settings.projectId, newOperationId: d.newOperationId,
      computerIdFor: (vmId) => settings.computers.get(vmId)?.computerId,
      attestationFor: (vmId) => {
        const { vmId: hyperVId, expectedGeneration } = settings.computers.get(vmId) ?? {};
        return hyperVId === undefined ? undefined : { vmId: hyperVId, expectedGeneration };
      },
    });
    // Each initial job is requested through the room host's start path (the gate): the answer is 'pending_approval' at once, the outcome is a ledger entry.
    const requestInitialStarts = (host) => Promise.all(jobs.map((job) => host.requestStart(job.vmId, job.task)));
    const notice = `Hands start only after approval: each start is a task.start operation${prototype ? ' (a Broker checkpoint may let the policy approve it without a person)' : ''}; the ledger records start_approved or start_refused.`;
    return Object.freeze({ gate, attested: prototype !== null, notice, requestInitialStarts, close });
  } catch {
    close();
    throw fail('wiring_failed');
  }
}
