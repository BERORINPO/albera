#!/usr/bin/env node
// Independent local Runtime command. The default `albera` command stays read-only.
import path from 'node:path';
import process from 'node:process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRuntimeAuditJournal } from './audit-journal.mjs';
import { createRuntimeHost } from './host.mjs';
import { createDesktopWallHost, MAX_WALL_VMS } from './desktop-wall-host.mjs';
import { HyperVDesktopDriver } from './hyperv-desktop-driver.mjs';
import { createHyperVDesktopBrokerPrototype } from './hyperv-desktop-broker-prototype.mjs';
import { createAgentStatusBoard } from './agent-status-board.mjs';
import { createAgentFleet, MAX_FLEET_JOBS } from './agent-fleet.mjs';
import { createDesktopAgentLoop, MODEL_PRICES } from './desktop-agent-loop.mjs';
import { createRoomHost } from './room-host.mjs';
import { missingRoomParts, startRoomDemo } from './room-demo.mjs';
import { createHyperVGuestChecker } from './hyperv-guest-check-prototype.mjs';
import { createGuestScreenSource, runGuestCaptureSetup, GUEST_SETUP_OPS } from './hyperv-guest-capture-prototype.mjs';
import { validCheck, MAX_CHECKS_PER_VM } from './room-contract.mjs';
import { parseWorkspace, LIMIT_RULES, MAX_WORKSPACE_BYTES } from './workspace.mjs';
import { openRoomApproval, takeRoomApprovalArgs } from './room-approval-wiring.mjs';
import { parseApprovalCheckArgs, runApprovalCheckCommand } from './approval-check.mjs';
import * as roomJournalModule from './room-journal.mjs';
import * as roomFiguresModule from './room-figures.mjs';
import * as beroDirectorModule from './bero-director.mjs';
import { createAnthropicComputerUseClient, DEFAULT_COMPUTER_USE_MODEL } from './anthropic-computer-use-client.mjs';
import { createAnthropicPlannerClient } from './anthropic-planner-client.mjs';
import { createPlannedAgentLoop } from './planned-agent-loop.mjs';
import { loadOrCreateRuntimeSessionId } from './session-identity.mjs';
import { backupRuntimeJournal, recoverRuntimeJournalTail, restoreRuntimeJournal, verifyRuntimeJournalBackup } from './journal-backup.mjs';

const WALL_VM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WALL_LABEL_RE = /^[ -~]{1,32}$/;

// --guest-capture <vm> (repeatable) and --guest-password-file <file> (wall, agent, fleet, room): these VMs take their
// screen from the opt-in helper inside the guest (hyperv-guest/screen-helper.ps1) instead of the host thumbnail.
// Taken out before the command's own options are parsed; the password file is kept as a path only (read by the source).
function takeGuestCaptureArgs(args, { passwordFile = true } = {}) {
  const rest = [];
  const guestCapture = [];
  let guestPasswordFile = null;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg !== '--guest-capture' && !(passwordFile && arg === '--guest-password-file')) { rest.push(args[i]); continue; }
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--guest-password-file') {
      if (guestPasswordFile !== null) throw new Error('runtime_option_must_be_unique');
      guestPasswordFile = value;
    } else {
      if (!WALL_VM_RE.test(value)) throw new Error('runtime_guest_capture_vm_invalid');
      if (guestCapture.includes(value)) throw new Error('runtime_option_must_be_unique');
      guestCapture.push(value);
    }
  }
  return { rest, guestCapture: Object.freeze(guestCapture), guestPasswordFile };
}

function checkGuestCapture(guestCapture, guestPasswordFile, vmIds) {
  if (guestCapture.length > 0 && !guestPasswordFile) throw new Error('runtime_guest_capture_needs_password_file');
  if (!guestCapture.every((vm) => vmIds.includes(vm))) throw new Error('runtime_guest_capture_unknown_vm');
}

function withGuestCapture(args, parse, vmIdsOf) {
  const { rest, guestCapture, guestPasswordFile } = takeGuestCaptureArgs(args);
  const options = parse(rest);
  if (!options.help) {
    if (guestPasswordFile && guestCapture.length === 0) throw new Error('runtime_guest_password_file_needs_guest_capture');
    checkGuestCapture(guestCapture, guestPasswordFile, vmIdsOf(options));
  }
  return Object.freeze({ ...options, guestCapture, guestPasswordFile });
}

// guest-capture install|remove --vm <name> --guest-password-file <file>: puts the helper into one VM, or takes it out.
function parseGuestCaptureArgs(args) {
  const options = { command: 'guest-capture', op: args[0], vm: null, guestPasswordFile: null, help: false };
  if (args.includes('--help') || args.includes('-h')) return Object.freeze({ ...options, help: true });
  if (!GUEST_SETUP_OPS.includes(options.op)) throw new Error('runtime_guest_capture_op_invalid');
  for (let i = 1; i < args.length; i++) {
    const arg = String(args[i]);
    const key = arg === '--vm' ? 'vm' : arg === '--guest-password-file' ? 'guestPasswordFile' : null;
    if (!key) throw new Error('invalid_runtime_option');
    if (options[key] !== null) throw new Error('runtime_option_must_be_unique');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (key === 'vm' && !WALL_VM_RE.test(value)) throw new Error('runtime_guest_capture_vm_invalid');
    options[key] = value;
  }
  if (!options.vm || !options.guestPasswordFile) throw new Error('runtime_guest_capture_needs_vm_and_password_file');
  return Object.freeze(options);
}

function parseWallArgs(args) {
  const options = { command: 'wall', vms: [], port: 0, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg !== '--vm' && arg !== '--port') throw new Error('invalid_runtime_option');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('runtime_port_invalid');
      options.port = Number(value);
      continue;
    }
    const separator = value.indexOf(':');
    const vmId = separator < 0 ? value : value.slice(0, separator);
    const label = separator < 0 ? vmId : value.slice(separator + 1);
    if (!WALL_VM_RE.test(vmId) || !WALL_LABEL_RE.test(label)) throw new Error('runtime_wall_vm_invalid');
    if (options.vms.some((vm) => vm.vmId === vmId)) throw new Error('runtime_wall_vm_duplicate');
    options.vms.push(Object.freeze({ vmId, label }));
  }
  if (!options.help && options.vms.length === 0) throw new Error('runtime_wall_vm_required');
  if (options.vms.length > MAX_WALL_VMS) throw new Error('runtime_wall_vm_too_many');
  return Object.freeze({ ...options, vms: Object.freeze(options.vms) });
}

