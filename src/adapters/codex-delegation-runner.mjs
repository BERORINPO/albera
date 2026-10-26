// Filesystem/process adapter for explicitly confirmed Codex follow-up runs.
// Only user-authored purpose text is written to child stdin. Child output is discarded.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE_MAX = 2000;
const MAX_OPERATIONS = 200;
const OPERATION_ID = SESSION_ID;

/** Resolve only an absolute executable file from PATH; never let the target repo's cwd supply the command. */
export function resolveCodexExecutable({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const pathValue = pathKey ? env[pathKey] : '';
  if (typeof pathValue !== 'string') return null;
  const join = platform === 'win32' ? path.win32 : path;
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  for (const rawDirectory of pathValue.split(platform === 'win32' ? ';' : ':')) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory || !join.isAbsolute(directory)) continue;
    const candidate = join.resolve(directory, name);
    try { if (exists(candidate)) return candidate; } catch { /* unavailable PATH entry */ }
  }
  return null;
}

/** @param {{spawn?: typeof nodeSpawn, executable?: string|null}} [options] */
export function createCodexDelegationRunner({ spawn = nodeSpawn, executable = resolveCodexExecutable() } = {}) {
  const operations = new Map();
  const runningSessions = new Set();
  const start = ({ sessionId, cwd, purpose, confirmed, operationId }) => {
    if (confirmed !== true || !SESSION_ID.test(sessionId ?? '') || !OPERATION_ID.test(operationId ?? '') || typeof cwd !== 'string' || !cwd || typeof purpose !== 'string' || !purpose.trim() || purpose.length > PURPOSE_MAX) return { ok: false, reason: 'invalid_request' };
    if (!executable) return { ok: false, reason: 'cli_unavailable' };
    const previous = operations.get(operationId);
    if (previous) return previous.sessionId === sessionId
      ? { ok: true, operationId, status: previous.status }
      : { ok: false, reason: 'invalid_request' };
    if (runningSessions.has(sessionId)) return { ok: false, reason: 'already_running' };
    while (operations.size >= MAX_OPERATIONS) {
      const stale = [...operations].find(([, operation]) => operation.status !== 'running');
      if (!stale) return { ok: false, reason: 'operation_limit' };
      operations.delete(stale[0]);
    }
    const id = operationId;
    let child;
    try {
      child = spawn(executable, ['exec', '--sandbox', 'read-only', 'resume', sessionId, '-'], {
        cwd, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      operations.set(id, { sessionId, status: 'failed' });
      return { ok: true, operationId: id, status: 'failed' };
    }
    operations.set(id, { sessionId, status: 'running' });
    runningSessions.add(sessionId);
    let closed = false;
    const finish = (result) => {
      operations.set(id, { sessionId, status: result });
      if (closed) runningSessions.delete(sessionId);
    };
    child.once('error', () => finish('failed'));
    child.once('close', (code, signal) => {
      closed = true;
      finish(code === 0 && !signal ? 'completed' : 'failed');
    });
    try {
      child.stdin.end(purpose.trim());
    } catch {
      finish('failed');
      try { child.kill(); } catch { /* keep the session locked until close */ }
    }
    return { ok: true, operationId: id, status: operations.get(id)?.status ?? 'running' };
  };
  const status = (id) => operations.get(id)?.status ?? null;
  return { start, status };
}

