#!/usr/bin/env node
// upstream-sync: in a private copy of ALBERA, open (or refresh) one pull request that brings in what changed upstream.
// Run weekly by .github/workflows/albera-updates.yml; it never runs in BERORINPO/albera itself (the workflow's `if:`).
// docs/private-copy.md says how a copy is made and set up.
//
//   node scripts/upstream-sync.mjs        (in a checkout of the copy with full history, `gh` signed in as the workflow)
//
// What it does, in order:
//   1. fetches the upstream branch (ALBERA_UPSTREAM / ALBERA_UPSTREAM_REF, default the public ALBERA main);
//   2. stops quietly when the copy's base branch already contains it;
//   3. pushes the upstream tip to the copy's branch `albera-update` (a branch only this script writes);
//   4. opens a pull request albera-update -> base, or rewrites the title and body of the one already open.
// The body lists the new CHANGELOG lines and the commits, inside fenced blocks so that upstream text cannot mention
// people, link images or run markup in the copy. Nothing about the copy itself (its code, branches, issues) is read or
// sent anywhere: the only network calls are the fetch from upstream and the push / pull request inside the copy.
// Exit 0: up to date, opened or refreshed. Exit 1: a step failed; the job summary says why and what to change.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SYNC_DEFAULTS = Object.freeze({
  upstream: 'https://github.com/BERORINPO/albera.git',
  ref: 'main',
  base: 'main',
  branch: 'albera-update',
});
const MAX_COMMITS = 30;          // listed in the body; the rest are counted
const MAX_CHANGELOG_LINES = 60;
const MAX_LINE = 300;            // one listed line, in characters
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** Lines added to CHANGELOG.md in a unified diff (no "+++" header, no removed or context lines). */
export function changelogAdditions(diff) {
  return String(diff).split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .filter((line, i, all) => line.trim() || (i > 0 && all[i - 1].trim()));   // no runs of blank lines
}

const clip = (line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line);