const AGENT_MAX_TASK_LENGTH = 2000;
const AGENT_MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
// planner: null runs the hands alone; a model name runs them under a planner (planned-agent-loop.mjs).
const AGENT_DEFAULTS = Object.freeze({ model: DEFAULT_COMPUTER_USE_MODEL, planner: null, maxSteps: 40, maxUsd: 0.5, maxMinutes: 15 });
const AGENT_NUMBER_OPTIONS = Object.freeze({ '--max-steps': ['maxSteps', 200, true], '--max-usd': ['maxUsd', 100, false], '--max-minutes': ['maxMinutes', 240, false] });

function parseAgentArgs(args) {
  const options = { command: 'agent', vm: undefined, task: undefined, ...AGENT_DEFAULTS, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--vm', '--task', '--model', '--planner', ...Object.keys(AGENT_NUMBER_OPTIONS)].includes(arg)) throw new Error('invalid_runtime_option');
    if (seen.has(arg)) throw new Error('runtime_option_must_be_unique');
    seen.add(arg);
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--vm') {
      if (!WALL_VM_RE.test(value)) throw new Error('runtime_agent_vm_invalid');
      options.vm = value;
    } else if (arg === '--task') {
      if (value.length > AGENT_MAX_TASK_LENGTH) throw new Error('runtime_agent_task_too_long');
      options.task = value;
    } else if (arg === '--model' || arg === '--planner') {
      if (!AGENT_MODEL_RE.test(value) || !Object.hasOwn(MODEL_PRICES, value)) throw new Error('runtime_agent_model_unknown');
      options[arg.slice(2)] = value;
    } else {
      const [key, max, integer] = AGENT_NUMBER_OPTIONS[arg];
      const number = Number(value);
      if (!/^\d+(\.\d+)?$/.test(value) || !(number > 0) || number > max || (integer && !Number.isInteger(number))) throw new Error('runtime_agent_limit_invalid');
      options[key] = number;
    }
  }
  if (!options.help && (!options.vm || !options.task)) throw new Error('runtime_agent_vm_and_task_required');
  return Object.freeze(options);
}

const FLEET_DEFAULTS = Object.freeze({ model: DEFAULT_COMPUTER_USE_MODEL, planner: null, maxSteps: 40, maxUsdPerVm: 0.5, maxUsdTotal: 2, maxMinutes: 15, port: 0 });
// The same limits as a workspace file (workspace.mjs LIMIT_RULES).
const FLEET_NUMBER_OPTIONS = Object.freeze(Object.fromEntries(
  [['--max-steps', 'maxSteps'], ['--max-usd-per-vm', 'maxUsdPerVm'], ['--max-usd-total', 'maxUsdTotal'], ['--max-minutes', 'maxMinutes']]
    .map(([flag, key]) => [flag, [key, ...LIMIT_RULES[key]]]),
));

function parseFleetArgs(args) {
  const options = { command: 'fleet', jobs: [], ...FLEET_DEFAULTS, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--job', '--model', '--planner', '--port', ...Object.keys(FLEET_NUMBER_OPTIONS)].includes(arg)) throw new Error('invalid_runtime_option');
    if (arg !== '--job' && seen.has(arg)) throw new Error('runtime_option_must_be_unique');
    seen.add(arg);
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--job') {
      const at = value.indexOf('=');
      const vmId = at < 0 ? '' : value.slice(0, at);
      const task = at < 0 ? '' : value.slice(at + 1);
      if (!WALL_VM_RE.test(vmId) || task.length < 1) throw new Error('runtime_fleet_job_invalid');
      if (task.length > AGENT_MAX_TASK_LENGTH) throw new Error('runtime_agent_task_too_long');
      if (options.jobs.some((job) => job.vmId === vmId)) throw new Error('runtime_fleet_vm_duplicate');
      if (options.jobs.length >= MAX_FLEET_JOBS) throw new Error('runtime_fleet_too_many_jobs');
      options.jobs.push(Object.freeze({ vmId, task }));
    } else if (arg === '--model' || arg === '--planner') {
      if (!AGENT_MODEL_RE.test(value) || !Object.hasOwn(MODEL_PRICES, value)) throw new Error('runtime_agent_model_unknown');
      options[arg.slice(2)] = value;
    } else if (arg === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('runtime_port_invalid');
      options.port = Number(value);
    } else {
      const [key, max, integer] = FLEET_NUMBER_OPTIONS[arg];
      const number = Number(value);
      if (!/^\d+(\.\d+)?$/.test(value) || !(number > 0) || number > max || (integer && !Number.isInteger(number))) throw new Error('runtime_agent_limit_invalid');
      options[key] = number;
    }
  }
  if (!options.help && options.jobs.length === 0) throw new Error('runtime_fleet_job_required');
  return Object.freeze({ ...options, jobs: Object.freeze(options.jobs) });
}

// room --require-start-approval --approval <file> (a pair; the demo takes neither): hands start only after an approved task.start (gate built by room-approval-wiring.mjs).
function parseRoomArgs(args) {
  const { rest, approvalFile } = takeRoomApprovalArgs(args);
  const options = parseRoomBaseArgs(rest);
  if (approvalFile === null) return options;
  if (options.demo) throw new Error('invalid_runtime_option');
  return Object.freeze({ ...options, requireStartApproval: true, approvalFile });
}

// room: the fleet's options, or --demo (with --port only) for the scripted room with fake VMs.
function parseRoomBaseArgs(args) {
  const demo = args.filter((arg) => arg === '--demo').length;
  if (demo > 1) throw new Error('runtime_option_must_be_unique');
  const rest = args.filter((arg) => arg !== '--demo');
  if (demo === 0) return rest.includes('--workspace') ? parseRoomWorkspaceArgs(rest) : parseRoomCheckArgs(rest);
  const options = { command: 'room', demo: true, jobs: Object.freeze([]), port: 0, help: false };
  let portSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = String(rest[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg !== '--port') throw new Error(arg === '--job' ? 'runtime_room_demo_takes_no_jobs' : 'invalid_runtime_option');
    if (portSeen) throw new Error('runtime_option_must_be_unique');
    portSeen = true;
    const value = rest[++i];
    if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > 65535) throw new Error('runtime_port_invalid');
    options.port = Number(value);
  }
  return Object.freeze(options);
}

