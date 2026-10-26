// Explicit local Git worktree removal. Only an exact clean, non-current, unlocked branch target is eligible.
// Paths and Git diagnostics stay inside this adapter; the caller resolves cwd from a current session ID.

import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { managedWorktreePath, parseWorktreeList, summarizeGitStatus } from './worktrees-git.mjs';

const execFile = promisify(nodeExecFile);
const NETWORK_PATH_RE = /^(?:\\\\|\/\/)/;
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 512 * 1024;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

/** @param {unknown} value */
function safeBranch(value) {
  return typeof value === 'string' && SAFE_BRANCH_RE.test(value) && !value.includes('..') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.')
    && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.toLowerCase().endsWith('.lock'));
}

/** @param {string[]} args @param {string} cwd */
async function runGit(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' });
  const result = await execFile('git', args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8', shell: false });
  return typeof result.stdout === 'string' ? result.stdout : '';
}

const pathKey = (value) => {
  const key = path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

/** @param {{runGit?:(args:string[],cwd:string)=>Promise<string>}} [options] */
export function createWorktreeRemover({ runGit: run = runGit } = {}) {
  return {
    /**
     * Remove one explicitly confirmed branch worktree. Git rechecks cleanliness; force is never used.
     * @param {{cwd:string,branch:string,confirmed:boolean}} request
     * @returns {Promise<{ok:true,branch:string}|{ok:false,reason:'invalid_target'|'not_repo'|'invalid_branch'|'not_found'|'current'|'locked'|'prunable'|'not_clean'|'removal_failed'}>}
     */
    async remove({ cwd, branch, confirmed }) {
      if (confirmed !== true) return { ok: false, reason: 'invalid_target' };
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || NETWORK_PATH_RE.test(cwd)) return { ok: false, reason: 'invalid_target' };
      if (!safeBranch(branch)) return { ok: false, reason: 'invalid_branch' };
      let root;
      try { root = (await run(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd)).trim(); } catch { return { ok: false, reason: 'not_repo' }; }
      if (!path.isAbsolute(root) || NETWORK_PATH_RE.test(root)) return { ok: false, reason: 'not_repo' };

      let entries;
      try { entries = parseWorktreeList(await run(['-C', root, 'worktree', 'list', '--porcelain', '-z'], root)); }
      catch { return { ok: false, reason: 'removal_failed' }; }
      const target = entries.find((entry) => entry.branch === branch);
      if (!target) return { ok: false, reason: 'not_found' };
      if (pathKey(target.path) === pathKey(root)) return { ok: false, reason: 'current' };
      if (NETWORK_PATH_RE.test(target.path)) return { ok: false, reason: 'invalid_target' };
      if (pathKey(target.path) !== pathKey(managedWorktreePath(root, branch))) return { ok: false, reason: 'invalid_target' };
      if (target.locked) return { ok: false, reason: 'locked' };
      if (target.prunable) return { ok: false, reason: 'prunable' };

      let status;
      try {
        status = summarizeGitStatus(await run(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', target.path, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], target.path));
      } catch { return { ok: false, reason: 'not_clean' }; }
      if (status.state !== 'clean') return { ok: false, reason: 'not_clean' };

      try {
        await run(['-C', root, 'worktree', 'remove', target.path], root);
        return { ok: true, branch };
      } catch { return { ok: false, reason: 'removal_failed' }; }
    },
  };
}
