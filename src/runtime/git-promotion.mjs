import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitEnv, hardening, isOid, runGitProcess } from './git-process.mjs';

// Promotion of an approved integration candidate to a protected ref (ADR-007 §5 and §8; acceptance INT-02). The adapter between
// integration-candidate.mjs (authorizePromotion's `update`, then recordPromotion / reconcilePromotion) and real git:
//
//   const p = createGitPromotion({ git, root, remotes })
//   await p.readTip({ repositoryId, ref })                                      -> { ok: true, oid } (oid null: no such ref) | { ok: false, code }
//   await p.fetchTip(repo, { repositoryId, ref })                               -> { ok: true, oid } | { ok: false, code }   (the tip's objects are now in `repo`)
//   await p.push(repo, { repositoryId, ref, expectedOldOid, newOid })           -> { outcome: 'updated' | 'rejected' | 'blocked' | 'unknown', code }
//
// fetchTip brings the target tip's commit and history into a quarantine repository (a candidate's first parent must exist there, and a bundle cannot carry it): it
// reads the tip (readTip), fetches exactly that one registered ref into the host-owned ref refs/albera/target-tip of `repo`, reads that ref back, and answers ok only
// when the fetched commit IS the tip it read first (a tip that moved in between is `target_moved`: nothing was frozen on it, the caller starts again). No tags, no
// submodules, no FETCH_HEAD, objects fsck'd. `repo` is only written to; the only configuration git reads is the host's own (the empty global file and the flags below).
//
// Only host-registered remotes and refs: `remotes` maps a repositoryId to { url, refs }, where url is an absolute local path for now (no network
// remote, no UNC share and no credential is used by this adapter yet) and refs lists the refs a candidate may be promoted to. A push is a fast-forward
// compare-and-swap and nothing else: newOid must descend from expectedOldOid in `repo` (checked here before anything is sent), and the remote updates
// the ref only if it still is expectedOldOid (`--force-with-lease=<ref>:<expected>`; receive-pack checks the old value under its ref lock), atomically,
// one ref, no hooks of ours, no tags. Outcomes map onto recordPromotion: 'updated' -> MERGED, 'rejected' (the tip moved, or not a fast-forward
// any more) -> STALE, 'blocked' (the remote's own rules refused, e.g. its pre-receive hook) -> BLOCKED, 'unknown' (no answer, a timeout, a
// `[remote failure]`, output that does not say) -> UNKNOWN_PROMOTION, whose only exit is readTip + reconcilePromotion: an ambiguous push is never re-sent blindly (ADR-007 §8).

export const PROMOTION_REFUSALS = Object.freeze(['request_invalid', 'remote_unknown', 'ref_not_promotable', 'not_fast_forward', 'git_failed', 'target_missing', 'target_moved']);
export const TARGET_TIP_REF = 'refs/albera/target-tip';

const REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const isRef = (r) => typeof r === 'string' && REF_RE.test(r) && !r.includes('..') && !r.endsWith('/') && !r.endsWith('.lock');
const refuse = (code) => Object.freeze({ ok: false, code });
const outcome = (o, code) => Object.freeze({ outcome: o, code });

/**
 * @param {{ git: string, root: string, remotes: { [repositoryId: string]: { url: string, refs: readonly string[] } }, run?: Function }} deps
 *   `git` is the absolute path of the git executable the host chose; `root` a host-owned folder (its empty.gitconfig is git's global config);
 *   `run` replaces the process runner in tests of the argument shape and of the outcome mapping only.
 */
