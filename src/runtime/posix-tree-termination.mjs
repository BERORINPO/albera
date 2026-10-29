import process from 'node:process';

const DEFAULT_GRACE_MS = 300;

/**
 * Stop a detached POSIX process group. A direct-child kill is only a fallback:
 * it cannot prove that descendants have exited, so it never confirms the tree.
 */
export async function terminatePosixTree(pid, signal, {
  killImpl = process.kill,
  fallbackImpl = () => false,
  delayImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs = DEFAULT_GRACE_MS,
} = {}) {
  const first = signalGroup(pid, signal, killImpl, fallbackImpl);
  if (signal === 'SIGKILL') return first;

  await delayImpl(graceMs);
  const escalated = signalGroup(pid, 'SIGKILL', killImpl, fallbackImpl);
  return {
    ...escalated,
    fallbackAttempted: first.fallbackAttempted || escalated.fallbackAttempted,
    fallbackAccepted: first.fallbackAccepted || escalated.fallbackAccepted,
  };
}

function signalGroup(pid, signal, killImpl, fallbackImpl) {
  try {
    killImpl(-pid, signal);
    return { treeConfirmed: true, confirmed: true, fallbackAttempted: false, fallbackAccepted: false };
  } catch (error) {
    // ESRCH means the process group no longer exists, which is a confirmed stop.
    if (error?.code === 'ESRCH') {
      return { treeConfirmed: true, confirmed: true, fallbackAttempted: false, fallbackAccepted: false };
    }
    let fallbackAccepted = false;
    try { fallbackAccepted = fallbackImpl() === true; } catch { /* fallback cannot confirm descendants */ }
    return { treeConfirmed: false, confirmed: false, fallbackAttempted: true, fallbackAccepted };
  }
}