// room --checks <file> --guest-password-file <file>: taken out before the fleet options are parsed. Both or neither.
// Only the paths are kept here; the files are read when the room starts (the password file only by the checker).
const ROOM_CHECK_OPTIONS = Object.freeze({ '--checks': 'checksFile', '--guest-password-file': 'guestPasswordFile' });

function parseRoomCheckArgs(given) {
  const { rest: args, guestCapture } = takeGuestCaptureArgs(given, { passwordFile: false });
  const found = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (!Object.hasOwn(ROOM_CHECK_OPTIONS, arg)) { rest.push(args[i]); continue; }
    const key = ROOM_CHECK_OPTIONS[arg];
    if (Object.hasOwn(found, key)) throw new Error('runtime_option_must_be_unique');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    found[key] = value;
  }
  const fleet = parseFleetArgs(rest);
  if (!fleet.help) {
    if (Object.keys(found).length === 1 && !(found.guestPasswordFile && guestCapture.length > 0)) throw new Error('runtime_room_checks_need_both_files');
    checkGuestCapture(guestCapture, found.guestPasswordFile, fleet.jobs.map((job) => job.vmId));
  }
  return Object.freeze({
    ...fleet, command: 'room', demo: false, checksFile: found.checksFile ?? null, guestPasswordFile: found.guestPasswordFile ?? null, guestCapture,
  });
}

// room --workspace <file> [--guest-password-file <file>] [--port <n>]: VMs, tasks, labels, checks and limits come from
// the file; nothing else may be given on the command line, so the file is the one place a team reviews.
const ROOM_WORKSPACE_OPTIONS = Object.freeze({ '--workspace': 'workspaceFile', '--guest-password-file': 'guestPasswordFile', '--port': 'port' });

function parseRoomWorkspaceArgs(args) {
  const found = {};
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (!Object.hasOwn(ROOM_WORKSPACE_OPTIONS, arg)) throw new Error('runtime_room_workspace_takes_no_other_options');
    const key = ROOM_WORKSPACE_OPTIONS[arg];
    if (Object.hasOwn(found, key)) throw new Error('runtime_option_must_be_unique');
    const value = args[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (key === 'port' && (!/^\d+$/.test(value) || Number(value) > 65535)) throw new Error('runtime_port_invalid');
    found[key] = key === 'port' ? Number(value) : value;
  }
  return Object.freeze({
    command: 'room', demo: false, help, workspaceFile: found.workspaceFile ?? null, guestPasswordFile: found.guestPasswordFile ?? null, port: found.port ?? 0,
  });
}

/**
 * Read a workspace file and turn it into the room's options. Throws an Error whose message is a fixed code.
 * A workspace with checks or a guest-capture VM needs --guest-password-file (checked to be a file here, read only by the
 * checker and the guest screen source).
 */
export function loadRoomWorkspace({ workspaceFile, guestPasswordFile, port = 0 }, io = { statSync, readFileSync }) {
  let text;
  try {
    const stat = io.statSync(workspaceFile);
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_BYTES) throw new Error('too_big');
    text = io.readFileSync(workspaceFile, 'utf8');
  } catch { throw new Error('runtime_room_workspace_unreadable'); }
  let workspace;
  try { workspace = parseWorkspace(text, { knownModels: Object.keys(MODEL_PRICES) }); }
  catch (error) { throw new Error(`runtime_room_${error.message}`); }
  const hasChecks = Object.keys(workspace.checks).length > 0;
  const hasGuestCapture = workspace.guestCapture.length > 0;
  if (hasChecks || hasGuestCapture) {
    let stat;
    try { stat = guestPasswordFile ? io.statSync(guestPasswordFile) : null; } catch { stat = null; }
    if (!stat?.isFile()) throw new Error(hasChecks ? 'runtime_room_workspace_checks_need_password_file' : 'runtime_room_workspace_guest_capture_needs_password_file');
  }
  return Object.freeze({
    command: 'room', demo: false, help: false, port, workspaceName: workspace.name,
    jobs: workspace.jobs, labels: workspace.labels, checks: workspace.checks,
    guestPasswordFile: hasChecks || hasGuestCapture ? guestPasswordFile : null, checksFile: null, guestCapture: workspace.guestCapture,
    ...FLEET_DEFAULTS, port, ...workspace.limits,
  });
}

const MAX_CHECKS_FILE_BYTES = 64 * 1024;

/**
 * Read and validate a checks file: { "<vmId>": [Check, ...] } for VMs of this room only, 1 to 8 valid checks each.
 * Throws an Error whose message is a fixed code. The password file is only checked to be a file (never read here).
 */
