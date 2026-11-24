#!/usr/bin/env node
// upstream-sync: in a private copy of ALBERA, open (or refresh) one pull request that brings in what changed upstream.
// Run weekly by .github/workflows/albera-updates.yml; it never runs in BERORINPO/albera itself (the workflow's `if:`).
// docs/private-copy.md says how a copy is made and set up.
//
//   node scripts/upstream-sync.mjs        (in a checkout of the copy with full history, `gh` signed in as the workflow)
//
// What it does, in order:
//   1. fetches the upstream branch (ALBERA_UPSTREAM / ALBERA_UPSTREAM_REF, default the public ALBERA main);
//   2. stops quietly when the copy's base branch already contains it (in its history, or in its files after a squash merge);
//   3. brings the copy's branch `albera-update` up to the upstream tip, never by force: it creates or fast-forwards the
//      branch, or, when a person added commits there (a conflict resolution), merges the tip on top and stops on a conflict;
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
/** The public issue form for copies (.github/ISSUE_TEMPLATE/from-a-copy.yml). */
export const ISSUE_FORM = 'https://github.com/BERORINPO/albera/issues/new?template=from-a-copy.yml';
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
    'Merge it with **Create a merge commit** (not squash or rebase), so the next update starts from here.',
    '',
    '**Checks.** Read the changes first: checks run ALBERA\'s new code (and any changed workflow) with this copy\'s secrets. When this pull request was opened with GitHub\'s own token, its checks do not start by themselves; close and reopen it to start them.',
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
    + 'How a copy is set up: `docs/private-copy.md`.',
    '',
    `A problem or a wish for ALBERA? ${ISSUE_FORM} (the issue is public: write it without this organization's code, names or screenshots).`);
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

const lines = (text) => text.split('\n').filter(Boolean);
const commitsOf = (text) => lines(text).map((line) => { const [sha, ...rest] = line.split('\t'); return { sha, subject: rest.join('\t') }; });
const lastLine = (r) => r.stderr.trim().split('\n').pop();
const BOT = ['-c', 'user.name=ALBERA update', '-c', 'user.email=albera-update@users.noreply.github.com', '-c', 'commit.gpgsign=false'];

/**
 * True when merging `tip` into `baseRef` would change nothing: ALBERA's changes are already in the copy's files, even
 * if they came by a squash or rebase merge (which leaves `tip` outside the copy's history). Needs git 2.38+
 * (merge-tree --write-tree); with an older git the answer is "no" and the history check alone decides.
 */
function contentAlreadyIn(git, tip, baseRef) {
  const merged = git('merge-tree', '--write-tree', baseRef, tip);
  if (merged.code !== 0) return false;   // a conflict (exit 1) or no --write-tree (older git)
  const tree = git('rev-parse', `${baseRef}^{tree}`);
  return tree.code === 0 && merged.stdout.trim().split('\n')[0] === tree.stdout.trim();
}

/**
 * Bring the update branch to `tip` without ever discarding a commit on it: create it, fast-forward it, leave it when it
 * already has `tip`, or (when a person added commits, such as a conflict resolution) merge `tip` into it. A merge that
 * conflicts stops here: the branch is left as it is. Never a force push.
 */
function updateBranch(git, s, tip, workflows) {
  const remote = `refs/remotes/origin/${s.branch}`;
  const current = git('rev-parse', '--verify', '--quiet', `${remote}^{commit}`);
  let target = tip;
  let how = 'pushed';
  if (current.code === 0) {
    const head = current.stdout.trim();
    if (git('merge-base', '--is-ancestor', tip, head).code === 0) return { ok: true, how: 'already' };
    if (git('merge-base', '--is-ancestor', head, tip).code !== 0) {
      // A person's commits are on the branch: keep them and merge the new ALBERA on top.
      const at = git('checkout', '--quiet', '--detach', head);
      if (at.code !== 0) return { ok: false, status: 'branch_failed', message: `Reading ${s.branch} failed: ${lastLine(at)}` };
      const merge = git(...BOT, 'merge', '--no-edit', '--quiet', '-m', `Merge ALBERA ${s.ref} (${tip.slice(0, 7)}) into ${s.branch}`, tip);
      if (merge.code !== 0) {
        git('merge', '--abort');
        return { ok: false, status: 'branch_has_conflicts', message: `${s.branch} has commits a person added, and the new ALBERA changes conflict with them. Nothing was pushed. Merge the open update pull request first, or merge ALBERA ${s.ref} into ${s.branch} by hand (docs/private-copy.md, "When the update cannot be pushed").` };
      }
      target = git('rev-parse', 'HEAD').stdout.trim();
      how = 'merged';
    }
  }
  const push = git('push', '--quiet', 'origin', `${target}:refs/heads/${s.branch}`);
  if (push.code === 0) return { ok: true, how };
  const wf = /workflow/i.test(push.stderr) && workflows.length;
  return { ok: false, status: wf ? 'push_refused_workflows' : 'push_failed',
    message: wf
      ? `Pushing ${s.branch} was refused because ALBERA changed files under .github/workflows/, which the workflow's own token may not write. A person who may change workflows reads them and pushes the branch by hand (docs/private-copy.md, "When the update cannot be pushed").`
      : `Pushing ${s.branch} failed: ${lastLine(push)}` };
}

