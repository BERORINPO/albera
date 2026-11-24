// Parse `git log` output, find PR numbers, and work out the period (--since).
import { InputError } from '../shared/map-shape.mjs';

/** The --format string the git adapter must use. Fields: hash, parents, committer date, subject. */
export const LOG_FORMAT = '%x1e%H%x1f%P%x1f%cI%x1f%s';

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const CREATED = /^\s*create mode \d+ (.+)$/;

/**
 * Parse `git log --numstat --summary --format=LOG_FORMAT`.
 * @returns {{hash,parents:string[],date,subject,files:{path,added,deleted}[],created:string[]}[]} newest first
 */
export function parseGitLog(text) {
  const commits = [];
  for (const chunk of text.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [header, ...rest] = chunk.split(/\r?\n/);
    const [hash, parents = '', date = '', ...subjectParts] = header.split('\x1f');
    if (!/^[0-9a-f]{7,64}$/.test(hash)) continue;
    const files = [];
    const created = [];
    for (const line of rest) {
      const n = line.match(NUMSTAT);
      if (n) { files.push({ path: n[3], added: n[1] === '-' ? 0 : Number(n[1]), deleted: n[2] === '-' ? 0 : Number(n[2]) }); continue; }
      const c = line.match(CREATED);
      if (c) created.push(c[1]);
    }
    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      date,
      subject: subjectParts.join('\x1f'),
      files,
      created,
    });
  }
  return commits;
}

/** PR number written in a commit subject. Merge: "Merge pull request #12 ...". Squash: "title (#12)". */
export function prNumberOf(subject, isMerge) {
  const m = isMerge ? subject.match(/#(\d+)\b/) : subject.match(/\(#(\d+)\)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Map each commit to the PR it came in with.
 * Walks the first-parent line from the newest commit, oldest merge first; a merge claims every commit
 * reachable from its other parents that is not on the main line and not claimed yet.
 * @returns {Map<string, number>} hash -> PR number
 */
export function assignPrs(commits) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const mainline = [];
  for (let h = commits[0]?.hash; h && byHash.has(h) && !mainline.includes(h); h = byHash.get(h).parents[0]) mainline.push(h);
  const onMain = new Set(mainline);
  const prOf = new Map();
  for (const hash of [...mainline].reverse()) {
    const c = byHash.get(hash);
    const isMerge = c.parents.length > 1;
    const pr = prNumberOf(c.subject, isMerge);
    if (!pr) continue;
    prOf.set(hash, pr);
    if (!isMerge) continue;
    const stack = c.parents.slice(1);
    while (stack.length) {
      const h = stack.pop();
      if (!byHash.has(h) || onMain.has(h) || prOf.has(h)) continue;
      prOf.set(h, pr);
      stack.push(...byHash.get(h).parents);
    }
  }
  return prOf;
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" minus n days (calendar arithmetic, no clock). */
export function minusDays(date, n) {
  const m = date.match(DATE_ONLY);
  if (!m) throw new Error(`not a date: ${date}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The first day of the period, "YYYY-MM-DD".
 * @param {string|undefined} arg  --since value: a number of days or YYYY-MM-DD
 * @param {string} today          today's local date (given by the entry, core has no clock)
 * @param {string|null} lastCommitDate ISO date of the last commit in the folder
 */
export function resolveSince(arg, today, lastCommitDate) {
  if (arg === undefined || arg === null || arg === '') {
    const base = lastCommitDate ? lastCommitDate.slice(0, 10) : today;
    return minusDays(base, 1);
  }
  const s = String(arg).trim();
  if (/^\d{1,4}$/.test(s)) return minusDays(today, Number(s));
  const m = s.match(DATE_ONLY);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.toISOString().slice(0, 10) === s) return s;
  }
  throw new InputError(`--since は日数 (例: 7) か日付 (例: 2026-11-20) にする: "${s}"`);
}
