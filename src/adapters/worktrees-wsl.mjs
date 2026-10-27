// Git worktree adapter for one explicitly configured local WSL distro share.
// Paths and Git output stay here; no distro discovery or WSL shell is used.
import crypto from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseWorktreeList, summarizeGitStatus } from './worktrees-git.mjs';
import { wslCwdToUnc, wslShareRoot, wslUncToCwd } from './wsl-paths.mjs';

const execFile = promisify(nodeExecFile);
const MAX_OUTPUT = 512 * 1024;

/** @param {string[]} args @param {string} distro */
async function runWslGit(args, distro) {
  const env = {};
  const pathValue = process.env.PATH ?? process.env.Path;
  if (pathValue) env.PATH = pathValue;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const result = await execFile('wsl.exe', ['--distribution', distro, '--exec', 'git', ...args], {
    env, timeout: 10_000, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8', shell: false,
  });
  return typeof result.stdout === 'string' ? result.stdout : '';
}

const posixAbsolute = (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
const posixKey = (value) => value.replace(/\/+$/, '');
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const safeBranch = (value) => typeof value === 'string' && SAFE_BRANCH_RE.test(value) && !value.includes('..') && !value.includes('//')
  && !value.endsWith('/') && !value.endsWith('.') && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.toLowerCase().endsWith('.lock'));

function worktreeTarget(root, distro, branch) {
  const repoHash = crypto.createHash('sha256').update(`${distro.toLowerCase()}\0${root}`).digest('hex').slice(0, 12);
  const branchHash = crypto.createHash('sha256').update(branch).digest('hex').slice(0, 8);
  const slug = branch.replaceAll('/', '-').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48);
  return path.posix.join(path.posix.dirname(root), `${path.posix.basename(root)}-pigeonholes-${repoHash}-${slug}-${branchHash}`);
}

function isManagedWorktreeEntry(target, entries, distro) {
  return !!target.branch && entries.some((origin) => posixKey(origin.path) !== posixKey(target.path)
    && posixKey(target.path) === posixKey(worktreeTarget(origin.path, distro, target.branch)));
}

/** @param {{shareRoot:string,runGit?:(args:string[],distro:string,timeout?:number)=>Promise<string>,fs?:typeof fs}} options */
export function createWslWorktreeSource({ shareRoot, runGit = runWslGit, fs: fileSystem = fs }) {
  const configuredRoot = wslShareRoot(shareRoot);
  return {
    /** Read-only list for a session path already mapped through the configured WSL share. */
    async listForCwd(uncCwd) {
      if (!configuredRoot || typeof uncCwd !== 'string') return [];
      const mapped = wslUncToCwd(uncCwd, configuredRoot);
      if (!mapped) return [];
      const run = (args) => runGit(args, mapped.distro);
      const top = (await run(['-C', mapped.cwd, 'rev-parse', '--show-toplevel'])).trim();
      if (!posixAbsolute(top)) return [];
      const entries = parseWorktreeList(await run(['-C', top, 'worktree', 'list', '--porcelain', '-z']), posixAbsolute)
        .filter((entry) => posixAbsolute(entry.path)).slice(0, 20);
      const rows = await Promise.all(entries.map(async (entry) => {
        let status = { state: 'unknown', changed: 0, untracked: 0, conflicted: 0 };
        try {
          status = summarizeGitStatus(await run(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', entry.path, 'status', '--porcelain=v1', '-z', '--untracked-files=normal']));
        } catch { /* Keep only safe branch metadata and an explicit unknown status. */ }
        return {
          branch: entry.branch, status: status.state, changed: status.changed, untracked: status.untracked,
          conflicted: status.conflicted, detached: entry.detached, locked: entry.locked, prunable: entry.prunable,
          current: posixKey(entry.path) === posixKey(top), removable: isManagedWorktreeEntry(entry, entries, mapped.distro),
        };
      }));
      return rows;
    },
    /** Create a branch worktree only after the user confirms in the board. */
    async create({ cwd: uncCwd, branch, confirmed }) {
      if (confirmed !== true || !safeBranch(branch)) return { ok: false, reason: 'invalid_target' };
      const mapped = wslUncToCwd(uncCwd, configuredRoot);
      if (!mapped) return { ok: false, reason: 'invalid_target' };
      const run = (args, timeout = 10_000) => runGit(args, mapped.distro, timeout);
      let root;
      try { root = (await run(['-C', mapped.cwd, 'rev-parse', '--show-toplevel'])).trim(); } catch { return { ok: false, reason: 'not_repo' }; }
      if (!posixAbsolute(root)) return { ok: false, reason: 'not_repo' };
      try { await run(['-C', root, 'check-ref-format', '--branch', branch]); } catch { return { ok: false, reason: 'invalid_branch' }; }
      const target = worktreeTarget(root, mapped.distro, branch);
      const targetUnc = wslCwdToUnc(target, configuredRoot);
      if (!targetUnc) return { ok: false, reason: 'invalid_target' };
      try {
        await fileSystem.lstat(targetUnc);
        return { ok: false, reason: 'target_exists' };
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return { ok: false, reason: 'invalid_target' };
      }
      try { await run(['-c', 'core.hooksPath=/dev/null', '-C', root, 'worktree', 'add', '-b', branch, target], 60_000); }
      catch { return { ok: false, reason: 'creation_failed' }; }
      let status = { state: 'unknown', changed: 0, untracked: 0, conflicted: 0 };
      try { status = summarizeGitStatus(await run(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', target, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'])); } catch { /* safe unknown */ }
      return { ok: true, branch, status: status.state, changed: status.changed, untracked: status.untracked, conflicted: status.conflicted };
    },
    /** Remove only a managed, clean, non-current worktree after branch-name confirmation. */
    async remove({ cwd: uncCwd, branch, confirmed }) {
      if (confirmed !== true || !safeBranch(branch)) return { ok: false, reason: 'invalid_target' };
      const mapped = wslUncToCwd(uncCwd, configuredRoot);
      if (!mapped) return { ok: false, reason: 'invalid_target' };
      const run = (args, timeout = 10_000) => runGit(args, mapped.distro, timeout);
      let root;
      try { root = (await run(['-C', mapped.cwd, 'rev-parse', '--show-toplevel'])).trim(); } catch { return { ok: false, reason: 'not_repo' }; }
      if (!posixAbsolute(root)) return { ok: false, reason: 'not_repo' };
      let entries;
      try { entries = parseWorktreeList(await run(['-C', root, 'worktree', 'list', '--porcelain', '-z']), posixAbsolute); }
      catch { return { ok: false, reason: 'removal_failed' }; }
      const entry = entries.find((item) => item.branch === branch);
      if (!entry) return { ok: false, reason: 'not_found' };
      if (posixKey(entry.path) === posixKey(root)) return { ok: false, reason: 'current' };
      if (!entry.branch || !posixAbsolute(entry.path) || !isManagedWorktreeEntry(entry, entries, mapped.distro)) return { ok: false, reason: 'invalid_target' };
      if (entry.locked) return { ok: false, reason: 'locked' };
      if (entry.prunable) return { ok: false, reason: 'prunable' };
      let status;
      try { status = summarizeGitStatus(await run(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', entry.path, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'])); }
      catch { return { ok: false, reason: 'not_clean' }; }
      if (status.state !== 'clean') return { ok: false, reason: 'not_clean' };
      try { await run(['-C', root, 'worktree', 'remove', entry.path], 60_000); return { ok: true, branch }; }
      catch { return { ok: false, reason: 'removal_failed' }; }
    },
  };
}