/** Open the update pull request, or refresh the one already open from THIS repository's branch (not a fork's). */
function openOrRefresh(gh, s, title, body) {
  const open = gh('pr', 'list', '--head', s.branch, '--base', s.base, '--state', 'open', '--json', 'number,isCrossRepository',
    '--jq', '[.[] | select(.isCrossRepository | not)][0].number // empty');
  if (open.code !== 0) return { ok: false, message: `Listing pull requests failed: ${lastLine(open)}` };
  const number = Number(open.stdout.trim()) || 0;
  const r = number
    ? gh('pr', 'edit', String(number), '--title', title, '--body', body)
    : gh('pr', 'create', '--base', s.base, '--head', s.branch, '--title', title, '--body', body);
  if (r.code !== 0) {
    const notAllowed = /not permitted to create|not allowed to create/i.test(r.stderr);
    return { ok: false, message: notAllowed
      ? 'GitHub Actions may not open pull requests in this repository. Turn on Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests" (an organization owner may have to allow it first, in the organization\'s Actions settings), or add ALBERA_SYNC_TOKEN (docs/private-copy.md).'
      : `${number ? 'Updating' : 'Opening'} the pull request failed: ${lastLine(r)}` };
  }
  return { ok: true, refreshed: !!number, pr: number || Number((r.stdout.match(/\/pull\/(\d+)/) || [])[1]) || undefined };
}

/**
 * One sync. `run(cmd, args, {cwd})` -> {code, stdout, stderr}; tests pass a runner with a fake `gh`.
 * @returns {{status:string, exitCode:number, message:string, pr?:number}}
 */
export function upstreamSync({ cwd, env = process.env, run = runCommand }) {
  const s = { ...syncSettings(env) };
  const git = (...args) => run('git', args, { cwd });
  const gh = (...args) => run('gh', args, { cwd });
  const must = (r, what) => { if (r.code !== 0) throw Object.assign(new Error(`${what}: ${lastLine(r)}`), { step: what }); return r.stdout.trim(); };

  if (!s.base) {
    s.base = must(gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'), 'read_default_branch');
    if (!REF_RE.test(s.base) || s.base === s.branch) throw Object.assign(new Error(`default branch not usable: ${s.base}`), { step: 'read_default_branch' });
  }
  must(git('fetch', '--no-tags', '--quiet', '--', s.upstream, `refs/heads/${s.ref}`), 'fetch_upstream');
  const tip = must(git('rev-parse', '--verify', 'FETCH_HEAD^{commit}'), 'read_upstream_tip');
  const baseRef = `refs/remotes/origin/${s.base}`;
  must(git('rev-parse', '--verify', `${baseRef}^{commit}`), 'read_base_branch');
  const upToDate = { status: 'up_to_date', exitCode: 0, message: `The copy's ${s.base} already has ALBERA ${s.ref} at ${tip.slice(0, 7)}.` };
  if (git('merge-base', '--is-ancestor', tip, baseRef).code === 0) return upToDate;
  const mb = git('merge-base', tip, baseRef);
  if (mb.code !== 0 || !mb.stdout.trim()) {
    return { status: 'no_shared_history', exitCode: 1,
      message: `The copy's ${s.base} shares no history with ALBERA ${s.ref}, so there is nothing to compare. Make the copy with its history (docs/private-copy.md, "Make the copy").` };
  }
  if (contentAlreadyIn(git, tip, baseRef)) return { ...upToDate, message: `${upToDate.message} (its changes are in already, by a squash or rebase merge)` };
  const since = mb.stdout.trim();
  const commits = commitsOf(must(git('log', '--no-merges', '--format=%H%x09%s', `${since}..${tip}`), 'list_commits'));
  if (!commits.length) commits.push(...commitsOf(must(git('log', '--format=%H%x09%s', '-1', tip), 'read_tip')));
  const changelog = changelogAdditions(must(git('diff', '--no-color', '--no-ext-diff', since, tip, '--', 'CHANGELOG.md'), 'diff_changelog'));
  const workflows = lines(must(git('diff', '--name-only', since, tip, '--', '.github/workflows'), 'list_workflow_changes'));

  const branch = updateBranch(git, s, tip, workflows);
  if (!branch.ok) return { status: branch.status, exitCode: 1, message: branch.message };
  const { title, body } = syncPullRequest({ upstream: s.upstream, ref: s.ref, tip, commits, changelog, workflows });
  const pr = openOrRefresh(gh, s, title, body);
  if (!pr.ok) return { status: 'pr_failed', exitCode: 1, message: pr.message };
  const n = commits.length;
  return { status: pr.refreshed ? 'updated' : 'opened', exitCode: 0, pr: pr.pr, branch: branch.how,
    message: `${pr.refreshed ? 'Refreshed' : 'Opened'} the update pull request${pr.pr ? ` #${pr.pr}` : ''}: ${n} ${n === 1 ? 'commit' : 'commits'} from ALBERA ${s.ref} up to ${tip.slice(0, 7)}${branch.how === 'merged' ? ', merged onto the commits a person added' : ''}.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = upstreamSync({ cwd: process.cwd() }); }
  catch (error) { result = { status: error.step || 'failed', exitCode: 1, message: error.message }; }
  console.log(`${result.status}: ${result.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ALBERA update\n\n${result.message}\n`);
  process.exitCode = result.exitCode;
}
