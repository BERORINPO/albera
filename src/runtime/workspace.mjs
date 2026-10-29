// Workspace file (spec/room.md §8): one JSON file that names a room's VMs, their tasks, camera labels, automatic
// checks and cost limits, so a team can keep it in a repository and review it like code. Pure: it parses text it is
// given and never reads a file, the clock or the environment. Secrets never belong here: the guest password file
// stays a command-line option of the machine that runs the room.
import { validCheck, MAX_CHECKS_PER_VM } from './room-contract.mjs';

export const WORKSPACE_VERSION = 1;
export const MAX_WORKSPACE_BYTES = 256 * 1024;
export const MAX_WORKSPACE_VMS = 8;
export const MAX_TASK_LENGTH = 2000;
export const MAX_LABEL_LENGTH = 32;

/** Cost and time limits: [largest allowed, whole numbers only]. The room's command-line options use the same table. */
export const LIMIT_RULES = Object.freeze({
  maxSteps: Object.freeze([200, true]),
  maxUsdPerVm: Object.freeze([100, false]),
  maxUsdTotal: Object.freeze([800, false]),
  maxMinutes: Object.freeze([240, false]),
});

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOP_KEYS = new Set(['version', 'name', 'vms', 'limits']);
const VM_KEYS = new Set(['vm', 'label', 'task', 'checks', 'capture']);
/** Where a VM's screen comes from: the host thumbnail (default) or the opt-in helper inside the guest. */
export const CAPTURE_SOURCES = Object.freeze(['host', 'guest']);
const LIMIT_KEYS = new Set(['model', 'planner', ...Object.keys(LIMIT_RULES)]);

/** A camera label: 1 to 32 characters (any script), no control characters. */
export function isLabel(value) {
  return typeof value === 'string' && value.trim() === value && [...value].length >= 1 && [...value].length <= MAX_LABEL_LENGTH
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

export function validLimit(key, value) {
  const rule = LIMIT_RULES[key];
  return Boolean(rule) && typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= rule[0] && (!rule[1] || Number.isInteger(value));
}

/**
 * Parse and validate a workspace file's text. Throws an Error whose message is a fixed code (never the file content).
 * @param {string} text
 * @param {{knownModels: string[]}} options models the room can price
 * @returns {{name: string, jobs: {vmId: string, task: string}[], labels: Record<string, string>, checks: Record<string, object[]>,
 *   guestCapture: string[], limits: object}}
 */
export function parseWorkspace(text, { knownModels = [] } = {}) {
  if (typeof text !== 'string' || text.length > MAX_WORKSPACE_BYTES) throw new Error('workspace_too_big');
  let raw;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('workspace_not_json'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workspace_invalid');
  if (Object.keys(raw).some((key) => !TOP_KEYS.has(key))) throw new Error('workspace_unknown_field');
  if (raw.version !== WORKSPACE_VERSION) throw new Error('workspace_version_unsupported');
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) throw new Error('workspace_name_invalid');
  if (!Array.isArray(raw.vms) || raw.vms.length < 1 || raw.vms.length > MAX_WORKSPACE_VMS) throw new Error('workspace_vms_invalid');

  const jobs = [];
  const labels = {};
  const checks = {};
  const guestCapture = [];
  for (const entry of raw.vms) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('workspace_vm_invalid');
    if (Object.keys(entry).some((key) => !VM_KEYS.has(key))) throw new Error('workspace_unknown_field');
    const { vm, task } = entry;
    if (typeof vm !== 'string' || !VM_RE.test(vm)) throw new Error('workspace_vm_invalid');
    if (Object.hasOwn(labels, vm)) throw new Error('workspace_vm_duplicate');
    if (typeof task !== 'string' || task.trim().length < 1 || task.length > MAX_TASK_LENGTH) throw new Error('workspace_task_invalid');
    const label = entry.label ?? vm.slice(0, MAX_LABEL_LENGTH);
    if (!isLabel(label)) throw new Error('workspace_label_invalid');
    if (entry.checks !== undefined) {
      if (!Array.isArray(entry.checks) || entry.checks.length < 1) throw new Error('workspace_checks_invalid');
      if (entry.checks.length > MAX_CHECKS_PER_VM) throw new Error('workspace_checks_too_many');
      if (!entry.checks.every(validCheck)) throw new Error('workspace_check_invalid');
      checks[vm] = Object.freeze(entry.checks.map((check) => Object.freeze({ ...check })));
    }
    if (entry.capture !== undefined && !CAPTURE_SOURCES.includes(entry.capture)) throw new Error('workspace_capture_invalid');
    if (entry.capture === 'guest') guestCapture.push(vm);
    labels[vm] = label;
    jobs.push(Object.freeze({ vmId: vm, task }));
  }

  const limits = {};
  if (raw.limits !== undefined) {
    if (!raw.limits || typeof raw.limits !== 'object' || Array.isArray(raw.limits)) throw new Error('workspace_limits_invalid');
    for (const [key, value] of Object.entries(raw.limits)) {
      if (!LIMIT_KEYS.has(key)) throw new Error('workspace_unknown_field');
      if (key === 'model' || key === 'planner') {
        if (typeof value !== 'string' || !knownModels.includes(value)) throw new Error('workspace_model_unknown');
      } else if (!validLimit(key, value)) throw new Error('workspace_limit_invalid');
      limits[key] = value;
    }
  }
  if (limits.maxUsdPerVm !== undefined && limits.maxUsdTotal !== undefined && limits.maxUsdPerVm > limits.maxUsdTotal) throw new Error('workspace_limit_invalid');

  return Object.freeze({
    name: raw.name, jobs: Object.freeze(jobs), labels: Object.freeze(labels), checks: Object.freeze(checks), guestCapture: Object.freeze(guestCapture), limits: Object.freeze(limits),
  });
}
