// Explicit local Git worktree creation. Session records remain read-only; only the selected repo gets a new worktree.
// All paths and Git diagnostics stay in this adapter and never enter the API response.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { managedWorktreePath, summarizeGitStatus } from './worktrees-git.mjs';

const execFile = promisify(nodeExecFile);
const NETWORK_PATH_RE = /^(?:\\\\|\/\/)/;
const MAX_OUTPUT = 512 * 1024;
const TIMEOUT_MS = 60_000;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

/** @param {unknown} value */
function safeBranch(value) {
  if (typeof value !== 'string' || !SAFE_BRANCH_RE.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')) return false;
  return value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.toLowerCase().endsWith('.lock'));
}

/** @param {string[]} args @param {string} cwd @param {number} [timeout] */
async function runGit(args, cwd, timeout = 2_000) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' });
  const result = await execFile('git', args, { cwd, env, timeout, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8', shell: false });
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/** @param {string} value */
const pathKey = (value) => {
  const key = path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

/** @param {{runGit?:(args:string[],cwd:string,timeout?:number)=>Promise<string>,fs?:typeof fs,tmpdir?:()=>string}} [options] */
export function createWorktreeCreator({ runGit: run = runGit, fs: fileSystem = fs, tmpdir = os.tmpdir } = {}) {
  return {
    /**
     * Create a branch worktree after a user-confirmed request. The caller must resolve cwd from a current session ID;
     * it must never accept a path from the browser.
     * @param {{cwd:string,branch:string}} request
     * @returns {Promise<{ok:true,branch:string,status:'clean'|'changed'|'untracked'|'mixed'|'conflicted'|'unknown',changed:number,untracked:number,conflicted:number}|{ok:false,reason:'invalid_target'|'not_repo'|'invalid_branch'|'target_exists'|'creation_failed'}>}
     */
    async create({ cwd, branch }) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || NETWORK_PATH_RE.test(cwd)) return { ok: false, reason: 'invalid_target' };
      if (!safeBranch(branch)) return { ok: false, reason: 'invalid_branch' };
      let root;
      try {
        root = (await run(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd)).trim();
      } catch {
        return { ok: false, reason: 'not_repo' };
      }
      if (!path.isAbsolute(root) || NETWORK_PATH_RE.test(root)) return { ok: false, reason: 'not_repo' };
      try {
        await run(['-C', root, 'check-ref-format', '--branch', branch], root);
      } catch {
        return { ok: false, reason: 'invalid_branch' };
      }

      const target = managedWorktreePath(root, branch);

      try {
        try {
          await fileSystem.lstat(target);
          return { ok: false, reason: 'target_exists' };
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return { ok: false, reason: 'invalid_target' };
        }
      } catch {
        return { ok: false, reason: 'invalid_target' };
      }

      let hookDir;
      try {
        hookDir = await fileSystem.mkdtemp(path.join(tmpdir(), 'pigeonholes-hooks-'));
        await run(['-C', root, '-c', `core.hooksPath=${hookDir}`, 'worktree', 'add', '-b', branch, target], root, TIMEOUT_MS);
      } catch {
        return { ok: false, reason: 'creation_failed' };
      } finally {
        if (hookDir) {
          try { await fileSystem.rm(hookDir, { recursive: true, force: true }); } catch { /* no diagnostics */ }
        }
      }

      try {
        const status = summarizeGitStatus(await run(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', target, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], target));
        return { ok: true, branch, status: status.state, changed: status.changed, untracked: status.untracked, conflicted: status.conflicted };
      } catch {
        return { ok: true, branch, status: 'unknown', changed: 0, untracked: 0, conflicted: 0 };
      }
    },
  };
}