export function loadRoomChecks({ checksFile, guestPasswordFile, vmIds }, io = { statSync, readFileSync }) {
  let passwordStat;
  try { passwordStat = io.statSync(guestPasswordFile); } catch { throw new Error('runtime_room_password_file_missing'); }
  if (!passwordStat.isFile()) throw new Error('runtime_room_password_file_missing');
  let parsed;
  try {
    const stat = io.statSync(checksFile);
    if (!stat.isFile() || stat.size > MAX_CHECKS_FILE_BYTES) throw new Error('too_big');
    parsed = JSON.parse(io.readFileSync(checksFile, 'utf8').replace(/^﻿/, ''));
  } catch { throw new Error('runtime_room_checks_unreadable'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('runtime_room_checks_invalid');
  const known = new Set(vmIds);
  const out = {};
  for (const [vmId, list] of Object.entries(parsed)) {
    if (!known.has(vmId)) throw new Error('runtime_room_checks_unknown_vm');
    if (!Array.isArray(list) || list.length < 1) throw new Error('runtime_room_checks_invalid');
    if (list.length > MAX_CHECKS_PER_VM) throw new Error('runtime_room_checks_too_many');
    if (!list.every(validCheck)) throw new Error('runtime_room_check_invalid');
    out[vmId] = Object.freeze(list.map((check) => Object.freeze({ ...check })));
  }
  if (Object.keys(out).length === 0) throw new Error('runtime_room_checks_invalid');
  return Object.freeze(out);
}

export function parseRuntimeArgs(argv, platform = process.platform) {
  const Path = platform === 'win32' ? path.win32 : path;
  if (argv[0] === 'wall') return withGuestCapture(argv.slice(1), parseWallArgs, (o) => o.vms.map((vm) => vm.vmId));
  if (argv[0] === 'agent') return withGuestCapture(argv.slice(1), parseAgentArgs, (o) => [o.vm]);
  if (argv[0] === 'fleet') return withGuestCapture(argv.slice(1), parseFleetArgs, (o) => o.jobs.map((job) => job.vmId));
  if (argv[0] === 'guest-capture') return parseGuestCaptureArgs(argv.slice(1));
  if (argv[0] === 'room') return parseRoomArgs(argv.slice(1));
  if (argv[0] === 'approval-check') return parseApprovalCheckArgs(argv.slice(1));
  const command = ['backup', 'restore', 'recover-tail', 'verify-backup'].includes(argv[0]) ? argv[0] : 'serve';
  const args = command === 'serve' ? argv : argv.slice(1);
  if (command !== 'serve') {
    const options = { command, journalPath: undefined, outputPath: undefined, backupPath: undefined, destinationDirectory: undefined, help: false };
    const accepted = command === 'restore' ? ['--backup', '--destination']
      : command === 'verify-backup' ? ['--backup'] : ['--journal', '--output'];
    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]);
      if (arg === '--help' || arg === '-h') { options.help = true; continue; }
      if (!accepted.includes(arg)) throw new Error('invalid_runtime_option');
      const value = args[++i];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
      if (!Path.isAbsolute(value)) throw new Error('runtime_path_must_be_absolute');
      const key = command === 'verify-backup' ? 'backupPath'
        : command !== 'restore' ? (arg === '--journal' ? 'journalPath' : 'outputPath')
        : (arg === '--backup' ? 'backupPath' : 'destinationDirectory');
      if (options[key]) throw new Error('runtime_option_must_be_unique');
      options[key] = value;
    }
    if (!options.help && (command === 'verify-backup' ? !options.backupPath
      : command === 'restore' ? (!options.backupPath || !options.destinationDirectory)
        : (!options.journalPath || !options.outputPath))) {
      throw new Error('runtime_backup_options_required');
    }
    return Object.freeze(options);
  }
  const options = { roots: [], port: 0, journalPath: undefined, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--root', '--port', '--journal'].includes(arg)) throw new Error('invalid_runtime_option');
    const value = argv[++i];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('runtime_option_requires_value');
    if (arg === '--root') {
      if (!Path.isAbsolute(value)) throw new Error('runtime_root_must_be_absolute');
      options.roots.push(value);
    } else if (arg === '--journal') {
      if (!Path.isAbsolute(value) || options.journalPath) throw new Error('runtime_journal_must_be_absolute_and_unique');
      options.journalPath = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('runtime_port_invalid');
      options.port = Number(value);
    }
  }
  if (options.help) return Object.freeze({ ...options, roots: Object.freeze(options.roots) });
  if (options.roots.length === 0 || !options.journalPath) throw new Error('runtime_root_and_journal_required');
  return Object.freeze({ ...options, roots: Object.freeze([...new Set(options.roots)]) });
}

