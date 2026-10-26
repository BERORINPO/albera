// @ts-check
// Read-only local Git adapter. Git paths and porcelain entries stay in this adapter.

import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { mapLimit } from './map-limit.mjs';

const execFile = promisify(nodeExecFile);
const MAX_SESSIONS = 20;
const MAX_OUTPUT = 512 * 1024;
const CACHE_MS = 5_000;
const TIMEOUT_MS = 1_500;
const MAX_COUNT = 999;
const NETWORK_PATH_RE = /^(?:\\\\|\/\/)/;

/** @typedef {{path:string,branch:string|null,detached:boolean,locked:boolean,prunable:boolean}} GitWorktree */
/** @typedef {{branch:string|null,status:'clean'|'changed'|'untracked'|'mixed'|'conflicted'|'unknown',changed:number,untracked:number,conflicted:number,locked:boolean,prunable:boolean}} WorktreeSummary */

/** Git's porcelain `-z` format is NUL-delimited; paths and lock reasons are intentionally kept private. @param {string} raw */
export function parseWorktreeList(raw) {
  /** @type {GitWorktree[]} */
  const out = [];
  /** @type {Partial<GitWorktree>} */
  let entry = {};
  const push = () => {
    if (typeof entry.path === 'string' && path.isAbsolute(entry.path)) {
      out.push({ path: entry.path, branch: entry.branch ?? null, detached: !!entry.detached, locked: !!entry.locked, prunable: !!entry.prunable });
    }
    entry = {};
  };
  for (const tokenRaw of raw.split('\0')) {
    const token = tokenRaw.replace(/[\r\n]+$/, '');
    if (!token) {
      if (entry.path) push();
      continue;
    }
    const space = token.indexOf(' ');
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? '' : token.slice(space + 1);
    if (key === 'worktree') {
      if (entry.path) push();
      entry.path = value;
    } else if (key === 'branch' && value.startsWith('refs/heads/')) {
      entry.branch = safeBranch(value.slice('refs/heads/'.length));
    } else if (key === 'detached') entry.detached = true;
    else if (key === 'locked') entry.locked = true;
    else if (key === 'prunable') entry.prunable = true;
  }
  if (entry.path) push();
  return out;
}

/** @param {string} value */
function safeBranch(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(value) || value.includes('..') || value.includes('//')) return null;
  return value;
}

/** Parse Git status codes and discard every path before returning. @param {string} raw */
export function summarizeGitStatus(raw) {
  let changed = 0;
  let untracked = 0;
  let conflicted = 0;
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i].replace(/[\r\n]+$/, '');
    if (line.length < 3 || line[2] !== ' ') continue;
    const xy = line.slice(0, 2);
    if (xy === '??') untracked++;
    else if (/[U]/.test(xy) || ['AA', 'DD'].includes(xy)) conflicted++;
    else if (xy !== '  ') changed++;
    if (/[RC]/.test(xy)) i++; // -z rename/copy records include the old path as a second NUL item.
  }
  changed = Math.min(MAX_COUNT, changed);
  untracked = Math.min(MAX_COUNT, untracked);
  conflicted = Math.min(MAX_COUNT, conflicted);
  const state = conflicted ? 'conflicted' : changed && untracked ? 'mixed' : changed ? 'changed' : untracked ? 'untracked' : 'clean';
  return { state, changed, untracked, conflicted };
}

const pathKey = (value) => {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/** @param {string[]} args @param {string} cwd */
async function runGit(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  const result = await execFile('git', args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8', shell: false });
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/** @param {{runGit?:(args:string[],cwd:string)=>Promise<string>,clock?:()=>number}} [options] */
export function createWorktreeSource({ runGit: run = runGit, clock = () => Date.now() } = {}) {
  /** @type {Map<string,{at:number,value:WorktreeSummary|null}>} */
  const cache = new Map();
  let stats = { scanned: 0, matched: 0, unavailable: 0, skipped: 0 };

  /** @param {string} cwd */
  async function inspect(cwd) {
    if (NETWORK_PATH_RE.test(cwd)) return null;
    const top = (await run(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd)).trim();
    if (!path.isAbsolute(top)) return null;
    const list = parseWorktreeList(await run(['-C', top, 'worktree', 'list', '--porcelain', '-z'], top));
    const match = list.find((entry) => pathKey(entry.path) === pathKey(top));
    if (!match) return null;
    let status = { state: 'unknown', changed: 0, untracked: 0, conflicted: 0 };
    try {
      const statusText = await run(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], top);
      status = summarizeGitStatus(statusText);
    } catch {
      // Keep the discovered branch/lock metadata, but don't surface command diagnostics.
    }
    return {
      branch: match.branch,
      status: status.state,
      changed: status.changed,
      untracked: status.untracked,
      conflicted: status.conflicted,
      locked: match.locked,
      prunable: match.prunable,
    };
  }

  return {
    /**
     * Add path-free Git worktree summaries to recent, non-archived session records.
     * @param {import('../shared/types.mjs').SessionRecord[]} sessions
     */
    async enrich(sessions) {
      const candidates = sessions.filter((s) => !s.isArchived && typeof s.cwd === 'string' && path.isAbsolute(s.cwd))
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
      const unique = [...new Map(candidates.map((s) => [pathKey(s.cwd), s.cwd])).values()];
      const selected = unique.slice(0, MAX_SESSIONS);
      const now = clock();
      const results = await mapLimit(selected, 4, async (cwd) => {
        const key = pathKey(cwd);
        const hit = cache.get(key);
        if (hit && now - hit.at < CACHE_MS) return [key, hit.value];
        try {
          const value = await inspect(cwd);
          cache.set(key, { at: now, value });
          return [key, value];
        } catch {
          cache.set(key, { at: now, value: null });
          return [key, null];
        }
      });
      const byCwd = new Map(results);
      const matched = [...byCwd.values()].filter(Boolean).length;
      stats = { scanned: selected.length, matched, unavailable: selected.length - matched, skipped: unique.length - selected.length };
      const activeMap = new Map(candidates.map((s) => [pathKey(s.cwd), byCwd.get(pathKey(s.cwd)) ?? {
        branch: null, status: 'unknown', changed: 0, untracked: 0, conflicted: 0, locked: false, prunable: false,
      }]));
      return sessions.map((s) => {
        const summary = typeof s.cwd === 'string' ? activeMap.get(pathKey(s.cwd)) : undefined;
        return summary ? { ...s, gitWorktree: { ...summary } } : s;
      });
    },
    stats: () => ({ ...stats }),
  };
}
