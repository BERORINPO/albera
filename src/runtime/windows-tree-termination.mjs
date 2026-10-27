import path from 'node:path';

/**
 * Attempt the Windows tree kill first, then fall back to signaling the direct child
 * if taskkill is missing, fails to spawn, or reports a non-zero exit code.
 */
export function terminateWindowsTree(pid, { systemRoot, spawnImpl, killFallback } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof spawnImpl !== 'function' || typeof killFallback !== 'function') {
    throw new TypeError('invalid_windows_tree_termination_options');
  }

  const fallback = () => {
    let accepted = false;
    try { accepted = killFallback() !== false; } catch { /* direct child may already be gone */ }
    return { treeConfirmed: false, fallbackAttempted: true, fallbackAccepted: accepted };
  };
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) return Promise.resolve(fallback());

  const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    let killer;
    try { killer = spawnImpl(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { resolve(fallback()); return; }

    let settled = false;
    const finish = (treeConfirmed) => {
      if (settled) return;
      settled = true;
      resolve(treeConfirmed
        ? { treeConfirmed: true, fallbackAttempted: false, fallbackAccepted: false }
        : fallback());
    };
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}
