import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Host-side quarantine for agent submissions (ADR-007 §2 and §4 steps 2-4; acceptance INT-01). The adapter between the pure
// integration-candidate.mjs and real git. A submission arrives as a git BUNDLE FILE, never as a repository to fetch from: reading a bundle runs
// nothing of the sender's (no upload-pack in their repository, no config of theirs), so the guest's .git/config, hooks and attributes never reach
// the host. Everything happens in fresh BARE repositories under `root` (no working tree is ever checked out), with git run as
//   git -c <hardening> ...   (argv only, no shell, a fixed environment without the user's global or system config, bounded time and output)
//
//   const q = createGitQuarantine({ git, root })
//   const repo = await q.create()                                     -> absolute path of a new bare repository
//   await q.importBundle(repo, { bundlePath, ref, expectedOid })        -> { ok: true } | { ok: false, code }
//   await q.inspect(repo, { baseOid, resultOid, limits })               -> { ok: true, changed } | { ok: false, code }
//   await q.buildCandidate(repo, { targetOid, resultOids, identity })   -> { ok: true, candidateCommitOid, candidateTreeOid } | { ok: false, code }
//
// importBundle verifies the bundle, fetches exactly `ref` into refs/albera/quarantine/<n> and checks the fetched commit IS `expectedOid` (the
// guest's word is checked, not trusted). inspect checks ancestry (base is an ancestor of result) and every path the submission adds or changes:
// no symlink, no submodule (gitlink), no .git / .gitmodules component, no absolute, drive-letter, backslash, dot-dot or control-character path, no
// blob over the size limit, at most `maxChangedPaths` changes. buildCandidate merges each result into the target with `git merge-tree --write-tree`
// (a conflict probe that touches no working tree; a clean text merge is NOT semantic compatibility, ADR-007 §4 step 3) and writes the merge commit
// with `git commit-tree` under a fixed identity and timestamp, so the same inputs give the same candidate commit.

export const QUARANTINE_REFUSALS = Object.freeze([
  'bundle_invalid', 'ref_missing', 'oid_mismatch', 'not_descendant', 'symlink', 'submodule', 'path_forbidden', 'blob_too_large',
  'too_many_paths', 'conflicted', 'git_failed', 'request_invalid',
]);
export const DEFAULT_LIMITS = Object.freeze({ maxBlobBytes: 50 * 1024 * 1024, maxChangedPaths: 10_000 });

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}$/u;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 32 * 1024 * 1024;
// Hardening on every call: no hooks (and `init --template=` copies no sample hooks), no fsmonitor, no transport but `file` (git reads a bundle through it;
// importBundle only passes a path that lstat shows is a regular file, so a repository folder is never fetched from), objects fsck'd
// on the way in, no automatic gc or maintenance, no replace refs, no credential helper, no pager.
const hardening = (root) => [
  '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'transfer.fsckObjects=true',
  '-c', 'fetch.fsckObjects=true', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.useReplaceRefs=false',
  '-c', 'credential.helper=', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false',
];   // core.hooksPath names a folder that is never created, so no hook can exist

const ok = Object.freeze({ ok: true });
const refuse = (code) => Object.freeze({ ok: false, code });
const isOid = (v) => typeof v === 'string' && OID_RE.test(v);

/** A path the submission may add or change: relative, forward slashes, no .git / .gitmodules / dot-dot component, printable, not a drive path. */
export function isAllowedPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  if (/[\u0000-\u001f\u007f\\]/u.test(p) || p.startsWith('/') || /^[A-Za-z]:/u.test(p)) return false;
  return p.split('/').every((part) => {
    const lower = part.toLowerCase().replace(/[. ]+$/u, '');   // Windows ignores trailing dots and spaces: ".git." is ".git"
    return part.length > 0 && part !== '.' && part !== '..' && lower !== '.git' && lower !== '.gitmodules' && !/^git~\d+$/u.test(lower);
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
  const runGit = run ?? defaultRun;
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
    const diff = await gitIn(repo, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', baseOid, resultOid]);
    const entries = parseRawDiff(diff.stdout);
    if (entries.length > limits.maxChangedPaths) return refuse('too_many_paths');
    const written = entries.filter((e) => e.status !== 'D');
    for (const e of written) {
      if (!isAllowedPath(e.path)) return refuse('path_forbidden');
      if (e.dstMode === '120000') return refuse('symlink');
      if (e.dstMode === '160000') return refuse('submodule');
      if (e.dstMode !== '100644' && e.dstMode !== '100755') return refuse('path_forbidden');
    }
    if (entries.some((e) => !isAllowedPath(e.path))) return refuse('path_forbidden');   // deleting .git* paths is refused too
    if (written.length > 0) {
      const sizes = await gitIn(repo, ['cat-file', '--batch-check=%(objectsize)'], { input: `${written.map((e) => e.dstOid).join('\n')}\n` });
      if (sizes.stdout.trim().split('\n').some((n) => !/^\d+$/u.test(n) || Number(n) > limits.maxBlobBytes)) return refuse('blob_too_large');
    }
    return Object.freeze({ ok: true, changed: written.length });
  }

  async function buildCandidate(repo, { targetOid, resultOids, identity } = {}) {
    if (!isOid(targetOid) || !Array.isArray(resultOids) || resultOids.length === 0 || !resultOids.every(isOid)) return refuse('request_invalid');
    const id = identity ?? {};
    if (!NAME_RE.test(id.name ?? '') || !EMAIL_RE.test(id.email ?? '') || !Number.isSafeInteger(id.timestamp) || id.timestamp < 0) return refuse('request_invalid');
    const commitEnv = { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email,
      GIT_AUTHOR_DATE: `${id.timestamp} +0000`, GIT_COMMITTER_DATE: `${id.timestamp} +0000` };
    let head = targetOid;
    let tree = null;
    for (const result of resultOids) {
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

// A fixed environment: the system and global config files are not read (a host user's aliases, credential helpers or hooks must not apply), no
// prompts, no editor, no pager, English messages. Only PATH-free essentials are kept (SYSTEMROOT is needed by Windows for sockets and crypto).
function gitEnv(root) {
  const env = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '',
    GIT_EDITOR: ':', GIT_PAGER: 'cat', LC_ALL: 'C', LANG: 'C', HOME: root, GIT_OPTIONAL_LOCKS: '0',
  };
  for (const key of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

async function isRegularFile(p) {
  try { return (await lstat(p)).isFile(); } catch { return false; }
}

// argv only (shell: false), a fixed environment, a deadline and an output cap; stdout and stderr are collected as UTF-8 and never logged.
function defaultRun(file, args, { env, input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = []; let size = 0; let failed = null;
    const stop = (why) => { if (!failed) { failed = why; child.kill(); } };
    const timer = setTimeout(() => stop('timeout'), TIMEOUT_MS);
    const take = (chunks) => (chunk) => { size += chunk.length; if (size > MAX_OUTPUT) stop('output_limit'); else chunks.push(chunk); };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.on('error', () => stop('spawn_failed'));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const code = failed ? -1 : exitCode ?? -1;
      if (code !== 0 && !allowFailure) return reject(Object.assign(new Error('git_failed'), { code: 'git_failed', exitCode: code }));
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