export const RUNTIME_HELP = `ALBERA Runtime — separate local execution and approval host

Usage:
  albera-runtime --root <absolute-project-directory> [--root <directory> ...] --journal <absolute-jsonl-path> [--port <0-65535>]
  albera-runtime backup --journal <absolute-jsonl-path> --output <new-encrypted-backup-path>
  albera-runtime verify-backup --backup <absolute-backup-path>
  albera-runtime restore --backup <absolute-backup-path> --destination <new-private-directory>
  albera-runtime recover-tail --journal <absolute-jsonl-path> --output <new-jsonl-path-in-same-directory>
  albera-runtime wall --vm <hyper-v-vm-name>[:<label>] [--vm ...] [--port <0-65535>]
  albera-runtime agent --vm <hyper-v-vm-name> --task <text> [--model claude-haiku-5-5] [--planner claude-sonnet-5-5] [--max-steps 40] [--max-usd 0.50] [--max-minutes 15]
  albera-runtime fleet --job <vm>=<task> [--job ...] [--model claude-haiku-5-5] [--planner claude-sonnet-5-5] [--max-steps 40] [--max-usd-per-vm 0.50] [--max-usd-total 2] [--max-minutes 15] [--port <0-65535>]
  albera-runtime room --job <vm>=<task> [--job ...] [--model claude-haiku-5-5] [--planner claude-sonnet-5-5] [--max-steps 40] [--max-usd-per-vm 0.50] [--max-usd-total 2] [--max-minutes 15] [--port <0-65535>]
                      [--checks <checks.json> --guest-password-file <file>]
  albera-runtime room --workspace <albera.workspace.json> [--guest-password-file <file>] [--port <0-65535>]
  (room --job and room --workspace also take [--require-start-approval --approval <albera.approval.json>], both or neither)
  albera-runtime room --demo [--port <0-65535>]
  albera-runtime approval-check --approval <albera.approval.json> [--helper <absolute path of the pipe client helper>]
  albera-runtime guest-capture install|remove --vm <hyper-v-vm-name> --guest-password-file <file>
  (wall, agent, fleet and room --job also take [--guest-capture <vm> ...] --guest-password-file <file>)

The regular "albera" command remains a read-only session dashboard. Runtime binds only to 127.0.0.1.
Each provider start, input, and stop requires a visible one-use decision in the local approval page.
Only Claude Code is currently profile-configured; installed CLI compatibility is not verified.
The journal stores redacted decisions and lifecycle events, never prompts or process output.
Journal storage permissions are checked without repair; Runtime refuses broad or unverifiable Windows DACLs and POSIX ownership/modes.
Backups are created only while Runtime is stopped. Backup, verification, and restore passphrases are entered in a hidden terminal prompt, never as command-line arguments or environment variables. verify-backup authenticates and validates a backup offline without writing files.
Restore creates a new directory and never overwrites existing files. Keep the passphrase separately; ALBERA cannot recover it.
wall is a local, view-only development command: it shows the latest screen of up to 16 Hyper-V VMs you name, refreshed every 2 seconds, on 127.0.0.1 behind the same one-time code. It never sends input to a VM, keeps only the newest frame in memory and saves nothing. Screens can show secrets; use it only on a PC and display you trust. It uses the same-user prototype Broker and needs Hyper-V Administrators membership.
agent lets an AI operate one Hyper-V VM desktop through screenshots, mouse and keyboard until it says it is done or a limit (steps, USD, minutes) is reached. Ctrl+C stops it before the next action. The Anthropic API key is read only from ANTHROPIC_API_KEY. Screens are sent to the Anthropic API and can show secrets; use only a VM that holds nothing sensitive. The AI saying DONE is a claim, not proof that the task succeeded. It uses the same-user prototype Broker and needs Hyper-V Administrators membership.
--planner <model> (agent, fleet, room) adds a planner: that model sees the task and the screen, writes 1 to 8 short sub-goals, gives the hands one at a time (at most 15 steps each), looks at the screen after each and decides next, replan (at most 2), done or failed. Its calls count toward the same USD limits; its DONE is a claim too.
fleet runs up to 8 agents at once (one per VM, each with its own lease) and shows the desktop wall with each AI's pointer and status drawn over its screen. Cost grows with the number of VMs: every loop stops at --max-usd-per-vm and all stop together at --max-usd-total (each may finish the response already paid for, so the total can pass the limit slightly). Ctrl+C stops all agents and keeps the wall open; press it again to exit. The wall shows what each AI claims, not whether it succeeded: check every VM yourself. Same API key, privacy and Broker notes as agent.
room is the control room: the fleet's VMs as cameras on a canvas, with Bero (a rule-based main AI, no LLM) pointing out stalls, DONE claims and limits and opening decision cards. A card choice can stop the hands on a VM or start a short fixed job there (close a blocking dialog, or look again whether the original task is done); the browser cannot type a task. Jobs started from cards share the same per-VM and total USD limits. Ctrl+C stops all agents and keeps the room open; press it again to exit. --demo runs 3 fake VMs with a scripted AI: no VM, no API key, no network. Same API key, privacy and Broker notes as fleet.
room does NOT ask for approval before it starts a hand (the initial jobs and the jobs a card starts): it says so on start. --require-start-approval --approval <file> is the gated form: the room is created with no jobs and every start (the initial jobs and the jobs a card starts) is requested as a guest.command / task.start operation through the Host Broker and the Approval Authority; the hand starts only after the Broker claimed it (a person approves in the approver app, or the policy does after a Broker checkpoint of the VM). A start that is denied, expires, fails or has an unknown outcome starts nothing and is recorded as start_refused. The file holds names and paths only, never a secret: {"version": 1, "projectId": "<id>", "broker": {"pipeName": "<pipe>", "expect": {"serviceName": "<service>"}}, "authority": {"pipeRoot": "<pipe root>", "expect": {"serviceName": "<service>"}}, "journal": "<absolute path of the SQLite store>", "computers": {"<hyper-v-vm-name>": "<computerId>"}, "attestation": null}. Every VM of the room must be in "computers" and every task must fit a task.start (1 to 256 UTF-8 bytes, no control characters), or the room refuses to start (exit 2). See examples/albera.approval.example.json and docs/architecture/approver-app.md.
approval-check is the first request after the host install: with the same settings file as the gated room it sends ONE broker.operation / synthetic.noop through the Host Broker and the Approval Authority (fence, submit, wait for a person, claim), prints the approval id, and ends with the status; exit 0 only when the Broker claimed it. The operation changes nothing: the Broker only records the claim. Run it as the Control Plane account (the only account the two pipes admit); the person approves in the approver console under their own account. --helper names an installed copy of the pipe client helper (its .manifest.json must sit beside it); without it the build output next to the sources is used. See docs/architecture/host-install.md.
room --checks checks the VM itself when its AI claims DONE, and asks you only when a check fails or cannot run. The file maps VM names to at most 8 read-only checks each: {"<vm>": [{"kind": "file_exists", "path": "C:\\\\x.txt"}, {"kind": "file_text", "path": "C:\\\\x.txt", "text": "expected"}, {"kind": "dir_has", "path": "C:\\\\dir", "name": "entry"}]}. file_text compares the file's trimmed text (first 64 KiB) inside the VM; only ok / missing / differs / error comes back, never file contents. Checks run over PowerShell Direct as the guest user Administrator, with the password read from --guest-password-file at each check (never from the command line or the environment, never printed). Both options are needed together. It uses a same-user prototype and needs Hyper-V Administrators membership.
room --workspace starts the room from one JSON file you can keep in a repository and review: {"version": 1, "name": "booking-site", "vms": [{"vm": "<hyper-v-vm-name>", "label": "<camera label>", "task": "<task>", "checks": [...]}], "limits": {"model": "claude-haiku-5-5", "planner": "claude-sonnet-5-5", "maxSteps": 40, "maxUsdPerVm": 0.5, "maxUsdTotal": 2, "maxMinutes": 15}}. No other room option may be given with it, so the file is the one place to read. Secrets never go in the file: if any VM has checks or "capture": "guest", give --guest-password-file on the command line. See examples/albera.workspace.example.json.
guest-capture is OPT-IN, for VMs whose host thumbnail does not work (a GPU-partitioned VM keeps showing its boot logo there). install puts a small PowerShell helper into that VM over PowerShell Direct, as the guest user Administrator with the password from --guest-password-file (never from the command line or the environment, never printed): a scheduled task starts it at each logon of Administrator, without a window, and it saves the screen under C:\\ProgramData\\Albera about once a second (only the newest frame). remove stops it and deletes the task and the files. Then --guest-capture <vm> (or "capture": "guest" on that VM in a workspace file) takes that VM's screen from the helper; input still comes from the host. The frame is guest data and is checked like any screen. The first frame after a logon can take a minute or two (the helper compiles a little C# with the guest's built-in compiler). It uses a same-user prototype and needs Hyper-V Administrators membership.
recover-tail requires Runtime to be stopped and copies only the fully validated record prefix to a new file beside the original. It keeps the original journal and incomplete tail unchanged, refuses an existing writer lock, and preserves the session identity. It cannot recover a possibly lost final event.
`;

async function readHiddenPassphrase(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('backup_requires_interactive_tty');
  const wasRaw = input.isRaw;
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') { cleanup(); reject(new Error('backup_prompt_cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
        if (char >= ' ' && char !== '\u007f') value += char;
        if (Buffer.byteLength(value, 'utf8') > 1024) { cleanup(); reject(new Error('backup_passphrase_length_invalid')); return; }
      }
    };
    input.on('data', onData);
  });
}

