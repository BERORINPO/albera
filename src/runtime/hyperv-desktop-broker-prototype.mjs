// PROTOTYPE. This runs as the same OS user as the caller; it is NOT the privileged Host Broker
// that ADR-002 requires. It is not called from any entry point, API route or host composition.
// Reaching a VM needs membership in the local "Hyper-V Administrators" group.
// Transport: a fixed `pwsh -File <fixed path>` process; the VM name and the action travel as JSON
// on stdin. No command line is ever assembled from data.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDesktopAction, validateDesktopScreen } from './desktop-control.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./hyperv-desktop/desktop-io.ps1', import.meta.url));
const PWSH_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH]);
const VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_CODES = new Set(['desktop_input_rejected', 'desktop_unavailable', 'desktop_vm_not_found']);
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function createHyperVDesktopBrokerPrototype({ pwsh = 'pwsh', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof pwsh !== 'string' || pwsh.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('invalid_hyperv_desktop_prototype_options');
  }
  const run = (request) => runScript(pwsh, timeoutMs, request);
  return {
    async captureVmScreen({ vmId, width, height }) {
      const screen = validateDesktopScreen({ width, height });
      const result = await run({ op: 'capture', vm: checkedVm(vmId), width: screen.width, height: screen.height });
      if (typeof result.png !== 'string') throw brokerError('desktop_unavailable');
      return Buffer.from(result.png, 'base64');
    },
    async sendVmInput({ vmId, action }) {
      // Re-validate with the largest allowed screen; the Driver already applied the real size.
      const checked = validateDesktopAction(action, { width: 4096, height: 4096 });
      await run({ op: 'input', vm: checkedVm(vmId), action: checked });
      return { ok: true };
    },
  };
}

function checkedVm(vmId) {
  if (typeof vmId !== 'string' || !VM_NAME_RE.test(vmId)) throw brokerError('desktop_vm_not_found', 'not_applied');
  return vmId;
}

function brokerError(code, outcome = 'unknown') {
  return Object.assign(new Error(code), { code, outcome });
}

function runScript(pwsh, timeoutMs, request) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(pwsh, PWSH_ARGS, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    catch {
      reject(brokerError('desktop_unavailable', 'not_applied'));
      return;
    }
    const out = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, brokerError('desktop_broker_timeout'));
    }, timeoutMs);
    child.on('error', () => finish(reject, brokerError('desktop_unavailable', 'not_applied')));
    child.stdout.on('data', (data) => {
      outBytes += data.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish(reject, brokerError('desktop_unavailable'));
        return;
      }
      out.push(data);
    });
    child.stderr.on('data', (data) => { // drained, never surfaced: it may contain host paths
      errBytes += data.length;
      if (errBytes > MAX_STDERR_BYTES) child.stderr.destroy();
    });
    child.on('close', () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(out).toString('utf8'));
      }
      catch {
        finish(reject, brokerError('desktop_unavailable'));
        return;
      }
      if (parsed && parsed.ok === true) finish(resolve, parsed);
      else finish(reject, brokerError(SAFE_CODES.has(parsed?.code) ? parsed.code : 'desktop_unavailable'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