export function createGitPromotion({ git, root, remotes, run } = {}) {
  if (typeof git !== 'string' || !path.isAbsolute(git) || typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('invalid_git_promotion_dependencies');
  const registry = freezeRemotes(remotes);
  const runGit = run ?? runGitProcess;
  // readTip runs inside an empty bare repository the host made under root, so git never discovers a repository from the host process's current
  // folder (whose .git/config could rewrite the remote URL with insteadOf or name an upload-pack command). Every call also runs with cwd = root.
  const reader = path.join(root, 'tip-reader.git');
  let prepared = null;
  const prepare = () => (prepared ??= (async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'empty.gitconfig'), '', { flag: 'a' });
    await runGit(git, [...hardening(root), 'init', '--bare', '--quiet', '--template=', '--', reader], { env: gitEnv(root), cwd: root });
  })());
  const gitRun = async (args, opts = {}) => { await prepare(); return runGit(git, [...hardening(root), ...args], { env: gitEnv(root), cwd: root, allowFailure: true, ...opts }); };
  const target = (repositoryId, ref) => {
    const remote = Object.hasOwn(registry, repositoryId) ? registry[repositoryId] : null;
    if (!remote) return { code: 'remote_unknown' };
    if (!remote.refs.includes(ref)) return { code: 'ref_not_promotable' };
    return { url: remote.url };
  };

  async function readTip({ repositoryId, ref } = {}) {
    if (typeof repositoryId !== 'string' || !isRef(ref)) return refuse('request_invalid');
    const t = target(repositoryId, ref);
    if (t.code) return refuse(t.code);
    const listed = await gitRun(['--git-dir', reader, 'ls-remote', '--refs', '--', t.url, ref]);
    if (listed.code !== 0) return refuse('git_failed');
    const lines = listed.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
    const exact = lines.filter(([, name]) => name === ref);
    if (exact.length > 1 || (exact.length === 1 && !isOid(exact[0][0]))) return refuse('git_failed');
    return Object.freeze({ ok: true, oid: exact.length === 1 ? exact[0][0] : null });
  }

  async function fetchTip(repo, { repositoryId, ref } = {}) {
    if (typeof repo !== 'string' || !path.isAbsolute(repo)) return refuse('request_invalid');
    const read = await readTip({ repositoryId, ref });
    if (!read.ok) return read;
    if (read.oid === null) return refuse('target_missing');
    const { url } = target(repositoryId, ref);   // readTip answered ok, so the target is registered
    // `+`: the ref is host-owned and moves to whatever the remote has now (a second fetch into the same repository is not an error).
    const fetched = await gitRun(['--git-dir', repo, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', url, `+${ref}:${TARGET_TIP_REF}`]);
    if (fetched.code !== 0) return refuse('git_failed');
    const back = await gitRun(['--git-dir', repo, 'rev-parse', '--verify', '--end-of-options', `${TARGET_TIP_REF}^{commit}`]);
    const oid = back.stdout.trim();
    if (back.code !== 0 || !isOid(oid)) return refuse('git_failed');
    return oid === read.oid ? Object.freeze({ ok: true, oid }) : refuse('target_moved');
  }

  async function push(repo, { repositoryId, ref, expectedOldOid, newOid } = {}) {
    if (typeof repo !== 'string' || !path.isAbsolute(repo) || typeof repositoryId !== 'string' || !isRef(ref) || !isOid(expectedOldOid) || !isOid(newOid) || expectedOldOid === newOid) {
      return Object.freeze({ ...refuse('request_invalid'), outcome: null });
    }
    const t = target(repositoryId, ref);
    if (t.code) return Object.freeze({ ...refuse(t.code), outcome: null });
    // Nothing is sent unless this is a fast-forward of the approved old tip (a candidate is a merge commit whose first parent is that tip).
    const ancestor = await gitRun(['--git-dir', repo, 'merge-base', '--is-ancestor', expectedOldOid, newOid]);
    if (ancestor.code === 1) return Object.freeze({ ...refuse('not_fast_forward'), outcome: null });
    if (ancestor.code !== 0) return Object.freeze({ ...refuse('git_failed'), outcome: null });
    const sent = await gitRun(['--git-dir', repo, 'push', '--porcelain', '--no-verify', '--atomic', '--no-follow-tags', '--no-recurse-submodules',
      `--force-with-lease=${ref}:${expectedOldOid}`, '--', t.url, `${newOid}:${ref}`]);
    return pushOutcome(sent, ref);
  }

  return Object.freeze({ readTip, fetchTip, push });
}

/**
 * Maps `git push --porcelain` for one ref to an outcome. The status line is `<flag>\t<from>:<to>\t<summary>`: ' ' fast-forwarded, '!' refused. A
 * forced update ('+'), a new ref ('*'), a deletion ('-'), "up to date" ('=') or no line for the ref cannot come from the push above and are not
 * trusted as success: 'unknown', so the tip is read back.
 */
export function pushOutcome(result, ref) {
  if (result?.code === -1 || typeof result?.stdout !== 'string') return outcome('unknown', 'no_answer');
  const lines = result.stdout.split('\n').filter((l) => l.split('\t')[1]?.endsWith(`:${ref}`));
  if (lines.length !== 1) return outcome('unknown', 'no_status');
  const [flag, , summary = ''] = lines[0].split('\t');
  if (flag === ' ' && result.code === 0) return outcome('updated', 'fast_forward');
  if (flag === '!') {
    if (summary.startsWith('[remote rejected]')) return outcome('blocked', 'remote_rule');
    if (summary.startsWith('[remote failure]')) return outcome('unknown', 'no_report');   // the pack was sent and the answer lost: the ref may have moved
    if (summary.includes('stale info')) return outcome('rejected', 'stale');
    if (summary.startsWith('[rejected]')) return outcome('rejected', 'not_fast_forward');
  }
  return outcome('unknown', 'no_status');
}

function freezeRemotes(remotes) {
  if (!remotes || typeof remotes !== 'object') throw new TypeError('invalid_git_promotion_remotes');
  const out = {};
  for (const [id, r] of Object.entries(remotes)) {
    if (!ID_RE.test(id) || typeof r?.url !== 'string' || !path.isAbsolute(r.url) || /^[\\/]{2}/u.test(r.url) || !Array.isArray(r.refs) || r.refs.length === 0 || !r.refs.every(isRef)) {
      throw new TypeError('invalid_git_promotion_remotes');
    }
    out[id] = Object.freeze({ url: r.url, refs: Object.freeze([...r.refs]) });
  }
  return Object.freeze(out);
}
