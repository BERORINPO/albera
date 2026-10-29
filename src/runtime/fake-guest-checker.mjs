// Fake of the guest checker (spec/room.md §7), for tests and `room --demo`. Touches no VM.
// It also holds `checkReport`, the one place that turns per-check findings into a CheckReport, so the fake
// and the Hyper-V prototype decide verdicts the same way.
import { validCheck, validCheckReport, CHECK_FINDINGS, MAX_CHECKS_PER_VM } from './room-contract.mjs';

const VM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;

/** `{verdict: 'unavailable', results: [], code}`: the VM could not be checked. */
export function unavailable(code) {
  return Object.freeze({ verdict: 'unavailable', results: Object.freeze([]), code: CODE_RE.test(code) ? code : 'guest_check_failed' });
}

/** Are these checks something a checker may run? (1 to 8 valid checks.) */
export function validChecks(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.length <= MAX_CHECKS_PER_VM && checks.every(validCheck);
}

/** Is this a VM name a checker may use? */
export function validVmName(vmId) {
  return typeof vmId === 'string' && VM_ID_RE.test(vmId);
}

/**
 * Build a report from one finding per check (same order). Paths come from the checks the host gave, never from the VM.
 * passed = every finding ok; failed = at least one missing / differs; otherwise (an error) unavailable with the results.
 */
export function checkReport(checks, findings) {
  if (!validChecks(checks) || !Array.isArray(findings) || findings.length !== checks.length
    || !findings.every((f) => CHECK_FINDINGS.includes(f))) return unavailable('guest_check_invalid');
  const results = Object.freeze(checks.map((c, i) => Object.freeze({ kind: c.kind, path: c.path, finding: findings[i] })));
  if (findings.every((f) => f === 'ok')) return Object.freeze({ verdict: 'passed', results });
  if (findings.some((f) => f === 'missing' || f === 'differs')) return Object.freeze({ verdict: 'failed', results });
  return Object.freeze({ verdict: 'unavailable', results, code: 'guest_check_error' });
}

/**
 * @param {Record<string, (import('./room-contract.mjs').CheckReport | string[])[]>} script
 *   vmId -> reports, used in order (the last one repeats). A report may be given as a findings array.
 * @param {{delayMs?: number}} [options]
 */
export function createFakeGuestChecker(script = {}, { delayMs = 0 } = {}) {
  const used = new Map();
  const calls = [];
  return Object.freeze({
    calls,
    async run(vmId, checks) {
      calls.push(Object.freeze({ vmId, count: Array.isArray(checks) ? checks.length : 0 }));
      if (delayMs > 0) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      if (!validVmName(vmId) || !validChecks(checks)) return unavailable('guest_check_invalid');
      const list = Array.isArray(script[vmId]) ? script[vmId] : [];
      if (list.length === 0) return unavailable('guest_unavailable');
      const i = used.get(vmId) ?? 0;
      used.set(vmId, i + 1);
      const item = list[Math.min(i, list.length - 1)];
      const report = Array.isArray(item) ? checkReport(checks, item) : item;
      return validCheckReport(report, checks.length) ? report : unavailable('guest_check_invalid');
    },
  });
}