/** The opt-in guest screen source of the VMs named with --guest-capture (or capture: "guest"), or null. */
function guestScreensOf(options) {
  return options.guestCapture?.length ? createGuestScreenSource({ vms: [...options.guestCapture], passwordFile: options.guestPasswordFile }) : null;
}

async function runGuestCapture(options) {
  const result = await runGuestCaptureSetup({ op: options.op, vmId: options.vm, passwordFile: options.guestPasswordFile });
  if (!result.ok) { console.error(`ALBERA Runtime guest-capture ${options.op}: ${result.code}`); process.exitCode = 1; return; }
  if (options.op === 'remove') { console.log(`Removed the ALBERA screen helper from ${options.vm}.`); return; }
  console.log(`Installed the ALBERA screen helper in ${options.vm}. It runs now and at each logon of Administrator; the first frame can take a minute or two.`);
  console.log(`Use it with --guest-capture ${options.vm} --guest-password-file <file>. Take it out with: albera-runtime guest-capture remove --vm ${options.vm} --guest-password-file <file>`);
}

async function runWall(options) {
  let wall;
  const guestScreens = guestScreensOf(options);
  try {
    const broker = createHyperVDesktopBrokerPrototype({ guestScreens });
    wall = createDesktopWallHost({
      vms: options.vms,
      driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease }),
    });
    const address = await wall.listen(options.port);
    console.log(`ALBERA desktop wall (view only) listening at ${address.url}`);
    console.log(`One-time UI bootstrap code: ${address.bootstrapCode}`);
    console.log('Open that local URL to watch the VM screens. Press Ctrl+C to stop.');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      guestScreens?.close();
      await wall.close().catch(() => {});
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    guestScreens?.close();
    await wall?.close().catch(() => {});
    console.error('ALBERA desktop wall could not start. Check the VM names and port.');
    process.exitCode = 1;
  }
}

function formatAgentEvent(event) {
  // Planned runs: each (re)plan, and every step's note (its `[plan i/n]` prefix tells where the run is).
  if (event.type === 'plan') return `plan${event.revision ? ` (replan ${event.revision})` : ''}:${event.goals.map((goal, i) => `\n  ${i + 1}. ${goal}`).join('')}`;
  if (event.type === 'step') {
    const note = event.note?.startsWith('[plan ') ? ` ${event.note}` : '';
    return `step ${event.step}: ${event.toolUses} tool call(s), $${event.usd.toFixed(4)}, ${Math.round(event.ms / 1000)}s${note}`;
  }
  if (event.type !== 'action') return null;
  const where = event.cursor ? ` at ${event.cursor[0]},${event.cursor[1]}` : '';
  const length = event.textLength === undefined ? '' : ` (${event.textLength} chars)`;
  return `  ${event.action}${length}${where} ${event.ok ? 'ok' : `failed: ${event.code}`}`;
}

const plannerText = (options) => (options.planner ? ` planned by ${options.planner}` : '');
const fleetPlanner = (apiKey, options) => (options.planner
  ? { createClient: () => createAnthropicPlannerClient({ apiKey, model: options.planner }), prices: MODEL_PRICES[options.planner] }
  : null);

async function runAgent(options) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ALBERA Runtime agent: set the ANTHROPIC_API_KEY environment variable first.'); process.exitCode = 1; return; }
  const started = Date.now();
  const lease = Object.freeze({
    desktopSessionId: `agent-${options.vm}`, ownerType: 'AI', ownerId: 'albera-agent', generation: 1,
    expiresAt: new Date(started + (options.maxMinutes + 1) * 60_000).toISOString(),
  });
  let loop;
  const guestScreens = guestScreensOf(options);
  try {
    const broker = createHyperVDesktopBrokerPrototype({ guestScreens });
    const driver = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease });
    const loopOptions = {
      driver,
      client: createAnthropicComputerUseClient({ apiKey, model: options.model }),
      vmId: options.vm, lease, task: options.task,
      limits: { maxSteps: options.maxSteps, maxUsd: options.maxUsd, maxMs: options.maxMinutes * 60_000 },
      prices: MODEL_PRICES[options.model],
      settleMs: 500,
      onEvent: (event) => { const line = formatAgentEvent(event); if (line) console.log(line); },
    };
    loop = options.planner
      ? createPlannedAgentLoop({ ...loopOptions, plannerClient: createAnthropicPlannerClient({ apiKey, model: options.planner }), plannerPrices: MODEL_PRICES[options.planner] })
      : createDesktopAgentLoop(loopOptions);
  } catch {
    guestScreens?.close();
    console.error('ALBERA Runtime agent could not start. Check the VM name and options.');
    process.exitCode = 1;
    return;
  }
  process.once('SIGINT', () => loop.stop('stopped_by_user'));
  process.once('SIGTERM', () => loop.stop('stopped_by_user'));
  console.log(`ALBERA agent started on ${options.vm} with ${options.model}${plannerText(options)} (limits: ${options.maxSteps} steps, $${options.maxUsd}, ${options.maxMinutes} min). Press Ctrl+C to stop.`);
  const result = await loop.run();
  guestScreens?.close();
  console.log(`result: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}; ${result.steps} steps, ${result.actions} actions, $${result.usd.toFixed(4)}, ${Math.round(result.ms / 1000)}s`);
  if (result.claim) console.log(`AI said: ${result.claim}`);
  if (result.outcome === 'claimed_done') console.log('Note: this is only what the AI claimed. Check the VM yourself.');
  process.exitCode = result.outcome === 'claimed_done' ? 0 : 1;
}

