// Read-only Git worktree inventory for one explicitly configured local WSL distro share.
// Paths and Git output stay in this adapter; no distro discovery or WSL shell is used.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWorktreeList, summarizeGitStatus } from './worktrees-git.mjs';
import { wslShareRoot, wslUncToCwd } from './wsl-paths.mjs';

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

/** @param {{shareRoot:string,runGit?:(args:string[],distro:string)=>Promise<string>}} options */
export function createWslWorktreeSource({ shareRoot, runGit = runWslGit }) {
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
          current: posixKey(entry.path) === posixKey(top),
        };
      }));
      return rows;
    },
  };
}
