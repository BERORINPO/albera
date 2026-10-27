import path from 'node:path';

export const WINDOWS_TASKKILL_TIMEOUT_MS = 5000;

/** Run the fixed OS tree-termination utility with a finite wait and no shell. */
export function runWindowsTaskkill(pid, { systemRoot, spawnImpl, timeoutMs = WINDOWS_TASKKILL_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof spawnImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) {
    return Promise.reject(new TypeError('invalid_windows_tree_termination_options'));
  }
  const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  return new Promise((resolve, reject) => {
    let killer;
    try { killer = spawnImpl(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { reject(new Error('taskkill_spawn_failed')); return; }
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    killer.once('error', () => finish(new Error('taskkill_spawn_failed')));
    killer.once('close', (code) => code === 0 ? finish() : finish(new Error('taskkill_failed')));
    timer = setTimeout(() => {
      try { killer.kill?.('SIGKILL'); } catch { /* timeout still bounds the caller */ }
      finish(new Error('taskkill_timeout'));
    }, timeoutMs);
  });
}

/**
 * Attempt the Windows tree kill first, then fall back to signaling the direct child
 * if taskkill is missing, fails, reports non-zero, or exceeds its bounded wait.
 */
export function terminateWindowsTree(pid, { systemRoot, spawnImpl, killFallback, timeoutMs = WINDOWS_TASKKILL_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof spawnImpl !== 'function' || typeof killFallback !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('invalid_windows_tree_termination_options');
  }

  const fallback = () => {
    let accepted = false;
    try { accepted = killFallback() !== false; } catch { /* direct child may already be gone */ }
    return { treeConfirmed: false, fallbackAttempted: true, fallbackAccepted: accepted };
  };
  return runWindowsTaskkill(pid, { systemRoot, spawnImpl, timeoutMs })
    .then(() => ({ treeConfirmed: true, fallbackAttempted: false, fallbackAccepted: false }))
    .catch(() => fallback());
}