async function runFleet(options) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ALBERA Runtime fleet: set the ANTHROPIC_API_KEY environment variable first.'); process.exitCode = 1; return; }
  let wall;
  const guestScreens = guestScreensOf(options);
  try {
    const broker = createHyperVDesktopBrokerPrototype({ guestScreens });
    const board = createAgentStatusBoard();
    const fleet = createAgentFleet({
      jobs: options.jobs, board,
      createDriver: (vmId, lease) => new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease }),
      createClient: () => createAnthropicComputerUseClient({ apiKey, model: options.model }),
      limits: { maxSteps: options.maxSteps, maxUsd: options.maxUsdPerVm, maxMs: options.maxMinutes * 60_000 },
      prices: MODEL_PRICES[options.model], totalMaxUsd: options.maxUsdTotal, settleMs: 500, planner: fleetPlanner(apiKey, options),
      onEvent: (vmId, event) => { const line = formatAgentEvent(event); if (line) console.log(`[${vmId}] ${line}`); },
    });
    wall = createDesktopWallHost({
      vms: options.jobs.map(({ vmId }) => ({ vmId, label: vmId.slice(0, 32) })), statusSource: board,
      driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease }),
    });
    const address = await wall.listen(options.port);
    console.log(`ALBERA desktop wall listening at ${address.url}`);
    console.log(`One-time UI bootstrap code: ${address.bootstrapCode}`);
    console.log(`Starting ${options.jobs.length} agent(s) with ${options.model}${plannerText(options)} (per VM: ${options.maxSteps} steps, $${options.maxUsdPerVm}, ${options.maxMinutes} min; total $${options.maxUsdTotal}). Press Ctrl+C to stop all agents.`);
    let finished = false;
    let stopRequested = false;
    const onSignal = () => {
      if (!finished && !stopRequested) { stopRequested = true; fleet.stop('stopped_by_user'); return; }
      guestScreens?.close();
      void wall.close().catch(() => {});
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const outcome = await fleet.run();
    finished = true;
    for (const [vmId, result] of Object.entries(outcome.results)) {
      console.log(`[${vmId}] result: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}; ${result.steps} steps, ${result.actions} actions, $${result.usd.toFixed(4)}`);
      if (result.claim) console.log(`[${vmId}] AI said: ${result.claim}`);
    }
    console.log(`total cost: $${outcome.totalUsd.toFixed(4)}${outcome.stopReason ? ` (stopped: ${outcome.stopReason})` : ''}`);
    console.log('Note: results and "DONE" are only what each AI claimed. Check every VM yourself.');
    console.log('The wall is still open. Press Ctrl+C again to exit.');
    process.exitCode = Object.values(outcome.results).every((r) => r.outcome === 'claimed_done') ? 0 : 1;
  } catch {
    guestScreens?.close();
    await wall?.close().catch(() => {});
    console.error('ALBERA Runtime fleet could not start. Check the VM names, options and port.');
    process.exitCode = 1;
  }
}

async function runRoomDemo(options) {
  let demo;
  try { demo = await startRoomDemo({ port: options.port }); }
  catch (error) {
    if (error?.code === 'room_parts_missing') console.error(`ALBERA room demo: these room parts are not built yet: ${error.missing.join(', ')}.`);
    else console.error('ALBERA room demo could not start. Check the port.');
    process.exitCode = 1;
    return;
  }
  console.log(`ALBERA control room (demo: 3 fake VMs, no network) listening at ${demo.url}`);
  console.log(`One-time UI bootstrap code: ${demo.bootstrapCode}`);
  console.log('Press Ctrl+C to stop.');
  const stop = () => { void demo.close().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function runRoom(given) {
  if (given.demo) { await runRoomDemo(given); return; }
  let options = given;
  if (given.workspaceFile) {
    // The error is a fixed code; the workspace file's content is never printed.
    try { options = loadRoomWorkspace(given); }
    catch (error) { console.error(`ALBERA Runtime room: ${error.message}`); process.exitCode = 2; return; }
  }
  const labelOf = (vmId) => options.labels?.[vmId] ?? vmId.slice(0, 32);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ALBERA Runtime room: set the ANTHROPIC_API_KEY environment variable first.'); process.exitCode = 1; return; }
  const missing = missingRoomParts({ journalModule: roomJournalModule, figuresModule: roomFiguresModule, directorModule: beroDirectorModule });
  if (missing.length) { console.error(`ALBERA Runtime room: these room parts are not built yet: ${missing.join(', ')}.`); process.exitCode = 1; return; }
  let checks = options.checks ?? {};
  let checker = Object.keys(checks).length ? createHyperVGuestChecker({ passwordFile: options.guestPasswordFile }) : null;
  if (options.checksFile) {
    // The error is a fixed code; neither file's content is ever printed.
    try { checks = loadRoomChecks({ checksFile: options.checksFile, guestPasswordFile: options.guestPasswordFile, vmIds: options.jobs.map((job) => job.vmId) }); }
    catch (error) { console.error(`ALBERA Runtime room: ${error.message}`); process.exitCode = 2; return; }
    checker = createHyperVGuestChecker({ passwordFile: options.guestPasswordFile });
  }
  let approval = null; // gated: the error is a fixed code (never the settings content or paths); nothing is requested before the room is up
  try { if (given.requireStartApproval) approval = await openRoomApproval({ approvalFile: given.approvalFile, jobs: options.jobs }); }
  catch (error) { console.error(`ALBERA Runtime room: ${error.message}`); process.exitCode = 2; return; }
  let room;
  const guestScreens = guestScreensOf(options);
  const release = () => { guestScreens?.close(); approval?.close(); };
  try {
    const broker = createHyperVDesktopBrokerPrototype({ guestScreens });
    const board = createAgentStatusBoard();
    const journal = roomJournalModule.createRoomJournal({});
    const director = beroDirectorModule.createBeroDirector({ buildFigure: roomFiguresModule.buildFigure, labelOf });
    const fleet = createAgentFleet({
      jobs: approval ? [] : options.jobs, vmIds: approval ? options.jobs.map((job) => job.vmId) : [], board, keepAlive: true, // gated: no initial jobs, the gate starts them
      createDriver: (vmId, lease) => new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease }),
      createClient: () => createAnthropicComputerUseClient({ apiKey, model: options.model }),
      limits: { maxSteps: options.maxSteps, maxUsd: options.maxUsdPerVm, maxMs: options.maxMinutes * 60_000 },
      prices: MODEL_PRICES[options.model], totalMaxUsd: options.maxUsdTotal, settleMs: 500, planner: fleetPlanner(apiKey, options),
      onEvent: (vmId, event) => {
        room?.recordFleetEvent(vmId, event);
        const line = formatAgentEvent(event);
        if (line) console.log(`[${vmId}] ${line}`);
      },
    });
    room = createRoomHost({
      vms: options.jobs.map(({ vmId, task }) => ({ vmId, label: labelOf(vmId), task })), board, journal, director, fleet, checker, checks, startGate: approval?.gate,
      driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease }),
    });
    const address = await room.listen(options.port);
    console.log(`ALBERA control room${options.workspaceName ? ` (workspace ${options.workspaceName})` : ''} listening at ${address.url}`);
    console.log(approval?.notice ?? 'Warning: starting a hand (the initial jobs and the jobs a decision card starts) is NOT approved: no approval gate is wired.');
    const checked = Object.keys(checks);
    if (checked.length) console.log(`Automatic checks after a DONE claim on: ${checked.join(', ')}.`);
    console.log(`One-time UI bootstrap code: ${address.bootstrapCode}`);
    console.log(`${approval ? 'Requesting approval to start' : 'Starting'} ${options.jobs.length} agent(s) with ${options.model}${plannerText(options)} (per VM: ${options.maxSteps} steps, $${options.maxUsdPerVm}, ${options.maxMinutes} min; total $${options.maxUsdTotal}, card jobs included). Press Ctrl+C to stop all agents.`);
    let stopRequested = false;
    const onSignal = () => {
      if (!stopRequested) { stopRequested = true; fleet.close('stopped_by_user'); return; }
      release();
      void room.close().catch(() => {});
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const running = fleet.run();
    await approval?.requestInitialStarts(room); // gated: each answer is 'pending_approval' at once, the outcome is a ledger entry
    const outcome = await running;
    console.log(`total cost: $${outcome.totalUsd.toFixed(4)}${outcome.stopReason ? ` (stopped: ${outcome.stopReason})` : ''}`);
    console.log(checked.length
      ? 'Note: results and "DONE" are only what each AI claimed. The room shows the automatic checks; check the other VMs yourself.'
      : 'Note: results and "DONE" are only what each AI claimed. Check every VM yourself.');
    console.log('The room is still open. Press Ctrl+C again to exit.');
  } catch {
    release();
    await room?.close().catch(() => {});
    console.error('ALBERA Runtime room could not start. Check the VM names, options and port.');
    process.exitCode = 1;
  }
}