/** A fenced block that the text inside cannot close: the fence is longer than any backtick run in the text. */
export function fenced(lines) {
  const text = lines.map(clip).join('\n');
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * Title and body of the update pull request.
 * @param {{upstream:string, ref:string, tip:string, commits:{sha:string, subject:string}[], changelog:string[], workflows:string[]}} p
 */
export function syncPullRequest({ upstream, ref, tip, commits, changelog, workflows }) {
  const n = commits.length;
  const short = tip.slice(0, 7);
  const plural = n === 1 ? 'commit' : 'commits';
  const listed = commits.slice(0, MAX_COMMITS).map((c) => `${c.sha.slice(0, 7)} ${c.subject}`);
  if (n > MAX_COMMITS) listed.push(`… and ${n - MAX_COMMITS} more`);
  const log = changelog.slice(0, MAX_CHANGELOG_LINES);
  if (changelog.length > MAX_CHANGELOG_LINES) log.push(`… and ${changelog.length - MAX_CHANGELOG_LINES} more lines (see CHANGELOG.md)`);
  const parts = [
    `This copy of ALBERA is ${n} ${plural} behind \`${ref}\` of ${upstream} (now at \`${short}\`).`,
    'Merging this pull request brings them in. Your own changes stay as they are; if GitHub shows conflicts, resolve them here.',
    '',
    '## What changed (new lines in CHANGELOG.md)',
    '',
    log.length ? fenced(log) : 'CHANGELOG.md has no new lines in these commits.',
    '',
    `## Commits (${n})`,
    '',
    fenced(listed),
  ];
  if (workflows.length) {
    parts.push('', '## Workflow files changed upstream', '',
      'These files under `.github/workflows/` change. Read them before merging: they run in this copy with its permissions.', '',
      fenced(workflows));
  }
  parts.push('', '---',
    'Opened by `.github/workflows/albera-updates.yml` (`scripts/upstream-sync.mjs`). It runs once a week; disable that workflow to stop it. '
    + 'How a copy is set up: `docs/private-copy.md`.');
  return { title: `ALBERA update: ${n} new ${plural} (${short})`, body: parts.join('\n') };
}

/** Settings from the environment, checked. Empty values fall back to the defaults. */
export function syncSettings(env) {
  const pick = (name, fallback) => (env[name] && String(env[name]).trim()) || fallback;
  const s = {
    upstream: pick('ALBERA_UPSTREAM', SYNC_DEFAULTS.upstream),
    ref: pick('ALBERA_UPSTREAM_REF', SYNC_DEFAULTS.ref),
    base: pick('BASE_BRANCH', ''),   // empty: the copy's default branch, asked from GitHub
    branch: SYNC_DEFAULTS.branch,
  };
  for (const key of ['ref', 'base']) if (s[key] && (!REF_RE.test(s[key]) || s[key].includes('..'))) throw new Error(`${key}_invalid`);
  if (/^-/.test(s.upstream) || /\s/.test(s.upstream)) throw new Error('upstream_invalid');
  if (s.base === s.branch) throw new Error('base_is_the_update_branch');
  return s;
}

/** The real runner: argument arrays only (no shell), output as text. */
export function runCommand(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

/**
 * One sync. `run(cmd, args, {cwd})` -> {code, stdout, stderr}; tests pass a runner with a fake `gh`.
 * @returns {{status:string, exitCode:number, message:string, pr?:number}}
 */
export function upstreamSync({ cwd, env = process.env, run = runCommand }) {
  const s = { ...syncSettings(env) };
  const git = (...args) => run('git', args, { cwd });
  const must = (r, what) => { if (r.code !== 0) throw Object.assign(new Error(`${what}: ${r.stderr.trim().split('\n').pop()}`), { step: what }); return r.stdout.trim(); };

  if (!s.base) {
    s.base = must(run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd }), 'read_default_branch');
    if (!REF_RE.test(s.base) || s.base === s.branch) throw Object.assign(new Error(`default branch not usable: ${s.base}`), { step: 'read_default_branch' });
  }
  must(git('fetch', '--no-tags', '--quiet', '--', s.upstream, `refs/heads/${s.ref}`), 'fetch_upstream');
  const tip = must(git('rev-parse', '--verify', 'FETCH_HEAD^{commit}'), 'read_upstream_tip');
  const baseRef = `refs/remotes/origin/${s.base}`;
  must(git('rev-parse', '--verify', `${baseRef}^{commit}`), 'read_base_branch');
  if (git('merge-base', '--is-ancestor', tip, baseRef).code === 0) {
    return { status: 'up_to_date', exitCode: 0, message: `The copy's ${s.base} already has ALBERA ${s.ref} at ${tip.slice(0, 7)}.` };
  }
  const mb = git('merge-base', tip, baseRef);
  if (mb.code !== 0 || !mb.stdout.trim()) {
    return { status: 'no_shared_history', exitCode: 1,
      message: `The copy's ${s.base} shares no history with ALBERA ${s.ref}, so there is nothing to compare. Make the copy with its history (docs/private-copy.md, "Make the copy").` };
  }
  const since = mb.stdout.trim();
  const commits = must(git('log', '--no-merges', '--format=%H%x09%s', `${since}..${tip}`), 'list_commits')
    .split('\n').filter(Boolean).map((line) => { const [sha, ...rest] = line.split('\t'); return { sha, subject: rest.join('\t') }; });
  const changelog = changelogAdditions(must(git('diff', '--no-color', '--no-ext-diff', since, tip, '--', 'CHANGELOG.md'), 'diff_changelog'));
  const workflows = must(git('diff', '--name-only', since, tip, '--', '.github/workflows'), 'list_workflow_changes').split('\n').filter(Boolean);
  if (!commits.length) commits.push(...must(git('log', '--format=%H%x09%s', '-1', tip), 'read_tip').split('\n').filter(Boolean)
    .map((line) => { const [sha, ...rest] = line.split('\t'); return { sha, subject: rest.join('\t') }; }));

  const push = git('push', '--force-with-lease', '--quiet', 'origin', `${tip}:refs/heads/${s.branch}`);
  if (push.code !== 0) {
    const wf = /workflow/i.test(push.stderr) && workflows.length;
    return { status: wf ? 'push_refused_workflows' : 'push_failed', exitCode: 1,
      message: wf
        ? `Pushing ${s.branch} was refused because upstream changed files under .github/workflows/, which the workflow's own token may not write. Add a repository secret ALBERA_SYNC_TOKEN (a token that may write workflows) or merge by hand (docs/private-copy.md, "When the update cannot be pushed").`
        : `Pushing ${s.branch} failed: ${push.stderr.trim().split('\n').pop()}` };
  }

  const { title, body } = syncPullRequest({ upstream: s.upstream, ref: s.ref, tip, commits, changelog, workflows });
  const gh = (...args) => run('gh', args, { cwd });
  const open = gh('pr', 'list', '--head', s.branch, '--base', s.base, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty');
  if (open.code !== 0) return { status: 'pr_failed', exitCode: 1, message: `Listing pull requests failed: ${open.stderr.trim().split('\n').pop()}` };
  const number = Number(open.stdout.trim()) || 0;
  const r = number
    ? gh('pr', 'edit', String(number), '--title', title, '--body', body)
    : gh('pr', 'create', '--base', s.base, '--head', s.branch, '--title', title, '--body', body);
  if (r.code !== 0) {
    const notAllowed = /not permitted to create|not allowed to create/i.test(r.stderr);
    return { status: 'pr_failed', exitCode: 1,
      message: notAllowed
        ? 'GitHub Actions may not open pull requests in this repository. Turn on Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests", or add ALBERA_SYNC_TOKEN (docs/private-copy.md).'
        : `${number ? 'Updating' : 'Opening'} the pull request failed: ${r.stderr.trim().split('\n').pop()}` };
  }
  const made = number || Number((r.stdout.match(/\/pull\/(\d+)/) || [])[1]) || undefined;
  return { status: number ? 'updated' : 'opened', exitCode: 0, pr: made,
    message: `${number ? 'Refreshed' : 'Opened'} the update pull request${made ? ` #${made}` : ''}: ${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} from ALBERA ${s.ref} up to ${tip.slice(0, 7)}.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = upstreamSync({ cwd: process.cwd() }); }
  catch (error) { result = { status: error.step || 'failed', exitCode: 1, message: error.message }; }
  console.log(`${result.status}: ${result.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ALBERA update\n\n${result.message}\n`);
  process.exitCode = result.exitCode;
}
