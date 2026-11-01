import { lstat, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitEnv, hardening, isOid, runGitProcess } from './git-process.mjs';

// Host-side quarantine for agent submissions (ADR-007 §2 and §4 steps 2-4; acceptance INT-01). The adapter between the pure
// integration-candidate.mjs and real git. A submission arrives as a git BUNDLE FILE, never as a repository to fetch from: reading a bundle runs
// nothing of the sender's (no upload-pack in their repository, no config of theirs), so the guest's .git/config, hooks and attributes never reach
// the host. Everything happens in fresh BARE repositories under `root` (no working tree is ever checked out), with git run as
//   git -c <hardening> ...   (git-process.mjs: argv only, no shell, a fixed environment without the user's global or system config, bounded time and output)
//
//   const q = createGitQuarantine({ git, root })
//   const repo = await q.create()                                     -> absolute path of a new bare repository
//   await q.importBundle(repo, { bundlePath, ref, expectedOid })        -> { ok: true } | { ok: false, code }
//   await q.inspect(repo, { baseOid, resultOid, limits })               -> { ok: true, changed } | { ok: false, code }
//   await q.buildCandidate(repo, { targetOid, submissions, identity })  -> { ok: true, candidateCommitOid, candidateTreeOid } | { ok: false, code }
//
// importBundle verifies the bundle, fetches exactly `ref` into refs/albera/quarantine/<n> and checks the fetched commit IS `expectedOid` (the
// guest's word is checked, not trusted). inspect checks ancestry (base is an ancestor of result) and every path that ANY commit in base..result adds
// or changes (every commit lands in the candidate's history, not only the last tree): no symlink, no submodule (gitlink), no .git / .gitmodules
// component (any case, trailing dots or spaces, NTFS short names), no absolute, drive-letter, backslash, colon (NTFS stream), Windows-reserved or
// control-character path, no blob over the size limit, bounded commits and paths. buildCandidate requires each submission's inspected base to be the
// merge base with the head it merges into (else a guest holding newer host commits could revert them silently), merges with `git merge-tree --write-tree`
// (a conflict probe that touches no working tree; a clean text merge is NOT semantic compatibility, ADR-007 §4 step 3) and writes the merge commit
// with `git commit-tree` under a fixed identity and timestamp, so the same inputs give the same candidate commit.

export const QUARANTINE_REFUSALS = Object.freeze([
  'bundle_invalid', 'ref_missing', 'oid_mismatch', 'not_descendant', 'symlink', 'submodule', 'path_forbidden', 'blob_too_large',
  'too_many_paths', 'too_many_commits', 'base_mismatch', 'conflicted', 'git_failed', 'request_invalid',
]);
export const DEFAULT_LIMITS = Object.freeze({ maxBlobBytes: 50 * 1024 * 1024, maxChangedPaths: 10_000, maxCommits: 1_000 });

const REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}$/u;

const ok = Object.freeze({ ok: true });
const refuse = (code) => Object.freeze({ ok: false, code });

/** A path the submission may add or change: relative, forward slashes, no .git / .gitmodules / dot-dot component, printable, not a drive path. */
export function isAllowedPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  if (/[\u0000-\u001f\u007f\\:<>"|?*]/u.test(p) || p.startsWith('/')) return false;   // ':' also covers drive letters and NTFS streams (.gitmodules:x)
  return p.split('/').every((part) => {
    const lower = part.toLowerCase().replace(/[. ]+$/u, '');   // Windows ignores trailing dots and spaces: ".git." is ".git"
    return part.length > 0 && part !== '.' && part !== '..' && lower !== '.git' && lower !== '.gitmodules' && !/^(?:git|gitmod)~\d+$/u.test(lower);   // NTFS short names
  });
}

/** Parses `git diff-tree -r -z --raw --no-renames` output into { srcMode, dstMode, dstOid, status, path }. */
export function parseRawDiff(text) {
  const parts = text.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/u);
    if (!meta) throw new Error('unparsable_diff');
    entries.push(Object.freeze({ srcMode: meta[1], dstMode: meta[2], dstOid: meta[4], status: meta[5], path: parts[i + 1] }));
  }
  return entries;
}

/**
 * @param {{ git: string, root: string, run?: Function }} deps  `git` is the absolute path of the git executable the host chose (not a PATH lookup);
 *   `root` is a host-owned folder for quarantine repositories; `run` replaces the process runner in tests of the argument shape only.
 */