async function main() {
  let options;
  try { options = parseRuntimeArgs(process.argv.slice(2)); }
  catch (error) { console.error(`ALBERA Runtime: ${error.message}`); process.exitCode = 2; return; }
  if (options.help) { console.log(RUNTIME_HELP); return; }
  // Only checked to be a file here; the guest screen source and the setup read it.
  if ((options.guestCapture?.length || options.command === 'guest-capture') && !statSync(options.guestPasswordFile, { throwIfNoEntry: false })?.isFile()) {
    console.error('ALBERA Runtime: runtime_guest_password_file_missing'); process.exitCode = 2; return;
  }
  if (options.command === 'guest-capture') { await runGuestCapture(options); return; }
  if (options.command === 'wall') { await runWall(options); return; }
  if (options.command === 'agent') { await runAgent(options); return; }
  if (options.command === 'fleet') { await runFleet(options); return; }
  if (options.command === 'room') { await runRoom(options); return; }
  if (options.command === 'approval-check') { await runApprovalCheckCommand(options); return; }
  if (options.command === 'backup' || options.command === 'restore' || options.command === 'recover-tail' || options.command === 'verify-backup') {
    try {
      if (options.command === 'backup') {
        const passphrase = await readHiddenPassphrase('Backup passphrase (12+ UTF-8 bytes): ');
        const confirmation = await readHiddenPassphrase('Confirm passphrase: ');
        if (passphrase !== confirmation) throw new Error('backup_passphrase_mismatch');
        const result = await backupRuntimeJournal({ journalPath: options.journalPath, outputPath: options.outputPath, passphrase });
        console.log(`Encrypted Runtime backup created (${result.bytes} bytes).`);
      } else if (options.command === 'verify-backup') {
        const passphrase = await readHiddenPassphrase('Backup passphrase: ');
        const result = await verifyRuntimeJournalBackup({ backupPath: options.backupPath, passphrase });
        console.log(`Encrypted Runtime backup is valid (${result.recordCount} records).`);
      } else if (options.command === 'restore') {
        const passphrase = await readHiddenPassphrase('Backup passphrase: ');
        const result = await restoreRuntimeJournal({ backupPath: options.backupPath, destinationDirectory: options.destinationDirectory, passphrase });
        console.log(`Runtime journal restored to ${result.journalPath}.`);
      } else {
        const result = await recoverRuntimeJournalTail({ journalPath: options.journalPath, outputPath: options.outputPath });
        console.log(`Recovered ${result.recordCount} complete records to ${result.journalPath}; preserved the original and ${result.discardedTailBytes} incomplete tail bytes.`);
      }
    } catch (error) {
      console.error(`ALBERA Runtime ${options.command}: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  let journal;
  let runtime;
  try {
    journal = await openRuntimeAuditJournal(options.journalPath);
    const sessionId = await loadOrCreateRuntimeSessionId(options.journalPath);
    runtime = createRuntimeHost({ roots: options.roots, journal, hostOptions: { sessionId } });
    const address = await runtime.listen(options.port);
    console.log(`ALBERA Runtime listening at ${address.url}`);
    console.log(`One-time UI bootstrap code: ${address.bootstrapCode}`);
    console.log('Open that local URL to review and control Runtime actions. Press Ctrl+C to stop.');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const uncertain = await runtime.close().catch(() => ['unknown']);
      if (uncertain.length) {
        console.error(`ALBERA Runtime: cleanup could not be confirmed for ${uncertain.length} run(s).`);
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    await runtime?.close().catch(() => {});
    if (!runtime) await journal?.close().catch(() => {});
    if (error?.code === 'runtime_storage_acl_not_private'
      || ['journal_directory_permissions', 'journal_permissions', 'journal_lock_permissions'].includes(error?.code)
      || ['journal_hard_linked_file', 'journal_lock_hard_linked'].includes(error?.code)
      || error?.code === 'runtime_session_identity_permissions') {
      console.error('ALBERA Runtime could not start because journal storage permissions allow other local principals to access or change its data. Choose a private directory; ALBERA will not change existing permissions.');
      process.exitCode = 1;
      return;
    }
    if (String(error?.code ?? '').startsWith('runtime_storage_acl_')) {
      console.error('ALBERA Runtime could not verify journal storage permissions and stopped without changing existing data.');
      process.exitCode = 1;
      return;
    }
    console.error('ALBERA Runtime could not start. Check the selected root, journal, and port.');
    process.exitCode = 1;
  }
}

function isMainModule(moduleUrl, argvPath) {
  if (typeof argvPath !== 'string' || argvPath.length === 0) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); }
  catch { return false; }
}

if (isMainModule(import.meta.url, process.argv[1])) void main();
