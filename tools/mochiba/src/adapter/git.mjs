// Calls the real git. Read-only commands only (log, rev-parse), never anything that writes to the repo.
import { execFileSync } from 'node:child_process';
import { LOG_FORMAT } from '../core/git-log.mjs';

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
// Unquoted paths (Japanese names match table 1) and no repo-defined diff drivers or textconv programs.
const SAFE_CONFIG = ['-c', 'core.quotePath=false'];

/** An error from git that the CLI reports as an input problem (not a git repo, git missing, too much output). */
export class GitUnavailable extends Error {}

function git(dir, args) {
  try {
    return execFileSync('git', [...SAFE_CONFIG, '-C', dir, ...args], {
      encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (err) {
    if (err.code === 'ENOENT') throw new GitUnavailable('git が見つからない (git を入れて PATH に通す)');
    if (err.code === 'ENOBUFS') throw new GitUnavailable('git log の出力が多すぎる (--since で期間を狭める)');
    if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') throw new GitUnavailable(`git が ${TIMEOUT_MS / 1000} 秒で終わらなかった (--since で期間を狭める)`);
    const msg = String(err.stderr || err.message).split(/\r?\n/)[0];
    throw new GitUnavailable(`git が読めない: ${msg} (対象は git の repo の中のフォルダにする)`);
  }
}

export function createGit() {
  return {
    /** Absolute path of the top of the work tree that holds dir. */
    topLevel(dir) {
      return git(dir, ['rev-parse', '--show-toplevel']).trim();
    },
    /** Last commit that touched the folder: {hash, date, subject} or null when there is none. */
    lastCommit(dir) {
      const out = git(dir, ['log', '-1', '--format=%H%x1f%cI%x1f%s', '--', '.']).trim();
      if (!out) return null;
      const [hash, date, subject] = out.split('\x1f');
      return { hash, date, subject };
    },
    /** Commits since the date, paths relative to the folder, children before parents. */
    log(dir, sinceIso) {
      return git(dir, ['log', `--since=${sinceIso}`, '--topo-order', '--numstat', '--summary', '--relative', '--no-renames',
        '--no-textconv', '--no-ext-diff', `--format=${LOG_FORMAT}`]);
    },
  };
}
