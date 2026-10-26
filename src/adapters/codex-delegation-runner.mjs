// Filesystem/process adapter for explicitly confirmed Codex follow-up runs.
// Only user-authored purpose text is written to child stdin. Child output is discarded.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE_MAX = 2000;

/** @param {{spawn?: typeof nodeSpawn, executable?: string}} [options] */
export function createCodexDelegationRunner({ spawn = nodeSpawn, executable = process.platform === 'win32' ? 'codex.exe' : 'codex' } = {}) {
  const operations = new Map();
  const runningSessions = new Set();
  const start = ({ sessionId, cwd, purpose, confirmed }) => {
    if (confirmed !== true || !SESSION_ID.test(sessionId ?? '') || typeof cwd !== 'string' || !cwd || typeof purpose !== 'string' || !purpose.trim() || purpose.length > PURPOSE_MAX) return { ok: false, reason: 'invalid_request' };
    if (runningSessions.has(sessionId)) return { ok: false, reason: 'already_running' };
    const id = randomUUID();
    let child;
    try {
      child = spawn(executable, ['exec', '--sandbox', 'read-only', 'resume', sessionId, '-'], {
        cwd, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      operations.set(id, 'failed');
      return { ok: true, operationId: id };
    }
    operations.set(id, 'running');
    runningSessions.add(sessionId);
    const finish = (result) => { operations.set(id, result); runningSessions.delete(sessionId); };
    child.once('error', () => finish('failed'));
    child.once('close', (code, signal) => finish(code === 0 && !signal ? 'completed' : 'failed'));
    try {
      child.stdin.end(purpose.trim());
    } catch {
      finish('failed');
    }
    return { ok: true, operationId: id };
  };
  const status = (id) => operations.get(id) ?? null;
  return { start, status };
}