export function createGitQuarantine({ git, root, run } = {}) {
  if (typeof git !== 'string' || !path.isAbsolute(git) || typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('invalid_git_quarantine_dependencies');
  const runGit = run ?? runGitProcess;
  let fetched = 0;

  const gitIn = (repo, args, opts = {}) => runGit(git, [...hardening(root), '--git-dir', repo, ...args], { env: gitEnv(root), ...opts });

  async function create() {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'empty.gitconfig'), '', { flag: 'a' });   // the "global" config git reads: empty, owned by the host
    const repo = await mkdtemp(path.join(root, 'q-'));
    await runGit(git, [...hardening(root), 'init', '--bare', '--quiet', '--template=', '--', repo], { env: gitEnv(root) });
    await mkdir(path.join(repo, 'info'), { recursive: true });
    await writeFile(path.join(repo, 'info', 'attributes'), '* -text -diff -merge=text\n');   // no driver from anywhere: plain text merge only
    return repo;
  }

  async function importBundle(repo, { bundlePath, ref, expectedOid } = {}) {
    if (typeof bundlePath !== 'string' || !path.isAbsolute(bundlePath) || typeof ref !== 'string' || !REF_RE.test(ref) || !isOid(expectedOid)) return refuse('request_invalid');
    if (!(await isRegularFile(bundlePath))) return refuse('bundle_invalid');   // a folder would be fetched from as a repository (upload-pack, its config)
    const verified = await gitIn(repo, ['bundle', 'verify', '--quiet', bundlePath], { allowFailure: true });
    if (verified.code !== 0) return refuse('bundle_invalid');
    const heads = await gitIn(repo, ['bundle', 'list-heads', bundlePath, ref], { allowFailure: true });
    const listed = heads.code === 0 ? heads.stdout.split('\n').map((l) => l.split(' ')).find(([, name]) => name === ref) : undefined;
    if (!listed) return refuse('ref_missing');
    if (listed[0] !== expectedOid) return refuse('oid_mismatch');
    const target = `refs/albera/quarantine/${(fetched += 1)}`;
    const fetchedRef = await gitIn(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', bundlePath, `${ref}:${target}`], { allowFailure: true });
    if (fetchedRef.code !== 0) return refuse('bundle_invalid');
    const tip = (await gitIn(repo, ['rev-parse', '--verify', '--end-of-options', `${target}^{commit}`])).stdout.trim();
    return tip === expectedOid ? ok : refuse('oid_mismatch');
  }

  async function inspect(repo, { baseOid, resultOid, limits = DEFAULT_LIMITS } = {}) {
    if (!isOid(baseOid) || !isOid(resultOid)) return refuse('request_invalid');
    const ancestor = await gitIn(repo, ['merge-base', '--is-ancestor', baseOid, resultOid], { allowFailure: true });
    if (ancestor.code === 1) return refuse('not_descendant');
    if (ancestor.code !== 0) return refuse('git_failed');
    const commits = (await gitIn(repo, ['rev-list', '--end-of-options', resultOid, `^${baseOid}`])).stdout.split('\n').filter(Boolean);
    if (commits.length > limits.maxCommits) return refuse('too_many_commits');
    const blobs = new Set();
    let paths = 0;
    for (const commit of commits) {
      // Every commit against each of its parents (-m), so a path added in one commit and removed in the next is still seen.
      const diff = await gitIn(repo, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-commit-id', '-m', '--root', commit]);
      const entries = parseRawDiff(diff.stdout);
      paths += entries.length;
      if (paths > limits.maxChangedPaths) return refuse('too_many_paths');
      const problem = checkEntries(entries);
      if (problem) return refuse(problem);
      for (const e of entries) if (e.status !== 'D') blobs.add(e.dstOid);
    }
    if (blobs.size > 0) {
      const sizes = await gitIn(repo, ['cat-file', '--batch-check=%(objectsize)'], { input: `${[...blobs].join('\n')}\n` });
      if (sizes.stdout.trim().split('\n').some((n) => !/^\d+$/u.test(n) || Number(n) > limits.maxBlobBytes)) return refuse('blob_too_large');
    }
    const final = parseRawDiff((await gitIn(repo, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', baseOid, resultOid])).stdout);
    return Object.freeze({ ok: true, changed: final.filter((e) => e.status !== 'D').length, commits: commits.length });
  }

  async function buildCandidate(repo, { targetOid, submissions, identity } = {}) {
    if (!isOid(targetOid) || !Array.isArray(submissions) || submissions.length === 0 || !submissions.every((x) => isOid(x?.baseOid) && isOid(x?.resultOid))) return refuse('request_invalid');
    const id = identity ?? {};
    if (!NAME_RE.test(id.name ?? '') || !EMAIL_RE.test(id.email ?? '') || !Number.isSafeInteger(id.timestamp) || id.timestamp < 0) return refuse('request_invalid');
    const commitEnv = { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email,
      GIT_AUTHOR_DATE: `${id.timestamp} +0000`, GIT_COMMITTER_DATE: `${id.timestamp} +0000` };
    let head = targetOid;
    let tree = null;
    for (const { baseOid, resultOid: result } of submissions) {
      // The merge base must be the base inspect() checked: otherwise the three-way merge would use an older base, and changes between it and the
      // inspected one would be reverted or merged unseen.
      const bases = await gitIn(repo, ['merge-base', '--all', head, result], { allowFailure: true });
      if (bases.code !== 0 || bases.stdout.trim() !== baseOid) return refuse('base_mismatch');
      const merged = await gitIn(repo, ['merge-tree', '--write-tree', '--no-messages', '-z', head, result], { allowFailure: true });
      if (merged.code === 1) return refuse('conflicted');
      if (merged.code !== 0) return refuse('git_failed');
      tree = merged.stdout.split('\0')[0].trim();
      if (!isOid(tree)) return refuse('git_failed');
      const commit = await gitIn(repo, ['commit-tree', tree, '-p', head, '-p', result, '-m', `ALBERA integration candidate: merge ${result}`], { env: { ...gitEnv(root), ...commitEnv } });
      head = commit.stdout.trim();
      if (!isOid(head)) return refuse('git_failed');
    }
    return Object.freeze({ ok: true, candidateCommitOid: head, candidateTreeOid: tree });
  }

  return Object.freeze({ create, importBundle, inspect, buildCandidate });
}

/** The first refusal code for a set of diff entries, or null. Deleting a forbidden path is refused too. */
function checkEntries(entries) {
  for (const e of entries) {
    if (!isAllowedPath(e.path)) return 'path_forbidden';
    if (e.status === 'D') continue;
    if (e.dstMode === '120000') return 'symlink';
    if (e.dstMode === '160000') return 'submodule';
    if (e.dstMode !== '100644' && e.dstMode !== '100755') return 'path_forbidden';
  }
  return null;
}

async function isRegularFile(p) {
  try { return (await lstat(p)).isFile(); } catch { return false; }
}
